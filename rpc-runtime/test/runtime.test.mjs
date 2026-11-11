import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { serveBrowserChannel } from "../browser-channel.mjs";
import test from "node:test";
import { createRuntime, internals, normalizeConfig } from "../runtime.mjs";

const TOKEN = "correct-horse-battery-staple";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const ALL_SCOPES = ["profiles:read", "sessions:create", "sessions:read", "sessions:write", "sessions:delete"];
const RESUME_ID = "3d90a428-2ed7-4a53-8aef-b5f5489f0e63";

test("sandbox schema defaults disabled and validates keys, types and paths", () => {
  assert.deepEqual(normalizeConfig(config(), {}).sandbox, {
    enable: false, executable: undefined, readOnlyPaths: [], readWritePaths: [],
    sshAgentSocket: null, sshKnownHostsPath: "/home/agent/.ssh/known_hosts",
  });
  const sandbox = { enable: true, executable: "/bin/bwrap", readOnlyPaths: ["/opt/tools"], readWritePaths: ["/var/cache/tool"], sshAgentSocket: null, sshKnownHostsPath: "/home/agent/.ssh/known_hosts" };
  assert.deepEqual(normalizeConfig(config({ sandbox }), {}).sandbox, sandbox);
  assert.equal(normalizeConfig(config({ sandbox: { enable: true } }), { PI_RPC_SANDBOX_EXECUTABLE: "/bin/bwrap" }).sandbox.executable, "/bin/bwrap");
  for (const [value, pattern] of [
    [null, /must be an object/],
    [{ extra: true }, /unknown key extra/],
    [{ enable: "true" }, /enable must be a boolean/],
    [{ enable: true }, /executable must be an absolute path/],
    [{ executable: 42 }, /executable must be an absolute path/],
    [{ executable: "bwrap" }, /executable must be an absolute path/],
    [{ sshAgentSocket: "relative" }, /sshAgentSocket must be a normalized absolute path/],
    [{ sshAgentSocket: 42 }, /sshAgentSocket must be a normalized absolute path/],
    [{ sshAgentSocket: "/tmp/../agent.sock" }, /sshAgentSocket must be a normalized absolute path/],
    [{ sshKnownHostsPath: null }, /sshKnownHostsPath must be a normalized absolute path/],
    [{ sshKnownHostsPath: "relative" }, /sshKnownHostsPath must be a normalized absolute path/],
    [{ readOnlyPaths: null }, /must be an array/],
    [{ readWritePaths: "/tmp" }, /must be an array/],
    [{ readOnlyPaths: [42] }, /must be an array/],
    [{ readOnlyPaths: ["relative"] }, /normalized absolute paths/],
    [{ readWritePaths: ["/tmp/../var"] }, /normalized absolute paths/],
    [{ readWritePaths: ["/tmp/\u0000bad"] }, /normalized absolute paths/],
  ]) assert.throws(() => normalizeConfig(config({ sandbox: value }), {}), pattern);
  assert.throws(() => normalizeConfig(config({ sandbox, profiles: { default: { cwd: "/workspace" } } }), {}), /sessionDir must be a normalized absolute path when sandbox is enabled/);
});

test("sandbox accepts normalized session directories for explicit and discovered profiles", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), sessions = join(root, "sessions");
  await mkdir(join(workspace, "project"), { recursive: true });
  await mkdir(sessions);
  const normalized = normalizeConfig(config({
    sandbox: { enable: true, executable: "/bin/bwrap" },
    profiles: { default: { cwd: workspace, sessionDir: join(sessions, "default") } },
    autoDiscoverProfiles: { enable: true, root: workspace, sessionDirPrefix: sessions },
  }), {});
  assert.deepEqual(normalized.discoveredProfiles, ["project"]);
  assert.equal(normalized.profiles.get("project").sessionDir, join(sessions, "--project--"));
  assert.equal(normalized.sandbox.enable, true);
});

test("SSH forwarding is per-profile, explicit, and requires a sandbox socket", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-ssh-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"), sessions = join(root, "sessions");
  await mkdir(join(workspace, "project"), { recursive: true });
  await mkdir(sessions);
  const sandbox = { enable: true, executable: "/bin/bwrap", sshAgentSocket: "/run/dedicated-agent.sock" };
  const profiles = { default: { cwd: workspace, sessionDir: join(sessions, "default"), sshAgentForwarding: false } };
  const cfg = config({ sandbox, profiles,
    autoDiscoverProfiles: { enable: true, root: workspace, sessionDirPrefix: sessions, sshAgentForwarding: true },
  });
  const normalized = normalizeConfig(cfg, {});
  assert.equal(normalized.profiles.get("default").sshAgentForwarding, false);
  assert.equal(normalized.profiles.get("project").sshAgentForwarding, true);
  assert.equal(normalizeConfig(config(), {}).profiles.get("default").sshAgentForwarding, false);
  for (const key of ["sshAgentSocket", "sshKnownHostsPath"]) {
    for (const source of [join(workspace, "agent-source"), join(sessions, "default", "agent-source")]) {
      assert.throws(() => normalizeConfig({ ...cfg, piRpcApi: {
        ...cfg.piRpcApi, sandbox: { ...sandbox, [key]: source },
      } }, {}), /SSH sources must not be inside any profile/);
    }
  }
  for (const broken of [{ enable: false }, { enable: true, executable: "/bin/bwrap" }]) {
    assert.throws(() => normalizeConfig({ ...cfg, piRpcApi: { ...cfg.piRpcApi, sandbox: broken } }, {}), /SSH forwarding requires/);
  }
  assert.throws(() => normalizeConfig(config({ profiles: { default: { ...profiles.default, sshAgentForwarding: "true" } } }), {}), /sshAgentForwarding must be a boolean/);
  assert.throws(() => normalizeConfig({ ...cfg, piRpcApi: { ...cfg.piRpcApi, autoDiscoverProfiles: { ...cfg.piRpcApi.autoDiscoverProfiles, sshAgentForwarding: "true" } } }, {}), /sshAgentForwarding must be a boolean/);
});

test("sandbox executable must resolve to an immutable store path before any spawn", () => {
  const cfg = config({ sandbox: { enable: true, executable: "/bin/bwrap" } });
  let spawned = false;
  for (const missing of [false, true]) {
    assert.throws(() => createRuntime(cfg, {
      spawn() { spawned = true; },
      realpath(path) {
        if (path === "/bin/pi") return "/nix/store/00000000000000000000000000000000-pi/bin/pi";
        if (missing) throw new Error("missing sandbox");
        return "/tmp/bwrap";
      },
    }), missing ? /sandbox.executable could not be resolved: missing sandbox/ : /sandbox.executable must resolve to an immutable Nix store path/);
  }
  assert.equal(spawned, false);
});

const SANDBOX_STORE_EXECUTABLE = "/nix/store/11111111111111111111111111111111-bubblewrap/bin/bwrap";
const sandboxRealpath = (path) => path === "/bin/bwrap" ? SANDBOX_STORE_EXECUTABLE : "/nix/store/00000000000000000000000000000000-pi/bin/pi";

test("enabled sandbox wraps Pi and creates session storage before launch", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), sessionDir = join(root, "history", "default");
  await mkdir(cwd);
  const { baseUrl, spawns } = await fixture(t, config({
    sandbox: { enable: true, executable: "/bin/bwrap" },
    profiles: { default: { cwd, sessionDir, args: ["--approve"] } },
  }), { realpath: sandboxRealpath });
  const id = await createSession(baseUrl, { profile: "default" });
  assert.equal((await stat(sessionDir)).isDirectory(), true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, SANDBOX_STORE_EXECUTABLE);
  assert.ok(spawns[0].args.includes("--ro-bind"));
  assert.ok(spawns[0].args.includes(cwd));
  assert.ok(spawns[0].args.includes(sessionDir));
  const command = spawns[0].args.indexOf("/nix/store/00000000000000000000000000000000-pi/bin/pi");
  assert.ok(command > 0);
  assert.deepEqual(spawns[0].args.slice(command + 1), ["--mode", "rpc", "--session-dir", sessionDir, "--session-id", id, "--approve"]);
});

test("sandbox policy failures never spawn an unconfined Pi", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-reject-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const { baseUrl, spawns } = await fixture(t, config({
    sandbox: { enable: true, executable: "/bin/bwrap" },
    profiles: { default: { cwd, sessionDir: root } },
  }), { realpath: sandboxRealpath });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } });
    assert.equal(result.response.status, 502);
    assert.equal(result.body.error.code, "spawn_failed");
    assert.equal(spawns.length, 0);
  }
});

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

function browserDuplexPair() {
  let a, b;
  const endpoint = (peer) => new Duplex({
    read() {},
    write(chunk, encoding, done) { peer().push(Buffer.from(chunk)); done(); },
    final(done) { peer().push(null); done(); },
    destroy(error, done) { if (!peer().destroyed) peer().destroy(); done(error); },
  });
  a = endpoint(() => b); b = endpoint(() => a);
  return [a, b];
}

class FakeChild extends EventEmitter {
  constructor(browser = false) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdio = [this.stdin, this.stdout, this.stderr];
    if (browser) [this.stdio[3], this.browserPeer] = browserDuplexPair();
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
    const child = new FakeChild(spawnOptions.stdio.length === 4);
    if (child.browserPeer && options.browserHandler) serveBrowserChannel(child.browserPeer, options.browserHandler);
    children.push(child);
    spawns.push({ file, args, options: spawnOptions });
    options.onSpawn?.(child, args);
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

for (const missing of [true, false]) test(`resume ${missing ? "rebases missing" : "retains existing"} project cwd before spawning Pi`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-missing-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = join(root, "sessions"), orphanDir = join(root, "orphan");
  await mkdir(sessionDir);
  await mkdir(orphanDir);
  const path = join(orphanDir, `saved_${RESUME_ID}.jsonl`);
  const tail = '\n{"type":"custom","id":"entry","data":"preserve me"}\n';
  const header = { type: "session", version: 3, id: RESUME_ID, cwd: join(root, "project"), timestamp: "2026-01-01T00:00:00Z" };
  if (!missing) await mkdir(header.cwd);
  await writeFile(path, JSON.stringify(header) + tail);
  let observedHeader;
  const cfg = config({ profiles: { default: { cwd: root, sessionDir } } });
  const f = await fixture(t, cfg, { onSpawn: () => { observedHeader = JSON.parse(readFileSync(path, "utf8").split("\n")[0]); } });
  // Orphan directories are normally populated by startup auto-discovery.
  f.runtime.config.profiles.get("default").extraSessionDirs = [orphanDir];
  f.runtime.config.profiles.get("default").allowSubdirectories = true;
  const result = await request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: RESUME_ID } });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  const expectedCwd = missing ? root : header.cwd;
  assert.equal(f.spawns[0].options.cwd, expectedCwd);
  assert.deepEqual(observedHeader, { ...header, cwd: expectedCwd });
  assert.equal(await readFile(path, "utf8"), JSON.stringify({ ...header, cwd: expectedCwd }) + tail);
  const history = await request(f.baseUrl, "/v1/history?profile=default");
  assert.equal(history.response.status, 200);
  assert.ok(history.body.sessions.some((session) => session.id === RESUME_ID));
});

test("end stops the child and archives history across runtime restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-archive-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = config({ profiles: { default: { cwd: "/workspace", sessionDir: root } } });
  const first = await fixture(t, settings);
  const created = (await request(first.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).body.session;
  const source = join(root, `${created.nativeSessionId}.jsonl`);
  const original = JSON.stringify({ type: "session", version: 3, id: created.nativeSessionId, cwd: "/workspace" }) + "\n";
  await writeFile(source, original);
  // A failed archive must retain the stopped runtime slot for an explicit retry.
  const marker = join(root, `.archived-${created.nativeSessionId}`);
  await mkdir(marker);
  const failed = await request(first.baseUrl, `/v1/sessions/${created.id}`, { method: "DELETE" });
  assert.equal(failed.body.error.code, "archive_failed");
  assert.equal(first.children[0].exited, true);
  assert.equal((await request(first.baseUrl, "/v1/sessions")).body.sessions.length, 1);
  await rm(marker, { recursive: true });
  assert.equal((await request(first.baseUrl, `/v1/sessions/${created.id}`, { method: "DELETE" })).response.status, 204);
  assert.equal((await request(first.baseUrl, "/v1/sessions")).body.sessions.length, 0);
  await first.runtime.close();
  const second = await fixture(t, settings);
  assert.deepEqual((await request(second.baseUrl, "/v1/history?profile=default")).body.sessions, []);
  const archived = await request(second.baseUrl, "/v1/history?profile=default&includeArchived=true");
  assert.equal(archived.body.sessions[0].id, created.nativeSessionId);
  assert.equal(await readFile(source, "utf8"), original);
  assert.equal(archived.body.sessions[0].archived, true);
  const reopened = await request(second.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: created.nativeSessionId } });
  assert.equal(reopened.response.status, 201);
  assert.equal((await request(second.baseUrl, `/v1/sessions/${reopened.body.session.id}`, { method: "DELETE" })).response.status, 204);
  const rearchived = await request(second.baseUrl, "/v1/history?profile=default&includeArchived=true");
  assert.equal(rearchived.body.sessions.length, 1);
  assert.equal(rearchived.body.sessions[0].id, created.nativeSessionId);
  assert.equal(rearchived.body.sessions[0].archived, true);
  assert.equal(await readFile(source, "utf8"), original);
});

