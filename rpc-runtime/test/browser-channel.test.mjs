import assert from "node:assert/strict";
import test from "node:test";
import { Duplex } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createBrowserClient, serveBrowserChannel } from "../browser-channel.mjs";

const NATIVE = "3d90a428-2ed7-4a53-8aef-b5f5489f0e63";
function pair() {
  let a, b;
  const endpoint = (peer) => new Duplex({
    read() {},
    write(chunk, encoding, done) { peer().push(Buffer.from(chunk)); done(); },
    final(done) { peer().push(null); done(); },
    destroy(error, done) { const other = peer(); if (!other.destroyed) other.destroy(); done(error); },
  });
  a = endpoint(() => b); b = endpoint(() => a);
  return [a, b];
}
const record = (extra = {}) => ({ version: 1, type: "request", id: "opaque-id", nativeSessionId: NATIVE, operation: "status", payload: {}, principal: "principal", ...extra });

test("duplex channel correlates concurrent results and safe public errors", async () => {
  const [a, b] = pair();
  const client = createBrowserClient(a);
  const seen = [];
  serveBrowserChannel(b, async (request, signal) => {
    seen.push(request);
    assert.ok(signal instanceof AbortSignal);
    if (request.operation === "frame") throw Object.assign(new Error("/private/path stderr"), { code: "browser_frame_stale" });
    await delay(request.payload.delay ?? 0);
    return { echo: request.payload };
  });
  const first = client.request(NATIVE, "status", { delay: 15 }, "operator");
  const second = client.request(NATIVE, "status", { delay: 1 });
  assert.equal(client.pendingCount, 2);
  assert.deepEqual(await second, { echo: { delay: 1 } });
  assert.deepEqual(await first, { echo: { delay: 15 } });
  await assert.rejects(client.request(NATIVE, "frame"), (error) => error.code === "browser_frame_stale" && !error.message.includes("private"));
  assert.equal(seen[0].principal, "operator");
  assert.equal(client.pendingCount, 0);
  client.close();
});

test("unknown handler errors become fixed browser_failed", async () => {
  const [a, b] = pair();
  const client = createBrowserClient(a);
  serveBrowserChannel(b, () => { throw new Error("secret argv"); });
  await assert.rejects(client.request(NATIVE, "status"), { code: "browser_failed", message: "Browser operation failed" });
  client.close();
});

test("client limits outstanding requests; deadline closes channel and aborts server", async () => {
  const [a, b] = pair();
  const client = createBrowserClient(a, { timeoutMs: 25, maxPending: 1 });
  let signal;
  serveBrowserChannel(b, (_request, incoming) => { signal = incoming; return new Promise(() => {}); });
  assert.equal(client.closed, false);
  const pending = assert.rejects(client.request(NATIVE, "input"), { code: "browser_unavailable" });
  await assert.rejects(client.request(NATIVE, "status"), { code: "browser_busy" });
  await delay(40);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(client.pendingCount, 0);
  assert.equal(client.closed, true);
  await assert.rejects(client.request(NATIVE, "status"), { code: "browser_unavailable" });
});

test("EOF rejects pending requests and aborts handlers", async () => {
  const [a, b] = pair();
  const client = createBrowserClient(a);
  let signal;
  const server = serveBrowserChannel(b, (_request, incoming) => { signal = incoming; return new Promise(() => {}); });
  const pending = assert.rejects(client.request(NATIVE, "status"), { code: "browser_unavailable" });
  await delay(1);
  server.close();
  await pending;
  assert.equal(signal.aborted, true);
});

test("fragmented and coalesced LF records work", async () => {
  const [a, b] = pair();
  let calls = 0;
  serveBrowserChannel(b, () => { calls++; return null; });
  const first = JSON.stringify(record());
  a.write(first.slice(0, 7)); a.write(first.slice(7) + "\n" + JSON.stringify(record({ id: "second" })) + "\n");
  await delay(5);
  assert.equal(calls, 2);
  a.destroy();
});

