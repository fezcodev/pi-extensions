import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMockContext, createMockPi } from "../../../test/support/mock-pi.ts";
import { reportSessionName } from "../herdr.ts";
import autoName from "../index.ts";

type Request = { method: string; params: { pane_id: string; source: string; seq: number; tokens: Record<string, string | null> } };
type HcRequest = { jsonrpc: string; method: string; params: { terminal: string; labels: Record<string, string> } };

/** A stand-in server on a real Unix socket, recording each request. `delayMs` holds every reply. */
async function fakeServer<T>(t: test.TestContext, env: (socketPath: string) => Record<string, string>, respond = true, delayMs = 0) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "fake-"));
	const socketPath = path.join(dir, "server.sock");
	const requests: T[] = [];
	const server = net.createServer((socket) => {
		socket.on("data", (chunk) => {
			for (const line of chunk.toString().split("\n").filter(Boolean)) requests.push(JSON.parse(line));
			if (respond) setTimeout(() => socket.write('{"id":"x","result":{}}\n'), delayMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const vars = env(socketPath);
	Object.assign(process.env, vars);
	t.after(() => {
		for (const key of Object.keys(vars)) delete process.env[key];
		server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return requests;
}

const fakeHerdr = (t: test.TestContext, respond = true) =>
	fakeServer<Request>(t, (socket) => ({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "w1:p1" }), respond);

const fakeHc = (t: test.TestContext, respond = true, delayMs = 0) =>
	fakeServer<HcRequest>(t, (socket) => ({ HC_TERMINAL_SOCKET: socket, HC_TERMINAL_ID: "t7" }), respond, delayMs);

function setup(mode = "tui") {
	const mock = createMockPi();
	let name: string | undefined;
	Object.assign(mock.rawPi, { getSessionName: () => name, setSessionName: (value: string) => (name = value) });
	autoName(mock.pi);
	const { ctx } = createMockContext({ mode });
	return {
		setName: (value: string | undefined) => (name = value),
		fire: async (event: string, payload: unknown = {}) => {
			for (const handler of mock.events.get(event) ?? []) await handler(payload, ctx);
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("reports the name as the session_name token, and clears it with null", async (t) => {
	const requests = await fakeHerdr(t);
	await reportSessionName("statusline cache fix");
	await reportSessionName(undefined);
	assert.equal(requests.length, 2);
	assert.equal(requests[0].method, "pane.report_metadata");
	assert.deepEqual(
		{ pane: requests[0].params.pane_id, source: requests[0].params.source, tokens: requests[0].params.tokens },
		{ pane: "w1:p1", source: "pi-auto-name", tokens: { session_name: "statusline cache fix" } },
	);
	assert.deepEqual(requests[1].params.tokens, { session_name: null });
	assert.ok(requests[1].params.seq > requests[0].params.seq, "seq increases so stale reports are ignored");
});

test("follows session start, every rename, and clears on quit only", async (t) => {
	const requests = await fakeHerdr(t);
	const s = setup();
	s.setName("resumed name");
	await s.fire("session_start", { reason: "resume" });
	await s.fire("session_info_changed", { name: "renamed" });
	await s.fire("session_shutdown", { reason: "reload" });
	await s.fire("session_shutdown", { reason: "quit" });
	await settle();
	assert.deepEqual(
		requests.map((request) => request.params.tokens.session_name),
		["resumed name", "renamed", null],
	);
});

test("an unnamed session clears any token left by the previous one", async (t) => {
	const requests = await fakeHerdr(t);
	await setup().fire("session_start", { reason: "new" });
	await settle();
	assert.deepEqual(requests.map((request) => request.params.tokens), [{ session_name: null }]);
});

test("sends nothing outside Herdr or outside the TUI", async (t) => {
	const requests = await fakeHerdr(t);
	await setup("print").fire("session_info_changed", { name: "x" });
	delete process.env.HERDR_ENV;
	await reportSessionName("x");
	await settle();
	assert.equal(requests.length, 0);
});

test("under hc, sets the session_name label on pi's terminal, and removes it with an empty value", async (t) => {
	const requests = await fakeHc(t);
	await reportSessionName("statusline cache fix");
	await reportSessionName(undefined);
	assert.deepEqual(
		requests.map(({ jsonrpc, method, params }) => ({ jsonrpc, method, params })),
		[
			{ jsonrpc: "2.0", method: "terminal.label", params: { terminal: "t7", labels: { session_name: "statusline cache fix" } } },
			{ jsonrpc: "2.0", method: "terminal.label", params: { terminal: "t7", labels: { session_name: "" } } },
		],
	);
});

test("hc labels land in call order, so a slow write cannot restore an older name", async (t) => {
	const requests = await fakeHc(t, true, 30);
	const s = setup();
	await s.fire("session_info_changed", { name: "first" });
	await s.fire("session_info_changed", { name: "second" });
	await s.fire("session_shutdown", { reason: "quit" });
	assert.deepEqual(
		requests.map((request) => request.params.labels.session_name),
		["first", "second", ""],
	);
});

test("reports to both when Herdr and hc are both present", async (t) => {
	const herdr = await fakeHerdr(t);
	const hc = await fakeHc(t);
	await reportSessionName("both");
	assert.deepEqual(herdr.map((request) => request.params.tokens), [{ session_name: "both" }]);
	assert.deepEqual(hc.map((request) => request.params.labels), [{ session_name: "both" }]);
});

test("never throws or hangs when hc is missing or silent", async (t) => {
	await fakeHc(t, false);
	const started = Date.now();
	await reportSessionName("silent hc");
	assert.ok(Date.now() - started < 2000, "bounded by the timeout");

	process.env.HC_TERMINAL_SOCKET = path.join(os.tmpdir(), "no-such-hc.sock");
	await reportSessionName("missing hc");
});

test("never throws or hangs when Herdr is missing or silent", async (t) => {
	await fakeHerdr(t, false);
	const started = Date.now();
	await reportSessionName("silent server");
	assert.ok(Date.now() - started < 2000, "bounded by the timeout");

	process.env.HERDR_SOCKET_PATH = path.join(os.tmpdir(), "no-such-herdr.sock");
	await reportSessionName("missing server");
});
