import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ProviderCatalog } from "../src/catalog.ts";
import { cpaModelsCachePath, modelsDevCachePath } from "../src/discovery.ts";
import { withCacheLock, writeCache } from "../src/cache.ts";
import type { CpaProviderConfig } from "../src/types.ts";

const config: CpaProviderConfig = {
  providerName: "cpa-catalog-test",
  baseUrl: "http://cliproxyapi.test/v1",
  authRequired: false,
  authHeader: false,
  headers: {},
  modelsDevEnabled: true,
  metadataFallbackProvider: "openrouter",
  modelAliases: {},
  modelOverrides: {},
};

// Each test gets its own cache tree under the hermetic preload's scratch HOME,
// and HOME is put back so the next test never inherits a deleted directory.
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const scratchHome = process.env.HOME!;
  const home = await mkdtemp(join(scratchHome, "pi-cpa-catalog-"));
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = scratchHome;
    await rm(home, { recursive: true, force: true });
  }
}

function catalog(): ProviderCatalog {
  return new ProviderCatalog({
    config,
    gpt56ContextWindow: "canonical",
    getApiKey: async () => undefined,
    backgroundTimeoutMs: 50,
  });
}

test("catalog load ignores malformed source snapshots", async () => {
  await withTempHome(async () => {
    const path = cpaModelsCachePath(config);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ fetchedAt: Date.now(), data: { id: "not-an-array" } }));

    const snapshot = await catalog().load();

    assert.deepEqual(snapshot.cpaModels, []);
    assert.equal(snapshot.built.stats.total, 0);
  });
});

test("catalog load is cache-first and performs no network request", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }], 1234);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network should not run"); }) as typeof fetch;
    try {
      const snapshot = await catalog().load();
      assert.deepEqual(snapshot.cpaModels.map((model) => model.id), ["cached"]);
      assert.equal(snapshot.cpaUpdatedAt, 1234);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("seeds provider-qualified metadata from pi's built-in catalog on a first run", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "claude-fable-5", owned_by: "anthropic" }]);

    const snapshot = await catalog().load();

    assert.equal(snapshot.metadataSource, "builtin");
    // Expectations come from the installed pi-ai so a catalog refresh in a
    // newer pi cannot fail this test on a price change.
    const pinned = getBuiltinModels("anthropic").find((model) => model.id === "claude-fable-5");
    assert.ok(pinned, "pi-ai's catalog should still ship claude-fable-5");
    const seeded = snapshot.metadata["anthropic/claude-fable-5"];
    assert.equal(seeded.sourceProvider, "anthropic");
    assert.equal(seeded.cost?.input, pinned.cost.input);
    assert.deepEqual(seeded.thinkingLevelMap, pinned.thinkingLevelMap);
    assert.equal(seeded.thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(snapshot.built.models[0].name, pinned.name);
    assert.equal(snapshot.built.models[0].thinkingLevelMap?.xhigh, "xhigh");
    assert.equal(snapshot.built.stats.matchMethods["owner-prefix"], 1);
  });
});

test("ignores legacy flat metadata caches and falls back to the built-in seed", async () => {
  await withTempHome(async () => {
    await writeCache(modelsDevCachePath(), {
      "anthropic/claude-fable-5": { id: "anthropic/claude-fable-5", name: "Legacy Fable", reasoning: true },
    }, 1234);
    await writeCache(cpaModelsCachePath(config), [{ id: "claude-fable-5", owned_by: "anthropic" }]);

    const snapshot = await catalog().load();

    assert.equal(snapshot.metadataSource, "builtin");
    assert.notEqual(snapshot.metadataUpdatedAt, 1234);
    assert.equal(snapshot.built.models[0].name, "Claude Fable 5");
  });
});