for (const [name, raw] of [
  ["CRLF", JSON.stringify(record()) + "\r\n"],
  ["invalid JSON", "nope\n"],
  ["unknown version", JSON.stringify(record({ version: 2 })) + "\n"],
  ["extra field", JSON.stringify(record({ path: "/tmp" })) + "\n"],
  ["unknown operation", JSON.stringify(record({ operation: "cdp" })) + "\n"],
  ["oversized", "x".repeat(1024 * 1024 + 1)],
  ["bad UTF8", Buffer.from([0xff, 10])],
  ["UTF8 BOM", "\ufeff" + JSON.stringify(record()) + "\n"],
]) test(`server fails closed on ${name}`, async () => {
  const [a, b] = pair();
  let calls = 0;
  serveBrowserChannel(b, () => { calls++; });
  a.write(raw);
  await delay(1);
  assert.equal(b.destroyed, true);
  assert.equal(calls, 0);
});

test("unknown response correlation and malformed errors fail closed", async () => {
  for (const response of [
    { version: 1, type: "response", id: "foreign", ok: true, data: {} },
    { version: 1, type: "response", id: "foreign", ok: false, error: { code: "private", message: "secret" } },
    { version: 1, type: "response", id: "foreign", ok: false, error: { code: ["browser_busy"], message: "secret" } },
  ]) {
    const [a, b] = pair();
    const client = createBrowserClient(a);
    const pending = assert.rejects(client.request(NATIVE, "status"), { code: "browser_unavailable" });
    b.write(JSON.stringify(response) + "\n");
    await pending;
    assert.equal(a.destroyed, true);
  }
});

test("duplicate in-flight IDs fail closed and abort original handler", async () => {
  const [a, b] = pair();
  let signal;
  serveBrowserChannel(b, (_req, incoming) => { signal = incoming; return new Promise(() => {}); });
  a.write(JSON.stringify(record()) + "\n");
  await delay(1);
  a.write(JSON.stringify(record()) + "\n");
  await delay(1);
  assert.equal(signal.aborted, true);
});

test("oversized results and write backlog close rather than buffer without bounds", async () => {
  const [a, b] = pair();
  const client = createBrowserClient(a);
  serveBrowserChannel(b, () => "x".repeat(1024 * 1024));
  await assert.rejects(client.request(NATIVE, "status"), { code: "browser_unavailable" });
  const blocked = new Duplex({ read() {}, write() {} });
  const other = createBrowserClient(blocked);
  const results = [];
  for (let i = 0; i < 4; i++) results.push(assert.rejects(other.request(NATIVE, "status", { text: "x".repeat(800000) }), { code: "browser_unavailable" }));
  await Promise.all(results);
  assert.ok(blocked.writableLength <= 2 * 1024 * 1024);
});


test("server deadline aborts even when the client never sets a deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const [a, b] = pair();
  let signal;
  serveBrowserChannel(b, (_request, incoming) => { signal = incoming; return new Promise(() => {}); });
  a.write(JSON.stringify(record()) + "\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(10000);
  assert.equal(signal.aborted, true);
  assert.equal(b.destroyed, true);
});

test("real inherited fd3 is duplex and timeout EOF aborts the child handler", { timeout: 10000 }, async (t) => {
  const moduleUrl = new URL("../browser-channel.mjs", import.meta.url).href;
  const source = `
    import { Socket } from 'node:net';
    import { serveBrowserChannel } from ${JSON.stringify(moduleUrl)};
    const stream = new Socket({ fd: 3, readable: true, writable: true });
    serveBrowserChannel(stream, (request, signal) => {
      if (request.operation === 'status') return { nativeSessionId: request.nativeSessionId, principal: request.principal };
      process.stdout.write('started\\n');
      signal.addEventListener('abort', () => process.stdout.write('aborted\\n'), { once: true });
      return new Promise(() => {});
    });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let output = "", stderr = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { child.kill("SIGKILL"); child.stdio[3].destroy(); });
  const client = createBrowserClient(child.stdio[3], { timeoutMs: 1000 });
  assert.deepEqual(await client.request(NATIVE, "status", {}, "operator"), { nativeSessionId: NATIVE, principal: "operator" });
  await assert.rejects(client.request(NATIVE, "input"), { code: "browser_unavailable" });
  const [code] = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(output, "started\naborted\n");
  assert.equal(client.pendingCount, 0);
});