test("list metadata tracks all sessions without per-session RPC or SSE subscriptions", async (t) => {
  const { baseUrl, children } = await fixture(t);
  const create = () => request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } });
  const first = (await create()).body.session;
  const second = (await create()).body.session;
  const activity = async (id = first.id) => (await request(baseUrl, "/v1/sessions")).body.sessions.find((session) => session.id === id)?.activity;
  const completion = async () => (await request(baseUrl, "/v1/sessions")).body.sessions.find((session) => session.id === first.id).settledEventId;
  assert.equal(await completion(), null, "a fresh idle process is not a finished run");
  assert.equal(await activity(), "starting");
  children[0].output({ type: "agent_start" });
  assert.equal(await activity(), "running");
  assert.equal(await activity(second.id), "starting");
  children[0].output({ type: "extension_ui_request", id: "reply", method: "input", title: "Answer?" });
  assert.equal(await activity(), "waiting_reply");
  children[0].output({ type: "extension_ui_request", id: "approval", method: "confirm", title: "Allow?" });
  assert.equal(await activity(), "waiting_action");
  await request(baseUrl, `/v1/sessions/${first.id}/ui`, { method: "POST", body: { id: "approval", confirmed: false } });
  assert.equal(await activity(), "waiting_reply");
  await request(baseUrl, `/v1/sessions/${first.id}/ui`, { method: "POST", body: { id: "reply", value: "yes" } });
  children[0].output({ type: "agent_end" });
  assert.equal(await activity(), "running", "a low-level run end can still continue automatically");
  assert.equal(await completion(), null, "agent_end is not full completion");
  children[0].output({ type: "agent_settled" });
  assert.equal(await activity(), "idle");
  const firstCompletion = await completion();
  assert.ok(firstCompletion > 0);
  for (let i = 0; i < 12; i++) children[0].output({ type: "extension_ui_request", method: "notify", message: "hello" });
  assert.equal(await completion(), firstCompletion, "completion survives replay eviction and unrelated events");
  children[0].output({ type: "agent_start" });
  children[0].output({ type: "agent_settled" });
  assert.ok(await completion() > firstCompletion, "short runs between list requests retain distinct completion IDs");
  children[0].output({ type: "compaction_start", reason: "manual" });
  assert.equal(await activity(), "running");
  children[0].output({ type: "compaction_end", reason: "manual" });
  assert.equal(await activity(), "idle");
  const deleted = await request(baseUrl, `/v1/sessions/${first.id}`, { method: "DELETE" });
  assert.equal(deleted.response.status, 204);
  assert.equal(await activity(), undefined);
  assert.equal(await activity(second.id), "starting");
});

test("live metadata retains first-message titles and explicit names override previews", async (t) => {
  const f = await fixture(t);
  const session = (await request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).body.session;
  const child = f.children[0];
  const name = async () => (await request(f.baseUrl, "/v1/sessions")).body.sessions[0].name;
  assert.equal(await name(), null);
  child.output({ type: "response", command: "get_messages", success: true, data: { messages: [{ role: "user", content: "Inspect this project" }] } });
  assert.equal(await name(), "Inspect this project");
  child.output({ type: "response", command: "get_state", success: true, data: { sessionName: "", sessionId: session.nativeSessionId } });
  assert.equal(await name(), "Inspect this project", "an unnamed native snapshot does not erase the preview");
  child.output({ type: "response", command: "get_messages", success: true, data: { messages: [{ role: "user", content: "Later compacted context" }] } });
  assert.equal(await name(), "Inspect this project");
  child.output({ type: "response", command: "get_state", success: true, data: { sessionName: "Explicit name" } });
  assert.equal(await name(), "Explicit name");
});

test("expired approval replies remain single-use and never reach Pi", async (t) => {
  const f = await fixture(t);
  const session = (await request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).body.session;
  f.children[0].output({ type: "extension_ui_request", id: "expired", method: "confirm", title: "Allow?", timeout: 10 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const result = await request(f.baseUrl, `/v1/sessions/${session.id}/ui`, { method: "POST", body: { id: "expired", confirmed: true } });
  assert.equal(result.body.error.code, "ui_request_not_found");
  assert.equal(f.children[0].input, "");
  assert.deepEqual((await request(f.baseUrl, `/v1/sessions/${session.id}`)).body.session.pendingUi, []);
});

test("auto mode changes require write scope, native identity, extension support and prompt permission", async (t) => {
  const reader = "read-only-token";
  const f = await fixture(t, config({ auth: { tokens: [
    { sha256: TOKEN_HASH, scopes: ALL_SCOPES },
    { sha256: createHash("sha256").update(reader).digest("hex"), scopes: ["sessions:read"] },
  ] } }));
  const session = (await request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).body.session;
  const route = `/v1/sessions/${session.id}/auto`;
  const change = (body, extra = {}) => request(f.baseUrl, route, { method: "POST", body, headers: { "X-Pi-Session-Id": session.nativeSessionId }, ...extra });
  const child = f.children[0];
  assert.equal(session.autoMode, null);
  assert.equal((await change({ enabled: true })).body.error.code, "auto_mode_unavailable");
  const status = (available, enabled) => child.output({ type: "extension_ui_request", method: "setStatus", statusKey: "agentbox-auto", statusText: JSON.stringify({ available, enabled }) });
  status(true, false);
  assert.equal((await change({ enabled: true }, { token: reader })).response.status, 403);
  assert.equal((await change({ enabled: true }, { headers: { "X-Pi-Session-Id": RESUME_ID } })).response.status, 409);
  for (const body of [{}, { enabled: "yes" }, { enabled: true, command: "other" }, []]) {
    assert.equal((await change(body)).response.status, 400);
  }
  assert.equal(child.input, "", "rejected changes never send a command");
  let hold = false, suppressStatus = false, pending;
  const commands = [];
  child.stdin.on("data", (chunk) => {
    const command = JSON.parse(chunk.toString()); commands.push(command);
    if (hold) { pending = command; return; }
    if (!suppressStatus) status(true, command.message === "/auto on");
    child.output({ type: "response", id: command.id, command: "prompt", success: true });
  });
  assert.deepEqual((await change({ enabled: true })).body.autoMode, { available: true, enabled: true });
  assert.deepEqual((await change({ enabled: false })).body.autoMode, { available: true, enabled: false });
  assert.deepEqual(commands.map(({ type, message }) => ({ type, message })), [{ type: "prompt", message: "/auto on" }, { type: "prompt", message: "/auto off" }]);
  const meta = (await request(f.baseUrl, `/v1/sessions/${session.id}`)).body.session;
  assert.deepEqual(meta.autoMode, { available: true, enabled: false });
  suppressStatus = true;
  assert.equal((await change({ enabled: true })).body.error.code, "auto_mode_unchanged", "RPC success alone must not optimistically enable auto");
  suppressStatus = false;
  hold = true;
  const first = change({ enabled: true });
  const deadline = Date.now() + 1000;
  while (!pending) {
    assert.ok(Date.now() < deadline, "auto command reached Pi");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal((await change({ enabled: false })).body.error.code, "auto_mode_busy");
  status(true, true);
  child.output({ type: "response", id: pending.id, command: "prompt", success: true });
  assert.equal((await first).response.status, 200);
  hold = false;
  status(false, false);
  assert.equal((await change({ enabled: true })).body.error.code, "auto_mode_unavailable");
  child.output({ type: "extension_ui_request", method: "setStatus", statusKey: "agentbox-auto", statusText: '{"available":true,"enabled":"yes"}' });
  assert.equal((await change({ enabled: true })).body.error.code, "auto_mode_unavailable");

  const restricted = await fixture(t, config({ allowedCommands: ["get_state"] }));
  const blocked = (await request(restricted.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).body.session;
  restricted.children[0].output({ type: "extension_ui_request", method: "setStatus", statusKey: "agentbox-auto", statusText: '{"available":true,"enabled":false}' });
  assert.equal((await request(restricted.baseUrl, `/v1/sessions/${blocked.id}/auto`, { method: "POST", body: { enabled: true } })).body.error.code, "command_forbidden");
});

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

async function conversationFixture(t, overrides = {}, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-conversation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = config({ allowedCommands: ["prompt", "get_state", "get_entries", "abort"],
    profiles: { default: { cwd: "/workspace", sessionDir: root } }, limits: { maxRecordBytes: 64 * 1024 }, ...overrides });
  const f = await fixture(t, cfg, { onSpawn(child, args) {
    const path = args.includes("--session") ? args[args.indexOf("--session") + 1] : null;
    const records = path ? readFileSync(path, "utf8").trim().split("\n").map(JSON.parse) : [];
    child.nativeId = records[0]?.id ?? args[args.indexOf("--session-id") + 1];
    child.entries = records.slice(1);
    child.state = { isStreaming: false, isCompacting: false, pendingMessageCount: 0, model: { provider: "test", id: "model" },
      thinkingLevel: "off", autoCompactionEnabled: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time" };
    child.stdin.on("data", (chunk) => {
      for (const line of chunk.toString().trim().split("\n")) {
        const command = JSON.parse(line);
        if (["set_model", "set_thinking_level", "set_auto_compaction", "set_steering_mode", "set_follow_up_mode"].includes(command.type)) {
          const values = { set_model: ["model", { provider: command.provider, id: command.modelId }], set_thinking_level: ["thinkingLevel", command.level],
            set_auto_compaction: ["autoCompactionEnabled", command.enabled], set_steering_mode: ["steeringMode", command.mode], set_follow_up_mode: ["followUpMode", command.mode] };
          const [key, value] = values[command.type];
          if (!child.ignoreSettings) child.state[key] = value;
          setImmediate(() => child.output({ type: "response", id: command.id, command: command.type, success: !child.rejectSettings }));
          continue;
        }
        if (!["get_state", "get_entries"].includes(command.type)) continue;
        const respond = () => {
          options.beforeRead?.(child, command, f);
          const data = command.type === "get_state" ? { sessionId: child.nativeId, ...child.state }
            : { entries: child.entries, leafId: child.leafId === undefined ? child.entries.at(-1)?.id ?? null : child.leafId };
          child.output({ id: command.id, type: "response", command: command.type, success: true, data });
        };
        if (child.holdReads) child.releaseRead = respond;
        else setImmediate(respond);
      }
    });
    options.onSpawn?.(child, args);
  } });
  const id = await createSession(f.baseUrl);
  const source = f.children[0];
  f.source = source;
  const entry = (id, parentId, type, rest) => ({ id, parentId, type, timestamp: "2026-09-10T00:00:00.000Z", ...rest });
  source.entries = [
    entry("model", null, "model_change", { provider: "test", modelId: "model" }),
    entry("u1", "model", "message", { message: { role: "user", content: "same", timestamp: 1 } }),
    entry("a1", "u1", "message", { message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 } }),
    entry("offbranch", "a1", "message", { message: { role: "user", content: "not active", timestamp: 3 } }),
    entry("u2", "a1", "message", { message: { role: "user", content: [{ type: "text", text: "same" }, { type: "image", data: "YWJj", mimeType: "image/png" }], timestamp: 4 } }),
    entry("a2", "u2", "message", { message: { role: "assistant", content: [], timestamp: 5 } }),
  ];
  const path = join(root, `source_${source.nativeId}.jsonl`);
  const persist = () => writeFile(path, [JSON.stringify({ type: "session", version: 3, id: source.nativeId, cwd: "/workspace", timestamp: "2026-09-10T00:00:00.000Z" }), ...source.entries.map((e) => JSON.stringify(e))].join("\n") + "\n");
  await persist();
  const route = `/v1/sessions/${id}/conversation`;
  const body = { action: "fork", entryId: "u2", expectedNativeSessionId: source.nativeId, expectedLeafId: "a2" };
  return { ...f, id, source, root, path, persist, route, body,
    act: (changes = {}, requestOptions = {}) => request(f.baseUrl, route, { method: "POST", body: { ...body, ...changes }, ...requestOptions }) };
}

test("thinking levels use model-reported values and changing them requires write scope", async (t) => {
  const reader = "thinking-reader", writer = "thinking-writer";
  const cfg = config({ allowedCommands: undefined, auth: { tokens: [
    { sha256: TOKEN_HASH, scopes: ALL_SCOPES },
    { sha256: createHash("sha256").update(reader).digest("hex"), scopes: ["sessions:read"] },
    { sha256: createHash("sha256").update(writer).digest("hex"), scopes: ["sessions:write"] },
  ] } });
  assert.ok(normalizeConfig(cfg).profiles.get("default").allowedCommands.has("set_thinking_level"));
  const f = await fixture(t, cfg);
  const id = await createSession(f.baseUrl), child = f.children[0];
  const meta = (await request(f.baseUrl, `/v1/sessions/${id}`)).body.session;
  let level = "low";
  const levels = ["off", "low", "high", "max"], received = [];
  child.stdin.on("data", (chunk) => {
    const command = JSON.parse(chunk.toString()); received.push(command);
    let data;
    if (command.type === "get_available_thinking_levels") data = { levels };
    if (command.type === "set_thinking_level") {
      if (!levels.includes(command.level)) { child.output({ type: "response", id: command.id, command: command.type, success: false, error: "Unsupported level" }); return; }
      level = command.level;
    }
    child.output({ type: "response", id: command.id, command: command.type, success: true, data });
  });
  const rpc = (body, token = TOKEN, native = meta.nativeSessionId) => request(f.baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", token, headers: { "X-Pi-Session-Id": native }, body });
  assert.deepEqual((await rpc({ type: "get_available_thinking_levels" }, reader)).body.data.levels, levels);
  assert.equal((await rpc({ type: "get_available_thinking_levels" }, writer)).response.status, 403);
  assert.equal((await rpc({ type: "set_thinking_level", level: "max" }, reader)).response.status, 403);
  assert.equal((await rpc({ type: "set_thinking_level", level: "max" }, TOKEN, RESUME_ID)).response.status, 409);
  assert.equal(received.length, 1, "rejected mutations never reach Pi");
  assert.equal((await rpc({ type: "set_thinking_level", level: "max" }, writer)).body.success, true);
  assert.equal(level, "max");
  assert.equal((await rpc({ type: "set_thinking_level", level: "unknown" })).body.success, false);
  assert.equal(level, "max", "Pi rejects levels outside its model's capabilities");
});

test("conversation export preserves the complete tree and requires only read access", async (t) => {
  const reader = "export-reader", writer = "export-writer";
  const f = await conversationFixture(t, { auth: { tokens: [
    { sha256: TOKEN_HASH, scopes: ALL_SCOPES },
    { sha256: createHash("sha256").update(reader).digest("hex"), scopes: ["sessions:read"] },
    { sha256: createHash("sha256").update(writer).digest("hex"), scopes: ["sessions:write"] },
  ] } });
  f.source.entries.push(
    { id: "thinking", parentId: "a2", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "reasoning" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } }] } },
    { id: "tool", parentId: "thinking", type: "message", message: { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "/workspace" }] } },
    { id: "compact", parentId: "tool", type: "compaction", summary: "summary", firstKeptEntryId: "a2", tokensBefore: 100 },
  );
  const before = structuredClone(f.source.entries);
  const route = `/v1/sessions/${f.id}/export`;
  const result = await request(f.baseUrl, route, { token: reader });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.format, "agentbox-conversation");
  assert.equal(result.body.version, 1);
  assert.equal(result.body.nativeSessionId, f.source.nativeId);
  assert.equal(result.body.leafId, "compact");
  assert.equal(result.body.profile, "default");
  assert.deepEqual(result.body.entries, before, "includes off-branch, pre-compaction, image, thinking, tool and metadata entries");
  assert.deepEqual(f.source.entries, before, "export does not mutate the conversation");
  assert.equal((await request(f.baseUrl, route, { token: writer })).response.status, 403);
  f.source.state.isStreaming = true;
  assert.equal((await request(f.baseUrl, route)).body.error.code, "conversation_busy");
  f.source.state.isStreaming = false;
  assert.equal((await request(f.baseUrl, route)).response.status, 200, "a failed export releases its lock");
});

