import assert from "node:assert/strict";
import test from "node:test";
import {
  createCpaResponsesStreamSimple,
  rewriteCodexCompatiblePayload,
  rewriteCodexCompatibleToolPayload,
} from "../src/codex-compat.ts";

const cpaResponsesModel = { id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" as const };

test("publishes Codex-compatible null strict markers for CPA Responses function tools", () => {
  const functionTool = {
    type: "function",
    name: "interactive_shell",
    parameters: {
      type: "object",
      properties: {
        listBackground: { type: "boolean" },
        spawn: { type: "object" },
      },
      required: [],
    },
  };
  const customTool = { type: "custom", name: "exec", format: { type: "text" } };

  const rewritten = rewriteCodexCompatibleToolPayload(
    { model: "gpt-5.6-sol", tools: [functionTool, customTool] },
    cpaResponsesModel,
    "cpa",
  ) as { tools: Array<Record<string, unknown>> };

  assert.equal(rewritten.tools[0]?.strict, null);
  assert.deepEqual(rewritten.tools[0]?.parameters, functionTool.parameters);
  assert.deepEqual(rewritten.tools[1], customTool);
});

test("leaves non-CPA and non-Responses requests unchanged", () => {
  const payload = { tools: [{ type: "function", name: "test", strict: false }] };

  assert.equal(rewriteCodexCompatibleToolPayload(payload, { provider: "openai", api: "openai-responses" }, "cpa"), undefined);
  assert.equal(rewriteCodexCompatibleToolPayload(payload, { provider: "cpa", api: "openai-completions" }, "cpa"), undefined);
});

test("does not allocate a replacement when function tools already use null strict markers", () => {
  const payload = { tools: [{ type: "function", name: "test", strict: null }] };

  assert.equal(rewriteCodexCompatibleToolPayload(payload, cpaResponsesModel, "cpa"), undefined);
});

test("injects service_tier on CPA Responses requests without clobbering an existing tier", () => {
  const payload = { model: "gpt-6.2-sol", tools: [{ type: "function", name: "bash" }] };
  const rewritten = rewriteCodexCompatiblePayload(payload, cpaResponsesModel, "cpa", () => "ultrafast") as {
    service_tier?: string;
    tools: Array<Record<string, unknown>>;
  };

  assert.equal(rewritten.service_tier, "ultrafast");
  assert.equal(rewritten.tools[0]?.strict, null);

  const alreadySet = { model: "gpt-6.1-sol-fast", service_tier: "priority" };
  assert.equal(rewriteCodexCompatiblePayload(alreadySet, cpaResponsesModel, "cpa", () => "ultrafast"), undefined);
});

test("never injects service_tier on Anthropic Messages or non-CPA models", () => {
  const payload = { model: "claude-opus-5-5-fast" };
  assert.equal(
    rewriteCodexCompatiblePayload(payload, { id: "claude-opus-5-5-fast", provider: "cpa", api: "anthropic-messages" }, "cpa", () => "priority"),
    undefined,
  );
  assert.equal(
    rewriteCodexCompatiblePayload(payload, { id: "gpt-6.2-sol", provider: "openai", api: "openai-responses" }, "cpa", () => "priority"),
    undefined,
  );
});

test("createCpaResponsesStreamSimple scopes rewrites to the actual request model and chains caller onPayload", async () => {
  const seen: Array<{ path: "stream" | "streamSimple"; payload: Record<string, unknown>; options: Record<string, unknown>; model: { provider: string; id: string; api: string } }> = [];
  let downstreamPayload: Record<string, unknown> | undefined;
  const fakeResponsesApi = {
    stream: (model: any, _context: any, options: any) => {
      const payload: Record<string, unknown> = {
        model: model.id,
        tools: [{ type: "function", name: "bash" }],
        ...(options.serviceTier !== undefined ? { service_tier: options.serviceTier } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoning: { effort: options.reasoningEffort } } : {}),
      };
      const promise = Promise.resolve(options.onPayload(payload, model)).then((finalPayload) => {
        seen.push({ path: "stream", payload: finalPayload, options, model });
      });
      return promise as any;
    },
    streamSimple: (model: any, _context: any, options: any) => {
      const payload = { model: model.id, tools: [{ type: "function", name: "bash" }] };
      const promise = Promise.resolve(options.onPayload(payload, model)).then((finalPayload) => {
        seen.push({ path: "streamSimple", payload: finalPayload, options, model });
      });
      return promise as any;
    },
  };

  const streamSimple = createCpaResponsesStreamSimple(
    "cpa",
    (model) => (model?.provider === "cpa" && model.id === "gpt-6.2-sol" ? "priority" : undefined),
    fakeResponsesApi as any,
  );

  // CPA Responses request receives strict: null + service_tier before caller onPayload runs.
  await (streamSimple(cpaResponsesModel as any, { messages: [] } as any, {
    reasoning: "high",
    onPayload: (payload) => {
      downstreamPayload = payload as Record<string, unknown>;
      return { ...(payload as Record<string, unknown>), touchedByCaller: true };
    },
  }) as unknown as Promise<void>);

  assert.equal(downstreamPayload?.service_tier, "priority");
  assert.equal((downstreamPayload?.tools as Array<Record<string, unknown>>)?.[0]?.strict, null);
  assert.equal(seen[0]?.path, "streamSimple");
  assert.equal(seen[0]?.payload.service_tier, "priority");
  assert.equal(seen[0]?.payload.touchedByCaller, true);

  // Full OpenAIResponsesOptions (`serviceTier: "default"`, `reasoningEffort`) use the full `stream` path
  // and must never be overwritten with the session's `/fast` tier.
  await (streamSimple(cpaResponsesModel as any, { messages: [] } as any, {
    serviceTier: "default",
    reasoningEffort: "low",
  } as any) as unknown as Promise<void>);
  assert.equal(seen[1]?.path, "stream");
  assert.equal(seen[1]?.payload.service_tier, "default");
  assert.deepEqual(seen[1]?.payload.reasoning, { effort: "low" });
  assert.equal((seen[1]?.payload.tools as Array<Record<string, unknown>>)?.[0]?.strict, null);

  // If a non-CPA model somehow reaches the wrapper, it is left completely untouched.
  const directCodex = { id: "gpt-6.2-sol", provider: "openai-codex", api: "openai-codex-responses" };
  await (streamSimple(directCodex as any, { messages: [] } as any, {}) as unknown as Promise<void>);
  assert.equal(seen[2]?.payload.service_tier, undefined);
  assert.equal((seen[2]?.payload.tools as Array<Record<string, unknown>>)?.[0]?.strict, undefined);
});
