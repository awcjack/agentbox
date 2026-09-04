import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createRuntime, internals, normalizeConfig } from "../runtime.mjs";

const TOKEN = "correct-horse-battery-staple";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const ALL_SCOPES = ["profiles:read", "sessions:create", "sessions:read", "sessions:write", "sessions:delete"];
const RESUME_ID = "3d90a428-2ed7-4a53-8aef-b5f5489f0e63";

function config(overrides = {}) {
  const base = {
    piRpcApi: {
      host: "127.0.0.1",
      port: 0,
      executable: "/bin/pi",
      allowedOrigins: ["https://client.example"],
      auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ALL_SCOPES }] },
      allowedCommands: ["prompt", "get_state", "abort"],
      profiles: {
        default: {
          cwd: "/workspace",
          sessionDir: "/sessions",
          args: ["--approve"],
          env: { PROFILE_VALUE: "yes" },
        },
      },
      limits: {
        maxSessions: 4,
        maxSseClients: 2,
        maxBodyBytes: 1024,
        maxRecordBytes: 1024,
        maxEvents: 10,
        maxEventBytes: 4096,
        maxStderrBytes: 1024,
        maxPendingCommands: 2,
        maxPendingUi: 2,
        commandTimeoutMs: 500,
        idleTimeoutMs: 10_000,
        cleanupIntervalMs: 1_000,
        sseHeartbeatMs: 1_000,
        shutdownGraceMs: 10,
        killGraceMs: 10,
        requestTimeoutMs: 2_000,
      },
    },
  };
  const api = base.piRpcApi;
  for (const [key, value] of Object.entries(overrides)) {
    api[key] = value && typeof value === "object" && !Array.isArray(value) && typeof api[key] === "object"
      ? { ...api[key], ...value }
      : value;
  }
  return base;
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.input = "";
    this.signals = [];
    this.exited = false;
    this.stdin.on("data", (chunk) => { this.input += chunk.toString(); });
  }

  kill(signal) {
    this.signals.push(signal);
    if (!this.exited) {
      this.exited = true;
      queueMicrotask(() => this.emit("exit", null, signal));
    }
    return true;
  }

  output(value, ending = "\n") {
    this.stdout.write(`${JSON.stringify(value)}${ending}`);
  }
}

async function fixture(t, customConfig = config(), options = {}) {
  const children = [];
  const spawns = [];
  const spawn = (file, args, spawnOptions) => {
    const child = new FakeChild();
    children.push(child);
    spawns.push({ file, args, options: spawnOptions });
    return child;
  };
  const runtime = createRuntime(customConfig, {
    spawn,
    now: options.now,
    randomUUID: options.randomUUID,
    realpath: options.realpath ?? (() => "/nix/store/00000000000000000000000000000000-pi/bin/pi"),
    signalProcessGroup: options.signalProcessGroup,
  });
  const address = await runtime.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => runtime.close());
  return { runtime, children, spawns, baseUrl };
}

async function request(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.auth !== false) headers.set("Authorization", `Bearer ${options.token ?? TOKEN}`);
  if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body),
    signal: options.signal,
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function createSession(baseUrl, body = { profile: "default" }) {
  const result = await request(baseUrl, "/v1/sessions", { method: "POST", body });
  assert.equal(result.response.status, 201);
  return result.body.session.id;
}

function waitForInput(child, pattern) {
  if (pattern.test(child.input)) return Promise.resolve();
  return new Promise((resolve) => {
    const listener = () => {
      if (pattern.test(child.input)) {
        child.stdin.off("data", listener);
        resolve();
      }
    };
    child.stdin.on("data", listener);
  });
}

