import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverWorkspaceProfiles } from "../discover-profiles.mjs";
import { normalizeConfig } from "../runtime.mjs";
import { createHash } from "node:crypto";

const TOKEN_HASH = createHash("sha256").update("correct-horse-battery-staple").digest("hex");

function baseConfig(overrides = {}) {
  return {
    piRpcApi: {
      host: "127.0.0.1",
      port: 0,
      executable: "/bin/pi",
      allowedOrigins: [],
      auth: { tokens: [{ sha256: TOKEN_HASH, scopes: ["*"] }] },
      profiles: {
        default: {
          cwd: "/workspace",
          sessionDir: "/home/agent/.pi/agent/sessions/--workspace--",
        },
      },
      ...overrides,
    },
  };
}

test("discoverWorkspaceProfiles synthesizes child directories and skips junk", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "aogb-erp"));
  await mkdir(join(root, "nix-config"));
  await mkdir(join(root, "tmp-scratch"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "README.md"), "nope");
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(root, "link-ok"));

  const found = discoverWorkspaceProfiles({
    root,
    sessionDirPrefix: "/sessions",
    excludePrefixes: ["tmp-"],
    existingNames: new Set(["default"]),
    existingSessionDirs: [{ name: "default", path: "/sessions/--workspace--" }],
  });

  assert.deepEqual(found.map((item) => item.name), ["aogb-erp", "link-ok", "nix-config", "outside"]);
  assert.equal(found[0].cwd, join(root, "aogb-erp"));
  assert.equal(found[0].sessionDir, "/sessions/--aogb-erp--");
});

test("discoverWorkspaceProfiles skips explicit names and rejects sessionDir overlap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-overlap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "shared"));
  await mkdir(join(root, "project"));

  const skipped = discoverWorkspaceProfiles({
    root,
    sessionDirPrefix: "/sessions",
    existingNames: new Set(["shared"]),
    existingSessionDirs: [{ name: "shared", path: "/sessions/--shared--" }],
  });
  assert.deepEqual(skipped.map((item) => item.name), ["project"]);

  assert.throws(() => discoverWorkspaceProfiles({
    root,
    sessionDirPrefix: "/sessions",
    existingNames: new Set(),
    existingSessionDirs: [{ name: "default", path: "/sessions" }],
  }), /overlaps default/);
});

test("discoverWorkspaceProfiles rejects symlink escape and over-limit trees", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-escape-"));
  const other = await mkdtemp(join(tmpdir(), "pi-discover-other-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(other, { recursive: true, force: true }));
  await symlink(other, join(root, "escaped"));
  await mkdir(join(root, "keep"));

  const found = discoverWorkspaceProfiles({
    root,
    sessionDirPrefix: "/sessions",
  });
  assert.deepEqual(found.map((item) => item.name), ["keep"]);

  await mkdir(join(root, "extra"));
  assert.throws(() => discoverWorkspaceProfiles({
    root,
    sessionDirPrefix: "/sessions",
    maxProfiles: 1,
  }), /maxProfiles is 1/);
});

test("normalizeConfig merges discovered profiles and keeps explicit overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-discover-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "aogb-erp"));
  await mkdir(join(root, "custom"));
  await mkdir(join(root, "tmp-ignore"));

  const cfg = baseConfig({
    autoDiscoverProfiles: {
      enable: true,
      root,
      sessionDirPrefix: "/home/agent/.pi/agent/sessions",
      excludePrefixes: ["tmp-"],
      args: ["--approve"],
      envReferences: { GH_TOKEN: "GH_TOKEN" },
    },
    profiles: {
      default: {
        cwd: root,
        sessionDir: "/home/agent/.pi/agent/sessions/--workspace--",
      },
      custom: {
        cwd: join(root, "custom"),
        sessionDir: "/home/agent/.pi/agent/sessions/--custom-explicit--",
        args: ["--no-context-files"],
      },
    },
  });

  const normalized = normalizeConfig(cfg, { GH_TOKEN: "secret-token" });
  assert.deepEqual([...normalized.profiles.keys()].sort(), ["aogb-erp", "custom", "default"]);
  assert.deepEqual(normalized.discoveredProfiles, ["aogb-erp"]);
  assert.equal(normalized.profiles.get("aogb-erp").cwd, join(root, "aogb-erp"));
  assert.equal(normalized.profiles.get("aogb-erp").sessionDir, "/home/agent/.pi/agent/sessions/--aogb-erp--");
  assert.deepEqual(normalized.profiles.get("aogb-erp").args, ["--approve"]);
  assert.equal(normalized.profiles.get("aogb-erp").env.GH_TOKEN, "secret-token");
  assert.deepEqual(normalized.profiles.get("custom").args, ["--no-context-files"]);
  assert.equal(normalized.profiles.get("custom").sessionDir, "/home/agent/.pi/agent/sessions/--custom-explicit--");
});

test("normalizeConfig leaves discovery disabled and rejects bad discovery config", () => {
  const disabled = normalizeConfig(baseConfig({
    autoDiscoverProfiles: { enable: false, root: "/workspace", sessionDirPrefix: "/sessions" },
  }));
  assert.deepEqual(disabled.discoveredProfiles, []);
  assert.equal(disabled.profiles.size, 1);

  assert.throws(() => normalizeConfig(baseConfig({
    autoDiscoverProfiles: { enable: true, root: "relative", sessionDirPrefix: "/sessions" },
  })), /absolute path/);
  assert.throws(() => normalizeConfig(baseConfig({
    autoDiscoverProfiles: {
      enable: true,
      root: "/workspace",
      sessionDirPrefix: "/sessions",
      unknown: true,
    },
  })), /unknown key unknown/);
  assert.throws(() => normalizeConfig(baseConfig({
    autoDiscoverProfiles: {
      enable: true,
      root: "/workspace",
      sessionDirPrefix: "/sessions",
      args: ["--session-dir=/tmp"],
    },
  })), /supervisor-owned/);
});
