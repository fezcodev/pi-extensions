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

function hasFullResponsesOptions(options: unknown): boolean {
  if (!isRecord(options) || options.reasoning !== undefined) return false;
  return options.reasoningEffort !== undefined
    || options.reasoningSummary !== undefined
    || options.serviceTier !== undefined;
}

/**
 * Provider-scoped OpenAI Responses stream wrapper for CLIProxyAPI models.
 * Runs against the actual request model (`payloadModel`) rather than the
 * currently selected UI model, so concurrent requests on other providers are
 * never rewritten. Preserves both full `stream()` options (`reasoningEffort`,
 * `reasoningSummary`, `serviceTier`) and `streamSimple()` options.
 */
export function createCpaResponsesStreamSimple(
  providerName: string,
  resolveServiceTier?: (
    model: ServiceTierModelRef | null | undefined,
    sessionId: string | undefined,
  ) => ServiceTier | undefined,
  responsesApi: Pick<ProviderStreams, "stream" | "streamSimple"> = openAIResponsesApi(),
): NonNullable<ProviderConfig["streamSimple"]> {
  return (model, context, options) => {
    const baseOnPayload = options?.onPayload;
    const explicitServiceTier = isRecord(options) && options.serviceTier !== undefined;
    const requestSessionId = typeof options?.sessionId === "string" ? options.sessionId : undefined;
    const tierResolver = explicitServiceTier || !resolveServiceTier
      ? undefined
      : (targetModel: ServiceTierModelRef | null | undefined) => resolveServiceTier(targetModel, requestSessionId);
    const wrappedOptions = {
      ...options,
      onPayload: async (payload: unknown, payloadModel: typeof model) => {
        const rewritten = rewriteCodexCompatiblePayload(payload, payloadModel, providerName, tierResolver);
        const next = rewritten ?? payload;
        if (!baseOnPayload) return next;
        return (await baseOnPayload(next, payloadModel)) ?? next;
      },
    };
    if (hasFullResponsesOptions(options)) {
      return responsesApi.stream(model, context, wrappedOptions);
    }
    return responsesApi.streamSimple(model, context, wrappedOptions);
  };
}
