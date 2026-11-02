// Resolve a file path to preview text from transcript tool calls/results.
// Prefers the latest successful write/edit/read that mentions the path.

import { parseToolArgs } from "./file-changes.mjs";

const PREVIEW_TOOLS = new Set(["write", "edit", "read", "apply_patch", "patch"]);
const PATH_KEYS = ["path", "file_path", "filePath", "notebook_path"];

function toolName(call, result) {
  return String(call?.name || result?.toolName || "").trim().toLowerCase();
}

function pathOf(args) {
  if (!args) return "";
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function samePath(left, right) {
  if (!left || !right) return false;
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function resultText(result) {
  if (!result) return "";
  if (typeof result.content === "string") return result.content;
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks.filter((block) => block?.type === "text" && block.text).map((block) => block.text).join("\n");
}

function writeText(args) {
  if (typeof args?.content === "string") return args.content;
  if (typeof args?.contents === "string") return args.contents;
  return "";
}

function editText(args) {
  const edits = Array.isArray(args?.edits) ? args.edits : null;
  if (edits?.length) {
    return edits.map((entry, index) => {
      const next = entry?.newText ?? entry?.new_string ?? entry?.newString ?? "";
      return edits.length === 1 ? String(next) : `--- edit ${index + 1} ---\n${next}`;
    }).join("\n\n");
  }
  return String(args?.newText ?? args?.new_string ?? "");
}

export function isMarkdownPath(path) {
  return /\.(md|markdown|mdx)$/i.test(String(path || ""));
}

export function pathBasename(path) {
  const value = String(path || "");
  const parts = value.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || value;
}

export function pathBreadcrumb(path) {
  const value = String(path || "").replace(/\\/g, "/");
  const parts = value.split("/").filter(Boolean);
  if (parts.length <= 1) return value;
  return `${parts.slice(0, -1).join(" / ")} › ${parts[parts.length - 1]}`;
}

/** @returns {{ path: string, text: string, source: string } | null} */
export function findFilePreview(messages, resultsMap, targetPath) {
  if (!targetPath) return null;
  const results = resultsMap instanceof Map ? resultsMap : new Map();
  let best = null;

  for (const message of messages || []) {
    if (message?.role === "toolResult") {
      const name = toolName(null, message);
      if (!PREVIEW_TOOLS.has(name) || message.isError) continue;
      const args = parseToolArgs({ arguments: message.args }, message);
      const path = pathOf(args);
      if (!samePath(path, targetPath)) continue;
      const text = resultText(message) || (name === "write" ? writeText(args) : name === "edit" ? editText(args) : "");
      if (!text) continue;
      best = { path: path || targetPath, text, source: name };
      continue;
    }
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== "toolCall") continue;
      const name = toolName(block);
      if (!PREVIEW_TOOLS.has(name)) continue;
      const result = results.get(block.id);
      if (result?.isError) continue;
      const args = parseToolArgs(block, result);
      const path = pathOf(args);
      if (!samePath(path, targetPath)) continue;
      let text = "";
      if (name === "write") text = writeText(args) || resultText(result);
      else if (name === "edit") text = editText(args) || resultText(result);
      else text = resultText(result);
      if (!text) continue;
      best = { path: path || targetPath, text, source: name };
    }
  }
  return best;
}
