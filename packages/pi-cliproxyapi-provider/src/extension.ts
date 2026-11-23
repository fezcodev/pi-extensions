import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { ProviderCatalog } from "./catalog.ts";
import { ProviderRuntime } from "./runtime.ts";
import { buildProviderRegistration } from "./registration.ts";
import { buildUnavailableProviderModels } from "./provider.ts";
import { registerCliproxyapiCommand } from "./commands.ts";
import { getDiscoveryApiKey } from "./auth.ts";
import { loadProviderSettings } from "./settings.ts";
import { createCpaResponsesStreamSimple } from "./codex-compat.ts";
import {
  registerServiceTierCommands,
  registerServiceTierLifecycle,
  ServiceTierController,
} from "./service-tier.ts";

export default async function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  let catalog: ProviderCatalog | undefined;
  const serviceTier = new ServiceTierController(() => catalog?.current()?.cpaModels);
  try {
    const cwd = process.cwd();
    config = loadConfig(cwd);
    const settings = loadProviderSettings(cwd);
    catalog = new ProviderCatalog({
      config,
      gpt56ContextWindow: settings.gpt56ContextWindow,
      perTurnEffort: settings.perTurnEffort,
      midConversationUpdates: settings.midConversationUpdates,
      messageThreads: settings.messageThreads,
      getApiKey: () => getDiscoveryApiKey(config.providerName),
    });
    const streamSimple = createCpaResponsesStreamSimple(
      config.providerName,
      (model, sessionId) => serviceTier.effectiveTierForRequest(model, config.providerName, sessionId),
    );
    const runtime = new ProviderRuntime({
      pi,
      config,
      catalog,
      streamSimple,
      onCatalogUpdated: () => serviceTier.syncActiveStatus(config.providerName),
    });
    registerServiceTierCommands(pi, config.providerName, serviceTier);
    registerServiceTierLifecycle(pi, config.providerName, serviceTier);
    registerCliproxyapiCommand(pi, runtime, catalog, serviceTier);
    await runtime.start();
  } catch (error) {
    registerServiceTierCommands(pi, config.providerName, serviceTier);
    registerServiceTierLifecycle(pi, config.providerName, serviceTier);
    registerCliproxyapiCommand(pi);
    pi.registerProvider(config.providerName, buildProviderRegistration(config, buildUnavailableProviderModels()).config);
    console.warn(`[pi-cliproxyapi-provider] registered placeholder provider after startup failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}