test("configuration requires hashed tokens and prevents command/profile escape", () => {
  assert.throws(() => normalizeConfig({ piRpcApi: { auth: { tokens: [] }, profiles: {} } }), /non-empty array/);
  assert.throws(() => normalizeConfig(config({ auth: { tokens: [{ sha256: "plaintext", scopes: ["*"] }] } })), /SHA-256/);
  assert.throws(() => normalizeConfig(config({ allowedCommands: ["prompt", "switch_session"] })), /forbidden command/);
  assert.throws(() => normalizeConfig(config({ profiles: { default: { cwd: "relative" } } })), /absolute path/);
  for (const argument of [
    "--continue", "-c", "--fork", "--mode=rpc", "--name", "-n", "--no-session",
    "--resume", "-r", "--session=other", "--session-id", "--session-id=other", "--session-dir=/tmp",
  ]) {
    assert.throws(() => normalizeConfig(config({ profiles: { default: { cwd: "/workspace", args: [argument] } } })), /supervisor-owned/);
  }
  const referenced = config({
    auth: { tokens: [{ sha256Env: "PI_RPC_TOKEN_SHA256", scopes: ["sessions:read"] }] },
    profiles: { default: { cwd: "/workspace", envReferences: { API_TOKEN: "PROFILE_API_TOKEN" } } },
  });
  const normalized = normalizeConfig(referenced, {
    PI_RPC_TOKEN_SHA256: TOKEN_HASH,
    PROFILE_API_TOKEN: "runtime-secret",
  });
  assert.equal(normalized.tokens[0].digest.toString("hex"), TOKEN_HASH);
  assert.equal(normalized.profiles.get("default").env.API_TOKEN, "runtime-secret");
  assert.equal(JSON.stringify(referenced).includes("runtime-secret"), false);
  assert.throws(() => normalizeConfig(referenced, {}), /requires environment variable PI_RPC_TOKEN_SHA256/);
  assert.throws(() => normalizeConfig(config({
    auth: { tokens: [{ sha256Env: "PI_RPC_TOKEN_SHA256", scopes: ["sessions:read"] }] },
    profiles: { default: { cwd: "/workspace", envReferences: { LEAK: "PI_RPC_TOKEN_SHA256" } } },
  }), { PI_RPC_TOKEN_SHA256: TOKEN_HASH }), /must not expose an RPC authentication variable/);
});

test("configuration rejects unknown keys, scopes, and overlapping profile session directories", () => {
  const cases = [
    [() => { const value = config(); value.unknown = true; return value; }, /runtime config contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.unknown = true; return value; }, /piRpcApi contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.auth.unknown = true; return value; }, /piRpcApi.auth contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.auth.tokens[0].unknown = true; return value; }, /tokens\[0\] contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.profiles.default.unknown = true; return value; }, /profiles.default contains unknown key unknown/],
    [() => { const value = config(); value.piRpcApi.limits.unknown = 1; return value; }, /limits contains unknown key unknown/],
  ];
  for (const [makeConfig, pattern] of cases) assert.throws(() => normalizeConfig(makeConfig()), pattern);
  assert.throws(() => normalizeConfig(config({ auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ["unknown"] }] } })), /unknown scope/);
  assert.throws(() => normalizeConfig(config({
    profiles: {
      first: { cwd: "/workspace", sessionDir: "/sessions" },
      second: { cwd: "/workspace", sessionDir: "/sessions/nested" },
    },
  })), /must not overlap/);
  assert.throws(() => normalizeConfig(config({ profiles: { default: { cwd: "/workspace", sessionDir: "/sessions/../other" } } })), /must be normalized/);
});

test("runtime resolves the configured executable to the immutable Nix store", () => {
  assert.throws(() => normalizeConfig(config({ executable: "pi" })), /absolute path/);
  assert.throws(() => createRuntime(config(), { spawn() {}, realpath: () => "/tmp/pi" }), /immutable Nix store path/);
  assert.throws(() => createRuntime(config(), { spawn() {}, realpath: () => { throw new Error("missing"); } }), /could not be resolved: missing/);
});

test("liveness and readiness are public and all responses receive security headers", async (t) => {
  const { baseUrl } = await fixture(t);
  const live = await request(baseUrl, "/health/live", { auth: false });
  assert.equal(live.response.status, 200);
  assert.deepEqual(live.body, { status: "alive" });
  const ready = await request(baseUrl, "/health/ready", { auth: false });
  assert.equal(ready.response.status, 200);
  assert.deepEqual(ready.body, { status: "ready" });
  assert.equal(ready.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ready.response.headers.get("x-frame-options"), "DENY");
  assert.equal(ready.response.headers.get("cache-control"), "no-store");
  const obsolete = await request(baseUrl, "/health", { auth: false });
  assert.equal(obsolete.response.status, 404);

  const missing = await request(baseUrl, "/v1/profiles", { auth: false });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.response.headers.get("www-authenticate"), 'Bearer realm="pi-rpc-runtime"');
  const wrong = await request(baseUrl, "/v1/profiles", { token: "wrong" });
  assert.equal(wrong.response.status, 401);
});

