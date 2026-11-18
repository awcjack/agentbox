import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig } from "./runtime.mjs";

function config() {
  return {
    version: 1, defaults: {}, servers: {},
    piRpcApi: {
      executable: "/bin/pi",
      auth: { tokens: [{ sha256: "a".repeat(64), scopes: ["profiles:read"] }] },
      profiles: { default: { cwd: "/workspace", sessionDir: "/sessions" } },
    },
  };
}

test("RPC tolerates extension-owned browser config and grants the bridge only on explicit enable", () => {
  const base = config();
  const expected = normalizeConfig(base);
  for (const browser of [
    { enable: false },
    { enable: true, decisions: { enable: true, apiKeyEnv: "OPENAI_API_KEY", timeoutMs: 10000, maxSteps: 8, minConfidence: 0.85 } },
    { enable: true, delegation: "tabs", allowedDomains: [], maxOutputChars: 16000, commandTimeoutMs: 30000, idleTimeoutMs: 300000 },
    { enable: true, delegation: "isolated", allowedDomains: ["example.test"] },
    null, // Browser validation is deliberately owned by the extension.
    { enable: "true" }, {},
  ]) assert.deepEqual(normalizeConfig({ ...base, browser }), { ...expected, browserEnabled: browser?.enable === true });
});

test("Decisions key stays out of RPC child environment without an explicit profile reference", () => {
  const base = { ...config(), browser: { enable: true, decisions: { enable: true, apiKeyEnv: "OPENAI_API_KEY" } } };
  const environment = { OPENAI_API_KEY: "synthetic-decisions-test-key" };
  assert.deepEqual(normalizeConfig(base, environment).profiles.get("default").env, {});
  base.piRpcApi.profiles.default.envReferences = { OPENAI_API_KEY: "OPENAI_API_KEY" };
  assert.deepEqual(normalizeConfig(base, environment).profiles.get("default").env, environment);
  assert.throws(() => normalizeConfig(base, {}), /requires environment variable OPENAI_API_KEY/);
});

test("browser compatibility does not relax RPC root or API validation", () => {
  const base = config();
  assert.throws(() => normalizeConfig({ ...base, browsers: {} }), /browsers/);
  assert.throws(() => normalizeConfig({ ...base, browser: {}, piRpcApi: { ...base.piRpcApi, browser: {} } }), /piRpcApi.*browser/);
  assert.throws(() => normalizeConfig({ ...base, browser: {}, piRpcApi: { ...base.piRpcApi, auth: { tokens: [] } } }), /non-empty array/);
});
