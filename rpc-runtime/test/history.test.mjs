import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createConversationHistory, listHistory, NATIVE_SESSION_ID_RE, resolveHistorySession } from "../history.mjs";

const ID = "01991817-3dac-7000-8123-0123456789ab";
const OLD_ID = "3d90a428-2ed7-4a53-8aef-b5f5489f0e63";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-history-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, profile: { sessionDir: root, cwd: "/workspace" } };
}
function header(id = ID, cwd = "/workspace") { return JSON.stringify({ type: "session", version: 3, id, cwd }); }

test("conversation history publishes a private v3 child including compaction and metadata, never rewrites source", async (t) => {
  const { root, profile } = await fixture(t);
  const entries = [
    { type: "model_change", id: "m", parentId: null, provider: "test", modelId: "test" },
    { type: "message", id: "u", parentId: "m", message: { role: "user", content: "hello" } },
    { type: "custom", id: "state", parentId: "u", customType: "workflow", data: { todos: [] } },
    { type: "compaction", id: "c", parentId: "state", summary: "summary", firstKeptEntryId: "u", tokensBefore: 10 },
    { type: "message", id: "target", parentId: "c", message: { role: "user", content: "edit me" } },
  ];
  const source = join(root, `${ID}.jsonl`), snapshot = { entries, leafId: "target" };
  const original = [header(), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n";
  await writeFile(source, original);
  const path = await createConversationHistory(profile, ID, snapshot, entries.slice(0, -1), OLD_ID, 4096);
  const child = (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(child.slice(1), entries.slice(0, -1));
  assert.equal(child[0].id, OLD_ID);
  assert.equal(child[0].version, 3);
  assert.equal(child[0].parentSession, await realpath(source));
  assert.equal(child[0].cwd, profile.cwd);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(source, "utf8"), original);
  assert.equal((await readdir(root)).some((file) => file.endsWith(".tmp")), false);
  assert.equal(await resolveHistorySession(profile, OLD_ID), path);
});

test("conversation history fails closed on unpersisted, oversized, old-version, ambiguous and symlink sources", async (t) => {
  const { root, profile } = await fixture(t);
  const source = join(root, `${ID}.jsonl`);
  const entries = [{ type: "message", id: "u", parentId: null, message: { role: "user", content: "hello" } }];
  const snapshot = { entries, leafId: "u" };
  const valid = `${header()}\n${JSON.stringify(entries[0])}\n`;
  for (const text of [header(), valid + '{"incomplete":', valid.replace('"version":3', '"version":2'), valid.replace("hello", "other")]) {
    await writeFile(source, text);
    await assert.rejects(createConversationHistory(profile, ID, snapshot, [], OLD_ID, 4096));
    assert.equal(await readFile(source, "utf8"), text);
  }
  await writeFile(source, valid);
  await assert.rejects(createConversationHistory(profile, ID, snapshot, [], OLD_ID, 10));
  const duplicate = join(root, `duplicate_${ID}.jsonl`);
  await writeFile(duplicate, valid);
  await assert.rejects(createConversationHistory(profile, ID, snapshot, [], OLD_ID, 4096));
  await rm(source);
  await symlink(duplicate, source);
  // The only validated source is the direct regular duplicate; removing it
  // leaves an untrusted symlink, not a usable history source.
  await rm(duplicate);
  await assert.rejects(createConversationHistory(profile, ID, snapshot, [], OLD_ID, 4096));
  assert.equal(await resolveHistorySession(profile, OLD_ID), null);
});

test("history reads Pi UUIDv7 and legacy UUIDv4 sessions and bounded metadata", async (t) => {
  const { root, profile } = await fixture(t);
  const file = join(root, `2026-09-09_${ID}.jsonl`);
  await writeFile(file, `${header()}\n${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Review my changes" }] } })}\n`);
  let result = await listHistory(profile, "personal");
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].name, "Review my changes");
  assert.equal(result.sessions[0].profile, "personal");
  assert.equal(result.sessions[0].id, ID);
  assert.equal("path" in result.sessions[0], false);
  // A huge tool/image record must not consume unbounded memory or hide the latest title.
  await writeFile(file, `${header()}\n${JSON.stringify({ type: "session_info", name: "Old title" })}\n${"x".repeat(200_000)}\n${JSON.stringify({ type: "session_info", name: "New title" })}\n{"incomplete":`);
  await writeFile(join(root, `${OLD_ID}.jsonl`), `${header(OLD_ID)}\n`);
  result = await listHistory(profile, "personal");
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions.find((session) => session.id === ID).name, "New title");
  assert.equal(result.truncated, false);
  assert.equal(NATIVE_SESSION_ID_RE.test("../../secret"), false);
});

