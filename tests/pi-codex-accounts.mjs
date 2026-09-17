// Offline contract test against the packaged Pi, including its real extension loader.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
assert.ok(root, "usage: node tests/pi-codex-accounts.mjs <pi package directory>");
const load = (path) => import(pathToFileURL(`${root}/${path}`));
const { loadExtensions } = await load("dist/core/extensions/loader.js");
const ai = await load("node_modules/@earendil-works/pi-ai/dist/index.js");
const { openaiCodexProvider } = await load("node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js");
const { getOpenAICodexWebSocketDebugStats } = await load("node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js");
const { ModelRuntime } = await load("dist/core/model-runtime.js");
const { ModelRegistry } = await load("dist/core/model-registry.js");
const { InMemoryCodingAgentModelsStore } = await load("dist/core/models-store.js");
const extension = new URL("../extensions/pi-codex-accounts.ts", import.meta.url).pathname;
const loaded = await loadExtensions([extension], process.cwd());
assert.deepEqual(loaded.errors, []);
const aliases = loaded.runtime.pendingNativeProviderRegistrations.map(({ provider }) => provider);
assert.deepEqual(aliases.map(({ id }) => id), ["codex-work"]);
const native = openaiCodexProvider();
const credentials = new ai.InMemoryCredentialStore();
const models = ai.createModels({ credentials });
models.setProvider(native);
for (const provider of aliases) {
  models.setProvider(provider);
  assert.equal(provider.auth, aliases[0].auth);
  assert.equal(provider.auth.apiKey, undefined);
  assert.deepEqual(provider.getModels(), native.getModels().map((model) => ({ ...model, provider: provider.id })));
}
assert.equal(models.getProvider("openai-codex"), native);

const token = (account, version = "test") => `fake.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url")}.${version}`;
const credential = (account, expires = Date.now() + 3_600_000) => ({
  type: "oauth", access: token(account), refresh: `refresh-${account}`, expires,
});
const original = credential("personal");
await credentials.modify(native.id, async () => original);
assert.equal(await models.getAuth("codex-work"), undefined, "no fallback to native login");
await credentials.modify("codex-work", async () => credential("work", 0));

