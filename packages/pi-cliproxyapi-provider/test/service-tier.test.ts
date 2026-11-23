import assert from "node:assert/strict";
import test from "node:test";
import type { CpaModel } from "../src/cpa.ts";
import {
  registerServiceTierCommands,
  registerServiceTierLifecycle,
  SERVICE_TIER_STATUS_KEY,
  ServiceTierController,
} from "../src/service-tier.ts";

const sampleModels: CpaModel[] = [
  { id: "gpt-6.2-sol", owned_by: "openai", spec: { maxTokens: 128000, serviceTiers: ["priority", "ultrafast"] } },
  { id: "gpt-6.2-astra", owned_by: "openai", spec: { maxTokens: 128000, serviceTiers: ["priority"] } },
  { id: "claude-opus-5-5", owned_by: "anthropic", spec: { maxTokens: 128000 } },
  { id: "claude-opus-5-5-fast", owned_by: "anthropic" },
  { id: "devin/gpt-6-astra", owned_by: "openai", spec: { maxTokens: 64000 } },
];

function mockCtx(model: any, mode = "tui", hasUI = true) {
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  return {
    ctx: {
      hasUI,
      mode,
      model,
      ui: {
        theme: { fg: (color: string, text: string) => `[${color}:${text}]` },
        notify: (message: string, level: string) => notifications.push({ message, level }),
        setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      },
    } as any,
    notifications,
    statuses,
  };
}