test("conversation GET returns authoritative active-branch message IDs", async (t) => {
  const f = await conversationFixture(t);
  const result = await request(f.baseUrl, f.route);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.nativeSessionId, f.source.nativeId);
  assert.equal(result.body.leafId, "a2");
  assert.deepEqual(result.body.messages.map((m) => m.entryId), ["u1", "a1", "u2", "a2"]);
  assert.equal(result.body.messages[2].parentId, "a1");
  assert.deepEqual(result.body.messages[2].message, f.source.entries[4].message);
});

test("conversation restores current settings rather than prefix defaults, without exposing internal setters", async (t) => {
  const f = await conversationFixture(t);
  Object.assign(f.source.state, { model: { provider: "other", id: "current" }, thinkingLevel: "high", autoCompactionEnabled: false, steeringMode: "all", followUpMode: "all" });
  const source = f.runtime.sessions.get(f.id), stop = source.stop;
  source.stop = function () {
    assert.deepEqual(f.children[1].state, f.source.state);
    return stop.call(this);
  };
  assert.equal((await f.act({ action: "revert", entryId: "u1" })).response.status, 200);
  assert.deepEqual(f.children[1].state, f.source.state);
  for (const type of ["set_thinking_level", "fork"]) {
    assert.equal((await request(f.baseUrl, `/v1/sessions/${f.id}/rpc`, { method: "POST", body: { type, level: "high" } })).response.status, 403);
  }
});

test("settings restoration rejection or mismatch never stops the source", async (t) => {
  for (const flag of ["rejectSettings", "ignoreSettings"]) {
    const f = await conversationFixture(t, {}, { onSpawn(child) { child[flag] = true; } });
    f.source.state.thinkingLevel = "high";
    assert.equal((await f.act({ action: "revert" })).body.error.code, "settings_restore_failed");
    assert.equal(f.source.exited, false);
    assert.equal(f.children[1].exited, true);
  }
});

test("native header rejects stale RPC/UI writes while preserving optional-header compatibility", async (t) => {
  const f = await conversationFixture(t);
  const reverted = await f.act({ action: "revert" });
  const rpc = `/v1/sessions/${f.id}/rpc`, ui = `/v1/sessions/${f.id}/ui`;
  const child = f.children[1];
  child.output({ type: "extension_ui_request", id: "dialog", method: "confirm" });
  const before = child.input;
  for (const [path, body] of [[rpc, { type: "prompt", message: "stale" }], [ui, { id: "dialog", confirmed: true }]]) {
    assert.equal((await request(f.baseUrl, path, { method: "POST", body, headers: { "X-Pi-Session-Id": f.source.nativeId } })).body.error.code, "conversation_stale");
    assert.equal((await request(f.baseUrl, path, { method: "POST", body, headers: { "X-Pi-Session-Id": "invalid" } })).response.status, 400);
  }
  assert.equal(child.input, before);
  assert.equal((await request(f.baseUrl, ui, { method: "POST", body: { id: "dialog", confirmed: true }, headers: { "X-Pi-Session-Id": reverted.body.session.nativeSessionId } })).response.status, 202);
  for (const headers of [{}, { "X-Pi-Session-Id": reverted.body.session.nativeSessionId }]) {
    const writing = request(f.baseUrl, rpc, { method: "POST", body: { type: "prompt", id: "write", message: "accepted" }, headers });
    await new Promise((resolve) => {
      child.stdin.once("data", () => { child.output({ type: "response", id: "write", command: "prompt", success: true }); resolve(); });
    });
    assert.equal((await writing).response.status, 200);
  }
  const preflight = await request(f.baseUrl, rpc, { method: "OPTIONS", headers: { Origin: "https://client.example" } });
  assert.match(preflight.response.headers.get("access-control-allow-headers"), /x-pi-session-id/);
});

test("replacement announces a nonterminal source exit and exposes switching metadata until commit", async (t) => {
  const f = await conversationFixture(t);
  const session = f.runtime.sessions.get(f.id), events = [];
  const publish = session.publish;
  session.publish = function (event) { events.push(event); return publish.call(this, event); };
  const stop = session.stop;
  let release, stopping;
  const stopped = new Promise((resolve) => { stopping = resolve; });
  session.stop = async function () {
    await stop.call(this);
    stopping();
    await new Promise((resolve) => { release = resolve; });
  };
  const stream = await fetch(`${f.baseUrl}/v1/sessions/${f.id}/events`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const streamText = stream.text();
  const action = f.act({ action: "revert" });
  await stopped;
  const replay = await streamText;
  assert.match(replay, /"event":"conversation_replacing"/);
  assert.match(replay, /"event":"conversation_source_exited"/);
  assert.doesNotMatch(replay, /"event":"child_exit"/);
  const metadata = await request(f.baseUrl, `/v1/sessions/${f.id}`);
  assert.equal(metadata.body.session.conversationReplacing, true);
  assert.equal((await request(f.baseUrl, f.route)).body.error.code, "conversation_locked");
  assert.ok(events.findIndex((e) => e.event === "conversation_replacing") < events.findIndex((e) => e.event === "conversation_source_exited"));
  assert.equal(events.some((e) => e.event === "child_exit"), false);
  release();
  assert.equal((await action).body.session.conversationReplacing, false);
});

test("late abandoned child exit releases native reservation and capacity", async (t) => {
  const f = await conversationFixture(t, { limits: { maxSessions: 2, maxRecordBytes: 64 * 1024 } }, { beforeRead(child, command, f) {
    if (child !== f.source) {
      child.ignoreSettings = true;
      child.kill = () => true; // Simulate SIGKILL not yet confirmed by an exit event.
    }
  } });
  f.source.state.thinkingLevel = "high";
  assert.equal((await f.act()).body.error.code, "settings_restore_failed");
  const abandoned = f.children[1];
  const resume = () => request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: abandoned.nativeId } });
  assert.equal((await resume()).body.error.code, "resume_in_use");
  assert.equal((await f.act()).body.error.code, "session_limit");
  abandoned.exited = true;
  abandoned.emit("exit", null, "SIGKILL");
  assert.equal((await resume()).response.status, 201);
});

test("fork creates a separate child with only the pre-target branch; source and files are unchanged", async (t) => {
  const f = await conversationFixture(t);
  const before = await readFile(f.path, "utf8");
  const result = await f.act();
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.notEqual(result.body.session.id, f.id);
  assert.notEqual(result.body.session.nativeSessionId, f.source.nativeId);
  assert.deepEqual(result.body.draft, { text: "same", images: [{ type: "image", data: "YWJj", mimeType: "image/png" }] });
  assert.deepEqual(f.children[1].entries.map((e) => e.id), ["model", "u1", "a1"]);
  assert.equal(f.source.exited, false);
  assert.equal(await readFile(f.path, "utf8"), before);
  assert.equal(f.runtime.sessions.size, 2);
  assert.equal(f.children.some((child) => /"type":"fork"/.test(child.input)), false);
  const history = await request(f.baseUrl, "/v1/history?profile=default");
  assert.equal(history.body.sessions.length, 2);
});

test("revert fork-and-switches the same supervisor slot and retains original native history", async (t) => {
  const f = await conversationFixture(t);
  const original = f.runtime.sessions.get(f.id);
  const before = await readFile(f.path, "utf8");
  const result = await f.act({ action: "revert", entryId: "u1" });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.session.id, f.id);
  assert.notEqual(result.body.session.nativeSessionId, f.source.nativeId);
  assert.equal(f.source.exited, true);
  assert.deepEqual(f.children[1].entries.map((e) => e.id), ["model"]);
  assert.equal(f.runtime.sessions.size, 1);
  assert.equal(await readFile(f.path, "utf8"), before);
  const current = f.runtime.sessions.get(f.id);
  assert.notEqual(current.events, original.events);
  assert.ok(current.events.records[0].id >= original.events.nextId);
  assert.equal(current.events.records.some((event) => JSON.parse(event.data).event === "child_exit"), false);
  assert.equal(JSON.parse(current.events.records.at(-1).data).event, "conversation_changed");
  assert.equal((await f.act()).body.error.code, "conversation_stale");
  const resumed = await request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: f.source.nativeId } });
  assert.equal(resumed.response.status, 201);
});

test("conversation rejects stale identity, off-branch/non-user targets and client paths", async (t) => {
  const f = await conversationFixture(t);
  for (const [changes, code] of [
    [{ expectedNativeSessionId: RESUME_ID }, "conversation_stale"], [{ expectedLeafId: "u1" }, "conversation_stale"],
    [{ entryId: "offbranch" }, "invalid_entry"], [{ entryId: "a1" }, "invalid_entry"],
    [{ entryId: "/etc/passwd" }, "invalid_conversation"], [{ sessionPath: f.path }, "invalid_conversation"],
    [{ expectedLeafId: undefined }, "invalid_conversation"], [{ action: "delete" }, "invalid_conversation"],
  ]) assert.equal((await f.act(changes)).body.error.code, code);
  assert.equal(f.children.length, 1);
});

