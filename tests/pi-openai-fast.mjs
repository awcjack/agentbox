import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
const root = process.argv[2];
const { loadExtensions } = await import(pathToFileURL(`${root}/dist/core/extensions/loader.js`));
const loaded = await loadExtensions([new URL("../extensions/pi-openai-fast.ts", import.meta.url).pathname], process.cwd());
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions[0];
const command = extension.commands.get("fast");
const emit = async (type, ctx, event = {}) => {
  let result;
  for (const handler of extension.handlers.get(type) ?? []) result = await handler({ type, ...event }, ctx);
  return result;
};
let status, idle = true;
const notices = [];
const ctx = {
  model: { provider: "openai", api: "openai-responses", id: "gpt-6.1-sol" },
  isIdle: () => idle,
  ui: { setStatus: (key, value) => { assert.equal(key, "agentbox-fast"); status = JSON.parse(value); },
    notify: (...args) => notices.push(args) },
};
const payload = { model: "gpt-6.1-sol", input: [], stream: true };
const request = () => emit("before_provider_request", ctx, { payload });
await emit("session_start", ctx);
assert.deepEqual(status, { available: true, enabled: false });
assert.equal(await request(), undefined);
for (const provider of ["openai", "openai-codex", "codex-work"]) {
  ctx.model.provider = provider;
  ctx.model.api = provider === "openai" ? "openai-responses" : "openai-codex-responses";
  await command.handler("on", ctx);
  assert.deepEqual(status, { available: true, enabled: true });
  assert.deepEqual(await request(), { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, undefined, "does not mutate another handler's payload");
  assert.equal(await emit("before_provider_request", ctx, { payload: { model: "other-model" } }), undefined);
  await command.handler("off", ctx);
  assert.equal(await request(), undefined);
}
await command.handler("on", ctx);
idle = false;
await command.handler("off", ctx);
assert.equal(status.enabled, true, "cannot change tier during a turn");
idle = true;
for (const type of ["model_select", "session_start", "session_switch", "session_fork"]) {
  await command.handler("on", ctx);
  await emit(type, ctx);
  assert.equal(status.enabled, false, `${type} resets paid mode`);
}
await command.handler("on", ctx);
ctx.model = { provider: "custom-proxy", api: "openai-responses", id: "gpt-6.1-sol" };
assert.equal(await request(), undefined, "never injects tier into a custom provider");
await emit("model_select", ctx);
assert.deepEqual(status, { available: false, enabled: false });
await command.handler("on", ctx);
assert.equal(status.enabled, false);
assert.equal(notices.at(-1)[1], "error");
await command.handler("invalid", ctx);
assert.match(notices.at(-1)[0], /Usage/);
// Exercise the actual streamSimple adapters used by agent sessions: the hook
// must change the outgoing body, not just return the right JavaScript object.
const { builtinProviders } = await import(pathToFileURL(`${root}/node_modules/@earendil-works/pi-ai/dist/providers/all.js`));
const originalFetch = globalThis.fetch;
const bodies = [];
globalThis.fetch = async (_url, init) => {
  const body = new Headers(init.headers).get("content-encoding") === "zstd" ? zstdDecompressSync(init.body) : init.body;
  bodies.push(JSON.parse(typeof body === "string" ? body : Buffer.from(body).toString("utf8")));
  const event = { type: "response.completed", response: { id: "resp_fast", status: "completed", output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
};
try {
  for (const id of ["openai", "openai-codex"]) {
    const provider = builtinProviders().find((entry) => entry.id === id);
    ctx.model = provider.getModels().find((model) => model.id === "gpt-6.1-sol");
    assert.ok(ctx.model);
    await emit("model_select", ctx);
    for (const mode of ["on", "off"]) {
      await command.handler(mode, ctx);
      const apiKey = id === "openai" ? "fake-key" : `fake.${Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "fixture" },
      })).toString("base64url")}.test`;
      const result = await provider.streamSimple(ctx.model, { messages: [] }, {
        apiKey, transport: "sse", onPayload: (payload) => emit("before_provider_request", ctx, { payload }),
      }).result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(bodies.at(-1).service_tier, mode === "on" ? "priority" : undefined);
    }
  }
} finally { globalThis.fetch = originalFetch; }
console.log("OpenAI fast mode: real loader, default-off lifecycle, streamSimple wire payload, provider isolation and idle guards passed");
