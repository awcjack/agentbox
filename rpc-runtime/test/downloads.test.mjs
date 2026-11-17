import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { DownloadError, MAX_DOWNLOAD_BYTES, downloadInternals, readWorkspaceDownload } from "../downloads.mjs";
import { createRuntime } from "../runtime.mjs";

const linux = { skip: process.platform !== "linux" };
const TOKEN = "download-test-operator";
const nativeOther = "3d90a428-2ed7-4a53-8aef-b5f5489f0e63";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const code = (expected) => (error) => error instanceof DownloadError && error.code === expected;
async function workspace(t) {
  // Canonicalize the fixture root on systems where /tmp itself is a symlink.
  const { realpath } = await import("node:fs/promises");
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-download-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd };
}

test("download path normalization confines absolute and relative paths", () => {
  const { downloadParts } = downloadInternals;
  assert.deepEqual(downloadParts("/workspace", "nested/../result.bin"), { root: "/workspace", inside: "result.bin", filename: "result.bin" });
  assert.equal(downloadParts("/workspace", "/workspace/nested/result.bin").inside, "nested/result.bin");
  for (const path of ["../secret", "/tmp/file", "/workspace-other/file", "/etc/passwd", ".", "/workspace", "../../workspace-other/file"]) {
    assert.throws(() => downloadParts("/workspace", path), code("download_forbidden"));
  }
  for (const path of [null, 42, "", "  ", "file\0name", "a".repeat(4097)]) {
    assert.throws(() => downloadParts("/workspace", path), code("invalid_download"));
  }
  assert.throws(() => downloadParts("relative", "file"), code("download_unavailable"));
});

test("downloads preserve arbitrary bytes, empty files and normalized basename", linux, async (t) => {
  const { cwd } = await workspace(t);
  await mkdir(join(cwd, "nested"));
  const bytes = Buffer.from([0, 255, 128, 13, 10, 0]);
  await writeFile(join(cwd, "nested", "résultat.bin"), bytes);
  const result = await readWorkspaceDownload(cwd, "unused/../nested/résultat.bin");
  assert.deepEqual(result, { data: bytes.toString("base64"), filename: "résultat.bin", mimeType: "application/octet-stream" });
  assert.deepEqual(await readWorkspaceDownload(cwd, join(cwd, "nested", "résultat.bin")), result);
  await writeFile(join(cwd, "empty"), "");
  assert.equal((await readWorkspaceDownload(cwd, "empty")).data, "");
  await assert.rejects(readWorkspaceDownload(cwd, "absent-secret-name"), (error) => code("download_not_found")(error) && !error.message.includes("absent-secret-name") && !error.message.includes(cwd));
});

test("symlinks at every level, hardlinks, directories, FIFO and devices are denied", linux, async (t) => {
  const { root, cwd } = await workspace(t);
  await mkdir(join(cwd, "nested"));
  await writeFile(join(cwd, "nested", "file"), "public");
  await writeFile(join(root, "secret"), "NEVER DISCLOSE");
  await symlink(join(root, "secret"), join(cwd, "escape"));
  await symlink("nested/file", join(cwd, "internal"));
  await symlink(root, join(cwd, "outside"));
  await symlink("nested", join(cwd, "alias"));
  await symlink(cwd, join(root, "cwd-alias"));
  for (const path of ["escape", "internal", "outside/secret", "alias/file", "nested"]) {
    await assert.rejects(readWorkspaceDownload(cwd, path), code("download_forbidden"));
  }
  await assert.rejects(readWorkspaceDownload(join(root, "cwd-alias"), "nested/file"), code("download_forbidden"));
  await link(join(root, "secret"), join(cwd, "hardlink"));
  await assert.rejects(readWorkspaceDownload(cwd, "hardlink"), code("download_forbidden"));
  execFileSync("mkfifo", [join(cwd, "fifo")]);
  await assert.rejects(readWorkspaceDownload(cwd, "fifo"), code("download_forbidden"));
  // /dev is a workspace only for this direct helper test; actual HTTP callers
  // cannot change the administrator-selected profile cwd to reach devices.
  await assert.rejects(readWorkspaceDownload("/dev", "null"), code("download_forbidden"));
});

