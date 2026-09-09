import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

// Pi currently creates UUIDv7 IDs; older persisted conversations use UUIDv4.
export const NATIVE_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WINDOW_BYTES = 64 * 1024;
const MAX_ENTRIES = 10_000;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

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

export async function listHistory(profile, profileName) {
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
    if (++visited > MAX_ENTRIES) { truncated = true; break; }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const id = entry.name.slice(-42, -6);
    if (!NATIVE_SESSION_ID_RE.test(id)) continue;
    const path = join(root, entry.name);
    try {
      const info = await lstat(path);
      if (info.isFile()) files.push({ path, id, modified: info.mtimeMs });
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
          const content = entry.message.content;
          firstMessage = typeof content === "string" ? content : Array.isArray(content)
            ? content.filter((block) => block?.type === "text").map((block) => block.text).join(" ") : "";
        }
      }
      sessions.push({
        id: header.id, name: (name || firstMessage || "Untitled session").slice(0, 200),
        cwd: header.cwd, profile: profileName, modifiedAt: info.mtime.toISOString(),
      });
    } catch { /* Discovery is best effort; corrupt/unreadable files are not sessions. */ }
    finally { await handle?.close(); }
  }
  return { sessions: sessions.filter((session) => !duplicates.has(session.id)), truncated };
}
