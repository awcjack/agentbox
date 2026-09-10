import { constants } from "node:fs";
import { link, lstat, open, opendir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

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