const requests = [];
const refreshes = [];
const events = [
  { type: "response.output_item.added", item: { type: "message", id: "msg_test", role: "assistant", content: [] } },
  { type: "response.content_part.added", part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", delta: "Hello" },
  { type: "response.output_item.done", item: { type: "message", id: "msg_test", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
  { type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
];
const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://auth.openai.com/oauth/token") {
    const body = new URLSearchParams(init.body);
    refreshes.push(body.get("refresh_token"));
    assert.equal(body.get("refresh_token"), "refresh-work");
    return Response.json({ access_token: token("work", "renewed"), refresh_token: "rotated-work", expires_in: 3600 });
  }
  assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses", "unexpected network request");
  requests.push(new Headers(init.headers));
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
};

try {
  await Promise.all([models.getAuth("codex-work"), models.getAuth("codex-work")]);
  assert.deepEqual(refreshes, ["refresh-work"], "native refresh is serialized per alias");
  assert.equal((await credentials.read("codex-work")).refresh, "rotated-work");
  assert.deepEqual(await credentials.read(native.id), original);

  const modelId = aliases[0].getModels().find((model) => model.id === "gpt-5.4").id;
  const history = (provider, model = modelId) => ({ messages: [
    { role: "assistant", provider, api: "openai-codex-responses", model,
      content: [
        { type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_private", encrypted_content: "opaque-account-data", summary: [] }) },
        { type: "text", text: "Checking", textSignature: "msg_private" },
        { type: "toolCall", id: "call_123|fc_456", name: "read", arguments: { path: "test" } },
      ], usage: {}, stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "call_123|fc_456", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: 2 },
  ] });
  const payloads = [];
  const results = new Map();
  async function run(provider, context, method = "streamSimple", extra = {}) {
    const model = models.getModel(provider, modelId);
    const before = structuredClone(context);
    const stream = models[method](model, context, {
      transport: "sse", sessionId: "shared-session", ...extra,
      onPayload(payload, observedModel) {
        assert.equal(observedModel.provider, provider);
        payloads.push(structuredClone(payload));
      },
    });
    const observed = [];
    for await (const event of stream) {
      observed.push(event.type);
      assert.equal((event.partial ?? event.message ?? event.error).provider, provider);
    }
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.content[0].text, "Hello");
    results.set(provider, result);
    assert.ok(observed.includes("text_delta"));
    assert.deepEqual(context, before, "history must not be mutated");
    return payloads.at(-1);
  }
  const personal = await run(native.id, history(native.id));
  assert.equal(personal.prompt_cache_key, "shared-session");
  const same = await run("codex-work", history("codex-work"));
  assert.ok(same.input.some((item) => item.id === "rs_private"));
  assert.ok(same.input.some((item) => item.id === "fc_456"));
  const workKey = same.prompt_cache_key;
  assert.notEqual(workKey, personal.prompt_cache_key);
  for (const source of ["openai-codex", "anthropic"]) {
    const foreign = await run("codex-work", history(source), "stream");
    assert.ok(!JSON.stringify(foreign).includes("opaque-account-data"));
    assert.ok(!foreign.input.some((item) => item.id === "msg_private" || item.id === "fc_456"));
    const call = foreign.input.find((item) => item.type === "function_call");
    const result = foreign.input.find((item) => item.type === "function_call_output");
    assert.equal(call.call_id, "call_123");
    assert.equal(result.call_id, call.call_id);
    assert.equal(foreign.prompt_cache_key, workKey);
  }
  const changedModel = await run("codex-work", history("codex-work", "different-model"));
  assert.ok(!JSON.stringify(changedModel).includes("opaque-account-data"));
  assert.equal(changedModel.input.find((item) => item.type === "function_call").id, undefined);
  assert.equal(changedModel.input.find((item) => item.type === "function_call").call_id, "call_123");
  const back = await run(native.id, history("codex-work"));
  assert.equal(back.prompt_cache_key, personal.prompt_cache_key);
  assert.ok(!JSON.stringify(back).includes("opaque-account-data"));
  assert.ok(!back.input.some((item) => item.id === "msg_private" || item.id === "fc_456"));
  assert.equal(back.input.find((item) => item.type === "function_call").call_id,
    back.input.find((item) => item.type === "function_call_output").call_id);
  assert.equal(requests[0].get("authorization"), `Bearer ${original.access}`);
  assert.equal(requests[1].get("authorization"), `Bearer ${token("work", "renewed")}`);
  assert.equal(requests[1].get("chatgpt-account-id"), "work");
  assert.equal(requests[1].get("session-id"), workKey);

  await credentials.modify("codex-work", async () => credential("work"));
  const relogin = await run("codex-work", history("codex-work"));
  assert.notEqual(relogin.prompt_cache_key, workKey, "changed token gets a fresh cache/socket scope");
  const uncached = await run("codex-work", history("codex-work"), "streamSimple", { cacheRetention: "none" });
  assert.equal(uncached.prompt_cache_key, undefined);
  await run(native.id, history("codex-work"));
  assert.equal(requests.at(-1).get("authorization"), `Bearer ${original.access}`);
  assert.equal(payloads.at(-1).prompt_cache_key, "shared-session");

  const sockets = [];
  globalThis.WebSocket = class extends EventTarget {
    readyState = 1;
    constructor(url, { headers }) {
      super();
      assert.equal(url, "wss://chatgpt.com/backend-api/codex/responses");
      this.headers = new Headers(headers);
      this.bodies = [];
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(body) {
      this.bodies.push(JSON.parse(body));
      queueMicrotask(() => {
        for (const event of events) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
      });
    }
    close() { this.readyState = 3; }
  };
  const ws = { transport: "websocket-cached" };
  await run("codex-work", history("codex-work"), "streamSimple", ws);
  const continuation = { messages: [...history("codex-work").messages,
    results.get("codex-work"), { role: "user", content: "Continue", timestamp: 3 }] };
  await run(native.id, history("codex-work"), "streamSimple", ws);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0].headers.get("authorization"), `Bearer ${token("work")}`);
  assert.equal(sockets[1].headers.get("authorization"), `Bearer ${original.access}`);
  await run("codex-work", continuation, "streamSimple", ws);
  assert.equal(sockets.length, 2, "returning to the work alias reuses only its socket");
  assert.equal(sockets[0].bodies.length, 2);
  assert.equal(sockets[0].bodies[1].previous_response_id, "resp_test");
  assert.equal(sockets[0].bodies[1].input.length, 1, "same-account continuation sends only new input");
  assert.equal(sockets[1].bodies[0].previous_response_id, undefined, "other account must receive full context");
  await credentials.modify("codex-work", async () => ({ ...credential("work"), access: token("work", "new-login") }));
  await run("codex-work", history("codex-work"), "streamSimple", ws);
  assert.equal(sockets.length, 3, "new credential cannot reuse old authenticated socket");
  assert.equal(sockets[2].headers.get("authorization"), `Bearer ${token("work", "new-login")}`);
  assert.equal(sockets[2].bodies[0].previous_response_id, undefined);
  await credentials.modify("codex-work", async () => credentials.read(native.id));
  await run("codex-work", history(native.id), "streamSimple", ws);
  assert.equal(sockets.length, 4, "providers stay isolated even with identical account credentials");
  assert.equal(sockets[3].bodies[0].previous_response_id, undefined);
  const wsKeys = payloads.slice(-5).map((payload) => payload.prompt_cache_key);
  assert.notEqual(wsKeys.at(-1), wsKeys[1]);
  assert.ok(getOpenAICodexWebSocketDebugStats(wsKeys[0]));

  const error = await aliases[0].streamSimple(aliases[0].getModels()[0], { messages: [] }).result();
  assert.equal(error.stopReason, "error");
  assert.equal(error.provider, "codex-work");
  await models.logout("codex-work");
  assert.equal(await models.getAuth("codex-work"), undefined);
  assert.ok(await models.getAuth(native.id));
  assert.deepEqual(await credentials.read(native.id), original);

  // Exercise the coding-agent layer, not just pi-ai's bundled provider catalog.
  const directory = await mkdtemp(join(tmpdir(), "pi-codex-catalog-"));
  try {
    const modelsPath = join(directory, "models.json");
    const configured = {
      models: [{ id: "configured-codex", name: "Configured Codex", contextWindow: 234567 }],
      modelOverrides: { "gpt-6-astra": { maxTokens: 12345 } },
      headers: { "X-Personal-Only": "synthetic-header" },
    };
    await writeFile(modelsPath, JSON.stringify({ providers: { [native.id]: configured } }));
    const store = new InMemoryCodingAgentModelsStore();
    // Synthetic metadata, not claims about Astra's actual limits or pricing.
    const astra = { ...native.getModels()[0], id: "gpt-6-astra", name: "Astra (fixture)",
      contextWindow: 345678, thinkingLevelMap: { high: "high", xhigh: "xhigh" } };
    const cache = (entries) => store.write(native.id, {
      models: entries, checkedAt: Date.now(), lastModified: Date.now() + 86_400_000,
    });
    await cache([astra]);
    const catalogCredentials = new ai.InMemoryCredentialStore();
    await catalogCredentials.modify("codex-work", async () => credential("work"));
    const runtime = await ModelRuntime.create({
      credentials: catalogCredentials, modelsPath, modelsStore: store, allowModelNetwork: false,
    });
    const registry = new ModelRegistry(runtime);
    loaded.runtime.registerNativeProvider = (provider) => registry.registerProvider(provider);
    registry.registerProvider(aliases[0]);
    await registry.refresh({ allowNetwork: false });
    for (const handler of loaded.extensions[0].handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, { modelRegistry: registry });
    }
    await registry.refresh({ allowNetwork: false });
    assert.equal(registry.getError(), undefined);
    assert.ok(registry.find("codex-work", astra.id), "work alias must include Astra from the runtime catalog");
    const assertCatalog = () => assert.deepEqual(
      registry.getAll().filter((model) => model.provider === "codex-work"),
      registry.getProvider(native.id).getModels().map((model) => ({ ...model, provider: "codex-work" })),
    );
    assertCatalog();
    assert.equal(registry.find("codex-work", astra.id).maxTokens, 12345);
    assert.equal(registry.find("codex-work", astra.id).contextWindow, astra.contextWindow);
    assert.equal(registry.find("codex-work", "configured-codex").contextWindow, 234567);
    assert.ok(registry.getAvailable().some((model) => model.provider === "codex-work" && model.id === astra.id),
      "Astra is available with only the work login configured");
    assert.equal(registry.getProvider("codex-work").auth, aliases[0].auth);
    const astraResult = await runtime.streamSimple(registry.find("codex-work", astra.id), { messages: [] },
      { transport: "sse" }).result();
    assert.equal(astraResult.stopReason, "stop", astraResult.errorMessage);
    assert.equal(astraResult.provider, "codex-work");
    assert.equal(requests.at(-1).get("authorization"), `Bearer ${token("work")}`);
    assert.equal(requests.at(-1).get("x-personal-only"), null, "native configured auth headers stay native");

    // Both a changed cache and models.json recompose must be visible without a new session.
    await cache([{ ...astra, contextWindow: 456789 }, { ...astra, id: "later-codex" }]);
    configured.models = [{ id: "replacement-codex" }];
    await writeFile(modelsPath, JSON.stringify({ providers: { [native.id]: configured } }));
    await registry.refresh({ allowNetwork: false });
    assertCatalog();
    assert.equal(registry.find("codex-work", astra.id).contextWindow, 456789);
    assert.ok(registry.find("codex-work", "later-codex"));
    assert.ok(registry.find("codex-work", "replacement-codex"));
    assert.equal(registry.find("codex-work", "configured-codex"), undefined);
    await cache([]);
    await registry.refresh({ allowNetwork: false });
    assertCatalog();
    assert.equal(registry.find("codex-work", astra.id), undefined, "removed catalog entries do not linger");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  ai.cleanupSessionResources("shared-session");
  assert.ok(sockets.every((socket) => socket.readyState === 3), "cleanup closes all scoped sockets");
  await credentials.modify("codex-work", async () => credential("work"));
  await run("codex-work", history("codex-work"), "streamSimple", ws);
  assert.equal(sockets.length, 5);
  for (const handler of loaded.extensions[0].handlers.get("session_shutdown")) await handler({}, {});
  assert.ok(sockets.every((socket) => socket.readyState === 3), "shutdown closes remaining sockets");
  console.log("Native personal Codex + work alias: real loader, bundled/remote/configured catalogs, Astra, isolated auth/refresh/logout, native SSE/WebSocket, history, cache isolation/cleanup and errors passed");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  ai.cleanupSessionResources();
}
