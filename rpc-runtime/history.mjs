import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { messageTitle } from "./web/session-title.mjs";

// Pi currently creates UUIDv7 IDs; older persisted conversations use UUIDv4.
export const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOW_BYTES = 64 * 1024;
const MAX_ENTRIES = 10_000;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

// Pi 0.84.2 SessionManager v3: parentId selects the branch; the last
// serialized entry becomes the leaf on open. Never truncate the source file.
export function conversationBranch(data) {
  if (!data || !Array.isArray(data.entries) || !(data.leafId === null || typeof data.leafId === "string")) {
    throw new Error("invalid Pi entries snapshot");
  }
  const byId = new Map();
  for (const entry of data.entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || byId.has(entry.id)
      || typeof entry.type !== "string" || entry.type === "session"
      || !(entry.parentId === null || typeof entry.parentId === "string")) {
      throw new Error("invalid or duplicate Pi entry");
    }
    byId.set(entry.id, entry);
  }
  const branch = [], seen = new Set();
  let id = data.leafId;
  while (id !== null) {
    const entry = byId.get(id);
    if (!entry || seen.has(id)) throw new Error("broken Pi branch");
    seen.add(id);
    branch.push(entry);
    id = entry.parentId;
  }
  return branch.reverse();
}

export function conversationDraft(message) {
  if (typeof message.content === "string") return { text: message.content, images: [] };
  if (!Array.isArray(message.content)) throw new Error("unsupported user message content");
  const text = [], images = [];
  for (const block of message.content) {
    if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
    else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      images.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else throw new Error("unsupported user message content");
  }
  return { text: text.join("\n"), images };
}

async function historyDirectory(profile) {
  if (typeof profile.sessionDir !== "string" || !profile.sessionDir) return null;
  const path = resolve(profile.sessionDir);
  if (!(await lstat(path)).isDirectory()) return null;
  return realpath(path);
}

async function readHeader(handle, id, cwd) {
  const info = await handle.stat();
  if (!info.isFile()) return null;
  const first = Buffer.alloc(Math.min(WINDOW_BYTES, info.size));
  const { bytesRead } = await handle.read(first, 0, first.length, 0);
  const lines = first.subarray(0, bytesRead).toString("utf8").split("\n");
  if (info.size > bytesRead) lines.pop();
  const header = JSON.parse(lines.shift());
  if (header?.type !== "session" || header.id !== id || header.cwd !== cwd) return null;
  return { info, header, lines };
}

export async function resolveHistorySession(profile, id) {
  if (typeof id !== "string" || !NATIVE_SESSION_ID_RE.test(id)) return null;
  try {
    const root = await historyDirectory(profile);
    if (!root) return null;
    const directory = await opendir(root);
    let visited = 0, match = null;
    for await (const entry of directory) {
      if (entry.name === ".session-folders" && entry.isDirectory()) continue;
      // An incomplete scan cannot establish that a match is unique.
      if (++visited > MAX_ENTRIES) return null;
      if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.slice(-42, -6) !== id) continue;
      const path = join(root, entry.name);
      let handle;
      try {
        handle = await open(path, READ_FLAGS);
        if (!(await readHeader(handle, id, profile.cwd))) continue;
        if (match) return null;
        match = path;
      } catch { /* Corrupt, unreadable or replaced entries are not sessions. */ }
      finally { await handle?.close(); }
    }
    return match;
  } catch { return null; }
}