test("resolves effective service_tier only for CPA Responses models advertising that tier", () => {
  const controller = new ServiceTierController(() => sampleModels);

  controller.setTier("priority");
  assert.equal(controller.effectiveTierFor({ id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" }, "cpa"), "priority");
  assert.equal(controller.effectiveTierFor({ id: "gpt-6.2-astra", provider: "cpa", api: "openai-responses" }, "cpa"), "priority");
  assert.equal(controller.effectiveTierFor({ id: "claude-opus-5-5", provider: "cpa", api: "anthropic-messages" }, "cpa"), undefined);
  assert.equal(controller.effectiveTierFor({ id: "claude-opus-5-5-fast", provider: "cpa", api: "anthropic-messages" }, "cpa"), undefined);
  assert.equal(controller.effectiveTierFor({ id: "devin/gpt-6-astra", provider: "cpa", api: "openai-responses" }, "cpa"), undefined);
  assert.equal(controller.effectiveTierFor({ id: "gpt-6.2-sol", provider: "openai", api: "openai-responses" }, "cpa"), undefined);

  controller.setTier("ultrafast");
  assert.equal(controller.effectiveTierFor({ id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" }, "cpa"), "ultrafast");
  assert.equal(controller.effectiveTierFor({ id: "gpt-6.2-astra", provider: "cpa", api: "openai-responses" }, "cpa"), undefined);
});

test("/fast and /ultrafast toggle session-only tiers, warn on unsupported models, and update TUI status", async () => {
  const commands = new Map<string, any>();
  const controller = new ServiceTierController(() => sampleModels);
  registerServiceTierCommands({
    registerCommand: (name: string, def: any) => commands.set(name, def),
  } as any, "cpa", controller);

  const sol = mockCtx({ id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" });
  await commands.get("fast").handler("", sol.ctx);
  assert.equal(controller.getTier(), "priority");
  assert.equal(sol.notifications.at(-1)?.level, "info");
  assert.deepEqual(sol.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: "[warning:fast]" });

  // Switch directly to ultrafast on gpt-6.2-sol.
  await commands.get("ultrafast").handler("", sol.ctx);
  assert.equal(controller.getTier(), "ultrafast");
  assert.equal(sol.notifications.at(-1)?.level, "info");
  assert.deepEqual(sol.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: "[warning:ultrafast]" });

  // Re-running /ultrafast turns it off.
  await commands.get("ultrafast").handler("", sol.ctx);
  assert.equal(controller.getTier(), undefined);
  assert.deepEqual(sol.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: undefined });

  // Enabling /ultrafast on a priority-only model warns and names the supported tier.
  const astra = mockCtx({ id: "gpt-6.2-astra", provider: "cpa", api: "openai-responses" });
  await commands.get("ultrafast").handler("", astra.ctx);
  assert.equal(astra.notifications.at(-1)?.level, "warning");
  assert.match(astra.notifications.at(-1)?.message ?? "", /only supports: priority/);
  assert.deepEqual(astra.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: undefined });

  // Enabling /fast on Claude warns and leaves Claude untouched.
  const claude = mockCtx({ id: "claude-opus-5-5-fast", provider: "cpa", api: "anthropic-messages" });
  await commands.get("fast").handler("", claude.ctx);
  assert.equal(claude.notifications.at(-1)?.level, "warning");
  assert.match(claude.notifications.at(-1)?.message ?? "", /does not advertise priority/);

  // Unexpected args fail cleanly without flipping state.
  await commands.get("fast").handler("extra", sol.ctx);
  assert.equal(sol.notifications.at(-1)?.level, "error");
  assert.equal(controller.getTier(), "priority");
});

test("lifecycle hooks reset session-only tier on start/shutdown and sync status on model switch", () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const controller = new ServiceTierController(() => sampleModels);
  registerServiceTierLifecycle({
    on: (event: string, fn: (...args: any[]) => void) => handlers.set(event, fn),
  } as any, "cpa", controller);

  controller.setTier("priority");
  const sol = mockCtx({ id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" });
  handlers.get("model_select")?.({ model: { id: "claude-opus-5-5", provider: "cpa", api: "anthropic-messages" } }, sol.ctx);
  assert.deepEqual(sol.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: undefined });

  handlers.get("model_select")?.({ model: { id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" } }, sol.ctx);
  assert.deepEqual(sol.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: "[warning:fast]" });

  // Non-TUI sessions never write status.
  const headless = mockCtx({ id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" }, "print", false);
  handlers.get("model_select")?.({ model: headless.ctx.model }, headless.ctx);
  assert.equal(headless.statuses.length, 0);

  // session_start resets tier so new/resumed sessions start standard.
  handlers.get("session_start")?.({}, sol.ctx);
  assert.equal(controller.getTier(), undefined);
  assert.deepEqual(sol.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: undefined });

  controller.setTier("ultrafast");
  handlers.get("session_shutdown")?.({}, sol.ctx);
  assert.equal(controller.getTier(), undefined);
});

test("syncActiveStatus updates the TUI badge when background discovery refreshes tier eligibility", async () => {
  let models: CpaModel[] = [{ id: "gpt-6.2-sol", owned_by: "openai" }];
  const handlers = new Map<string, (...args: any[]) => void>();
  const commands = new Map<string, any>();
  const controller = new ServiceTierController(() => models);
  registerServiceTierLifecycle({
    on: (event: string, fn: (...args: any[]) => void) => handlers.set(event, fn),
  } as any, "cpa", controller);
  registerServiceTierCommands({
    registerCommand: (name: string, def: any) => commands.set(name, def),
  } as any, "cpa", controller);

  const sol = mockCtx({ id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" });
  handlers.get("session_start")?.({}, sol.ctx);

  // User enables /fast before specs arrive: badge stays cleared.
  await commands.get("fast").handler("", sol.ctx);
  assert.deepEqual(sol.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: undefined });

  // Background discovery finishes and populates serviceTiers without a model switch.
  models = [{ id: "gpt-6.2-sol", owned_by: "openai", spec: { maxTokens: 128000, serviceTiers: ["priority"] } }];
  controller.syncActiveStatus("cpa");
  assert.deepEqual(sol.statuses.at(-1), { key: SERVICE_TIER_STATUS_KEY, value: "[warning:fast]" });
});

test("effectiveTierForRequest applies only to the active conversation session id", () => {
  const controller = new ServiceTierController(() => sampleModels);
  const solModel = { id: "gpt-6.2-sol", provider: "cpa", api: "openai-responses" };
  const ctx = {
    ...mockCtx(solModel).ctx,
    sessionManager: { getSessionId: () => "main-session-1" },
  } as any;
  controller.attach(ctx, "cpa");
  controller.setTier("priority");

  assert.equal(controller.effectiveTierForRequest(solModel, "cpa", "main-session-1"), "priority");
  assert.equal(controller.effectiveTierForRequest(solModel, "cpa", "guardian-reviewer-session"), undefined);
  assert.equal(controller.effectiveTierForRequest(solModel, "cpa", undefined), undefined);

  controller.detach();
  assert.equal(controller.effectiveTierForRequest(solModel, "cpa", "main-session-1"), undefined);
});