test("metadata comparison ignores object key order", async () => {
  await withTempHome(async () => {
    await writeCache(modelsDevCachePath(), {
      "openai/fresh": { id: "openai/fresh", sourceProvider: "openai", reasoning: true, name: "Fresh" },
    }, 1234);
    const instance = catalog();
    assert.equal((await instance.load()).metadataSource, "cache");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), "https://models.dev/api.json");
      return new Response(JSON.stringify({
        openai: { models: { fresh: { reasoning: true, name: "Fresh", id: "fresh" } } },
      }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("metadata", "manual");
      assert.equal(result.metadata.updated, true);
      assert.equal(result.metadata.changed, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("background refresh updates CPA models while retaining metadata", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.equal(String(url), "http://cliproxyapi.test/v1/models");
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("models", "background");
      assert.equal(result.models.updated, true);
      assert.equal(result.models.changed, true);
      assert.equal(result.models.retainedStaleCount, 1);
      assert.deepEqual(result.snapshot.cpaModels.map((model) => model.id), ["cached", "gpt-5.6-luna"]);
      assert.equal(result.snapshot.built.stats.stale, 1);
      // Metadata is still the built-in seed, which is what marks this model reasoning.
      const luna = result.snapshot.built.models.find((model) => model.id === "gpt-5.6-luna");
      assert.equal(luna?.reasoning, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("snapshot write failure preserves the in-memory CPA snapshot", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    const instance = new ProviderCatalog({
      config,
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
      writeSnapshot: async () => { throw new Error("disk full"); },
    });
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: "fresh" }] }), { status: 200 })) as typeof fetch;
    try {
      const result = await instance.refresh("models", "manual");
      assert.match(String(result.models.error), /disk full/);
      assert.equal(result.models.updated, false);
      assert.deepEqual(result.snapshot.cpaModels.map((model) => model.id), ["cached"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("failed background refresh preserves the last-known-good CPA snapshot", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    try {
      const result = await instance.refresh("models", "background");
      assert.match(String(result.models.error), /offline/);
      assert.deepEqual(result.snapshot.cpaModels.map((model) => model.id), ["cached"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("refresh deduplicates concurrent requests", async () => {
  await withTempHome(async () => {
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (!String(url).includes("client_version")) fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({ data: [{ id: "fresh" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const keyFn = async () => "runtime-key";
      await Promise.all([
        instance.refresh("models", "background", keyFn, new AbortController().signal),
        instance.refresh("models", "background", keyFn, new AbortController().signal),
      ]);
      assert.equal(fetches, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("deduplicated callers can abort without cancelling the shared refresh", async () => {
  await withTempHome(async () => {
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (!String(url).includes("client_version")) fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ data: [{ id: "fresh" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const firstController = new AbortController();
      const secondController = new AbortController();
      const reason = new Error("second caller cancelled");
      const keyFn = async () => "runtime-key";
      const first = instance.refresh("models", "background", keyFn, firstController.signal);
      const second = instance.refresh("models", "background", keyFn, secondController.signal);
      secondController.abort(reason);

      await assert.rejects(second, (error) => error === reason);
      const result = await first;
      assert.equal(result.models.updated, true);
      assert.equal(fetches, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("refresh propagates the initiating caller's cancellation reason", async () => {
  await withTempHome(async () => {
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    }) as typeof fetch;
    try {
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const refresh = instance.refresh("models", "manual", async () => undefined, controller.signal);
      controller.abort(reason);

      await assert.rejects(refresh, (error) => error === reason);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function catalogWithClock(now: () => number, staleAfterMs = 1_000): ProviderCatalog {
  return new ProviderCatalog({
    config,
    gpt56ContextWindow: "canonical",
    getApiKey: async () => undefined,
    backgroundTimeoutMs: 50,
    metadataStaleAfterMs: staleAfterMs,
    now,
  });
}

const modelsDevPayload = {
  openai: {
    models: {
      "gpt-5.6-luna": { id: "gpt-5.6-luna", name: "Fresh from models.dev", reasoning: true, limit: { context: 400000, output: 64000 } },
    },
  },
};

test("metadata is stale when only the built-in seed is loaded", async () => {
  await withTempHome(async () => {
    const instance = catalog();
    const snapshot = await instance.load();
    assert.equal(snapshot.metadataSource, "builtin");
    assert.equal(instance.metadataIsStale(snapshot), true);
  });
});

test("metadata is fresh inside the threshold and stale past it", async () => {
  await withTempHome(async () => {
    let now = 100_000;
    await writeCache(modelsDevCachePath(), { "openai/fresh": { id: "openai/fresh", sourceProvider: "openai" } }, now);
    const instance = catalogWithClock(() => now, 1_000);
    const snapshot = await instance.load();
    assert.equal(snapshot.metadataSource, "cache");

    now = 100_999;
    assert.equal(instance.metadataIsStale(snapshot), false);
    now = 101_000;
    assert.equal(instance.metadataIsStale(snapshot), true);
  });
});

test("metadata is never stale when models.dev is disabled", async () => {
  await withTempHome(async () => {
    const instance = new ProviderCatalog({
      config: { ...config, modelsDevEnabled: false },
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
    });
    const snapshot = await instance.load();
    assert.equal(snapshot.metadataSource, "disabled");
    assert.equal(instance.metadataIsStale(snapshot), false);
  });
});

test("models-if-stale skips models.dev when the metadata snapshot is fresh", async () => {
  await withTempHome(async () => {
    const now = 100_000;
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    await writeCache(modelsDevCachePath(), { "openai/fresh": { id: "openai/fresh", sourceProvider: "openai" } }, now);
    const instance = catalogWithClock(() => now);
    await instance.load();
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "fresh", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("models-if-stale", "background");
      assert.equal(result.models.updated, true);
      assert.equal(result.metadata.attempted, false);
      assert.deepEqual(urls.sort(), ["http://cliproxyapi.test/v1/models", "http://cliproxyapi.test/v1/models?client_version="]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("models-if-stale fetches models.dev when the snapshot is the built-in seed or stale", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "gpt-5.6-luna", owned_by: "openai" }]);
    const instance = catalog();
    const before = await instance.load();
    assert.equal(before.metadataSource, "builtin");
    assert.equal(before.built.models[0].name, "GPT-5.6 Luna");
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("models.dev")) return new Response(JSON.stringify(modelsDevPayload), { status: 200 });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("models-if-stale", "background");
      assert.equal(result.metadata.attempted, true);
      assert.equal(result.metadata.updated, true);
      assert.equal(result.snapshot.metadataSource, "cache");
      assert.equal(result.snapshot.built.models[0].name, "Fresh from models.dev");
      assert.equal(result.snapshot.built.models[0].maxTokens, 64000);
      assert.deepEqual(urls.sort(), [
        "http://cliproxyapi.test/v1/models",
        "http://cliproxyapi.test/v1/models?client_version=",
        "https://models.dev/api.json",
      ]);
      // The refreshed snapshot is no longer stale, so the next routine refresh skips it.
      assert.equal(instance.metadataIsStale(result.snapshot), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a failed stale-metadata fetch keeps the previous metadata and still publishes CPA models", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "cached", owned_by: "openai" }]);
    const instance = catalog();
    await instance.load();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("models.dev")) return new Response("upstream down", { status: 503 });
      return new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await instance.refresh("models-if-stale", "background");
      assert.equal(result.models.updated, true);
      assert.deepEqual(result.snapshot.cpaModels.map((model) => model.id), ["cached", "gpt-5.6-luna"]);
      assert.equal(result.metadata.attempted, true);
      assert.equal(result.metadata.updated, false);
      assert.ok(result.metadata.error);
      assert.equal(result.snapshot.metadataSource, "builtin");
      const luna = result.snapshot.built.models.find((model) => model.id === "gpt-5.6-luna");
      assert.equal(luna?.name, "GPT-5.6 Luna");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("catalog builds models with the injected pi profiles", async () => {
  await withTempHome(async () => {
    await writeCache(cpaModelsCachePath(config), [{ id: "claude-opus-5-5" }, { id: "gpt-5.5" }], Date.now());
    let loads = 0;
    const instance = new ProviderCatalog({
      config: { ...config, modelsDevEnabled: false },
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
      backgroundTimeoutMs: 50,
      loadPiProfiles: async () => {
        loads += 1;
        return {
          find: (upstream, context) => upstream === "anthropic" && context.availableModelId === "claude-opus-5-5"
            ? { reasoning: true, supportsMidConvoEffort: true }
            : upstream === "openai-codex" && context.availableModelId === "gpt-5.5"
              ? { reasoning: true }
              : undefined,
        };
      },
    });

    const snapshot = await instance.load();
    await instance.load();
    const byId = Object.fromEntries(snapshot.built.models.map((model) => [model.id, model]));

    assert.equal(loads, 1, "profiles are static per process");
    assert.deepEqual(byId["claude-opus-5-5"].compat, { supportsMidConvoEffort: true });
    assert.equal(byId["gpt-5.5"].api, "openai-responses");
    assert.equal(snapshot.perTurnEffort, true, "on by default");
    assert.equal(snapshot.midConversationUpdates, true, "on by default");
    assert.equal(snapshot.messageThreads, false, "opt-in");

    const flipped = await new ProviderCatalog({
      config: { ...config, modelsDevEnabled: false },
      gpt56ContextWindow: "canonical",
      perTurnEffort: false,
      midConversationUpdates: false,
      messageThreads: true,
      getApiKey: async () => undefined,
      backgroundTimeoutMs: 50,
      loadPiProfiles: async () => ({ find: (upstream) => upstream === "anthropic" ? { reasoning: true, supportsMidConvoEffort: true } : undefined }),
    }).load();
    assert.equal(flipped.perTurnEffort, false);
    assert.equal(flipped.midConversationUpdates, false);
    assert.equal(flipped.messageThreads, true);
    assert.deepEqual(flipped.built.models.find((model) => model.id === "claude-opus-5-5")?.compat, { supportsMessageThreads: true });
  });
});

test("background refresh retains missing models until TTL expires and manual refresh clears them", async () => {
  await withTempHome(async () => {
    let now = 1_000_000;
    const ttl = 10_000;
    await writeCache(cpaModelsCachePath(config), [
      { id: "transient-model", owned_by: "openai", spec: { maxTokens: 64000, serviceTiers: ["priority"] } },
      { id: "steady-model", owned_by: "openai" },
    ], now);

    const instance = new ProviderCatalog({
      config: { ...config, modelsDevEnabled: false },
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
      backgroundTimeoutMs: 50,
      staleModelTtlMs: ttl,
      now: () => now,
    });
    await instance.load();

    let remoteIds = ["steady-model"];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("client_version")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: remoteIds.map((id) => ({ id, owned_by: "openai" })),
      }), { status: 200 });
    }) as typeof fetch;

    try {
      // Blip at t+1000: transient-model disappears, kept as stale with its spec intact.
      now += 1_000;
      const blip = await instance.refresh("models", "background");
      assert.equal(blip.models.changed, true);
      assert.equal(blip.models.retainedStaleCount, 1);
      assert.equal(blip.snapshot.built.stats.stale, 1);
      const retained = blip.snapshot.cpaModels.find((m) => m.id === "transient-model");
      assert.equal(retained?.staleSince, now);
      assert.equal(retained?.spec?.maxTokens, 64000);

      // Still missing at t+5000: unchanged normalized snapshot reports changed=false.
      now += 4_000;
      const stillMissing = await instance.refresh("models", "background");
      assert.equal(stillMissing.models.changed, false);
      assert.equal(stillMissing.models.retainedStaleCount, 1);

      // Reappears at t+6000: staleSince clears.
      now += 1_000;
      remoteIds = ["steady-model", "transient-model"];
      const recovered = await instance.refresh("models", "background");
      assert.equal(recovered.models.changed, true);
      assert.equal(recovered.models.retainedStaleCount, undefined);
      assert.equal(recovered.snapshot.built.stats.stale, 0);
      assert.equal(recovered.snapshot.cpaModels.find((m) => m.id === "transient-model")?.staleSince, undefined);

      // Disappears again at t+7000, then expires past TTL at t+17000.
      now += 1_000;
      remoteIds = ["steady-model"];
      await instance.refresh("models", "background");
      now += ttl;
      const expired = await instance.refresh("models", "background");
      assert.deepEqual(expired.snapshot.cpaModels.map((m) => m.id), ["steady-model"]);
      assert.equal(expired.snapshot.built.stats.stale, 0);

      // Manual refresh immediately clears stale models without waiting for TTL.
      remoteIds = ["steady-model", "transient-model"];
      await instance.refresh("models", "background");
      now += 1_000;
      remoteIds = ["steady-model"];
      await instance.refresh("models", "background");
      assert.equal(instance.current()?.built.stats.stale, 1);
      const manual = await instance.refresh("models", "manual");
      assert.deepEqual(manual.snapshot.cpaModels.map((m) => m.id), ["steady-model"]);
      assert.equal(manual.snapshot.built.stats.stale, 0);

      // A valid empty HTTP 200 list also flows through bounded stale retention and expires after TTL.
      remoteIds = [];
      now += 1_000;
      const emptyBlip = await instance.refresh("models", "background");
      assert.equal(emptyBlip.models.error, undefined);
      assert.equal(emptyBlip.models.updated, true);
      assert.equal(emptyBlip.models.retainedStaleCount, 1);
      assert.equal(emptyBlip.snapshot.built.stats.stale, 1);
      now += ttl;
      const emptyExpired = await instance.refresh("models", "background");
      assert.deepEqual(emptyExpired.snapshot.cpaModels, []);
      assert.equal(emptyExpired.snapshot.built.stats.stale, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("background refresh merges against latest on-disk cache so another session cannot resurrect a manually removed model", async () => {
  await withTempHome(async () => {
    let now = 2_000_000;
    const ttl = 60_000;
    await writeCache(cpaModelsCachePath(config), [
      { id: "steady-model", owned_by: "openai", lastSeenAt: now },
      { id: "removed-model", owned_by: "openai", lastSeenAt: now },
    ], now);

    const sessionA = new ProviderCatalog({
      config,
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
      staleModelTtlMs: ttl,
      now: () => now,
    });
    const sessionB = new ProviderCatalog({
      config,
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
      staleModelTtlMs: ttl,
      now: () => now,
    });
    await sessionA.load();
    await sessionB.load();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("client_version")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "steady-model", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;

    try {
      now += 1_000;
      // Session A manually clears removed-model from disk.
      const manual = await sessionA.refresh("models", "manual");
      assert.deepEqual(manual.snapshot.cpaModels.map((m) => m.id), ["steady-model"]);

      // Session B still had removed-model in memory; its background refresh reads
      // the latest disk cache and must not write removed-model back as stale.
      now += 1_000;
      const bg = await sessionB.refresh("models", "background");
      assert.deepEqual(bg.snapshot.cpaModels.map((m) => m.id), ["steady-model"]);
      assert.equal(bg.models.retainedStaleCount, undefined);
      assert.equal(bg.models.changed, true);

      // A brand-new Session C sees only steady-model on disk.
      const sessionC = new ProviderCatalog({
        config,
        gpt56ContextWindow: "canonical",
        getApiKey: async () => undefined,
      });
      const loadedC = await sessionC.load();
      assert.deepEqual(loadedC.cpaModels.map((m) => m.id), ["steady-model"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("in-flight background discovery that predates a newer committed snapshot adopts the newer disk cache instead of overwriting", async () => {
  await withTempHome(async () => {
    let now = 3_000_000;
    const ttl = 60_000;
    await writeCache(cpaModelsCachePath(config), [
      { id: "steady-model", owned_by: "openai", lastSeenAt: now },
      { id: "removed-model", owned_by: "openai", lastSeenAt: now },
    ], now);

    const sessionA = new ProviderCatalog({
      config,
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
      staleModelTtlMs: ttl,
      now: () => now,
    });
    const sessionB = new ProviderCatalog({
      config,
      gpt56ContextWindow: "canonical",
      getApiKey: async () => undefined,
      staleModelTtlMs: ttl,
      now: () => now,
    });
    await sessionA.load();
    await sessionB.load();

    let releaseSlowSpecs!: () => void;
    let slowSpecsStarted!: () => void;
    const slowSpecsReady = new Promise<void>((resolve) => { slowSpecsStarted = resolve; });
    const slowSpecsGate = new Promise<void>((resolve) => { releaseSlowSpecs = resolve; });
    let phase: "slow-bg" | "manual" = "slow-bg";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (phase === "slow-bg") {
        if (target.includes("client_version")) {
          slowSpecsStarted();
          await slowSpecsGate;
          return new Response(JSON.stringify({ models: [] }), { status: 200 });
        }
        // Background refresh saw removed-model before manual refresh cleared it.
        return new Response(JSON.stringify({
          data: [
            { id: "steady-model", owned_by: "openai" },
            { id: "removed-model", owned_by: "openai" },
          ],
        }), { status: 200 });
      }
      if (target.includes("client_version")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "steady-model", owned_by: "openai" }] }), { status: 200 });
    }) as typeof fetch;

    try {
      now += 1_000;
      const slowBgPromise = sessionB.refresh("models", "background");
      await slowSpecsReady;

      // While sessionB is waiting on slow specs, sessionA manually removes removed-model at a later timestamp.
      phase = "manual";
      now += 500;
      const manual = await sessionA.refresh("models", "manual");
      assert.deepEqual(manual.snapshot.cpaModels.map((m) => m.id), ["steady-model"]);

      // Now sessionB's slower background discovery finishes; it must adopt sessionA's newer commit.
      now += 500;
      releaseSlowSpecs();
      const slowBg = await slowBgPromise;
      assert.deepEqual(slowBg.snapshot.cpaModels.map((m) => m.id), ["steady-model"]);

      const sessionC = new ProviderCatalog({
        config,
        gpt56ContextWindow: "canonical",
        getApiKey: async () => undefined,
      });
      const loadedC = await sessionC.load();
      assert.deepEqual(loadedC.cpaModels.map((m) => m.id), ["steady-model"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("withCacheLock refuses unlocked writes on timeout and releases its in-process gate after errors", async () => {
  await withTempHome(async () => {
    const cachePath = cpaModelsCachePath(config);
    const lockPath = `${cachePath}.lock`;
    await writeCache(cachePath, [{ id: "existing" }], 100);
    await writeFile(lockPath, "foreign-owner", "utf8");

    let ran = false;
    await assert.rejects(
      () => withCacheLock(cachePath, async () => { ran = true; }, { timeoutMs: 40, retryMs: 10, staleMs: 60_000 }),
      /Timed out waiting for cache lock/,
    );
    assert.equal(ran, false);

    // Once the foreign lock clears, the next caller must not hang on a wedged in-process gate.
    await rm(lockPath, { force: true });
    const result = await withCacheLock(cachePath, async () => "ok", { timeoutMs: 200, retryMs: 10 });
    assert.equal(result, "ok");

    // A lock owned by a live PID is never stolen even past staleMs.
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "live-owner" }), "utf8");
    await assert.rejects(
      () => withCacheLock(cachePath, async () => "stolen", { timeoutMs: 40, retryMs: 10, staleMs: 0 }),
      /Timed out waiting for cache lock/,
    );
    await rm(lockPath, { force: true });

    // A dead PID lock is reclaimed cleanly.
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }), "utf8");
    const reclaimed = await withCacheLock(cachePath, async (assertLockHeld) => {
      await assertLockHeld();
      // If ownership is lost externally before commit, the fence rejects.
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "someone-else" }), "utf8");
      await assert.rejects(() => assertLockHeld(), /Lost cache lock ownership/);
      return "reclaimed";
    }, { timeoutMs: 200, retryMs: 10, staleMs: 60_000 });
    assert.equal(reclaimed, "reclaimed");
    await rm(lockPath, { force: true });
  });
});
