import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CpaModel } from "./cpa.ts";

export type ServiceTier = "priority" | "ultrafast";

export const SERVICE_TIER_STATUS_KEY = "cpa-service-tier";

export type ServiceTierModelRef = Pick<NonNullable<ExtensionContext["model"]>, "id" | "provider" | "api">;

function isCpaResponsesModel(
  model: ServiceTierModelRef | null | undefined,
  providerName: string,
): model is ServiceTierModelRef {
  return model?.provider.trim().toLowerCase() === providerName.trim().toLowerCase()
    && model.api.toLowerCase().includes("responses");
}

function tierLabel(tier: ServiceTier): string {
  return tier === "ultrafast" ? "Ultra Fast" : "Fast";
}

function tierBadge(tier: ServiceTier): string {
  return tier === "ultrafast" ? "ultrafast" : "fast";
}

/**
 * Session-only `service_tier` selection for CLIProxyAPI Codex models.
 *
 * Eligibility comes directly from CPA's `/v1/models?client_version=` catalog:
 * CPA sets `service_tiers: []` for non-Codex routes (Claude, Devin, Gemini,
 * Grok), so only pure-Codex models that advertise a tier ever receive
 * `service_tier`. Separate Claude fast aliases (such as `claude-opus-5-5-fast`)
 * are never affected.
 */
export class ServiceTierController {
  private tier: ServiceTier | undefined;
  private activeCtx: ExtensionContext | undefined;
  private activeProviderName: string | undefined;
  private activeSessionId: string | undefined;
  private readonly getCpaModels: () => readonly CpaModel[] | undefined;

  constructor(getCpaModels: () => readonly CpaModel[] | undefined) {
    this.getCpaModels = getCpaModels;
  }

  attach(ctx: ExtensionContext, providerName: string): void {
    this.activeCtx = ctx;
    this.activeProviderName = providerName;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (typeof sessionId === "string" && sessionId.length > 0) {
      this.activeSessionId = sessionId;
    }
  }

  detach(): void {
    this.activeCtx = undefined;
    this.activeProviderName = undefined;
    this.activeSessionId = undefined;
  }

  getTier(): ServiceTier | undefined {
    return this.tier;
  }

  setTier(tier: ServiceTier | undefined): void {
    this.tier = tier;
  }

  toggle(selected: ServiceTier): ServiceTier | undefined {
    this.tier = this.tier === selected ? undefined : selected;
    return this.tier;
  }

  reset(): void {
    this.tier = undefined;
  }

  supportedTiersFor(modelId: string): readonly string[] {
    const entry = this.getCpaModels()?.find((model) => model.id === modelId);
    return entry?.spec?.serviceTiers ?? [];
  }

  effectiveTierFor(
    model: ServiceTierModelRef | null | undefined,
    providerName: string,
  ): ServiceTier | undefined {
    if (!this.tier || !isCpaResponsesModel(model, providerName)) return undefined;
    return this.supportedTiersFor(model.id).includes(this.tier) ? this.tier : undefined;
  }

  effectiveTierForRequest(
    model: ServiceTierModelRef | null | undefined,
    providerName: string,
    requestSessionId: string | undefined,
  ): ServiceTier | undefined {
    if (!this.activeSessionId || requestSessionId !== this.activeSessionId) return undefined;
    return this.effectiveTierFor(model, providerName);
  }

  syncStatus(
    ctx: ExtensionContext,
    providerName: string,
    model: ServiceTierModelRef | null | undefined = ctx.model,
  ): void {
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const effective = this.effectiveTierFor(model, providerName);
    ctx.ui.setStatus(
      SERVICE_TIER_STATUS_KEY,
      effective ? ctx.ui.theme.fg("warning", tierBadge(effective)) : undefined,
    );
  }

  syncActiveStatus(providerName?: string): void {
    const ctx = this.activeCtx;
    const targetProvider = providerName ?? this.activeProviderName;
    if (!ctx || !targetProvider) return;
    try {
      this.syncStatus(ctx, targetProvider);
    } catch {
      this.detach();
    }
  }
}

export function registerServiceTierCommands(
  pi: ExtensionAPI,
  providerName: string,
  controller: ServiceTierController,
): void {
  const register = (commandName: "fast" | "ultrafast", selected: ServiceTier) => {
    const label = tierLabel(selected);
    pi.registerCommand(commandName, {
      description: `Toggle CLIProxyAPI ${label} mode (service_tier: ${selected}) for this session.`,
      async handler(args, ctx) {
        if (args.trim()) {
          ctx.ui.notify(`Usage: /${commandName}`, "error");
          return;
        }

        controller.attach(ctx, providerName);
        const next = controller.toggle(selected);
        controller.syncStatus(ctx, providerName);

        if (!next) {
          ctx.ui.notify(`${label} mode disabled for this session.`, "info");
          return;
        }

        const current = ctx.model;
        if (controller.effectiveTierFor(current, providerName) === next) {
          ctx.ui.notify(`${label} mode enabled (service_tier: ${next}) for this session.`, "info");
          return;
        }

        if (current && isCpaResponsesModel(current, providerName)) {
          const supported = controller.supportedTiersFor(current.id);
          if (supported.length > 0) {
            ctx.ui.notify(
              `${label} mode enabled for this session, but ${current.id} only supports: ${supported.join(", ")}.`,
              "warning",
            );
            return;
          }
        }

        ctx.ui.notify(
          `${label} mode enabled for this session, but the current model does not advertise ${next} service_tier support.`,
          "warning",
        );
      },
    });
  };

  register("fast", "priority");
  register("ultrafast", "ultrafast");
}

export function registerServiceTierLifecycle(
  pi: ExtensionAPI,
  providerName: string,
  controller: ServiceTierController,
): void {
  pi.on("session_start", (_event, ctx) => {
    controller.attach(ctx, providerName);
    controller.reset();
    controller.syncStatus(ctx, providerName);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    controller.reset();
    controller.syncStatus(ctx, providerName);
    controller.detach();
  });

  pi.on("model_select", (event, ctx) => {
    controller.attach(ctx, providerName);
    controller.syncStatus(ctx, providerName, event.model ?? ctx.model);
  });
}