test("conversation requires read/write scopes, create only for fork, and allowed commands", async (t) => {
  const f = await conversationFixture(t);
  const token = f.runtime.config.tokens[0];
  for (const scopes of [["sessions:write", "sessions:create"], ["sessions:read", "sessions:create"], ["sessions:read", "sessions:write"]]) {
    token.scopes = new Set(scopes);
    assert.equal((await f.act()).response.status, 403);
  }
  assert.equal((await f.act({ action: "revert" })).response.status, 200);
  token.scopes = new Set(ALL_SCOPES);
  const current = f.runtime.sessions.get(f.id);
  current.profile.allowedCommands.delete("prompt");
  assert.equal((await f.act()).body.error.code, "command_forbidden");
  current.profile.allowedCommands.delete("get_entries");
  assert.equal((await request(f.baseUrl, f.route)).response.status, 403);
  assert.equal((await request(f.baseUrl, `/v1/sessions/${f.id}/rpc`, { method: "POST", body: { type: "fork", entryId: "u1" } })).response.status, 403);
});

test("conversation rejects streaming, compaction, queued messages, pending UI and uncertain writes", async (t) => {
  const f = await conversationFixture(t);
  for (const state of [{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }]) {
    const previous = { ...f.source.state };
    Object.assign(f.source.state, state);
    assert.equal((await f.act()).body.error.code, "conversation_busy");
    f.source.state = previous;
  }
  const session = f.runtime.sessions.get(f.id);
  session.uncertainWrite = true;
  assert.equal((await f.act()).body.error.code, "conversation_busy");
  session.uncertainWrite = false;
  f.source.output({ type: "extension_ui_request", id: "dialog", method: "confirm" });
  assert.equal((await f.act()).body.error.code, "conversation_busy");
  assert.equal(f.children.length, 1);
});

test("conversation lock rejects prompts, UI replies, delete, and competing actions while snapshot is pending", async (t) => {
  const f = await conversationFixture(t);
  f.source.holdReads = true;
  const action = f.act();
  await waitForInput(f.source, /"type":"get_state"/);
  for (const [path, opts] of [
    [f.route, { method: "POST", body: f.body }],
    [`/v1/sessions/${f.id}/rpc`, { method: "POST", body: { type: "prompt", message: "racing" } }],
    [`/v1/sessions/${f.id}/ui`, { method: "POST", body: { id: "dialog", cancelled: true } }],
    [`/v1/sessions/${f.id}`, { method: "DELETE" }],
  ]) assert.equal((await request(f.baseUrl, path, opts)).body.error.code, "conversation_locked");
  f.source.holdReads = false;
  f.source.releaseRead();
  assert.equal((await action).response.status, 200);
  assert.doesNotMatch(f.source.input, /racing/);
});

test("a pending write excludes conversation changes, including after write timeout", async (t) => {
  const f = await conversationFixture(t, { limits: { maxRecordBytes: 64 * 1024, commandTimeoutMs: 50 } });
  const prompt = request(f.baseUrl, `/v1/sessions/${f.id}/rpc`, { method: "POST", body: { type: "prompt", message: "hello" } });
  await waitForInput(f.source, /"type":"prompt"/);
  assert.equal((await f.act()).body.error.code, "conversation_busy");
  assert.equal((await prompt).response.status, 504);
  assert.equal((await f.act()).body.error.code, "conversation_busy");
});

test("unpersisted history and capacity limits fail without stopping the source", async (t) => {
  const f = await conversationFixture(t);
  await writeFile(f.path, "corrupt\n");
  assert.equal((await f.act({ action: "revert" })).body.error.code, "history_unavailable");
  await f.persist();
  f.runtime.config.limits.maxSessions = 1;
  assert.equal((await f.act({ action: "revert" })).body.error.code, "session_limit");
  assert.equal(f.source.exited, false);
  assert.equal(f.children.length, 1);
});

test("failed child verification keeps source active and releases the lock", async (t) => {
  const f = await conversationFixture(t, {}, { beforeRead(child, command, f) {
    if (child !== f.source && command.type === "get_state") child.nativeId = RESUME_ID;
  } });
  const result = await f.act({ action: "revert" });
  assert.equal(result.body.error.code, "conversation_changed");
  assert.equal(f.children[1].exited, true);
  assert.equal(f.source.exited, false);
  assert.equal(f.runtime.sessions.size, 1);
  assert.equal(f.runtime.sessions.get(f.id).conversationLocked, false);
});

test("source changes during child preparation are detected before revert stops it", async (t) => {
  const f = await conversationFixture(t, {}, { beforeRead(child, command, f) {
    if (child !== f.source && command.type === "get_entries") f.source.entries[4].message.content = "changed";
  } });
  assert.equal((await f.act({ action: "revert" })).body.error.code, "conversation_changed");
  assert.equal(f.source.exited, false);
  assert.equal(f.children[1].exited, true);
});

test("revert requires confirmed source exit and keeps native ownership after a failed stop", async (t) => {
  const f = await conversationFixture(t);
  const source = f.runtime.sessions.get(f.id), stop = source.stop;
  source.stop = async () => { source.status = "stopping"; };
  try {
    assert.equal((await f.act({ action: "revert" })).body.error.code, "stop_failed");
    assert.equal(source.conversationReplacing, false);
    assert.equal(JSON.parse(source.events.records.at(-1).data).event, "conversation_replace_failed");
    assert.equal(f.runtime.sessions.get(f.id), source);
    assert.equal(f.children[1].exited, true);
    const resume = await request(f.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: f.source.nativeId } });
    assert.equal(resume.body.error.code, "resume_in_use");
    const removed = await request(f.baseUrl, `/v1/sessions/${f.id}`, { method: "DELETE" });
    assert.equal(removed.body.error.code, "stop_failed");
    assert.equal(f.runtime.sessions.get(f.id), source);
  } finally { source.stop = stop; }
});

test("child startup dialogs reject revert without stopping the source", async (t) => {
  const f = await conversationFixture(t, {}, { beforeRead(child, command, f) {
    if (child !== f.source && command.type === "get_state") child.output({ type: "extension_ui_request", id: "startup", method: "confirm" });
  } });
  assert.equal((await f.act({ action: "revert" })).body.error.code, "conversation_busy");
  assert.equal(f.source.exited, false);
  assert.equal(f.children[1].exited, true);
});