test("history ignores symlinks, subdirectories, other projects and invalid or mismatched headers", async (t) => {
  const { root, profile } = await fixture(t);
  const subdir = join(root, "nested");
  await mkdir(subdir);
  await writeFile(join(subdir, `${ID}.jsonl`), `${header()}\n`);
  await symlink(join(subdir, `${ID}.jsonl`), join(root, `${ID}.jsonl`));
  await writeFile(join(root, `wrong-id_${OLD_ID}.jsonl`), `${header()}\n`);
  await writeFile(join(root, `wrong-cwd_${ID}.jsonl`), `${header(ID, "/elsewhere")}\n`);
  await writeFile(join(root, `broken_${ID}.jsonl`), "not json\n");
  await writeFile(join(root, "arbitrary-name.jsonl"), `${header()}\n`);
  assert.deepEqual(await listHistory(profile, "default"), { sessions: [], truncated: false });
  assert.deepEqual(await listHistory({ cwd: "/workspace" }, "default"), { sessions: [], truncated: false });
  assert.deepEqual(await listHistory({ ...profile, sessionDir: join(root, "missing") }, "default"), { sessions: [], truncated: false });
  await symlink(subdir, join(root, "linked"));
  assert.deepEqual(await listHistory({ ...profile, sessionDir: join(root, "linked") }, "default"), { sessions: [], truncated: false });
});

test("history omits ambiguous duplicate session IDs", async (t) => {
  const { root, profile } = await fixture(t);
  await writeFile(join(root, `first_${ID}.jsonl`), `${header()}\n`);
  await writeFile(join(root, `second_${ID}.jsonl`), `${header()}\n`);
  assert.deepEqual((await listHistory(profile, "default")).sessions, []);
  assert.equal(await resolveHistorySession(profile, ID), null);
});

test("resume resolves exact UUIDv4/v7 IDs to canonical paths, never prefixes or client paths", async (t) => {
  const { root, profile } = await fixture(t);
  for (const id of [ID, OLD_ID]) {
    const file = join(root, `2026-09-09_${id}.jsonl`);
    await writeFile(file, `${header(id)}\n`);
    assert.equal(await resolveHistorySession(profile, id), await realpath(file));
    assert.equal(await resolveHistorySession({ ...profile, sessionDir: relative(process.cwd(), root) }, id), await realpath(file));
  }
  for (const id of [undefined, null, 123, {}, [], "", ID.slice(0, 8), `${ID}extra`, `${ID}\n`,
    "../../secret", join(root, `2026-09-09_${ID}.jsonl`), `2026-09-09_${ID}.jsonl`,
    ID.replace("-7000-", "-1000-"), ID.replace("-8123-", "-7123-"),
    "01991817-3dac-7000-8123-0123456789ac"]) {
    assert.equal(await resolveHistorySession(profile, id), null);
  }
  // Neither a longer filename ID nor a different header ID is an exact match.
  await rm(join(root, `2026-09-09_${ID}.jsonl`));
  await writeFile(join(root, `${ID}extra.jsonl`), `${header()}\n`);
  await writeFile(join(root, `${OLD_ID}.jsonl`), `${header()}\n`);
  assert.equal(await resolveHistorySession(profile, ID), null);
});

test("resume ignores malformed, oversized, mismatched and other-cwd first headers", async (t) => {
  const { root, profile } = await fixture(t);
  const file = join(root, `${ID}.jsonl`);
  const oversized = JSON.stringify({ type: "session", id: ID, cwd: profile.cwd, padding: "x".repeat(64 * 1024) });
  for (const text of ["", "not json\n", "null\n", "[]\n", `\n${header()}\n`,
    `{"type":"message","id":"${ID}","cwd":"/workspace"}\n`,
    `${header(OLD_ID)}\n`, `${header(ID.toUpperCase())}\n`,
    `${header(ID, "/elsewhere")}\n`, `${header(ID, "/workspace/")}\n`,
    `${header(ID, "/workspace/project")}\n`, `${oversized}\n`]) {
    await writeFile(file, text);
    assert.equal(await resolveHistorySession(profile, ID), null);
    assert.deepEqual(await listHistory(profile, "default"), { sessions: [], truncated: false });
  }
  // Header-only files and headers ending at the read boundary are valid.
  for (const text of [header(), `${header().padEnd(64 * 1024 - 1)}\n${"x".repeat(200_000)}`]) {
    await writeFile(file, text);
    assert.equal(await resolveHistorySession(profile, ID), await realpath(file));
  }
});