// Read-only validation of the source. All writes go to an exclusively created
// child file, published only when complete. No client-supplied paths are used.
export async function createConversationHistory(profile, sourceId, snapshot, prefix, id, maxBytes) {
  if (!NATIVE_SESSION_ID_RE.test(id) || id === sourceId) throw new Error("invalid child session ID");
  const source = await resolveHistorySession(profile, sourceId);
  if (!source) throw new Error("source history is not uniquely persisted");
  const handle = await open(source, READ_FLAGS);
  try {
    const parsed = await readHeader(handle, sourceId, profile.cwd);
    if (!parsed || parsed.header.version !== 3 || parsed.info.size > maxBytes) throw new Error("unsupported source history");
    const buffer = Buffer.alloc(parsed.info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead !== parsed.info.size || after.size !== parsed.info.size || after.mtimeMs !== parsed.info.mtimeMs) {
      throw new Error("source history changed");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    const entries = text.trimEnd().split("\n").map((line) => JSON.parse(line));
    if (!isDeepStrictEqual(entries.slice(1), snapshot.entries)) throw new Error("source history is not fully persisted");
  } finally { await handle.close(); }
  const root = await historyDirectory(profile);
  if (!root || resolve(source, "..") !== root) throw new Error("source directory changed");
  const timestamp = new Date().toISOString();
  const path = join(root, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const temporary = join(root, `.conversation-${id}.tmp`);
  const header = { type: "session", version: 3, id, timestamp, cwd: profile.cwd, parentSession: source };
  const output = [header, ...prefix].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const child = await open(temporary, "wx", 0o600);
  try {
    await child.writeFile(output);
    await child.sync();
    await link(temporary, path); // Atomic publication without overwriting any history.
  } finally {
    await child.close();
    await unlink(temporary);
  }
  return path;
}

// Sidecar markers leave native Pi JSONL files untouched. Exclusive creation
// makes repeated archive requests safe without following existing symlinks.
export async function archiveHistory(profile, id) {
  if (!profile.sessionDir) return; // Ephemeral profiles have no browsable history.
  if (!NATIVE_SESSION_ID_RE.test(id)) throw new Error("invalid archive session ID");
  let root;
  try { root = await historyDirectory(profile); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!root) throw new Error("invalid history directory");
  const path = join(root, `.archived-${id.toLowerCase()}`);
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.sync();
  } catch (error) {
    if (error.code !== "EEXIST" || !(await lstat(path)).isFile()) throw error;
  } finally { await handle?.close(); }
}

export async function listHistory(profile, profileName, { includeArchived = false } = {}) {
  if (!profile.sessionDir) return { sessions: [], truncated: false };
  let directory, root;
  try {
    root = await historyDirectory(profile);
    if (!root) return { sessions: [], truncated: false };
    directory = await opendir(root);
  } catch (error) {
    if (error.code === "ENOENT") return { sessions: [], truncated: false };
    throw error;
  }
  const files = [];
  let visited = 0, truncated = false;
  for await (const entry of directory) {
    if (entry.name === ".session-folders" && entry.isDirectory()) continue;
    if (++visited > MAX_ENTRIES) { truncated = true; break; }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const id = entry.name.slice(-42, -6);
    if (!NATIVE_SESSION_ID_RE.test(id)) continue;
    const path = join(root, entry.name);
    try {
      let archived = false;
      try {
        await lstat(join(root, `.archived-${id.toLowerCase()}`));
        archived = true;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (archived && !includeArchived) continue;
      const info = await lstat(path);
      if (info.isFile()) files.push({ path, id, archived, modified: info.mtimeMs });
    } catch { /* A session can be removed while the directory is being scanned. */ }
  }
  files.sort((a, b) => b.modified - a.modified);
  if (files.length > 1000) truncated = true;
  const sessions = [], seen = new Set(), duplicates = new Set();
  for (const file of files.slice(0, 1000)) {
    let handle;
    try {
      // Never follow a session-file symlink, or block on a replaced FIFO.
      handle = await open(file.path, READ_FLAGS);
      const parsed = await readHeader(handle, file.id, profile.cwd);
      if (!parsed) continue;
      const { info, header, lines } = parsed;
      if (seen.has(header.id)) { duplicates.add(header.id); continue; }
      seen.add(header.id);
      if (info.size > WINDOW_BYTES) {
        const last = Buffer.alloc(WINDOW_BYTES);
        const result = await handle.read(last, 0, last.length, info.size - last.length);
        // Discard the first partial record; an incomplete final append is ignored below.
        lines.push(...last.subarray(0, result.bytesRead).toString("utf8").split("\n").slice(1));
      }
      let name, firstMessage;
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry?.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() : "";
        if (!firstMessage && entry?.type === "message" && entry.message?.role === "user") {
          firstMessage = messageTitle([entry.message]);
        }
      }
      const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
      sessions.push({
        id: header.id, name: (name || firstMessage || "Untitled session").slice(0, 200),
        cwd: header.cwd, profile: profileName,
        createdAt: Number.isFinite(created) ? new Date(created).toISOString() : info.mtime.toISOString(),
        modifiedAt: info.mtime.toISOString(),
        archived: file.archived,
      });
    } catch { /* Discovery is best effort; corrupt/unreadable files are not sessions. */ }
    finally { await handle?.close(); }
  }
  return { sessions: sessions.filter((session) => !duplicates.has(session.id)), truncated };
}

// Folder names are labels, never filesystem paths. Keep normalization identical
// to web/sidebar.mjs (including empty slash components and JS string lengths).
export function normalizeSessionFolder(value) {
  if (typeof value !== "string") throw new Error("folder must be a string");
  const parts = value.trim().split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 12 || parts.some((part) => part === "." || part === ".." || part.length > 80)) {
    throw new Error("Use up to 12 folder levels, with names of at most 80 characters (not . or ..).");
  }
  return parts.join("/");
}

