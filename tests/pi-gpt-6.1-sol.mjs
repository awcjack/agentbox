// Offline test against packaged Pi. Sources: https://pi.dev/api/models/providers/openai
// and https://pi.dev/api/models/providers/openai-codex. All state is isolated.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = process.argv[2];
assert.ok(root, "usage: node tests/pi-gpt-6.1-sol.mjs <pi package directory>");
const load = (path) => import(pathToFileURL(`${root}/${path}`));
const directory = await mkdtemp(join(tmpdir(), "pi-sol-"));
const savedEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_OFFLINE"].map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let networkCalls = 0;
process.env.PI_CODING_AGENT_DIR = directory;
process.env.PI_OFFLINE = "1";
globalThis.fetch = async () => { networkCalls++; throw new Error("Unexpected network access in offline regression"); };
try {
const { builtinProviders, getBuiltinModelDataGeneratedAt } = await load("node_modules/@earendil-works/pi-ai/dist/providers/all.js");
const { loadExtensions } = await load("dist/core/extensions/loader.js");
const providers = builtinProviders();
const id = "gpt-6.1-sol";
for (const providerId of ["openai", "openai-codex"]) {
  const provider = providers.find((entry) => entry.id === providerId);
  const matches = provider.getModels().filter((model) => model.id === id);
  assert.equal(matches.length, 1, `${providerId}: exactly one bundled Sol 6.1`);
  const [model] = matches;
  assert.equal(model.provider, providerId);
  assert.equal(model.api, providerId === "openai" ? "openai-responses" : "openai-codex-responses");
  assert.equal(model.baseUrl, provider.baseUrl);
  assert.equal(model.name, "GPT-6.1 Sol");
  assert.equal(model.contextWindow, 272000);
  assert.equal(model.maxTokens, 128000);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(model.cost, {
    input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
  });
  assert.deepEqual(model.thinkingLevelMap, {
    off: null, minimal: providerId === "openai" ? null : "low",
    low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
  });
  assert.ok(provider.getModels().some((entry) => entry.id === "gpt-6-sol"), "older models retained");
}
const extension = new URL("../extensions/pi-codex-accounts.ts", import.meta.url).pathname;
const loaded = await loadExtensions([extension], process.cwd());
assert.deepEqual(loaded.errors, []);
const alias = loaded.runtime.pendingNativeProviderRegistrations
  .map(({ provider }) => provider).find((provider) => provider.id === "codex-work");
assert.ok(alias, "alias registered before session_start");
const native = providers.find((provider) => provider.id === "openai-codex");
assert.deepEqual(alias.getModels().filter((model) => model.id === id), [
  { ...native.getModels().find((model) => model.id === id), provider: "codex-work" },
], "alias mirrors native metadata");
assert.ok(alias.auth.oauth);
assert.equal(alias.auth.apiKey, undefined);
// Exercise the actual picker composition, not just the native provider factories.
// 0.87.1 merges bundled + eligible cached models by ID, then applies models.json.
const { ModelRuntime, ModelRegistry } = await load("dist/index.js");
const { FileModelsStore } = await load("dist/core/models-store.js");
const { InMemoryCredentialStore } = await load("node_modules/@earendil-works/pi-ai/dist/index.js");
const store = new FileModelsStore(join(directory, "models-store.json"));
const credentials = new InMemoryCredentialStore();
await credentials.modify("openai", async () => ({ type: "api_key", key: "offline-fixture" }));
for (const account of ["openai-codex", "codex-work"]) {
  await credentials.modify(account, async () => ({ type: "oauth", access: "offline-fixture",
    refresh: "unused", expires: Date.now() + 3_600_000 }));
}
const nativeIds = ["openai", "openai-codex"];
const bundled = (provider) => providers.find((entry) => entry.id === provider).getModels();
const sol = (provider) => bundled(provider).find((model) => model.id === id);
const generatedAt = getBuiltinModelDataGeneratedAt();
assert.ok(Number.isFinite(generatedAt));
const runtime = await ModelRuntime.create({ credentials, allowModelNetwork: false });
const registry = new ModelRegistry(runtime);
async function refresh() {
  // The real extension bootstraps codex-work from its own offline ModelRuntime
  // before session_start. Reload it for each cold-start catalog/config scenario.
  const extensionLoad = await loadExtensions([extension], directory);
  assert.deepEqual(extensionLoad.errors, []);
  const registration = extensionLoad.runtime.pendingNativeProviderRegistrations
    .find(({ provider }) => provider.id === "codex-work");
  assert.ok(registration);
  runtime.registerNativeProvider(registration.provider, { refresh: false });
  const result = await registry.refresh({ allowNetwork: false });
  assert.equal(result.errors.size, 0);
  assert.equal(registry.getError(), undefined);
}
function expectModel(provider, expected) {
  assert.deepEqual(registry.find(provider, id), expected, `${provider}: composed metadata`);
  for (const list of [registry.getAll(), registry.getAvailable()]) {
    assert.deepEqual(list.filter((model) => model.provider === provider && model.id === id), [expected],
      `${provider}: exactly one Sol in registry and authenticated picker`);
  }
}
async function cache(lastModified, includeSol) {
  for (const provider of nativeIds) {
    // Distinct synthetic sentinels test precedence, not published metadata.
    const published = { ...sol(provider), name: "Published fixture", contextWindow: 123456,
      maxTokens: 12345, cost: { input: 7, output: 8, cacheRead: 9, cacheWrite: 10 },
      thinkingLevelMap: { off: null, high: "high" }, compat: { supportsStrictMode: false } };
    await store.write(provider, { models: [
      { ...bundled(provider)[0], id: "cached-only-fixture" },
      ...(includeSol ? [published] : []),
    ], checkedAt: 0, lastModified });
  }
}
// Missing cache, expired cache older than the bundle, and an eligible newer cache
// that still lacks Sol must all retain the bundled fallback, including codex-work.
for (const lastModified of [undefined, generatedAt - 1, generatedAt + 1]) {
  if (lastModified !== undefined) await cache(lastModified, false);
  await refresh();
  for (const provider of nativeIds) {
    expectModel(provider, sol(provider));
    assert.equal(Boolean(registry.find(provider, "cached-only-fixture")), lastModified > generatedAt,
      "prove the eligible remote catalog actually loaded");
  }
  expectModel("codex-work", { ...sol("openai-codex"), provider: "codex-work" });
}
await cache(generatedAt + 1, true);
await refresh();
for (const provider of nativeIds) {
  expectModel(provider, (await store.read(provider)).models.find((model) => model.id === id));
}
expectModel("codex-work", { ...registry.find("openai-codex", id), provider: "codex-work" });
// User model upserts and topmost overrides beat remote metadata and fallback;
// alias-local overrides remain independent of the native account.
for (const includeSol of [false, true]) {
  await cache(generatedAt + 1, includeSol);
  await writeFile(join(directory, "models.json"), JSON.stringify({ providers: {
    openai: { baseUrl: "https://override.invalid/v1", modelOverrides: {
      [id]: { name: "User OpenAI", contextWindow: 654321, cost: { input: 42 } },
    } },
    "openai-codex": { models: [{ ...sol("openai-codex"), name: "User Codex", maxTokens: 54321 }],
      modelOverrides: { [id]: { name: "Topmost user Codex" } } },
    "codex-work": { modelOverrides: { [id]: { name: "User Work" } } },
  } }));
  await refresh();
  const base = includeSol ? (await store.read("openai")).models.find((model) => model.id === id) : sol("openai");
  const actual = registry.find("openai", id);
  assert.equal(actual.name, "User OpenAI");
  assert.equal(actual.baseUrl, "https://override.invalid/v1");
  assert.equal(actual.contextWindow, 654321);
  assert.deepEqual(actual.cost, { ...base.cost, input: 42, tiers: base.cost.tiers });
  assert.equal(registry.find("openai-codex", id).name, "Topmost user Codex");
  assert.equal(registry.find("codex-work", id).name, "User Work");
  for (const provider of [...nativeIds, "codex-work"]) {
    expectModel(provider, registry.find(provider, id));
    if (provider !== "openai") assert.equal(registry.find(provider, id).maxTokens, 54321);
  }
}
assert.equal(networkCalls, 0, "no network, token refresh or catalog fetch");
console.log("GPT-6.1 Sol: native metadata, offline stale-cache runtime/registry picker, codex-work bootstrap, published/user precedence passed");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(directory, { recursive: true, force: true });
}
