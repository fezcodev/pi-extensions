/**
 * Reports the session name as `session_name`, so a sidebar row can show it as
 * `$session_name`:
 *
 * - Herdr TUI (`HERDR_ENV=1`): a pane metadata token on the pane's Herdr server.
 * - herdr-core (`hc`, used by rodeo and the Herdr app): a label on the
 *   terminal pi runs in.
 *
 * Display-only: it does not touch agent state or pi's terminal title.
 * Defensive by design: a no-op outside both, one short-lived socket write per
 * report, bounded by a timeout, and every failure is swallowed.
 */
import net from "node:net";

const SOURCE = "pi-auto-name";
const TOKEN = "session_name";
const TIMEOUT_MS = 500;

// Herdr ignores reports whose seq is not newer than the last one from this
// source, so a late write can never restore an older name. Time-based so a
// restarted pi in the same pane still counts as newer.
let seq = Date.now() * 1000;

// hc labels have no seq, so writes go out one at a time, in order.
let hcQueue: Promise<void> = Promise.resolve();

function herdrRequest(name: string | null): { socket: string; request: object } | undefined {
	const { HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID } = process.env;
	if (HERDR_ENV !== "1" || !HERDR_SOCKET_PATH || !HERDR_PANE_ID) return undefined;
	const socket = process.platform === "win32" ? `\\\\.\\pipe\\${HERDR_SOCKET_PATH}` : HERDR_SOCKET_PATH;
	return {
		socket,
		request: {
			id: `${SOURCE}:${Date.now()}`,
			method: "pane.report_metadata",
			params: { pane_id: HERDR_PANE_ID, source: SOURCE, seq: ++seq, tokens: { [TOKEN]: name } },
		},
	};
}

function hcRequest(name: string | null): { socket: string; request: object } | undefined {
	const { HC_TERMINAL_SOCKET, HC_TERMINAL_ID } = process.env;
	if (!HC_TERMINAL_SOCKET || !HC_TERMINAL_ID) return undefined;
	return {
		socket: HC_TERMINAL_SOCKET,
		request: {
			jsonrpc: "2.0",
			id: `${SOURCE}:${Date.now()}`,
			method: "terminal.label",
			// An empty value removes the label.
			params: { terminal: HC_TERMINAL_ID, labels: { [TOKEN]: name ?? "" } },
		},
	};
}

/** One JSON line to a Unix socket; resolves on reply, error, close or timeout. Never throws. */
function send(target: { socket: string; request: object }): Promise<void> {
	return new Promise((resolve) => {
		let socket: net.Socket | undefined;
		const finish = () => {
			clearTimeout(timer);
			socket?.destroy();
			resolve();
		};
		const timer = setTimeout(finish, TIMEOUT_MS);
		timer.unref?.();
		try {
			socket = net.createConnection(target.socket);
			socket.on("connect", () => socket?.write(`${JSON.stringify(target.request)}\n`));
			socket.on("data", finish);
			socket.on("error", finish);
			socket.on("close", finish);
		} catch {
			finish();
		}
	});
}

/** Sets (or, with no name, clears) `session_name` wherever pi is running. Never throws. */
export function reportSessionName(name: string | undefined): Promise<void> {
	const value = name?.trim() || null;
	const writes: Promise<void>[] = [];
	const herdr = herdrRequest(value);
	if (herdr) writes.push(send(herdr));
	const hc = hcRequest(value);
	if (hc) {
		hcQueue = hcQueue.then(() => send(hc));
		writes.push(hcQueue);
	}
	return Promise.all(writes).then(() => undefined);
}