test("16 MiB is accepted, larger files are rejected without partial data", linux, async (t) => {
  const { cwd } = await workspace(t);
  const file = await open(join(cwd, "large"), "w");
  try {
    await file.truncate(MAX_DOWNLOAD_BYTES);
    const result = await readWorkspaceDownload(cwd, "large");
    assert.equal(Buffer.from(result.data, "base64").length, MAX_DOWNLOAD_BYTES);
    await file.truncate(MAX_DOWNLOAD_BYTES + 1);
    await assert.rejects(readWorkspaceDownload(cwd, "large"), code("download_too_large"));
  } finally { await file.close(); }
});

test("bounded reader detects growth, truncation, metadata changes and new hardlinks", async () => {
  const metadata = (size, extra = {}) => ({ size, nlink: 1, mtimeMs: 1, ctimeMs: 1, isFile: () => true, ...extra });
  for (const [initial, final, bytes, expected] of [
    [metadata(0), metadata(MAX_DOWNLOAD_BYTES + 1), MAX_DOWNLOAD_BYTES + 1, "download_too_large"],
    [metadata(5), metadata(3), 3, "download_changed"],
    [metadata(1), metadata(1, { mtimeMs: 2 }), 1, "download_changed"],
    [metadata(1), metadata(1, { ctimeMs: 2 }), 1, "download_changed"],
    [metadata(1), metadata(1, { nlink: 2 }), 1, "download_forbidden"],
    [metadata(0), metadata(MAX_DOWNLOAD_BYTES + 1), 0, "download_too_large"],
  ]) {
    let calls = 0, total = 0;
    const fake = {
      async stat() { return calls++ ? final : initial; },
      async read(buffer, offset, length, position) {
        assert.ok(length <= 64 * 1024);
        assert.equal(position, total);
        const bytesRead = Math.min(length, bytes - total);
        buffer.fill(0, 0, bytesRead);
        total += bytesRead;
        return { bytesRead };
      },
    };
    await assert.rejects(downloadInternals.readBoundedFile(fake), code(expected));
    assert.ok(total <= MAX_DOWNLOAD_BYTES + 1);
  }
});