test("configuration requires hashed tokens and prevents command/profile escape", () => {
  assert.throws(() => normalizeConfig({ piRpcApi: { auth: { tokens: [] }, profiles: {} } }), /non-empty array/);
  assert.throws(() => normalizeConfig(config({ auth: { tokens: [{ sha256: "plaintext", scopes: ["*"] }] } })), /SHA-256/);
  assert.throws(() => normalizeConfig(config({ allowedCommands: ["prompt", "switch_session"] })), /forbidden command/);
  assert.ok(normalizeConfig(config({ allowedCommands: ["prompt", "bash"] })).profiles.get("default").allowedCommands.has("bash"));
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

test("raw token environment references are hashed and cannot leak to Pi children", () => {
  const cfg = config({ auth: { tokens: [{ tokenEnv: "WEB_PASSWORD", scopes: ALL_SCOPES }] } });
  const normalized = normalizeConfig(cfg, { WEB_PASSWORD: TOKEN });
  assert.equal(normalized.tokens[0].digest.toString("hex"), TOKEN_HASH);
  assert.equal(JSON.stringify(normalized).includes(TOKEN), false);
  assert.throws(() => normalizeConfig(cfg, {}), /requires a non-empty printable token/);
  assert.throws(() => normalizeConfig(cfg, { WEB_PASSWORD: "has spaces" }), /without whitespace/);
  cfg.piRpcApi.auth.tokens[0].sha256Env = "HASH";
  assert.throws(() => normalizeConfig(cfg), /exactly one/);
  delete cfg.piRpcApi.auth.tokens[0].sha256Env;
  cfg.piRpcApi.profiles.default.envReferences = { LEAK: "WEB_PASSWORD" };
  assert.throws(() => normalizeConfig(cfg, { WEB_PASSWORD: TOKEN }), /must not expose an RPC authentication variable/);
});

test("login page module graph and remember-me markup stay deployable", async (t) => {
  const { baseUrl } = await fixture(t);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="remember-token"/);
  assert.match(html, /<dialog id="login-dialog" open/);

  assert.match(html, /Remember on this device/);
  assert.match(html, /src="\.\/app\.mjs"/);
  const app = await fetch(`${baseUrl}/app.mjs`);
  assert.equal(app.status, 200);
  const appText = await app.text();
  assert.match(appText, /auth-storage\.mjs/);
  const auth = await fetch(`${baseUrl}/auth-storage.mjs`);
  assert.equal(auth.status, 200);
  assert.match(auth.headers.get("content-type") || "", /javascript/);
  assert.match(await auth.text(), /STORAGE_KEY/);
  const wrong = await request(baseUrl, "/v1/sessions", { auth: false, headers: { Authorization: "Bearer wrong-token" } });
  assert.equal(wrong.response.status, 401);
  const ok = await request(baseUrl, "/v1/sessions");
  assert.equal(ok.response.status, 200);
  assert.ok(Array.isArray(ok.body.sessions));
});

test("frontend module graph stays on the public web asset allowlist", async (t) => {
  const { baseUrl } = await fixture(t);
  const app = readFileSync(new URL("../web/app.mjs", import.meta.url), "utf8");
  const imports = [...app.matchAll(/from "\.\/([^"]+)"/g)].map((match) => match[1]);
  assert.ok(imports.includes("auth-storage.mjs"), "app.mjs imports auth-storage");
  for (const file of imports) {
    const response = await fetch(`${baseUrl}/${file}`);
    assert.equal(response.status, 200, `WEB_ASSETS must serve /${file}`);
    await response.arrayBuffer();
  }
});

test("web assets are public and allowlisted without weakening API authentication or CSP", async (t) => {
  const { baseUrl } = await fixture(t);
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Pi agent/);
  for (const asset of ["app.mjs", "transport.mjs", "markdown.mjs", "subagents.mjs", "sidebar.mjs", "attention.mjs", "tool-display.mjs", "commands.mjs", "thinking.mjs", "attachments.mjs", "session-title.mjs", "model-visibility.mjs", "auth-storage.mjs", "styles.css", "icon.svg"]) {
    const response = await fetch(`${baseUrl}/${asset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    await response.arrayBuffer();
  }
  const head = await fetch(baseUrl, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const path of ["/runtime.mjs", "/history.mjs", "/web/README.md", "/README.md", "/browser-smoke.mjs", "/auth-storage.test.mjs", "/%2e%2e%2fruntime.mjs"]) {
    assert.equal((await request(baseUrl, path, { auth: false })).response.status, 404);
  }
  const api = await request(baseUrl, "/v1/sessions", { auth: false });
  assert.equal(api.response.status, 401);
  assert.equal(api.response.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  const crossOrigin = await fetch(baseUrl, { headers: { Origin: "https://untrusted.example" } });
  assert.equal(crossOrigin.status, 403);
  await crossOrigin.arrayBuffer();
});

test("history is scoped and restricted to a configured profile", async (t) => {
  const { baseUrl } = await fixture(t);
  assert.equal((await request(baseUrl, "/v1/history?profile=default", { auth: false })).response.status, 401);
  assert.equal((await request(baseUrl, "/v1/history?profile=../../etc")).response.status, 400);
  const result = await request(baseUrl, "/v1/history?profile=default");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { sessions: [], truncated: false });
  const limited = await fixture(t, config({ auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ["sessions:write"] }] } }));
  assert.equal((await request(limited.baseUrl, "/v1/history?profile=default")).response.status, 403);
});

test("new sessions own a native ID immediately and cannot be resumed concurrently", async (t) => {
  const { baseUrl, spawns, children } = await fixture(t, config({ profiles: {
    default: { cwd: "/workspace", sessionDir: "/sessions" },
    other: { cwd: "/workspace", sessionDir: "/other-sessions" },
  } }));
  const id = await createSession(baseUrl, { profile: "default", name: "UI session" });
  const meta = (await request(baseUrl, `/v1/sessions/${id}`)).body.session;
  assert.equal(meta.nativeSessionId, id);
  assert.equal(meta.name, "UI session");
  assert.equal(meta.cwd, "/workspace");
  assert.equal(meta.latestEventId, 1);
  assert.ok(spawns[0].args.includes("--session-id"));
  assert.equal(spawns[0].args[spawns[0].args.indexOf("--session-id") + 1], id);
  const duplicate = await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: id } });
  assert.equal(duplicate.response.status, 409);
  const crossProfile = await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "other", resume: id } });
  assert.equal(crossProfile.response.status, 409);
  children[0].output({ type: "extension_ui_request", id: "confirm-1", method: "confirm", title: "Approve?" });
  const answered = await request(baseUrl, `/v1/sessions/${id}/ui`, { method: "POST", body: { id: "confirm-1", confirmed: false } });
  assert.equal(answered.response.status, 202);
  const after = (await request(baseUrl, `/v1/sessions/${id}`)).body.session;
  assert.equal(after.latestEventId, 3);
  assert.deepEqual(after.pendingUi, []);
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
  const directory = await mkdtemp(join(tmpdir(), "pi-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, `2026-09-09_${RESUME_ID}.jsonl`);
  await writeFile(file, `${JSON.stringify({ type: "session", id: RESUME_ID, cwd: "/workspace" })}\n`);
  const { baseUrl, spawns } = await fixture(t, config({ profiles: { default: {
    cwd: "/workspace", sessionDir: directory, args: ["--approve"], env: { PROFILE_VALUE: "yes" },
  } } }));
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
    "--mode", "rpc", "--session-dir", directory, "--session", file, "--name", "Review", "--approve",
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

test("unknown resume IDs fail before spawning and concurrent resumes are reserved", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-resume-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { baseUrl, spawns } = await fixture(t, config({ profiles: { default: { cwd: "/workspace", sessionDir: directory } } }));
  const options = { method: "POST", body: { profile: "default", resume: RESUME_ID } };
  assert.equal((await request(baseUrl, "/v1/sessions", options)).response.status, 404);
  assert.equal(spawns.length, 0);
  await writeFile(join(directory, `${RESUME_ID}.jsonl`), `${JSON.stringify({ type: "session", id: RESUME_ID, cwd: "/workspace" })}\n`);
  const results = await Promise.all([request(baseUrl, "/v1/sessions", options), request(baseUrl, "/v1/sessions", options)]);
  assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 409]);
  assert.equal(spawns.length, 1);
});

test("large read snapshots stay out of SSE replay even when larger than the ring", async (t) => {
  const { baseUrl, runtime, children } = await fixture(t, config({
    allowedCommands: ["get_messages"], limits: { maxRecordBytes: 256 * 1024, maxEventBytes: 1024 },
  }));
  const id = await createSession(baseUrl);
  const reading = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_messages", id: "snapshot" } });
  await waitForInput(children[0], /snapshot/);
  children[0].output({ id: "snapshot", type: "response", command: "get_messages", success: true, data: { messages: [{ role: "user", content: "x".repeat(128 * 1024) }] } });
  assert.equal((await reading).response.status, 200);
  const session = runtime.sessions.get(id);
  assert.equal(session.events.nextId, 2);
  assert.equal(session.events.records.length, 1);
  assert.equal(session.events.records[0].id, 1);
});

test("oversized correlated reads drain without killing Pi and subsequent RPC still works", async (t) => {
  const { baseUrl, runtime, children } = await fixture(t, config({ allowedCommands: ["get_messages", "get_state"] }));
  const id = await createSession(baseUrl);
  const child = children[0];
  const reading = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_messages", id: "oversized" } });
  await waitForInput(child, /oversized/);
  child.stdout.write('{"id":"oversized","type":"response","command":"get_messages","success":true,"data":{"messages":["');
  child.stdout.write("x".repeat(2048));
  const result = await reading;
  assert.equal(result.response.status, 413);
  assert.equal(result.body.error.code, "snapshot_too_large");
  child.stdout.write("x".repeat(8192));
  child.stdout.write('"]}}\n');
  assert.equal(runtime.sessions.get(id).status, "running");
  assert.deepEqual(child.signals, []);
  const state = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_state", id: "after-large" } });
  await waitForInput(child, /after-large/);
  child.output({ id: "after-large", type: "response", command: "get_state", success: true, data: {} });
  assert.equal((await state).response.status, 200);
});

test("timed-out oversized reads retain bounded correlation and do not kill Pi", async (t) => {
  const { baseUrl, runtime, children } = await fixture(t, config({
    allowedCommands: ["get_messages", "get_state", "abort"],
    limits: { maxPendingCommands: 1, commandTimeoutMs: 30 },
  }));
  const id = await createSession(baseUrl), child = children[0];
  const result = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_messages", id: "late" } });
  assert.equal(result.response.status, 504);
  assert.equal(runtime.sessions.get(id).lateReads.size, 1);
  const more = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_state" } });
  assert.equal(more.response.status, 429);
  child.stdout.write(`{"id":"late","type":"response","command":"get_messages","success":true,"data":{"messages":["${"x".repeat(4096)}"]}}\n`);
  assert.equal(runtime.sessions.get(id).status, "running");
  assert.equal(runtime.sessions.get(id).lateReads.size, 0);
  const state = request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type: "get_state", id: "recovered" } });
  await waitForInput(child, /recovered/);
  child.output({ id: "recovered", type: "response", command: "get_state", success: true, data: {} });
  assert.equal((await state).response.status, 200);
  assert.deepEqual(child.signals, []);
});

test("shutdown detaches backpressured streams before Pi emits its final events", async (t) => {
  const { baseUrl, runtime } = await fixture(t);
  const id = await createSession(baseUrl), session = runtime.sessions.get(id);
  const client = new EventEmitter();
  client.writableLength = 100;
  client.writableEnded = false;
  client.destroyed = false;
  client.write = () => { assert.equal(client.writableEnded, false); return false; };
  client.end = () => { client.writableEnded = true; client.emit("finish"); };
  client.destroy = () => { client.destroyed = true; client.emit("close"); };
  session.addSseClient(client, 0);
  await runtime.close();
  assert.equal(client.writableEnded, true);
  assert.equal(session.clients.size, 0);
  assert.equal(session.writeSse(client, ": cannot write after end\n\n"), false);
});

test("idle SSE subscriptions send body bytes immediately without advancing the replay cursor", async (t) => {
  const { baseUrl, runtime } = await fixture(t, config({ limits: { sseHeartbeatMs: 60_000 } }));
  const id = await createSession(baseUrl);
  const session = runtime.sessions.get(id);
  const cursor = session.metadata().latestEventId;
  assert.equal(cursor, 1);
  // There is nothing to replay. Both initial attachment and reconnection must
  // yield a body without waiting for Pi activity or the periodic heartbeat.
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(`${baseUrl}/v1/sessions/${id}/events?after=${cursor}`, {
        headers: { Authorization: `Bearer ${TOKEN}` }, signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false);
      assert.equal(new TextDecoder().decode(first.value), ": connected\n\n");
      assert.equal(session.metadata().latestEventId, cursor);
      assert.equal(session.events.records.length, 1);
      await reader.cancel();
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
});

test("SSE tolerates ordinary write backpressure and bounds a stalled client's buffer", async (t) => {
  const { baseUrl, runtime } = await fixture(t, config({ limits: { maxRecordBytes: 256 * 1024, maxEventBytes: 256 * 1024 } }));
  const id = await createSession(baseUrl);
  const session = runtime.sessions.get(id);
  session.publish({ type: "message_end", message: { content: "x".repeat(128 * 1024) } });
  const client = new EventEmitter();
  client.writableLength = 0;
  client.destroyed = false;
  client.end = () => { throw new Error("backpressure must not end the stream"); };
  client.destroy = () => { client.destroyed = true; client.emit("close"); };
  const frames = [];
  client.write = (data) => { frames.push(data); client.writableLength += Buffer.byteLength(data); return false; };
  session.addSseClient(client, 0);
  assert.equal(session.clients.has(client), true);
  assert.equal(client.destroyed, false);
  assert.equal(frames[0], ": connected\n\n");
  assert.equal(frames.length, 3);
  // Model a drain, then verify live delivery remains connected.
  client.writableLength = 0;
  session.publish({ type: "agent_end" });
  assert.equal(frames.length, 4);
  assert.equal(client.destroyed, false);
  client.writableLength = 512 * 1024;
  session.publish({ type: "agent_start" });
  assert.equal(client.destroyed, true);
  assert.equal(session.clients.has(client), false);
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
  for (const type of ["switch_session", "not_a_command", "export_html"]) {
    const result = await request(baseUrl, `/v1/sessions/${id}/rpc`, { method: "POST", body: { type } });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "command_forbidden");
  }
  assert.equal(children[0].input, before);
});

test("user bash RPC commands are allowed by default for OpenCode-style !", async (t) => {
  const cfg = config({ allowedCommands: undefined });
  assert.ok(normalizeConfig(cfg).profiles.get("default").allowedCommands.has("bash"));
  assert.equal(internals.HARD_FORBIDDEN_COMMANDS.has("bash"), false);
  const { baseUrl, children } = await fixture(t, cfg);
  const id = await createSession(baseUrl);
  const promise = request(baseUrl, `/v1/sessions/${id}/rpc`, {
    method: "POST",
    body: { type: "bash", command: "echo hi", excludeFromContext: true },
  });
  await waitForInput(children[0], /"type":"bash"/);
  const forwarded = JSON.parse(children[0].input.trim().split("\n").at(-1));
  assert.equal(forwarded.type, "bash");
  assert.equal(forwarded.command, "echo hi");
  assert.equal(forwarded.excludeFromContext, true);
  children[0].output({
    type: "response",
    id: forwarded.id,
    command: "bash",
    success: true,
    data: { output: "hi\n", exitCode: 0, cancelled: false, truncated: false },
  });
  const result = await promise;
  assert.equal(result.response.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.data.output, "hi\n");
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

test("child approvals show parent-owned identity and route single-use responses", async (t) => {
  const { baseUrl, children, runtime } = await fixture(t);
  const id = await createSession(baseUrl);
  const owner = { version: 1, toolCallId: "task-call", taskId: "pi-workflow-child", role: "scout", requestId: "approval-id" };
  children[0].output({ type: "extension_ui_request", id: "child-dialog", method: "select", title: `Pi child approval ${JSON.stringify(owner)}\nread: README.md`, options: ["Allow once", "Deny"], timeout: 1000 });
  const { body } = await request(baseUrl, `/v1/sessions/${id}`);
  assert.equal(body.session.pendingUi[0].title, "Approve subagent scout?");
  assert.equal(body.session.pendingUi[0].message, "pi-workflow-child\nread: README.md");
  assert.equal(body.session.pendingUi[0].timeout, 1000);
  const accepted = await request(baseUrl, `/v1/sessions/${id}/ui`, { method: "POST", body: { id: "child-dialog", value: "Allow once" } });
  assert.equal(accepted.response.status, 202);
  assert.match(children[0].input, /"id":"child-dialog","value":"Allow once"/);
  assert.equal(runtime.sessions.get(id).pendingUi.size, 0);
  assert.equal((await request(baseUrl, `/v1/sessions/${id}/ui`, { method: "POST", body: { id: "child-dialog", value: "Allow once" } })).response.status, 404);
});

test("child approval cancellation and task completion expire only matching dialogs", async (t) => {
  const { baseUrl, children, runtime } = await fixture(t, config({ limits: { maxPendingUi: 4 } }));
  const id = await createSession(baseUrl);
  const session = runtime.sessions.get(id);
  for (const [dialog, toolCallId, taskId] of [["a", "parent-a", "child-a"], ["b", "parent-a", "child-b"], ["c", "parent-b", "child-a"]]) {
    const owner = { version: 1, toolCallId, taskId, role: "scout", requestId: `request-${dialog}` };
    children[0].output({ type: "extension_ui_request", id: dialog, method: "select", title: `Pi child approval ${JSON.stringify(owner)}\nread: README.md`, options: ["Allow once", "Deny"], timeout: 60_000 });
  }
  children[0].output({ type: "extension_ui_request", id: "ordinary", method: "select", title: "Choose", options: ["Allow once", "Deny"] });
  children[0].output({ type: "tool_execution_update", toolCallId: "parent-a", partialResult: { details: { jobs: [{ taskId: "child-a", approvalClosed: "request-c" }] } } });
  assert.equal(session.pendingUi.size, 4, "a wrong request ID never cancels another child");
  children[0].output({ type: "tool_execution_update", toolCallId: "parent-a", partialResult: { details: { jobs: [{ taskId: "child-a", approvalClosed: "request-a" }] } } });
  assert.deepEqual([...session.pendingUi.keys()], ["b", "c", "ordinary"]);
  assert.equal((await request(baseUrl, `/v1/sessions/${id}/ui`, { method: "POST", body: { id: "a", value: "Allow once" } })).response.status, 404);
  children[0].output({ type: "tool_execution_end", toolCallId: "parent-a" });
  assert.deepEqual([...session.pendingUi.keys()], ["c", "ordinary"]);
  const expired = session.events.records.map((event) => JSON.parse(event.data)).filter((event) => event.event === "extension_ui_expired");
  assert.deepEqual(expired.map((event) => event.id), ["a", "b"]);
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
  const bash = process.env.TEST_BASH ?? "/bin/bash";
  await writeFile(runtimePath, `#!${bash}\nprintf x >> ${JSON.stringify(countPath)}\nprintf '%s\\n' '${"x".repeat(2048)}'\nexit 7\n`);
  await chmod(runtimePath, 0o755);
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

test("fast-mode metadata is unknown until valid extension status and rejects malformed state", async (t) => {
  const { runtime, baseUrl, children } = await fixture(t);
  const id = await createSession(baseUrl);
  const session = runtime.sessions.get(id);
  assert.equal(session.metadata().fastMode, null);
  for (const value of [{ available: true, enabled: false }, { available: true, enabled: true }, { available: false, enabled: false }]) {
    children[0].output({ type: "extension_ui_request", method: "setStatus", statusKey: "agentbox-fast", statusText: JSON.stringify(value) });
    assert.deepEqual(session.metadata().fastMode, value);
    assert.deepEqual((await request(baseUrl, `/v1/sessions/${id}`)).body.session.fastMode, value);
  }
  for (const statusText of ['{"available":false,"enabled":true}', '{"available":true,"enabled":"true"}', '{}', 'bad json']) {
    children[0].output({ type: "extension_ui_request", method: "setStatus", statusKey: "agentbox-fast", statusText });
    assert.equal(session.metadata().fastMode, null);
  }
});

test("idle cleanup preserves disconnected quiet work and pending dialogs", async (t) => {
  for (const record of [
    { type: "agent_start" }, // Includes silent tool execution such as a long sleep.
    { type: "auto_retry_start" },
    { type: "auto_compaction_start" },
    { type: "compaction_start" },
    { type: "extension_ui_request", id: "approval", method: "confirm", title: "Allow?" },
    { type: "extension_ui_request", id: "reply", method: "input", title: "Reply?" },
  ]) {
    await t.test(`${record.type}/${record.method ?? "work"}`, async (t) => {
      let currentTime = 1_000;
      const { runtime, baseUrl, children } = await fixture(t, config({
        limits: { idleTimeoutMs: 100, cleanupIntervalMs: 50, shutdownGraceMs: 10, killGraceMs: 10 },
      }), { now: () => currentTime });
      const created = await createSession(baseUrl);
      const session = runtime.sessions.get(created);
      children[0].output(record);
      assert.equal(session.clients.size, 0);
      assert.equal(session.pending.size, 0);
      currentTime = 2_000;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(session.status, "running");
      assert.equal(runtime.sessions.size, 1);
      assert.equal(children[0].input.includes('"type":"abort"'), false);

      // Explicit runtime shutdown must still terminate protected work.
      await runtime.close();
      assert.equal(children[0].exited, true);
    });
  }
});

test("settled quiet work becomes eligible for idle cleanup again", async (t) => {
  let currentTime = 1_000;
  const { runtime, baseUrl, children } = await fixture(t, config({
    limits: { idleTimeoutMs: 100, cleanupIntervalMs: 50, shutdownGraceMs: 10, killGraceMs: 10 },
  }), { now: () => currentTime });
  await createSession(baseUrl);
  children[0].output({ type: "agent_start" });
  currentTime = 2_000;
  children[0].output({ type: "agent_settled" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(runtime.sessions.size, 1, "settling starts a fresh idle window");
  currentTime = 3_000;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(runtime.sessions.size, 0);
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

test("uploads enforce auth, identity, profile, bounds and generated private paths", async (t) => {
  const { baseUrl, runtime } = await fixture(t);
  const session = (await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).body.session;
  const endpoint = `/v1/sessions/${session.id}/uploads`;
  const options = { method: "POST", headers: { "X-Pi-Session-Id": session.nativeSessionId }, body: { profile: "default", data: "AP9BQgo=" } };
  assert.equal((await request(baseUrl, endpoint, { ...options, auth: false })).response.status, 401);
  assert.equal((await request(baseUrl, endpoint, { ...options, headers: {} })).response.status, 400);
  assert.equal((await request(baseUrl, endpoint, { ...options, headers: { "X-Pi-Session-Id": RESUME_ID } })).response.status, 409);
  for (const body of [{ ...options.body, profile: "other" }, { ...options.body, path: "../../escape" }, { ...options.body, name: "../../escape" }, { ...options.body, data: "!!!" }, { ...options.body, data: "AB==" }]) {
    assert.equal((await request(baseUrl, endpoint, { ...options, body })).response.status, 400);
  }
  assert.equal((await request(baseUrl, endpoint, { ...options, body: { ...options.body, data: "A".repeat(2048) } })).response.status, 413);
  const result = await request(baseUrl, endpoint, options);
  assert.equal(result.response.status, 201);
  const directory = join(result.body.path, "..");
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.match(result.body.path, /\/pi-upload-[^/]+\/file$/);
  assert.deepEqual(await readFile(result.body.path), Buffer.from(options.body.data, "base64"));
  assert.equal((await stat(result.body.path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const owned = runtime.sessions.get(session.id);
  owned.uploadCount = 100;
  assert.equal((await request(baseUrl, endpoint, options)).body.error.code, "upload_quota");
  owned.uploadCount = 0; owned.conversationLocked = true;
  assert.equal((await request(baseUrl, endpoint, options)).response.status, 409);
  owned.conversationLocked = false;
  owned.profile.allowedCommands.delete("prompt");
  assert.equal((await request(baseUrl, endpoint, options)).response.status, 403);
  assert.equal((await fetch(`${baseUrl}/attachments.mjs`)).status, 200);
});

test("uploads reject read-only credentials", async (t) => {
  const readToken = "read-only-upload-token";
  const { baseUrl } = await fixture(t, config({ auth: { tokens: [
    { sha256: TOKEN_HASH, scopes: ALL_SCOPES },
    { sha256: createHash("sha256").update(readToken).digest("hex"), scopes: ["sessions:read"] },
  ] } }));
  const session = (await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).body.session;
  assert.equal((await request(baseUrl, `/v1/sessions/${session.id}/uploads`, { method: "POST", token: readToken,
    headers: { "X-Pi-Session-Id": session.nativeSessionId }, body: { profile: "default", data: "" } })).response.status, 403);
});

test("uploads enforce decoded size and separate session storage", async (t) => {
  const { baseUrl } = await fixture(t, config({ limits: { maxBodyBytes: 8 * 1024 * 1024 } }));
  const create = async () => (await request(baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).body.session;
  const a = await create(), b = await create();
  const upload = (session, data, native = session.nativeSessionId) => request(baseUrl, `/v1/sessions/${session.id}/uploads`, {
    method: "POST", headers: { "X-Pi-Session-Id": native }, body: { profile: "default", data },
  });
  assert.equal((await upload(b, "AA==", a.nativeSessionId)).response.status, 409);
  const oversized = await upload(a, Buffer.alloc(5 * 1024 * 1024 + 1).toString("base64"));
  assert.equal(oversized.body.error.code, "upload_too_large");
  const first = await upload(a, "AA=="), second = await upload(b, "AA==");
  for (const result of [first, second]) {
    assert.equal(result.response.status, 201);
    t.after(() => rm(join(result.body.path, ".."), { recursive: true, force: true }));
  }
  assert.notEqual(first.body.path, second.body.path);
});

test("session folder API validates scopes, labels, storage and native profile ownership", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-folders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["default", "alias", "other"]) await mkdir(join(root, name));
  const source = join(root, "default", `${RESUME_ID}.jsonl`);
  const original = JSON.stringify({ type: "session", id: RESUME_ID, cwd: "/workspace" }) + "\n";
  await writeFile(source, original);
  const settings = config({ profiles: {
    default: { cwd: "/workspace", sessionDir: join(root, "default") },
    alias: { cwd: "/workspace", sessionDir: join(root, "alias") },
    other: { cwd: "/other", sessionDir: join(root, "other") },
    ephemeral: { cwd: "/workspace" },
    missing: { cwd: "/workspace", sessionDir: join(root, "missing") },
  } });
  const first = await fixture(t, settings);
  const path = "/v1/session-folders?profile=default";
  const put = (body, options = {}) => request(first.baseUrl, path, { method: "PUT", body, ...options });
  for (const method of ["GET", "PUT"]) {
    assert.equal((await request(first.baseUrl, path, { method, auth: false })).response.status, 401);
  }
  for (const folder of [null, 5, ".", "a/../b", "x".repeat(81), Array(13).fill("x").join("/")]) {
    assert.equal((await put({ id: RESUME_ID, folder })).response.status, 400);
  }
  for (const id of ["../../outside", "", null]) assert.equal((await put({ id, folder: "x" })).response.status, 400);
  assert.equal((await put({ id: "00000000-0000-4000-8000-000000000000", folder: "x" })).response.status, 404);
  for (const profile of ["", "unconfigured"]) {
    assert.equal((await request(first.baseUrl, `/v1/session-folders?profile=${profile}`)).response.status, 400);
  }
  for (const profile of ["ephemeral", "missing"]) {
    for (const method of ["GET", "PUT"]) {
      const result = await request(first.baseUrl, `/v1/session-folders?profile=${profile}`, { method, body: method === "PUT" ? { id: RESUME_ID, folder: "x" } : undefined });
      assert.equal(result.response.status, 409);
      assert.equal(result.body.error.code, "session_folders_unavailable");
    }
  }
  assert.equal((await request(first.baseUrl, "/v1/session-folders?profile=other", { method: "PUT", body: { id: RESUME_ID, folder: "x" } })).response.status, 404);
  for (const importOnly of [null, 0, "true", {}, []]) {
    assert.equal((await put({ id: RESUME_ID, folder: "x", importOnly })).response.status, 400);
  }
  assert.deepEqual((await put({ id: RESUME_ID, folder: "Legacy", importOnly: true })).body, { id: RESUME_ID, folder: "Legacy" });
  assert.deepEqual((await put({ id: RESUME_ID, folder: " / Work // Project / " })).body, { id: RESUME_ID, folder: "Work/Project" });
  assert.deepEqual((await put({ id: RESUME_ID, folder: "Stale", importOnly: true })).body, { id: RESUME_ID, folder: "Work/Project" });
  await first.runtime.close();
  const second = await fixture(t, settings);
  assert.deepEqual((await request(second.baseUrl, path)).body, { folders: [{ id: RESUME_ID, folder: "Work/Project" }] });
  for (const profile of ["alias", "other"]) {
    assert.deepEqual((await request(second.baseUrl, `/v1/session-folders?profile=${profile}`)).body, { folders: [] });
  }
  assert.equal((await request(second.baseUrl, path, { method: "PUT", body: { id: RESUME_ID, folder: " / / " } })).response.status, 200);
  assert.deepEqual((await request(second.baseUrl, path)).body, { folders: [{ id: RESUME_ID, folder: "" }] });
  await second.runtime.close();
  const third = await fixture(t, settings);
  assert.deepEqual((await request(third.baseUrl, path)).body, { folders: [{ id: RESUME_ID, folder: "" }] });
  assert.deepEqual((await request(third.baseUrl, path, { method: "PUT", body: { id: RESUME_ID, folder: "Stale", importOnly: true } })).body, { id: RESUME_ID, folder: "" });
  assert.deepEqual((await request(third.baseUrl, path)).body, { folders: [{ id: RESUME_ID, folder: "" }] });
  assert.equal(await readFile(source, "utf8"), original);
  for (const scope of ["sessions:read", "sessions:write", "profiles:read"]) {
    const scoped = await fixture(t, config({ auth: { tokens: [{ sha256: TOKEN_HASH, scopes: [scope] }] }, profiles: { default: { cwd: "/workspace", sessionDir: join(root, "default") } } }));
    assert.equal((await request(scoped.baseUrl, path)).response.status, scope === "sessions:read" ? 200 : 403);
    assert.equal((await request(scoped.baseUrl, path, { method: "PUT", body: { id: RESUME_ID, folder: "x" } })).response.status, scope === "sessions:write" ? 200 : 403);
  }
});

test("folder sessions start concurrently in selected cwd and resume there after restart", async (t) => {
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-folder-rpc-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), sessionDir = join(root, "history");
  await mkdir(cwd); await mkdir(sessionDir);
  const settings = config({ profiles: { default: { cwd: root, sessionDir, env: { PROJECT_VALUE: "yes" } } } });
  const first = await fixture(t, settings);
  const folders = await request(first.baseUrl, `/v1/folders?path=${encodeURIComponent(root)}`);
  assert.equal(folders.response.status, 200);
  assert.ok(folders.body.directories.some((entry) => entry.path === cwd));
  const created = await request(first.baseUrl, "/v1/sessions", { method: "POST", body: { cwd, name: "Project" } });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.session.cwd, cwd);
  assert.equal(first.spawns[0].options.cwd, cwd);
  assert.equal(first.spawns[0].options.env.PROJECT_VALUE, "yes");
  await createSession(first.baseUrl, { cwd });
  assert.equal(first.spawns.length, 2);
  assert.notEqual(first.spawns[0].args.join(" "), first.spawns[1].args.join(" "));
  const id = created.body.session.nativeSessionId;
  await writeFile(join(sessionDir, `${id}.jsonl`), JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n");
  await first.runtime.close();
  const second = await fixture(t, settings);
  const history = await request(second.baseUrl, "/v1/history?profile=default");
  assert.equal(history.body.sessions[0].cwd, cwd);
  const resumed = await request(second.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", resume: id } });
  assert.equal(resumed.response.status, 201);
  assert.equal(second.spawns[0].options.cwd, cwd);
  for (const body of [{ cwd: `${root}-outside` }, { cwd: root, resume: id }, { cwd: 42 }]) {
    assert.equal((await request(second.baseUrl, "/v1/sessions", { method: "POST", body })).response.status, 400);
  }
  assert.equal((await request(second.baseUrl, "/v1/folders", { auth: false })).response.status, 401);
  assert.equal((await request(second.baseUrl, "/v1/folders", { token: "bad" })).response.status, 401);
});

test("session folder creation validates labels and scopes before starting Pi", async (t) => {
  const first = await fixture(t);
  for (const folder of [null, 42, "..", "Work/../Project", "x".repeat(81)]) {
    const result = await request(first.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", folder } });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, "invalid_session_folder");
  }
  assert.equal((await request(first.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", folder: "Work", resume: RESUME_ID } })).response.status, 400);
  assert.equal(first.spawns.length, 0);
  const scoped = await fixture(t, config({ auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ["sessions:create"] }] } }));
  assert.equal((await request(scoped.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default", folder: "Work" } })).response.status, 403);
  assert.equal(scoped.spawns.length, 0);
  assert.equal((await request(scoped.baseUrl, "/v1/sessions", { method: "POST", body: { profile: "default" } })).response.status, 201);
});

test("session folder creation persists grouping before a prompt without changing cwd", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-new-session-group-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = config({ profiles: { default: { cwd: "/workspace", sessionDir: root } } });
  const first = await fixture(t, settings);
  const result = await request(first.baseUrl, "/v1/sessions", { method: "POST", body: { folder: " / brian // Work / ", name: "Grouped session" } });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.session.folder, "brian/Work");
  assert.equal(first.spawns[0].options.cwd, "/workspace");
  const id = result.body.session.nativeSessionId;
  assert.deepEqual((await request(first.baseUrl, "/v1/session-folders?profile=default")).body.folders, [{ id, folder: "brian/Work" }]);
  assert.equal((await request(first.baseUrl, "/v1/session-folders?profile=default", { method: "PUT", body: { id, folder: "brian/Other" } })).response.status, 200);
  assert.deepEqual((await request(first.baseUrl, "/v1/session-folders?profile=default")).body.folders, [{ id, folder: "brian/Other" }]);
  await writeFile(join(root, `${id}.jsonl`), JSON.stringify({ type: "session", version: 3, id, cwd: "/workspace" }) + "\n");
  await first.runtime.close();
  const second = await fixture(t, settings);
  assert.deepEqual((await request(second.baseUrl, "/v1/session-folders?profile=default")).body.folders, [{ id, folder: "brian/Other" }]);
  const ephemeral = await fixture(t, config({ profiles: { default: { cwd: "/workspace" } } }));
  assert.equal((await request(ephemeral.baseUrl, "/v1/sessions", { method: "POST", body: { folder: "brian" } })).response.status, 409);
  assert.equal(ephemeral.spawns.length, 0);
});

test("session folder DELETE ungroups nested labels and live sessions", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-delete-folder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = config({ profiles: { default: { cwd: "/workspace", sessionDir: root } } });
  const first = await fixture(t, settings);
  const path = "/v1/session-folders?profile=default";
  const del = (body, options = {}) => request(first.baseUrl, path, { method: "DELETE", body, ...options });
  assert.equal((await del({ folder: "Work" }, { auth: false })).response.status, 401);
  for (const body of [null, {}, { folder: "" }, { folder: "Work", extra: true }, { folder: 5 }, { folder: "a/../b" }]) {
    assert.equal((await del(body)).response.status, 400);
  }
  assert.deepEqual((await del({ folder: "Missing" })).body, { folder: "Missing", ungrouped: [] });
  const nested = await request(first.baseUrl, "/v1/sessions", { method: "POST", body: { folder: "Work/Agentbox", name: "Nested" } });
  const sibling = await request(first.baseUrl, "/v1/sessions", { method: "POST", body: { folder: "Work/Other", name: "Sibling" } });
  const personal = await request(first.baseUrl, "/v1/sessions", { method: "POST", body: { folder: "Personal", name: "Personal" } });
  assert.equal(nested.response.status, 201);
  assert.equal(sibling.response.status, 201);
  assert.equal(personal.response.status, 201);
  const nestedId = nested.body.session.nativeSessionId;
  const siblingId = sibling.body.session.nativeSessionId;
  const personalId = personal.body.session.nativeSessionId;
  await writeFile(join(root, `${nestedId}.jsonl`), JSON.stringify({ type: "session", version: 3, id: nestedId, cwd: "/workspace" }) + "\n");
  await writeFile(join(root, `${siblingId}.jsonl`), JSON.stringify({ type: "session", version: 3, id: siblingId, cwd: "/workspace" }) + "\n");
  await writeFile(join(root, `${personalId}.jsonl`), JSON.stringify({ type: "session", version: 3, id: personalId, cwd: "/workspace" }) + "\n");
  const deleted = await del({ folder: " / Work / " });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.folder, "Work");
  assert.deepEqual(new Set(deleted.body.ungrouped.map((item) => item.id)), new Set([nestedId, siblingId]));
  assert.ok(deleted.body.ungrouped.every((item) => item.folder === ""));
  const listed = await request(first.baseUrl, path);
  assert.deepEqual(new Map(listed.body.folders.map(({ id, folder }) => [id, folder])), new Map([
    [nestedId, ""],
    [siblingId, ""],
    [personalId, "Personal"],
  ]));
  assert.equal((await request(first.baseUrl, "/v1/sessions")).body.sessions.find((session) => session.nativeSessionId === nestedId).folder, "");
  assert.equal((await request(first.baseUrl, "/v1/sessions")).body.sessions.find((session) => session.nativeSessionId === personalId).folder, "Personal");
  for (const scope of ["sessions:read", "sessions:write", "profiles:read"]) {
    const scoped = await fixture(t, config({ auth: { tokens: [{ sha256: TOKEN_HASH, scopes: [scope] }] }, profiles: { default: { cwd: "/workspace", sessionDir: root } } }));
    assert.equal((await request(scoped.baseUrl, path, { method: "DELETE", body: { folder: "Personal" } })).response.status, scope === "sessions:write" ? 200 : 403);
  }
});

test("saved history archive requires delete scope, retains history and never starts Pi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-history-archive-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, `${RESUME_ID}.jsonl`);
  const original = JSON.stringify({ type: "session", version: 3, id: RESUME_ID, cwd: "/workspace" }) + "\n";
  await writeFile(file, original);
  const profiles = { default: { cwd: "/workspace", sessionDir: root } };
  const first = await fixture(t, config({ profiles }));
  const path = `/v1/history/${RESUME_ID}?profile=default`;
  assert.equal((await request(first.baseUrl, path, { method: "DELETE", auth: false })).response.status, 401);
  const scoped = await fixture(t, config({ profiles, auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ["sessions:read"] }] } }));
  assert.equal((await request(scoped.baseUrl, path, { method: "DELETE" })).response.status, 403);
  await createSession(first.baseUrl, { profile: "default", resume: RESUME_ID });
  assert.equal((await request(first.baseUrl, path, { method: "DELETE" })).response.status, 409);
  await first.runtime.close();
  const second = await fixture(t, config({ profiles }));
  assert.equal((await request(second.baseUrl, path, { method: "DELETE" })).response.status, 204);
  assert.equal((await request(second.baseUrl, path, { method: "DELETE" })).response.status, 204);
  assert.equal(second.spawns.length, 0);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await request(second.baseUrl, "/v1/history?profile=default")).body.sessions.length, 0);
  assert.equal((await request(second.baseUrl, "/v1/history?profile=default&includeArchived=true")).body.sessions[0].archived, true);
  assert.equal((await request(second.baseUrl, `/v1/history/${RESUME_ID}?profile=other`, { method: "DELETE" })).response.status, 400);
});

test("history move relocates JSONL across profiles and rejects active sessions", { skip: process.platform !== "linux" }, async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-history-move-src-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "pi-history-move-dst-"));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  t.after(() => rm(targetRoot, { recursive: true, force: true }));
  const file = join(sourceRoot, `2026-01-02T03-04-05-000Z_${RESUME_ID}.jsonl`);
  const original = [
    JSON.stringify({ type: "session", version: 3, id: RESUME_ID, cwd: "/workspace" }),
    JSON.stringify({ type: "session_info", name: "Moved" }),
    "",
  ].join("\n");
  await writeFile(file, original);
  const profiles = {
    default: { cwd: "/workspace", sessionDir: sourceRoot },
    agentbox: { cwd: "/workspace/agentbox", sessionDir: targetRoot },
  };
  const first = await fixture(t, config({ profiles }));
  const path = `/v1/history/${RESUME_ID}/move`;
  const move = (body, options = {}) => request(first.baseUrl, path, { method: "POST", body, ...options });
  assert.equal((await move({ profile: "default", targetProfile: "agentbox" }, { auth: false })).response.status, 401);
  const scoped = await fixture(t, config({
    profiles,
    auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ["sessions:read"] }] },
  }));
  assert.equal((await request(scoped.baseUrl, path, {
    method: "POST", body: { profile: "default", targetProfile: "agentbox" },
  })).response.status, 403);
  for (const body of [
    null, {}, { profile: "default" }, { profile: "default", targetProfile: "default" },
    { profile: "default", targetProfile: "missing" }, { profile: "default", targetProfile: "agentbox", folder: 5 },
    { profile: "default", targetProfile: "agentbox", extra: true },
  ]) {
    assert.equal((await move(body)).response.status, 400);
  }
  await createSession(first.baseUrl, { profile: "default", resume: RESUME_ID });
  assert.equal((await move({ profile: "default", targetProfile: "agentbox", folder: "Work" })).response.status, 409);
  await first.runtime.close();

  const second = await fixture(t, config({ profiles }));
  const moved = await request(second.baseUrl, path, {
    method: "POST", body: { profile: "default", targetProfile: "agentbox", folder: "Work/Inbox" },
  });
  assert.equal(moved.response.status, 200);
  assert.deepEqual(moved.body, {
    id: RESUME_ID, profile: "agentbox", cwd: "/workspace/agentbox", folder: "Work/Inbox", archived: false,
  });
  assert.equal(second.spawns.length, 0);
  assert.equal((await request(second.baseUrl, "/v1/history?profile=default")).body.sessions.length, 0);
  const targetHistory = await request(second.baseUrl, "/v1/history?profile=agentbox");
  assert.equal(targetHistory.body.sessions[0].id, RESUME_ID);
  assert.equal(targetHistory.body.sessions[0].cwd, "/workspace/agentbox");
  assert.equal(targetHistory.body.sessions[0].name, "Moved");
  assert.deepEqual((await request(second.baseUrl, "/v1/session-folders?profile=agentbox")).body.folders, [
    { id: RESUME_ID, folder: "Work/Inbox" },
  ]);
  const destination = join(targetRoot, `2026-01-02T03-04-05-000Z_${RESUME_ID}.jsonl`);
  const header = JSON.parse((await readFile(destination, "utf8")).split("\n")[0]);
  assert.equal(header.cwd, "/workspace/agentbox");
  assert.equal(header.id, RESUME_ID);
  // Idempotent retry refreshes folder assignment without requiring the source file.
  const again = await request(second.baseUrl, path, {
    method: "POST", body: { profile: "default", targetProfile: "agentbox", folder: "" },
  });
  assert.equal(again.response.status, 200);
  assert.equal(again.body.folder, "");
  assert.deepEqual((await request(second.baseUrl, "/v1/session-folders?profile=agentbox")).body.folders, [
    { id: RESUME_ID, folder: "" },
  ]);
});

