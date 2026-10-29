import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browseFolders, containsFolder, selectFolder } from "../folders.mjs";
import { listHistory, resolveHistorySession } from "../history.mjs";

test("folder browser confines paths and symlinks to workspace roots", async (t) => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "pi-folders-")));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "work"), outside = join(temp, "work-other");
  await mkdir(join(root, "project"), { recursive: true }); await mkdir(outside);
  await writeFile(join(root, "file"), "not a folder");
  await symlink(outside, join(root, "escape"));
  await symlink(join(root, "project"), join(root, "alias"));
  const profiles = new Map([["default", { cwd: root, env: { TEST: "inherited" } }]]);
  assert.deepEqual((await browseFolders(profiles, null)).roots, [{ profile: "default", path: root }]);
  const listing = await browseFolders(profiles, root);
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.directories.map((entry) => entry.name), ["alias", "project"]);
  const selected = await selectFolder(profiles, join(root, "project"));
  assert.equal(selected.profile.cwd, join(root, "project"));
  assert.deepEqual(selected.profile.env, { TEST: "inherited" });
  assert.equal((await browseFolders(profiles, join(root, "project"))).parent, root);
  for (const path of [outside, join(root, "escape"), join(root, "file"), `${root}/../work-other`, `${root}/missing`, "relative", null, 42, `${root}/bad\npath`]) {
    await assert.rejects(selectFolder(profiles, path));
  }
  assert.equal(containsFolder(`${root}-other`, root), false);
  assert.equal(containsFolder(`${root}/project`, root), true);
});

test("folder selection chooses the most specific profile and honors an explicit profile", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-profiles-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = join(root, "nested"); await mkdir(nested);
  const profiles = new Map([["default", { cwd: root }], ["project", { cwd: nested }]]);
  assert.equal((await selectFolder(profiles, nested)).name, "project");
  assert.equal((await selectFolder(profiles, nested, "default")).name, "default");
  await assert.rejects(selectFolder(profiles, root, "project"));
});

test("workspace history includes child folders and returns the saved cwd for resume", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-folder-history-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = "3d90a428-2ed7-4a53-8aef-b5f5489f0e63", cwd = "/workspace/project";
  const path = join(root, `${id}.jsonl`);
  await writeFile(path, JSON.stringify({ type: "session", version: 3, id, cwd }) + "\n");
  const profile = { cwd: "/workspace", sessionDir: root, allowSubdirectories: true };
  assert.equal((await listHistory(profile, "default")).sessions[0].cwd, cwd);
  assert.deepEqual(await resolveHistorySession(profile, id, { details: true }), { path, cwd });
  assert.equal(await resolveHistorySession({ ...profile, allowSubdirectories: false }, id), null);
  for (const invalid of ["/workspace-other", "/workspace/../other", "/workspace/project/..", "relative"]) {
    await writeFile(path, JSON.stringify({ type: "session", version: 3, id, cwd: invalid }) + "\n");
    assert.equal(await resolveHistorySession(profile, id), null);
  }
});
