import assert from "node:assert/strict";
import test from "node:test";
import { rewriteCodexCompatiblePayload, rewriteCodexCompatibleToolPayload } from "../src/codex-compat.ts";

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