const BROWSER_SCOPES = [...ALL_SCOPES, "browser:read", "browser:control"];
function browserConfig(overrides = {}, enabled = true) {
  return { ...config({ auth: { tokens: [{ sha256: TOKEN_HASH, scopes: BROWSER_SCOPES }] }, ...overrides }), browser: { enable: enabled } };
}
const browserBase = (nativeSessionId) => ({ version: 1, nativeSessionId, browserSessionId: "browser-incarnation" });
const browserStatus = (nativeSessionId) => ({ ...browserBase(nativeSessionId), available: true, ready: false, ownership: "tab",
  capabilities: { liveView: true, takeover: true }, control: { mode: "agent" } });
const browserFrame = (nativeSessionId) => ({ ...browserBase(nativeSessionId), frameId: "frame-one", createdAt: Date.now(),
  width: 1280, height: 720, mimeType: "image/jpeg", data: Buffer.from([255, 216, 255, 217]).toString("base64"),
  refs: [{ ref: "@e1", role: "textbox", name: "<img onerror=alert(1)>" }], control: { mode: "agent" } });
const browserHeaders = (id, control = false) => ({ "X-Pi-Session-Id": id, ...(control ? { Origin: "https://client.example" } : {}) });

for (const enabled of [false, true]) test(`browser fd is exclusively supervisor-owned (enabled=${enabled})`, async (t) => {
  const cfg = browserConfig({ profiles: { default: { cwd: "/workspace", sessionDir: "/sessions", env: { PI_BROWSER_RPC_FD: "9" } } } }, enabled);
  const f = await fixture(t, cfg, { browserHandler: ({ nativeSessionId }) => browserStatus(nativeSessionId) });
  const id = await createSession(f.baseUrl);
  assert.deepEqual(f.spawns[0].options.stdio, enabled ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"]);
  assert.equal(f.spawns[0].options.env.PI_BROWSER_RPC_FD, enabled ? "3" : undefined);
  const result = await request(f.baseUrl, `/v1/sessions/${id}/browser`, { headers: browserHeaders(id) });
  assert.equal(result.response.status, enabled ? 200 : 503);
  if (enabled) {
    assert.deepEqual(result.body.permissions, { view: true, control: true });
    f.children[0].emit("exit", 0, null);
    assert.equal(f.children[0].stdio[3].destroyed, true);
  } else assert.equal(result.body.error.code, "browser_unavailable");
});

test("sandbox browser launch keeps only the intended bridge fd", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-browser-fd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"); await mkdir(cwd);
  const f = await fixture(t, browserConfig({ sandbox: { enable: true, executable: "/bin/bwrap" },
    profiles: { default: { cwd, sessionDir: join(root, "history") } } }), { realpath: sandboxRealpath });
  await createSession(f.baseUrl);
  const args = f.spawns[0].args;
  assert.equal(args.includes("--preserve-fds"), false);
  assert.equal(args[args.indexOf("pi-rpc-sandbox-bootstrap") + 4], "1");
  assert.equal(f.spawns[0].options.stdio.length, 4);
});

