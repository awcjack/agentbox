// Offline test against packaged Pi. Sources: https://pi.dev/api/models/providers/openai
// and https://pi.dev/api/models/providers/openai-codex. Use an empty PI_CODING_AGENT_DIR.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const root = process.argv[2];
assert.ok(root, "usage: node tests/pi-gpt-6.1-sol.mjs <pi package directory>");
const load = (path) => import(pathToFileURL(`${root}/${path}`));
const { builtinProviders } = await load("node_modules/@earendil-works/pi-ai/dist/providers/all.js");
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
console.log("GPT-6.1 Sol: native catalogs and startup alias verified offline");
