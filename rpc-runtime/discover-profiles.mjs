import { readdirSync as defaultReaddirSync, realpathSync as defaultRealpathSync, statSync as defaultStatSync } from "node:fs";
import { join, normalize as normalizePath } from "node:path";

export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const within = (path, root) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

function assertAbsoluteNormalized(path, label) {
  if (typeof path !== "string" || !path.startsWith("/") || normalizePath(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

function isExcluded(name, exclude, excludePrefixes) {
  if (exclude.has(name)) return true;
  return excludePrefixes.some((prefix) => name.startsWith(prefix));
}

function sessionDirsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * Scan immediate children of root and synthesize Pi RPC profiles.
 * Explicit profile names win; discovered entries never replace them.
 */
export function discoverWorkspaceProfiles({
  root,
  sessionDirPrefix,
  exclude = [],
  excludePrefixes = [],
  maxProfiles = 64,
  existingNames = new Set(),
  existingSessionDirs = [],
  readdirSync = defaultReaddirSync,
  statSync = defaultStatSync,
  realpathSync = defaultRealpathSync,
} = {}) {
  const resolvedRoot = assertAbsoluteNormalized(root, "autoDiscoverProfiles.root");
  const resolvedPrefix = assertAbsoluteNormalized(sessionDirPrefix, "autoDiscoverProfiles.sessionDirPrefix");
  if (!Number.isInteger(maxProfiles) || maxProfiles < 1 || maxProfiles > 1000) {
    throw new Error("autoDiscoverProfiles.maxProfiles must be an integer between 1 and 1000");
  }
  if (!Array.isArray(exclude) || exclude.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("autoDiscoverProfiles.exclude must be an array of non-empty strings");
  }
  if (!Array.isArray(excludePrefixes) || excludePrefixes.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error("autoDiscoverProfiles.excludePrefixes must be an array of non-empty strings");
  }

  let rootReal;
  try {
    const rootStat = statSync(resolvedRoot);
    if (!rootStat.isDirectory()) throw new Error("autoDiscoverProfiles.root must be a directory");
    rootReal = realpathSync(resolvedRoot);
  } catch (error) {
    throw new Error(`autoDiscoverProfiles.root is inaccessible: ${error.message}`);
  }

  const excludeSet = new Set(exclude);
  let entries;
  try {
    entries = readdirSync(resolvedRoot, { withFileTypes: true });
  } catch (error) {
    throw new Error(`autoDiscoverProfiles.root could not be read: ${error.message}`);
  }

  const candidates = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!PROFILE_NAME_RE.test(name) || isExcluded(name, excludeSet, excludePrefixes)) continue;
    if (existingNames.has(name)) continue;

    const cwd = join(resolvedRoot, name);
    let targetReal;
    try {
      const info = statSync(cwd);
      if (!info.isDirectory()) continue;
      targetReal = realpathSync(cwd);
    } catch {
      continue;
    }
    if (!within(targetReal, rootReal)) continue;

    const sessionDir = `${resolvedPrefix}/--${name}--`;
    if (normalizePath(sessionDir) !== sessionDir) {
      throw new Error(`autoDiscoverProfiles produced a non-normalized sessionDir for ${name}`);
    }
    for (const owned of existingSessionDirs) {
      if (sessionDirsOverlap(sessionDir, owned.path)) {
        throw new Error(`discovered profile session directory overlaps ${owned.name} (${sessionDir})`);
      }
    }
    for (const prior of candidates) {
      if (sessionDirsOverlap(sessionDir, prior.sessionDir)) {
        throw new Error(`discovered profile session directories overlap (${prior.name} and ${name})`);
      }
    }
    candidates.push({ name, cwd, sessionDir });
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name));
  if (candidates.length > maxProfiles) {
    throw new Error(`autoDiscoverProfiles found ${candidates.length} profiles; maxProfiles is ${maxProfiles}`);
  }
  return candidates;
}

const SESSION_FOLDER_RE = /^--([A-Za-z0-9][A-Za-z0-9._-]{0,63})--$/;

/**
 * Find persistent `--name--` history folders that no longer have a live project
 * profile. Callers attach these to the default profile so sessions remain listed
 * when workspace directories come and go.
 */
export function discoverOrphanSessionDirs({
  sessionDirPrefix,
  existingSessionDirs = [],
  readdirSync = defaultReaddirSync,
  statSync = defaultStatSync,
} = {}) {
  const resolvedPrefix = assertAbsoluteNormalized(sessionDirPrefix, "orphanSessionDirs.sessionDirPrefix");
  if (!Array.isArray(existingSessionDirs)) {
    throw new Error("orphanSessionDirs.existingSessionDirs must be an array");
  }
  const owned = new Set();
  for (const item of existingSessionDirs) {
    if (!item || typeof item.path !== "string" || !item.path) {
      throw new Error("orphanSessionDirs.existingSessionDirs entries require a path");
    }
    owned.add(item.path);
  }

  let entries;
  try {
    entries = readdirSync(resolvedPrefix, { withFileTypes: true });
  } catch (error) {
    // Fresh installs and Nix check sandboxes may not have created the prefix yet.
    // No directory means there are simply no orphan history folders to attach.
    if (error && (error.code === "ENOENT" || /ENOENT/.test(String(error.message || "")))) return [];
    throw new Error(`orphanSessionDirs.sessionDirPrefix could not be read: ${error.message}`);
  }

  const orphans = [];
  for (const entry of entries) {
    const matched = SESSION_FOLDER_RE.exec(entry.name);
    if (!matched) continue;
    const name = matched[1];
    if (!PROFILE_NAME_RE.test(name)) continue;
    const sessionDir = `${resolvedPrefix}/${entry.name}`;
    if (normalizePath(sessionDir) !== sessionDir) continue;
    if (owned.has(sessionDir)) continue;
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
    } catch {
      continue;
    }
    orphans.push({ name, sessionDir });
  }
  orphans.sort((a, b) => a.name.localeCompare(b.name));
  return orphans;
}