test("scopes and browser origins are enforced", async (t) => {
  const limited = "write-token";
  const cfg = config({
    auth: { tokens: [{ sha256: createHash("sha256").update(limited).digest("hex"), scopes: ["sessions:write"] }] },
  });
  const { baseUrl } = await fixture(t, cfg);
  const denied = await request(baseUrl, "/v1/profiles", { token: limited });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, "insufficient_scope");

  const originDenied = await request(baseUrl, "/health/ready", { auth: false, headers: { Origin: "https://evil.example" } });
  assert.equal(originDenied.response.status, 403);
  const originAllowed = await request(baseUrl, "/health/ready", { auth: false, headers: { Origin: "https://client.example" } });
  assert.equal(originAllowed.response.headers.get("access-control-allow-origin"), "https://client.example");
});

test("session creation uses an isolated environment and exact profile-owned resume IDs", async (t) => {
  process.env.RUNTIME_SECRET_LEAK = "must-not-reach-child";
  t.after(() => { delete process.env.RUNTIME_SECRET_LEAK; });
  const { baseUrl, spawns } = await fixture(t);
  const invalid = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { profile: "default", resume: "../../secret" },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(spawns.length, 0);

  const partial = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { profile: "default", resume: "abc-123" },
  });
  assert.equal(partial.response.status, 400);

  const id = await createSession(baseUrl, { profile: "default", resume: RESUME_ID, name: "Review" });
  assert.match(id, /^[0-9a-f-]{36}$/i);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, "/nix/store/00000000000000000000000000000000-pi/bin/pi");
  assert.deepEqual(spawns[0].args, [
    "--mode", "rpc", "--session-dir", "/sessions", "--session", RESUME_ID, "--name", "Review", "--approve",
  ]);
  assert.equal(spawns[0].options.cwd, "/workspace");
  assert.deepEqual(spawns[0].options.env, {
    HOME: "/home/agent",
    XDG_CONFIG_HOME: "/home/agent/.config",
    XDG_CACHE_HOME: "/home/agent/.cache",
    USER: "agent",
    LOGNAME: "agent",
    SHELL: "/bin/bash",
    PATH: "/run/wrappers/bin:/home/agent/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/home/agent/.local/bin:/home/agent/.bun/bin:/home/agent/.cargo/bin:/bin:/usr/bin:/usr/local/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: "/tmp",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    PROFILE_VALUE: "yes",
  });
  assert.deepEqual(spawns[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(spawns[0].options.detached, process.platform !== "win32");

  const duplicate = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { profile: "default", resume: RESUME_ID },
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(spawns.length, 1);
});

test("resume is disabled without a profile-owned session directory", async (t) => {
  const cfg = config({ profiles: { default: { cwd: "/workspace" } } });
  const { baseUrl, spawns } = await fixture(t, cfg);
  const result = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { profile: "default", resume: RESUME_ID },
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error.code, "invalid_resume");
  assert.equal(spawns.length, 0);
});

test("read RPC commands require read scope and mutating commands require write scope", async (t) => {
  const readToken = "read-token";
  const writeToken = "write-token";
  const cfg = config({
    auth: {
      tokens: [
        { sha256: TOKEN_HASH, scopes: ALL_SCOPES },
        { sha256: createHash("sha256").update(readToken).digest("hex"), scopes: ["sessions:read"] },
        { sha256: createHash("sha256").update(writeToken).digest("hex"), scopes: ["sessions:write"] },
      ],
    },
  });
  const { baseUrl, children } = await fixture(t, cfg);
  const id = await createSession(baseUrl);

  const writeRead = await request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST", token: writeToken, body: { type: "get_state" },
  });
  assert.equal(writeRead.response.status, 403);
  assert.equal(children[0].input, "");

  const readPromise = request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST", token: readToken, body: { type: "get_state" },
  });
  await waitForInput(children[0], /"type":"get_state"/);
  const readCommand = JSON.parse(children[0].input.trim());
  children[0].output({ type: "response", id: readCommand.id, command: "get_state", success: true });
  assert.equal((await readPromise).response.status, 200);

  const readWrite = await request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST", token: readToken, body: { type: "prompt", message: "hello" },
  });
  assert.equal(readWrite.response.status, 403);
});

