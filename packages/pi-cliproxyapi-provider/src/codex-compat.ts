import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import type { ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { ServiceTier, ServiceTierModelRef } from "./service-tier.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponsesModel(
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "api"> | null | undefined,
  providerName: string,
): boolean {
  return model?.provider.trim().toLowerCase() === providerName.trim().toLowerCase()
    && model.api.toLowerCase().includes("responses");
}

/**
 * Match the Codex-compatible Responses wire contract used by
 * pi-codex-conversion: function tools explicitly publish `strict: null`.
 * Generic OpenAI Responses omits the field when strict mode is unsupported,
 * which does not preserve optional argument behavior for Codex-like models.
 */
export function rewriteCodexCompatibleToolPayload(
  payload: unknown,
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "api"> | null | undefined,
  providerName: string,
): unknown | undefined {
  if (!isResponsesModel(model, providerName) || !isRecord(payload) || !Array.isArray(payload.tools)) {
    return undefined;
  }

  let changed = false;
  const tools = payload.tools.map((tool) => {
    if (!isRecord(tool) || tool.type !== "function" || tool.strict === null) return tool;
    changed = true;
    return { ...tool, strict: null };
  });

  return changed ? { ...payload, tools } : undefined;
}

/**
 * Apply Codex-compatible Responses payload rewrites: `strict: null` on function
 * tools and optional session `service_tier` injection when the payload has not
 * already specified one.
 */
export function rewriteCodexCompatiblePayload(
  payload: unknown,
  model: ServiceTierModelRef | null | undefined,
  providerName: string,
  resolveServiceTier?: (model: ServiceTierModelRef | null | undefined) => ServiceTier | undefined,
): unknown | undefined {
  if (!isResponsesModel(model, providerName) || !isRecord(payload)) {
    return undefined;
  }

  const rewrittenTools = rewriteCodexCompatibleToolPayload(payload, model, providerName);
  const base = (rewrittenTools ?? payload) as Record<string, unknown>;
  const tier = base.service_tier === undefined ? resolveServiceTier?.(model) : undefined;

  if (tier !== undefined) {
    return { ...base, service_tier: tier };
  }
  return rewrittenTools;
}

/**
 * Provider-scoped OpenAI Responses stream wrapper for CLIProxyAPI models.
 * Runs against the actual request model (`payloadModel`) rather than the
 * currently selected UI model, so concurrent requests on other providers are
 * never rewritten.
 */
export function createCpaResponsesStreamSimple(
  providerName: string,
  resolveServiceTier?: (model: ServiceTierModelRef | null | undefined) => ServiceTier | undefined,
  responsesApi: Pick<ProviderStreams, "streamSimple"> = openAIResponsesApi(),
): NonNullable<ProviderConfig["streamSimple"]> {
  return (model, context, options) => {
    const baseOnPayload = options?.onPayload;
    return responsesApi.streamSimple(model, context, {
      ...options,
      onPayload: async (payload, payloadModel) => {
        const rewritten = rewriteCodexCompatiblePayload(payload, payloadModel, providerName, resolveServiceTier);
        const next = rewritten ?? payload;
        if (!baseOnPayload) return next;
        return (await baseOnPayload(next, payloadModel)) ?? next;
      },
    });
  };
}