test("resume rejects symlinks, non-regular files, nested sessions and invalid directories", async (t) => {
  const { root, profile } = await fixture(t);
  const nested = join(root, "nested");
  await mkdir(nested);
  const file = join(nested, `${ID}.jsonl`);
  await writeFile(file, `${header()}\n`);
  const link = join(root, `${ID}.jsonl`);
  await symlink(file, link);
  await symlink(nested, join(root, "linked"));
  assert.equal(await resolveHistorySession(profile, ID), null);
  for (const sessionDir of [undefined, null, "", 42, "\0", join(root, "missing"), file,
    join(root, "linked"), `${join(root, "linked")}/`]) {
    assert.equal(await resolveHistorySession({ ...profile, sessionDir }, ID), null);
  }
  await rm(link);
  await mkdir(link);
  assert.equal(await resolveHistorySession(profile, ID), null);
  await rm(link, { recursive: true });
  execFileSync("mkfifo", [link]);
  assert.equal(await resolveHistorySession(profile, ID), null);
  assert.deepEqual(await listHistory(profile, "default"), { sessions: [], truncated: false });
  // A symlink in an ancestor is canonicalized, not returned to the caller.
  await symlink(root, join(root, "ancestor"));
  assert.equal(await resolveHistorySession({ ...profile, sessionDir: join(root, "ancestor", "nested") }, ID), await realpath(file));
});

test("resume counts only validated duplicates", async (t) => {
  const { root, profile } = await fixture(t);
  const file = join(root, `${ID}.jsonl`);
  await writeFile(file, `${header()}\n`);
  await writeFile(join(root, `wrong-cwd_${ID}.jsonl`), `${header(ID, "/elsewhere")}\n`);
  await writeFile(join(root, `wrong-id_${ID}.jsonl`), `${header(OLD_ID)}\n`);
  await writeFile(join(root, `malformed_${ID}.jsonl`), "not json\n");
  await symlink(file, join(root, `linked_${ID}.jsonl`));
  assert.equal(await resolveHistorySession(profile, ID), await realpath(file));
  await writeFile(join(root, `duplicate_${ID}.jsonl`), `${header()}\n`);
  assert.equal(await resolveHistorySession(profile, ID), null);
});

test("resume scans beyond the latest 1000 files and rejects older duplicates", async (t) => {
  const { root, profile } = await fixture(t);
  const file = join(root, `old_${ID}.jsonl`);
  await writeFile(file, `${header()}\n`);
  await utimes(file, 1, 1);
  for (let i = 0; i < 1000; i++) {
    await writeFile(join(root, `${i}_${OLD_ID}.jsonl`), `${header(OLD_ID)}\n`);
  }
  const result = await listHistory(profile, "default");
  assert.equal(result.truncated, true);
  assert.equal(result.sessions.some((session) => session.id === ID), false);
  assert.equal(await resolveHistorySession(profile, ID), await realpath(file));
  await writeFile(join(root, `new_${ID}.jsonl`), `${header()}\n`);
  assert.equal(await resolveHistorySession(profile, ID), null);
});

test("resume fails closed when more than 10000 direct entries prevent a unique scan", async (t) => {
  const { root, profile } = await fixture(t);
  const file = join(root, `${ID}.jsonl`);
  await writeFile(file, `${header()}\n`);
  for (let i = 0; i < 9999; i++) await writeFile(join(root, `${i}.txt`), "");
  assert.equal(await resolveHistorySession(profile, ID), await realpath(file));
  assert.equal((await listHistory(profile, "default")).truncated, false);
  await writeFile(join(root, "overflow.txt"), "");
  assert.equal(await resolveHistorySession(profile, ID), null);
  assert.equal((await listHistory(profile, "default")).truncated, true);
});