test("allowed commands use LF JSON framing and correlated responses", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  const responsePromise = request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST",
    body: { id: "client-1", type: "get_state" },
  });
  await waitForInput(children[0], /\n$/);
  assert.equal(children[0].input, '{"id":"client-1","type":"get_state"}\n');
  children[0].stdout.write('{"type":"response","id":"client-1","command":"get_state",');
  children[0].stdout.write('"success":true}\n');
  const result = await responsePromise;
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { type: "response", id: "client-1", command: "get_state", success: true });

  const generatedPromise = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "abort" } });
  await waitForInput(children[0], /"type":"abort","id":"runtime-/);
  const generated = JSON.parse(children[0].input.trim().split("\n").at(-1));
  children[0].output({ type: "response", id: generated.id, command: "abort", success: true });
  const generatedResult = await generatedPromise;
  assert.equal("id" in generatedResult.body, false);
});

test("forbidden and unknown commands never reach Pi", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  const before = children[0].input;
  for (const type of ["bash", "switch_session", "not_a_command"]) {
    const result = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type } });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "command_forbidden");
  }
  assert.equal(children[0].input, before);
});

test("strict LF records preserve Unicode separators and protocol faults kill the child", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  children[0].output({ type: "notice", text: "one\u2028two\u2029three" }, "\r\n");
  await new Promise((resolve) => setImmediate(resolve));
  const details = await request(baseUrl, `/v1/sessions/${id}`);
  assert.equal(details.body.session.status, "running");

  children[0].stdout.write("not-json\n");
  await once(children[0], "exit");
  assert.deepEqual(children[0].signals, ["SIGKILL"]);
  const failed = await request(baseUrl, `/v1/sessions/${id}`);
  assert.equal(failed.body.session.status, "failed");
  assert.ok(failed.body.session.exit);
});

test("stderr and event history are bounded and SSE reports replay gaps", async (t) => {
  const cfg = config({ limits: { maxEvents: 2, maxEventBytes: 1024, maxStderrBytes: 1024 } });
  const { baseUrl, children } = await fixture(t, cfg);
  const id = await createSession(baseUrl);
  children[0].stderr.write(`discard-${"x".repeat(1100)}-tail`);
  children[0].output({ type: "event", n: 1 });
  children[0].output({ type: "event", n: 2 });
  children[0].output({ type: "event", n: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  const details = await request(baseUrl, `/v1/sessions/${id}`);
  assert.ok(Buffer.byteLength(details.body.session.stderr) <= 1024 + 3);
  assert.match(details.body.session.stderr, /-tail$/);

  const controller = new AbortController();
  const stream = await fetch(`${baseUrl}/v1/sessions/${id}/events`, {
    headers: { Authorization: `Bearer ${TOKEN}`, "Last-Event-ID": "1" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const { value } = await stream.body.getReader().read();
  const replay = new TextDecoder().decode(value);
  assert.match(replay, /event: reset/);
  assert.match(replay, /oldestEventId/);
  assert.match(replay, /"n":3/);
  assert.doesNotMatch(replay, /"n":1/);
  controller.abort();
});

test("extension dialogs only accept method-correct, single-use responses", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  children[0].output({ type: "extension_ui_request", id: "select-1", method: "select", title: "Choose", options: ["A", "B"] });
  await new Promise((resolve) => setImmediate(resolve));

  const invalid = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "select-1", value: "C" },
  });
  assert.equal(invalid.response.status, 400);
  const ambiguous = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "select-1", value: "B", confirmed: true },
  });
  assert.equal(ambiguous.response.status, 400);
  const accepted = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "select-1", value: "B" },
  });
  assert.equal(accepted.response.status, 202);
  assert.match(children[0].input, /{"type":"extension_ui_response","id":"select-1","value":"B"}\n$/);
  const replay = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "select-1", value: "A" },
  });
  assert.equal(replay.response.status, 404);

  children[0].output({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Wait", timeout: 20 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const expired = await request(baseUrl, `/v1/sessions/${id}/ui`, {
    method: "POST",
    body: { id: "confirm-1", confirmed: true },
  });
  assert.equal(expired.response.status, 404);
});

