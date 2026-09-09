import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, createSSEParser, createTransport, eventCursor, messageKey, updatePartial, visibleMessages } from "./transport.mjs";

test("SSE parses every chunk boundary, CRLF, comments, and multiline data", () => {
  const text = ': keepalive\r\nid: 42\r\nevent: pi\r\ndata: {"type":\r\ndata: "agent_start"}\r\n\r\n';
  for (let split = 0; split <= text.length; split++) {
    const events = [];
    const parser = createSSEParser((event) => events.push(event));
    parser.feed(text.slice(0, split)); parser.feed(text.slice(split));
    assert.deepEqual(events, [{ id: "42", event: "pi", data: '{"type":\n"agent_start"}' }]);
  }
});

test("SSE handles bare CR and LF, empty data, persistent IDs, and resets", () => {
  const events = [], parser = createSSEParser((event) => events.push(event));
  parser.feed("id: 9\nevent: pi\ndata: one\n\nid: bad\0id\rdata:\r\revent: reset\ndata: {}\n\n");
  assert.deepEqual(events, [
    { id: "9", event: "pi", data: "one" },
    { id: "9", event: "message", data: "" },
    { id: "9", event: "reset", data: "{}" },
  ]);
});

test("SSE ignores incomplete records and preserves Unicode line separators", () => {
  const events = [], parser = createSSEParser((event) => events.push(event));
  parser.feed('data: {"text":"a\u2028b\u2029c"}\n\ndata: unfinished');
  assert.equal(events.length, 1);
  assert.equal(JSON.parse(events[0].data).text, "a\u2028b\u2029c");
});

test("SSE bounds unterminated records and resets size after records", () => {
  assert.throws(() => createSSEParser(() => {}, 20).feed(`data: ${"x".repeat(20)}`), /size limit/);
  const events = [], parser = createSSEParser((event) => events.push(event), 15);
  parser.feed("data: a\n\ndata: b\n\ndata: c\n\n");
  assert.equal(events.length, 3);
});