test("browser routes require explicit scopes, profile rights, native binding and control Origin", async (t) => {
  let calls = 0;
  const f = await fixture(t, browserConfig(), { browserHandler: ({ nativeSessionId }) => { calls++; return browserStatus(nativeSessionId); } });
  const id = await createSession(f.baseUrl);
  const path = `/v1/sessions/${id}/browser`;
  for (const [options, status, code] of [
    [{ auth: false }, 401, "unauthorized"],
    [{}, 400, "invalid_session_precondition"],
    [{ headers: browserHeaders("bad") }, 400, "invalid_session_precondition"],
    [{ headers: browserHeaders(RESUME_ID) }, 409, "conversation_stale"],
    [{ headers: { ...browserHeaders(id), Origin: "https://evil.example" } }, 403, "origin_forbidden"],
    [{ method: "POST", headers: browserHeaders(id), body: { operation: "acquire", browserSessionId: "browser-incarnation" } }, 403, "origin_required"],
  ]) {
    const result = await request(f.baseUrl, options.method ? `${path}/control` : path, options);
    assert.equal(result.response.status, status);
    assert.equal(result.body.error.code, code);
  }
  assert.equal(calls, 0);
  for (const missing of ["sessions:read", "browser:read", "sessions:write", "browser:control"]) {
    const scopes = BROWSER_SCOPES.filter((scope) => scope !== missing);
    f.runtime.config.tokens[0].scopes = new Set(scopes);
    const control = missing.endsWith("write") || missing.endsWith("control");
    const result = await request(f.baseUrl, control ? `${path}/control` : path, {
      method: control ? "POST" : "GET", headers: browserHeaders(id, control),
      ...(control ? { body: { operation: "acquire", browserSessionId: "browser-incarnation" } } : {}),
    });
    assert.equal(result.response.status, 403, missing);
    assert.equal(result.body.error.code, "insufficient_scope");
    if (control) {
      const read = await request(f.baseUrl, path, { headers: browserHeaders(id) });
      assert.deepEqual(read.body.permissions, { view: true, control: false });
    }
  }
  f.runtime.config.tokens[0].scopes = new Set(["*"]);
  const session = f.runtime.sessions.get(id);
  session.profile.allowedCommands.delete("prompt");
  let result = await request(f.baseUrl, `${path}/control`, { method: "POST", headers: browserHeaders(id, true), body: { operation: "acquire", browserSessionId: "browser-incarnation" } });
  assert.equal(result.body.error.code, "command_forbidden");
  session.profile.allowedCommands.delete("get_state");
  result = await request(f.baseUrl, path, { headers: browserHeaders(id) });
  assert.equal(result.body.error.code, "command_forbidden");
});