test("body, session, pending-command, and timeout limits are enforced", async (t) => {
  const cfg = config({
    limits: { maxSessions: 1, maxBodyBytes: 1024, maxPendingCommands: 1, commandTimeoutMs: 30 },
  });
  const { baseUrl } = await fixture(t, cfg);
  const oversized = await request(baseUrl, "/v1/sessions", {
    method: "POST",
    body: `{"profile":"default","padding":"${"x".repeat(1100)}"}`,
  });
  assert.equal(oversized.response.status, 413);
  const id = await createSession(baseUrl);
  const second = await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } });
  assert.equal(second.response.status, 429);

  const firstPromise = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { id: "wait", type: "get_state" } });
  await new Promise((resolve) => setImmediate(resolve));
  const pending = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { id: "other", type: "get_state" } });
  assert.equal(pending.response.status, 429);
  const timedOut = await firstPromise;
  assert.equal(timedOut.response.status, 504);
});

test("exited sessions do not consume the active session quota", async (t) => {
  const cfg = config({ limits: { maxSessions: 1 } });
  const { baseUrl, children, spawns } = await fixture(t, cfg);
  await createSession(baseUrl);
  children[0].exited = true;
  children[0].emit("exit", 0, null);
  await createSession(baseUrl);
  assert.equal(spawns.length, 2);
});

test("termination signals the detached child process group when available", async (t) => {
  const groupSignals = [];
  let child;
  const { baseUrl, children } = await fixture(t, config(), {
    signalProcessGroup(pid, signal) {
      groupSignals.push({ pid, signal });
      child.kill(signal);
    },
  });
  const id = await createSession(baseUrl);
  child = children[0];
  child.pid = 4242;
  await request(baseUrl, `/v1/sessions/${id}`, { method: "DELETE" });
  assert.deepEqual(groupSignals, [{ pid: 4242, signal: "SIGTERM" }]);
});

test("runtime supervisor bounds logs and stops a crash loop", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-rpc-supervisor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimePath = join(directory, "runtime.sh");
  const countPath = join(directory, "count");
  const logPath = join(directory, "runtime.log");
  await writeFile(runtimePath, `#!/usr/bin/env bash\nprintf x >> ${JSON.stringify(countPath)}\nprintf '%s\\n' '${"x".repeat(2048)}'\nexit 7\n`);
  await chmod(runtimePath, 0o755);
  const bash = process.env.TEST_BASH ?? "/bin/bash";
  const result = spawnSync(bash, [new URL("../supervise.sh", import.meta.url).pathname], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PI_RPC_RUNTIME_EXECUTABLE: runtimePath,
      PI_RPC_LOG_FILE: logPath,
      PI_RPC_MAX_LOG_BYTES: "1024",
      PI_RPC_MAX_CRASHES: "3",
      PI_RPC_STABLE_SECONDS: "60",
      PI_RPC_INITIAL_BACKOFF_SECONDS: "0",
      PI_RPC_MAX_BACKOFF_SECONDS: "0",
    },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(await readFile(countPath, "utf8"), "xxx");
  assert.ok((await stat(logPath)).size <= 1024);
  assert.match(await readFile(logPath, "utf8"), /giving up$/m);
});

test("idle cleanup and graceful close terminate every child", async (t) => {
  let currentTime = 1_000;
  const cfg = config({
    limits: { idleTimeoutMs: 100, cleanupIntervalMs: 50, shutdownGraceMs: 10, killGraceMs: 10 },
  });
  const { runtime, baseUrl, children } = await fixture(t, cfg, { now: () => currentTime });
  await createSession(baseUrl);
  currentTime = 2_000;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(runtime.sessions.size, 0);
  assert.match(children[0].input, /{"type":"abort"}\n/);

  await createSession(baseUrl);
  await runtime.close();
  assert.equal(runtime.sessions.size, 0);
  assert.equal(children.every((child) => child.exited), true);
});

test("LF parser rejects overlong unterminated records", async () => {
  const stream = new PassThrough();
  const errors = [];
  internals.attachLfJsonReader(stream, 8, () => assert.fail("record should not parse"), (error) => errors.push(error));
  stream.write("123456789");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /unterminated record/);
});