test("cursor validation rejects malformed and imprecise IDs", () => {
  assert.equal(eventCursor(0), 0);
  assert.equal(eventCursor("0012"), 12);
  assert.equal(eventCursor(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  for (const value of [null, undefined, "", "-1", "1.1", "1e2", " 12", "Infinity", Number.MAX_SAFE_INTEGER + 1]) assert.equal(eventCursor(value), null);
});

test("transport sends same-origin bearer headers, never cookies or redirects", async () => {
  let token = "memory-only", calls = [];
  const api = createTransport(() => token, async (path, options) => {
    calls.push({ path, options });
    return Response.json({ success: true, data: { messages: [] } });
  });
  await api.request("/v1/sessions/session/rpc", { body: { type: "get_messages" } });
  assert.equal(calls[0].path, "/v1/sessions/session/rpc");
  assert.deepEqual(calls[0].options.headers, { Authorization: "Bearer memory-only", Accept: "application/json", "Content-Type": "application/json" });
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
  token = "replacement";
  await api.request("/v1/sessions");
  assert.equal(calls[1].options.headers.Authorization, "Bearer replacement");
  token = "";
  await assert.rejects(api.request("/v1/sessions"), (error) => error.status === 401);
  assert.equal(calls.length, 2);
});

test("transport rejects external paths before attaching credentials", async () => {
  let calls = 0;
  const api = createTransport(() => "secret", () => { calls++; });
  for (const path of ["https://evil.invalid/v1/sessions", "//evil.invalid/v1/sessions", "/v1/\\evil", "/v1/\nfoo", "/health/live"]) await assert.rejects(api.request(path), /same-origin/);
  assert.equal(calls, 0);
});

test("HTTP errors expose scope codes and RPC rejections retain their message", async () => {
  const api = createTransport(() => "secret", async () => Response.json({ error: { code: "insufficient_scope", message: "scope sessions:write is required" } }, { status: 403 }));
  await assert.rejects(api.request("/v1/sessions"), (error) => error instanceof ApiError && error.status === 403 && error.code === "insufficient_scope" && error.message.includes("sessions:write"));
  const rpc = createTransport(() => "secret", async () => Response.json({ type: "response", success: false, error: "Model not found" }));
  await assert.rejects(rpc.request("/v1/sessions/s/rpc", { body: { type: "set_model" } }), (error) => error.code === "rpc_error" && error.message === "Model not found");
});

test("network errors and ambiguous prompt failures are never automatically retried", async () => {
  let calls = 0;
  const api = createTransport(() => "secret", async () => { calls++; throw new TypeError("Failed to fetch"); });
  await assert.rejects(api.request("/v1/sessions/s/rpc", { body: { type: "prompt", message: "Do this once" } }), (error) => error.code === "network_error" && error.status === 0);
  assert.equal(calls, 1);
});

test("invalid JSON and non-JSON proxy errors are visible", async () => {
  const api = createTransport(() => "secret", async () => new Response("<html>proxy failure</html>", { status: 502 }));
  await assert.rejects(api.request("/v1/sessions"), (error) => error.status === 502 && error.message.includes("HTTP 502"));
  const invalid = createTransport(() => "secret", async () => new Response("not json"));
  await assert.rejects(invalid.request("/v1/sessions"), (error) => error.code === "invalid_response");
});

test("external cancellation propagates to pending fetch without retry", async () => {
  const controller = new AbortController();
  const api = createTransport(() => "secret", async (_path, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })));
  const request = api.request("/v1/sessions", { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
});

test("fetch SSE decodes split UTF-8 and authenticates the event subscription", async () => {
  const bytes = new TextEncoder().encode('id: 7\nevent: pi\ndata: {"text":"\u00e9\ud83d\ude80"}\n\n');
  const events = [], controller = new AbortController();
  let opened = false;
  const api = createTransport(() => "secret", async (path, options) => {
    assert.equal(path, "/v1/sessions/s/events?after=6");
    assert.equal(options.headers.Authorization, "Bearer secret");
    assert.equal(options.headers.Accept, "text/event-stream");
    return new Response(new ReadableStream({ start(stream) { for (const byte of bytes) stream.enqueue(new Uint8Array([byte])); stream.close(); } }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  });
  await api.events("/v1/sessions/s/events?after=6", { signal: controller.signal, onOpen: () => { opened = true; }, onEvent: (event) => events.push(event) });
  assert.equal(opened, true);
  assert.deepEqual(events, [{ id: "7", event: "pi", data: '{"text":"\u00e9\ud83d\ude80"}' }]);
});

test("event stream rejects unexpected content types and propagates malformed frames", async () => {
  const controller = new AbortController();
  const api = createTransport(() => "secret", async () => Response.json({ sessions: [] }));
  await assert.rejects(api.events("/v1/sessions/s/events", { signal: controller.signal, onEvent() {} }), (error) => error.code === "invalid_stream");
  let cancelled = false;
  const broken = createTransport(() => "secret", async () => new Response(new ReadableStream({
    start(stream) { stream.enqueue(new TextEncoder().encode("event: pi\ndata: broken\n\n")); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "text/event-stream" } }));
  await assert.rejects(broken.events("/v1/sessions/s/events", { signal: controller.signal, onEvent: (event) => JSON.parse(event.data) }), SyntaxError);
  assert.equal(cancelled, true);
});

test("snapshots win over replayed partials without suppressing identical new turns", () => {
  const final = { role: "assistant", timestamp: 10, content: [{ type: "text", text: "Finished" }] };
  const partial = { ...final, content: [{ type: "text", text: "Fin" }] };
  const messages = [final];
  assert.equal(visibleMessages(messages, partial), messages);
  assert.deepEqual(visibleMessages(messages, { ...partial, timestamp: 11 }), [final, { ...partial, timestamp: 11 }]);
  assert.equal(visibleMessages(messages, null), messages);
  assert.equal(messageKey({ role: "toolResult", toolCallId: "call-a", timestamp: 12 }), "tool:call-a");
  assert.notEqual(messageKey({ role: "user", timestamp: 10 }), messageKey(final));
});

test("explicit DELETE accepts 204 without a JSON body or automatic retry", async () => {
  let calls = 0;
  const api = createTransport(() => "secret", async (_path, options) => {
    calls++;
    assert.equal(options.method, "DELETE");
    assert.equal(options.body, undefined);
    assert.equal(options.headers["Content-Type"], undefined);
    return new Response(null, { status: 204 });
  });
  assert.equal(await api.request("/v1/sessions/s", { method: "DELETE" }), undefined);
  assert.equal(calls, 1);
});

test("Pi 0.84 streaming deltas assemble text, thinking, and tool calls without mutating snapshots", () => {
  const initial = { role: "assistant", timestamp: 10, content: [] };
  let partial = updatePartial(null, { type: "message_start", message: initial });
  const delta = (type, contentIndex, data = {}) => { partial = updatePartial(partial, { assistantMessageEvent: { type, contentIndex, ...data } }); };
  delta("text_start", 0); delta("text_delta", 0, { delta: "Hello " }); delta("text_delta", 0, { delta: "Pi" });
  assert.equal(partial.content[0].text, "Hello Pi");
  delta("text_end", 0, { content: "Hello Pi." });
  delta("thinking_delta", 1, { delta: "Check " }); delta("thinking_delta", 1, { delta: "tests" });
  delta("thinking_end", 1, { content: "Check tests first." });
  delta("toolcall_start", 2, { id: "c1", toolName: "read" }); delta("toolcall_delta", 2, { delta: '{"path":' });
  assert.equal(partial.content[2].arguments, '{"path":');
  const tool = { type: "toolCall", id: "c1", name: "read", arguments: { path: "file" } };
  delta("toolcall_end", 2, { toolCall: tool });
  assert.deepEqual(partial.content, [{ type: "text", text: "Hello Pi." }, { type: "thinking", thinking: "Check tests first." }, tool]);
  assert.deepEqual(initial.content, []);
  assert.equal(messageKey(partial), "assistant:10");
  const completed = { ...partial, stopReason: "toolUse" };
  assert.deepEqual(visibleMessages([completed], partial), [completed]);
});

test("midstream reconnect deltas work without message_start and full snapshots still take precedence", () => {
  const partial = updatePartial(null, { usage: { output: 3 }, assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: "continued" } });
  assert.equal(partial.content[2].text, "continued");
  assert.equal(partial.usage.output, 3);
  assert.ok(partial.content.every((block) => block.type === "text"));
  const snapshot = { role: "assistant", timestamp: 20, content: [{ type: "text", text: "Entire partial" }] };
  assert.equal(updatePartial(partial, { message: snapshot, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "must not append" } }), snapshot);
  assert.equal(updatePartial(partial, { assistantMessageEvent: { type: "text_delta", contentIndex: 999999999 } }), partial);
  assert.equal(updatePartial(partial, { message: { role: "user", content: "hello" } }), partial);
});