test("control is narrow, principal is injected, responses are projected and never enter history", async (t) => {
  const seen = [];
  const f = await fixture(t, browserConfig(), { browserHandler: (req) => {
    seen.push(req);
    if (req.operation === "status") return { ...browserStatus(req.nativeSessionId), principal: "secret", leaseId: "secret", permissions: { control: false } };
    if (req.operation === "frame") return { ...browserFrame(req.nativeSessionId), principal: "secret", leaseId: "secret" };
    return { ...browserBase(req.nativeSessionId), leaseId: "lease-one", expiresAt: Date.now() + 30000, accepted: true, principal: "secret" };
  } });
  const id = await createSession(f.baseUrl), path = `/v1/sessions/${id}/browser`;
  const session = f.runtime.sessions.get(id), eventCount = session.events.records.length;
  for (const suffix of ["", "/frame"]) {
    const result = await request(f.baseUrl, path + suffix, { headers: browserHeaders(id) });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.body.principal, undefined);
    assert.equal(result.body.leaseId, undefined);
  }
  for (const operation of ["acquire", "renew", "release", "input"]) {
    const body = { operation, browserSessionId: "browser-incarnation", ...(operation === "acquire" ? {} : { leaseId: "lease-one" }),
      ...(operation === "input" ? { frameId: "frame-one", request: { action: "click", ref: "@e1" } } : {}) };
    const result = await request(f.baseUrl, `${path}/control`, { method: "POST", headers: browserHeaders(id, true), body });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.principal, undefined);
    assert.equal(result.body.leaseId, ["acquire", "renew"].includes(operation) ? "lease-one" : undefined);
  }
  assert.equal(seen.length, 6);
  for (const requestBody of [{ action: "pointer", x: 0, y: 0 }, { action: "pointer", x: 1279, y: 719 }, { action: "type", text: "--config '世界'" }, { action: "wheel", x: 120, y: 200, deltaX: -20, deltaY: 100 }, { action: "resize", width: 390, height: 844 }]) {
    const result = await request(f.baseUrl, `${path}/control`, { method: "POST", headers: browserHeaders(id, true), body: { operation: "input", browserSessionId: "browser-incarnation", leaseId: "lease-one", frameId: "frame-one", request: requestBody } });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.deepEqual(seen.at(-1).payload.request, requestBody);
  }
  assert.match(seen[0].principal, /^[0-9a-f]{64}$/);
  assert.notEqual(seen[0].principal, TOKEN_HASH);
  assert.ok(seen.every((req) => req.principal === seen[0].principal && req.nativeSessionId === id));
  assert.equal(session.events.records.length, eventCount);
  assert.equal(f.children[0].input, "");
  for (const body of [
    { operation: "acquire", browserSessionId: "browser-incarnation", principal: "attacker" },
    { operation: "cdp", browserSessionId: "browser-incarnation" },
    ...[{ action: "open", url: "file:///tmp/private" }, { action: "open", url: "https://user:pass@example.com" },
      { action: "evaluate", script: "1" }, { action: "click", ref: "#selector" }, { action: "scroll", amount: 2001 },
      { action: "press", key: "--flag" }, { action: "reload", path: "/tmp" },
      { action: "pointer", x: -1, y: 0 }, { action: "pointer", x: 2560, y: 0 }, { action: "pointer", x: 0, y: 1600 }, { action: "pointer", x: 1.5, y: 0 }, { action: "pointer", x: 1, y: 1, button: "right" },
      { action: "type", text: "" }, { action: "type", text: "bad\0" }, { action: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 0 }, { action: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 2001 }, { action: "resize", width: 319, height: 844 }, { action: "resize", width: 390, height: 1601 }].map((request) => ({ operation: "input", browserSessionId: "browser-incarnation", leaseId: "lease-one", frameId: "frame-one", request })),
  ]) {
    const result = await request(f.baseUrl, `${path}/control`, { method: "POST", headers: browserHeaders(id, true), body });
    assert.equal(result.response.status, 400, JSON.stringify(body));
    assert.equal(result.body.error.code, "invalid_browser_request");
  }
  assert.equal(seen.length, 11);
});

for (const mutate of [
  (data) => ({ ...data, data: "not-base64" }),
  (data) => ({ ...data, data: Buffer.from("not-jpeg").toString("base64") }),
  (data) => ({ ...data, data: Buffer.alloc(600 * 1024 + 1, 255).toString("base64") }),
  (data) => ({ ...data, width: 999999 }),
  (data) => ({ ...data, url: "ws://127.0.0.1/private-cdp" }),
  (data) => ({ ...data, url: "https://user:private@example.test/" }),
  (data) => ({ ...data, refs: [{ ref: "@e1", role: "textbox", name: "x".repeat(513) }] }),
  (data) => ({ ...data, refs: Array.from({ length: 101 }, (_, i) => ({ ref: `@e${i + 1}`, role: "button", name: "" })) }),
  (data) => ({ ...data, nativeSessionId: RESUME_ID }),
]) test("malformed bridge frame fails closed without exposing payload", async (t) => {
  const f = await fixture(t, browserConfig(), { browserHandler: ({ nativeSessionId }) => mutate(browserFrame(nativeSessionId)) });
  const id = await createSession(f.baseUrl);
  const result = await request(f.baseUrl, `/v1/sessions/${id}/browser/frame`, { headers: browserHeaders(id) });
  assert.equal(result.response.status, 502);
  assert.deepEqual(result.body, { error: { code: "browser_failed", message: "Browser operation failed" } });
  assert.equal(f.children[0].stdio[3].destroyed, true);
});

for (const race of ["replace", "native", "exit", "lock"]) test(`browser result cannot cross ${race} race`, async (t) => {
  let resolve, started;
  const arrived = new Promise((r) => { started = r; });
  const f = await fixture(t, browserConfig(), { browserHandler: ({ nativeSessionId }) => {
    started(); return new Promise((r) => { resolve = () => r(browserStatus(nativeSessionId)); });
  } });
  const id = await createSession(f.baseUrl), session = f.runtime.sessions.get(id);
  const pending = request(f.baseUrl, `/v1/sessions/${id}/browser`, { headers: browserHeaders(id) });
  await arrived;
  if (race === "replace") f.runtime.sessions.set(id, { ...session });
  if (race === "native") session.nativeSessionId = RESUME_ID;
  if (race === "exit") f.children[0].emit("exit", 0, null);
  if (race === "lock") session.conversationLocked = true;
  resolve();
  const result = await pending;
  assert.equal(result.response.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.ready, undefined);
  f.runtime.sessions.set(id, session);
  session.conversationLocked = false;
});

test("permanently closed browser bridge has a distinct restart-required error", async (t) => {
  const f = await fixture(t, browserConfig(), { browserHandler: ({ nativeSessionId }) => browserStatus(nativeSessionId) });
  const id = await createSession(f.baseUrl);
  f.runtime.sessions.get(id).browserChannel.close();
  const result = await request(f.baseUrl, `/v1/sessions/${id}/browser`, { headers: browserHeaders(id) });
  assert.equal(result.response.status, 503);
  assert.equal(result.body.error.code, "browser_bridge_closed");
  assert.match(result.body.error.message, /Restart the conversation process/);
});

test("pending browser work blocks idle cleanup", async (t) => {
  let now = Date.now(), resolve, started;
  const arrived = new Promise((r) => { started = r; });
  const f = await fixture(t, browserConfig({ limits: { idleTimeoutMs: 100, cleanupIntervalMs: 100 } }), {
    now: () => now,
    browserHandler: ({ nativeSessionId }) => { started(); return new Promise((r) => { resolve = () => r(browserStatus(nativeSessionId)); }); },
  });
  const id = await createSession(f.baseUrl);
  const pending = request(f.baseUrl, `/v1/sessions/${id}/browser`, { headers: browserHeaders(id) });
  await arrived;
  now += 10000;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(f.children[0].signals.length, 0);
  assert.equal(f.runtime.sessions.get(id).browserPending, 1);
  resolve();
  assert.equal((await pending).response.status, 200);
  assert.equal(f.runtime.sessions.get(id).browserPending, 0);
});