export async function sessionFolderDirectory(profile) {
  try {
    const root = await historyDirectory(profile);
    if (root) return root;
  } catch { /* Surface unavailable storage consistently, including permissions. */ }
  throw new Error("session folders require an accessible profile sessionDir directory");
}

function folderPrefix(profile, profileName) {
  // Profiles sharing storage must not share assignments. No supplied path or
  // profile name is interpolated into a filename.
  const scope = createHash("sha256").update(JSON.stringify([profileName, profile.cwd])).digest("hex");
  return `.session-folder-${scope}-`;
}

// Pin both directory lookups with no-follow handles. The Linux runtime uses
// procfs descriptor paths as openat-style anchors: replacing the subdirectory
// with a symlink after validation cannot redirect reads, writes or cleanup.
async function openFolderStorage(root, create) {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const parent = await open(root, flags);
  try {
    const path = `/proc/self/fd/${parent.fd}/.session-folders`;
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    let directory;
    try { directory = await open(path, flags); }
    catch (error) { if (!create && error.code === "ENOENT") return null; throw error; }
    try {
      if (create) await parent.sync();
      return directory;
    } catch (error) { await directory.close(); throw error; }
  } finally { await parent.close(); }
}

async function readSessionFolder(path, id) {
  const handle = await open(path, READ_FLAGS);
  try {
    const info = await handle.stat();
    // Worst-case JSON escaping of 12 * 80 UTF-16 units fits in 8 KiB.
    if (!info.isFile() || info.size > 8192) throw new Error("invalid folder sidecar");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw new Error("folder sidecar changed");
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (value?.id !== id || normalizeSessionFolder(value.folder) !== value.folder) {
      throw new Error("invalid folder sidecar");
    }
    return value.folder;
  } finally { await handle.close(); }
}

export async function writeSessionFolder(root, profile, profileName, id, folder, { importOnly = false } = {}) {
  if (typeof id !== "string" || !NATIVE_SESSION_ID_RE.test(id)) throw new Error("invalid session ID");
  if (typeof importOnly !== "boolean") throw new Error("importOnly must be a boolean");
  folder = normalizeSessionFolder(folder);
  const directory = await openFolderStorage(root, true);
  try {
    const base = `/proc/self/fd/${directory.fd}`;
    const path = join(base, `${folderPrefix(profile, profileName)}${id}.json`);
    const temporary = join(base, `.session-folder-tmp-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      // Empty folders are persistent tombstones, not absent metadata.
      await handle.writeFile(JSON.stringify({ id, folder }));
      await handle.sync();
      if (importOnly) {
        // Atomic create-if-absent across processes, including concurrent updates.
        try { await link(temporary, path); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      } else {
        // Atomic per-session replacement, without following destination symlinks.
        await rename(temporary, path);
      }
    } finally {
      await handle.close();
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    await directory.sync();
    // A losing import must report stored metadata, never the proposed label.
    return importOnly ? await readSessionFolder(path, id) : folder;
  } finally { await directory.close(); }
}

export async function listSessionFolders(root, profile, profileName) {
  const storage = await openFolderStorage(root, false);
  if (!storage) return [];
  try {
    const prefix = folderPrefix(profile, profileName);
    const folders = [], native = new Set(), duplicates = new Set();
    const directory = await opendir(root);
    let visited = 0;
    for await (const entry of directory) {
      if (entry.name === ".session-folders" && entry.isDirectory()) continue;
      if (++visited > MAX_ENTRIES) throw new Error("native session directory exceeds 10000 entries");
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(-42, -6);
      if (!NATIVE_SESSION_ID_RE.test(id)) continue;
      let handle;
      try {
        handle = await open(join(root, entry.name), READ_FLAGS);
        if (await readHeader(handle, id, profile.cwd)) {
          if (native.has(id)) duplicates.add(id);
          native.add(id);
        }
      } catch { /* Same best-effort native discovery as history listing. */ }
      finally { await handle?.close(); }
    }
    // Bounded exact lookups rather than a metadata directory scan. At most
    // MAX_ENTRIES sidecars are read, regardless of stale files, other scopes or
    // concurrent temporary writes. Metadata accumulation cannot brick GET.
    for (const id of native) {
      if (duplicates.has(id)) continue;
      try {
        const folder = await readSessionFolder(`/proc/self/fd/${storage.fd}/${prefix}${id}.json`, id);
        folders.push({ id, folder });
      } catch { /* Ignore corrupt, symlinked, non-regular or removed sidecars. */ }
    }
    return folders.sort((a, b) => a.id.localeCompare(b.id));
  } finally { await storage.close(); }
}
