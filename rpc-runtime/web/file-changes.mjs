// Derive Codex-style Edited-files summaries from write/edit tool calls in the transcript.
// Counts are approximate from tool arguments (not a real git diff).

const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "patch", "delete", "move"]);
const PATH_KEYS = ["path", "file_path", "filePath", "notebook_path", "destination", "dest", "target"];

export function parseToolArgs(call, result) {
  let args = call?.arguments ?? result?.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return null; }
  }
  return args && typeof args === "object" && !Array.isArray(args) ? args : null;
}

export function lineCount(text) {
  if (text == null) return 0;
  const value = String(text);
  if (!value) return 0;
  // Trailing newline should not inflate the count past the last visible line.
  return value.replace(/\n$/, "").split("\n").length;
}

function toolName(call, result) {
  return String(call?.name || result?.toolName || "").trim().toLowerCase();
}

function firstPath(args) {
  if (!args) return "";
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function countUnifiedDiff(text) {
  let added = 0, removed = 0;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function editLineDelta(args) {
  let added = 0, removed = 0;
  const edits = Array.isArray(args?.edits) ? args.edits : null;
  if (edits?.length) {
    for (const entry of edits) {
      if (!entry || typeof entry !== "object") continue;
      const oldText = entry.oldText ?? entry.old_string ?? entry.oldString ?? "";
      const newText = entry.newText ?? entry.new_string ?? entry.newString ?? "";
      removed += lineCount(oldText);
      added += lineCount(newText);
    }
    return { added, removed };
  }
  if (typeof args?.oldText === "string" || typeof args?.old_string === "string" || typeof args?.newText === "string" || typeof args?.new_string === "string") {
    const oldText = args.oldText ?? args.old_string ?? "";
    const newText = args.newText ?? args.new_string ?? "";
    return { added: lineCount(newText), removed: lineCount(oldText) };
  }
  return { added: 0, removed: 0 };
}

/** @returns {{ path: string, added: number, removed: number, op: string } | null} */
export function changeFromTool(call, result) {
  const name = toolName(call, result);
  if (!WRITE_TOOLS.has(name)) return null;
  if (result?.isError) return null;
  const args = parseToolArgs(call, result);
  const path = firstPath(args);
  if (!path) return null;

  if (name === "write") {
    const content = typeof args.content === "string" ? args.content
      : typeof args.contents === "string" ? args.contents
      : typeof args.new_string === "string" ? args.new_string
      : "";
    return { path, added: lineCount(content), removed: 0, op: "write" };
  }
  if (name === "edit") {
    const delta = editLineDelta(args);
    return { path, added: delta.added, removed: delta.removed, op: "edit" };
  }
  if (name === "apply_patch" || name === "patch") {
    const patch = typeof args.patch === "string" ? args.patch
      : typeof args.input === "string" ? args.input
      : typeof args.diff === "string" ? args.diff
      : "";
    const delta = countUnifiedDiff(patch);
    return { path, added: delta.added, removed: delta.removed, op: name };
  }
  if (name === "delete") return { path, added: 0, removed: 0, op: "delete" };
  if (name === "move") return { path, added: 0, removed: 0, op: "move" };
  return null;
}

export function createChangeAccumulator() {
  return new Map();
}

export function accumulateChange(store, change) {
  if (!change?.path) return store;
  const previous = store.get(change.path) || { path: change.path, added: 0, removed: 0, ops: [] };
  previous.added += Number(change.added) || 0;
  previous.removed += Number(change.removed) || 0;
  if (change.op && !previous.ops.includes(change.op)) previous.ops.push(change.op);
  store.set(change.path, previous);
  return store;
}

export function summarizeFileChanges(store) {
  const files = [...(store?.values?.() || [])]
    .map((file) => ({ path: file.path, added: file.added, removed: file.removed, ops: [...file.ops] }))
    .sort((a, b) => a.path.localeCompare(b.path));
  let added = 0, removed = 0;
  for (const file of files) { added += file.added; removed += file.removed; }
  return { files, added, removed };
}

export function formatDiffCount(value) {
  const amount = Math.max(0, Number(value) || 0);
  return amount.toLocaleString("en-US");
}

export function isWriteTool(name) {
  return WRITE_TOOLS.has(String(name || "").trim().toLowerCase());
}
