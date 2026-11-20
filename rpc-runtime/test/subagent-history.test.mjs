import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, internals } from "../runtime.mjs";

const taskId = `pi-workflow-${randomUUID()}`;
const otherId = `pi-workflow-${randomUUID()}`;
const token = "subagent-test-token";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const message = (id, parentId, value) => ({ type: "message", id, parentId, message: value });
const result = () => message("result", null, { role: "toolResult", toolName: "task", details: { results: [{ taskId }] }, content: [] });
const call = () => message("call", null, { role: "assistant", content: [{ type: "toolCall", name: "task", id: "task-call", arguments: {} }] });

async function fixture(t, allowedCommands = ["get_state", "get_entries"]) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-"));
  const sessionDir = join(root, "history");
  await mkdir(sessionDir);
  const f = { entries: [result()], nativeId: null, commands: [], children: [], root, sessionDir };
  const runtime = createRuntime({ piRpcApi: {
    host: "127.0.0.1", port: 0, executable: "/bin/pi", allowedCommands,
    auth: { tokens: [
      { sha256: hash(token), scopes: ["sessions:create", "sessions:read"] },
      { sha256: hash("writer"), scopes: ["sessions:write"] },
    ] }, profiles: { default: { cwd: root, sessionDir } },
    limits: { shutdownGraceMs: 10, killGraceMs: 10 },
  } }, {
    realpath: () => "/nix/store/00000000000000000000000000000000-pi/bin/pi",
    spawn(_file, args) {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit("exit", 0, null)); return true; };
      f.nativeId = args[args.indexOf("--session-id") + 1];
      child.output = (value) => child.stdout.write(JSON.stringify(value) + "\n");
      child.stdin.on("data", (chunk) => {
        for (const line of chunk.toString().trim().split("\n")) {
          const cmd = JSON.parse(line); f.commands.push(cmd.type);
          f.beforeReply?.(cmd);
          child.output({ type: "response", id: cmd.id, command: cmd.type, success: true,
            data: cmd.type === "get_state" ? { sessionId: f.nativeId, isStreaming: true }
              : { entries: f.entries, leafId: f.entries.at(-1)?.id ?? null } });
        }
      });
      f.children.push(child); return child;
    },
  });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const address = await runtime.listen();
  f.request = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: options.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token ?? token}`, ...(f.id ? { "X-Pi-Session-Id": f.id } : {}), ...options.headers },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const created = await f.request("/v1/sessions", { method: "POST", body: { profile: "default" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  f.id = created.body.session.id;
  f.route = `/v1/sessions/${f.id}/subagents/${taskId}`;
  f.file = join(sessionDir, `2026-01-01_${taskId}.jsonl`);
  f.transcript = (cwd = root, id = taskId) => [
    { type: "session", version: 3, id, cwd },
    message("u", null, { role: "user", content: "task" }),
    message("discarded", "u", { role: "assistant", content: "old branch" }),
    message("a", "u", { role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "toolCall", name: "bash", id: "bash", arguments: {} }] }),
    message("t", "a", { role: "toolResult", toolName: "bash", content: "output" }),
    message("done", "t", { role: "assistant", content: "done" }),
  ].map(JSON.stringify).join("\n") + "\n";
  await writeFile(f.file, f.transcript());
  f.runtime = runtime;
  return f;
}

test("read-only endpoint authenticates, checks scope, commands, method and mandatory parent identity", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(f.route, { token: "bad" })).status, 401);
  assert.equal((await f.request(f.route, { token: "writer" })).status, 403);
  assert.equal((await f.request(f.route, { method: "POST" })).status, 405);
  assert.equal((await f.request(f.route, { headers: { "X-Pi-Session-Id": "" } })).status, 400);
  assert.equal((await f.request(f.route, { headers: { "X-Pi-Session-Id": "bad" } })).status, 400);
  assert.equal((await f.request(f.route, { headers: { "X-Pi-Session-Id": randomUUID() } })).status, 409);
  assert.deepEqual(f.commands, []);
  for (const allowed of [["get_entries"], ["get_state"]]) {
    const restricted = await fixture(t, allowed);
    assert.equal((await restricted.request(restricted.route)).status, 403);
    assert.deepEqual(restricted.commands, []);
  }
});

test("complete and running partial transcripts preserve native messages in branch order without spawning children", async (t) => {
  const f = await fixture(t);
  for (const tail of ["", '{"type":"message","id":"in-flight",']) {
    await writeFile(f.file, f.transcript() + tail);
    const response = await f.request(f.route);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ["leafId", "messages", "nativeSessionId", "taskId"]);
    assert.equal(response.body.nativeSessionId, f.id);
    assert.equal(response.body.taskId, taskId);
    assert.equal(response.body.leafId, "done");
    assert.deepEqual(response.body.messages.map((m) => m.entryId), ["u", "a", "t", "done"]);
    assert.equal(response.body.messages[1].message.content[0].thinking, "reason");
  }
  assert.deepEqual(f.commands, ["get_state", "get_entries", "get_state", "get_entries"]);
  assert.equal(f.children.length, 1);
});

test("task authorization is structured and branch-bound, before filesystem access", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request(f.route.replace(taskId, otherId))).status, 404);
  for (const entries of [[], [message("text", null, { role: "user", content: taskId })],
    [message("fake", null, { role: "toolResult", toolName: "bash", details: { jobs: [{ taskId }] } })],
    [result(), message("branch", null, { role: "user", content: "different branch" })]]) {
    f.entries = entries;
    assert.equal((await f.request(f.route)).body.error.code, "subagent_not_found");
  }
  for (const bad of ["arbitrary", "..%2Fsecret", `${taskId}%2F..%2Fsecret`]) {
    assert.equal((await f.request(f.route.replace(taskId, bad))).status, 400);
  }
  f.entries = [result()];
  f.runtime.config.profiles.get("default").sessionDir = "/nonexistent/private/location";
  f.entries = [];
  assert.equal((await f.request(f.route)).body.error.code, "subagent_not_found");
});

test("running progress requires the matching authoritative task call and native parent", async (t) => {
  const f = await fixture(t);
  f.entries = [call()];
  const progress = { type: "tool_execution_update", toolName: "task", toolCallId: "task-call", partialResult: { details: { jobs: [{ taskId }] } } };
  f.children[0].output({ ...progress, toolName: "bash" });
  assert.equal((await f.request(f.route)).status, 404);
  f.children[0].output(progress);
  assert.equal((await f.request(f.route)).status, 200);
  f.entries = [];
  assert.equal((await f.request(f.route)).status, 404);
  f.entries = [call()];
  f.runtime.sessions.get(f.id).subagentProgress.get("task-call").nativeSessionId = randomUUID();
  assert.equal((await f.request(f.route)).status, 404);
});

test("stale parents during state or entries requests fail closed", async (t) => {
  for (const phase of ["get_state", "get_entries"]) {
    const f = await fixture(t);
    f.beforeReply = (cmd) => {
      if (cmd.type !== phase) return;
      if (phase === "get_state") f.nativeId = randomUUID();
      else f.runtime.sessions.get(f.id).nativeSessionId = randomUUID();
    };
    assert.equal((await f.request(f.route)).status, 409);
  }
});

test("history rejects symlinks, unrelated cwd/ID, duplicate matches, malformed records and bounded oversize", async (t) => {
  const f = await fixture(t);
  for (const text of [f.transcript("/unrelated"), f.transcript(f.root, otherId), f.transcript() + "invalid\n",
    f.transcript() + JSON.stringify(message("cycle", "cycle", { role: "user", content: "x" })) + "\n"]) {
    await writeFile(f.file, text);
    assert.equal((await f.request(f.route)).status, 404);
  }
  await writeFile(f.file, f.transcript());
  const duplicate = join(f.sessionDir, `other_${taskId}.jsonl`);
  await writeFile(duplicate, f.transcript());
  assert.equal((await f.request(f.route)).status, 404);
  await rm(duplicate);
  const outside = join(f.root, "outside.jsonl");
  await writeFile(outside, f.transcript()); await rm(f.file); await symlink(outside, f.file);
  assert.equal((await f.request(f.route)).status, 404);
  await rm(f.file); await writeFile(f.file, f.transcript());
  f.runtime.config.limits.maxRecordBytes = 32;
  assert.equal((await f.request(f.route)).status, 404);
  f.runtime.config.limits.maxRecordBytes = 2 * 1024 * 1024;
  const alias = join(f.root, "alias"); await symlink(f.sessionDir, alias);
  f.runtime.config.profiles.get("default").sessionDir = alias;
  assert.equal((await f.request(f.route)).status, 404);
});

test("entry and branch depth limits reject excessive parent and child history", async (t) => {
  assert.throws(() => internals.parentHasTask({ entries: Array(10_001).fill(result()), leafId: "result" }, taskId));
  const f = await fixture(t);
  const entries = Array.from({ length: 10_001 }, (_, i) => message(String(i), i ? String(i - 1) : null, { role: "user", content: "x" }));
  const header = { type: "session", version: 3, id: taskId, cwd: f.root };
  await writeFile(f.file, [header, ...entries].map(JSON.stringify).join("\n") + "\n");
  assert.equal((await f.request(f.route)).status, 404);
});