test("intermediate directory swaps cannot redirect reads outside the workspace", linux, async (t) => {
  const { root, cwd } = await workspace(t);
  await mkdir(join(cwd, "nested"));
  await writeFile(join(cwd, "nested", "file"), "public");
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside", "file"), "PRIVATE SECRET");
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const { renameSync, symlinkSync, unlinkSync } = require('node:fs');
    const { cwd, outside } = workerData;
    parentPort.postMessage('ready');
    while (true) {
      renameSync(cwd + '/nested', cwd + '/held');
      symlinkSync(outside, cwd + '/nested');
      unlinkSync(cwd + '/nested');
      renameSync(cwd + '/held', cwd + '/nested');
    }
  `, { eval: true, workerData: { cwd, outside: join(root, "outside") } });
  try {
    await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const result = await readWorkspaceDownload(cwd, "nested/file");
        assert.equal(Buffer.from(result.data, "base64").toString(), "public");
      } catch (error) {
        assert.ok(error instanceof DownloadError);
        assert.ok(["download_forbidden", "download_not_found"].includes(error.code));
      }
    }
  } finally { await worker.terminate(); }
});

test("unsupported platforms fail closed", { skip: process.platform === "linux" }, async () => {
  await assert.rejects(readWorkspaceDownload("/workspace", "file"), code("download_unavailable"));
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough();
    this.stdio = [this.stdin, this.stdout, this.stderr];
  }
  kill(signal) { queueMicrotask(() => this.emit("exit", null, signal)); return true; }
}

async function fixture(t) {
  const { root, cwd } = await workspace(t);
  await writeFile(join(cwd, "file.bin"), Buffer.from([0, 255, 1]));
  const runtime = createRuntime({ piRpcApi: {
    host: "127.0.0.1", port: 0, executable: "/bin/pi",
    allowedOrigins: ["https://client.example"],
    auth: { tokens: [
      { sha256: hash(TOKEN), scopes: ["*"] },
      { sha256: hash("read"), scopes: ["sessions:read"] },
      { sha256: hash("write"), scopes: ["sessions:write"] },
      { sha256: hash("both"), scopes: ["sessions:read", "sessions:write"] },
    ] },
    profiles: { default: { cwd, sessionDir: join(root, "sessions") } },
    limits: { shutdownGraceMs: 10, killGraceMs: 10 },
  } }, { spawn: () => new FakeChild(), realpath: () => "/nix/store/00000000000000000000000000000000-pi/bin/pi" });
  t.after(() => runtime.close());
  const address = await runtime.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const created = await fetch(`${base}/v1/sessions`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ profile: "default" }) });
  assert.equal(created.status, 201);
  const { session } = await created.json();
  const endpoint = `${base}/v1/sessions/${session.id}/downloads`;
  const owned = runtime.sessions.get(session.id);
  async function download({ path = "file.bin", body = { path }, token = TOKEN, native = session.nativeSessionId, method = "POST", origin } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (native !== null) headers["X-Pi-Session-Id"] = native;
    if (origin) headers.Origin = origin;
    const response = await fetch(endpoint, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { runtime, cwd, root, owned, session, endpoint, download };
}

test("HTTP downloads require both scopes, prompt, identity, running and unlocked session", linux, async (t) => {
  const { owned, session, download } = await fixture(t);
  for (const token of [null, "wrong", "read", "write"]) {
    const result = await download({ token });
    assert.equal(result.status, token === null || token === "wrong" ? 401 : 403);
    assert.equal(result.body.data, undefined);
  }
  assert.equal((await download({ token: "both" })).status, 200);
  assert.equal((await download({ native: null })).body.error.code, "invalid_session_precondition");
  assert.equal((await download({ native: "invalid" })).status, 400);
  assert.equal((await download({ native: nativeOther })).body.error.code, "conversation_stale");
  assert.equal((await download({ method: "GET" })).status, 405);
  assert.equal((await download({ origin: "https://evil.example" })).status, 403);
  owned.conversationLocked = true;
  assert.equal((await download()).body.error.code, "conversation_locked");
  owned.conversationLocked = false;
  owned.status = "stopping";
  assert.equal((await download()).body.error.code, "session_not_running");
  owned.status = "running";
  owned.profile.allowedCommands.delete("prompt");
  assert.equal((await download()).body.error.code, "command_forbidden");
  owned.profile.allowedCommands.add("prompt");
  const result = await download();
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: "AP8B", filename: "file.bin", mimeType: "application/octet-stream", nativeSessionId: session.nativeSessionId });
});

test("HTTP validates JSON, workspace boundary and security errors without partial data", linux, async (t) => {
  const { cwd, root, download } = await fixture(t);
  for (const body of [null, [], "file.bin", {}, { path: 1 }, { path: "file.bin", extra: true }, { path: "" }, { path: "bad\0name" }]) {
    assert.equal((await download({ body })).status, 400);
  }
  assert.equal((await download({ path: join(cwd, "sub/../file.bin") })).status, 200);
  await writeFile(join(root, "private-key-name"), "SECRET VALUE");
  await symlink(join(root, "private-key-name"), join(cwd, "leak"));
  await link(join(root, "private-key-name"), join(cwd, "hardlink"));
  await mkdir(join(cwd, "directory"));
  const large = await open(join(cwd, "large"), "w");
  await large.truncate(MAX_DOWNLOAD_BYTES + 1); await large.close();
  for (const [path, status] of [["../private-key-name", 403], ["/tmp/private-key-name", 403], ["/etc/passwd", 403], ["leak", 403], ["hardlink", 403], ["directory", 403], ["missing-private-key-name", 404], ["large", 413]]) {
    const result = await download({ path });
    assert.equal(result.status, status, path);
    assert.deepEqual(Object.keys(result.body), ["error"]);
    assert.ok(!JSON.stringify(result.body).includes("SECRET VALUE"));
    assert.ok(!JSON.stringify(result.body).includes("private-key-name"));
    assert.ok(!JSON.stringify(result.body).includes(root));
  }
});

test("HTTP rechecks native identity and lock after awaiting the request body", linux, async (t) => {
  const { endpoint, owned, session } = await fixture(t);
  for (const change of ["identity", "lock"]) {
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest(endpoint, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "X-Pi-Session-Id": session.nativeSessionId } }, (res) => {
        let text = "";
        res.on("data", (chunk) => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on("error", reject);
      req.write('{"path":');
      // Let the route validate and wait on its incomplete JSON body.
      setTimeout(() => {
        if (change === "identity") owned.nativeSessionId = nativeOther;
        else owned.conversationLocked = true;
        req.end('"file.bin"}');
      }, 30);
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, change === "identity" ? "conversation_stale" : "conversation_locked");
    assert.equal(result.body.data, undefined);
    owned.nativeSessionId = session.nativeSessionId;
    owned.conversationLocked = false;
  }
});
