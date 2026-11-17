// Suggestions only: the server remains authoritative for workspace/symlink checks.
export const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_DOWNLOAD_ACTIONS = 6;

function localPath(value, { encoded = false, explicit = false } = {}) {
  let path = value.trim();
  if (encoded) {
    try { path = decodeURIComponent(path); } catch { return null; }
    path = path.replace(/\\([\\ ()\[\]])/g, "$1");
  }
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  if (!path || /[\x00-\x1f\x7f]/.test(path) || /^(?:[a-z][a-z\d+.-]*:|\/\/|#|~)/i.test(path) || path.endsWith("/")) return null;
  if (!explicit && !path.includes("/") && !/\.[a-z\d_-]{1,16}$/i.test(path)) return null;
  return path;
}

export function extractDownloadPaths(text, limit = MAX_DOWNLOAD_ACTIONS) {
  if (typeof text !== "string") return [];
  const found = [], seen = new Set();
  const add = (value, options) => {
    const path = localPath(value, options);
    if (path && !seen.has(path)) { seen.add(path); found.push(path); }
  };
  // Ignore fenced programs: commands and examples are not file suggestions.
  const source = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "");
  // Mask recognized spans so bare-path detection cannot split filenames with spaces.
  const rest = source.replace(/(`+)([^`\n]+)\1/g, (match, ticks, value) => {
    add(value); return " ".repeat(match.length);
  });
  // Balanced destinations allow report(1).zip; angle destinations allow spaces.
  const masked = rest.split("");
  const start = /!?\[[^\]\n]*\]\(/g;
  for (let match; (match = start.exec(rest));) {
    let i = start.lastIndex;
    while (rest[i] === " ") i++;
    const angle = rest[i] === "<";
    if (angle) i++;
    const begin = i;
    let depth = 0;
    for (; i < rest.length && rest[i] !== "\n"; i++) {
      if (rest[i] === "\\") { i++; continue; }
      if (angle ? rest[i] === ">" : (rest[i] === ")" && depth === 0) || /\s/.test(rest[i])) break;
      if (!angle && rest[i] === "(") depth++;
      if (!angle && rest[i] === ")") depth--;
    }
    const destination = rest.slice(begin, i);
    const tail = rest.slice(i);
    const close = tail.match(angle ? /^>\s*(?:"[^"\n]*"|'[^'\n]*')?\s*\)/ : /^\s*(?:"[^"\n]*"|'[^'\n]*')?\s*\)/);
    if (!close) continue;
    if (!match[0].startsWith("!")) add(destination, { encoded: true, explicit: true });
    const end = i + close[0].length;
    for (let j = match.index; j < end; j++) masked[j] = " ";
    start.lastIndex = end;
  }
  // Bare absolute paths are a convenience; quote/code paths containing spaces.
  for (const match of masked.join("").matchAll(/(?:^|[\s(])((?:\/(?!\/))[^\s<>`"']+)/g)) {
    add(match[1].replace(/[.,;:!?\])}]+$/, ""));
  }
  return found.slice(0, Math.max(0, Math.min(MAX_DOWNLOAD_ACTIONS, limit)));
}

export function downloadFilename(value) {
  if (typeof value !== "string") return "download";
  const name = value.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, "_").trim().slice(0, 240);
  return !name || /^\.+$/.test(name) ? "download" : name;
}

export function downloadBlob(response) {
  if (response?.mimeType !== "application/octet-stream" || typeof response.data !== "string"
      || response.data.length > 4 * Math.ceil(MAX_DOWNLOAD_BYTES / 3)
      || response.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(response.data)) {
    throw new Error("The server returned an invalid file download.");
  }
  const binary = atob(response.data);
  if (binary.length > MAX_DOWNLOAD_BYTES) throw new Error("Files must be 16 MiB or smaller.");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "application/octet-stream" });
}

export function saveDownload(blob, filename, { document: doc = document, URL: urls = URL, defer = setTimeout } = {}) {
  const url = urls.createObjectURL(blob);
  let link;
  try {
    link = doc.createElement("a");
    link.href = url; link.download = downloadFilename(filename);
    doc.body.append(link); link.click();
  } finally {
    link?.remove();
    defer(() => urls.revokeObjectURL(url), 1000);
  }
}

// All I/O is initiated by an explicit UI click. Never put credentials in a URL.
export async function fetchDownload({ request, sessionId, nativeSessionId, path, signal, valid, save = saveDownload }) {
  if (!valid()) return false;
  const response = await request(`/v1/sessions/${encodeURIComponent(sessionId)}/downloads`, {
    body: { path }, nativeSessionId, signal,
  });
  if (!valid()) return false;
  if (response?.nativeSessionId !== nativeSessionId) throw new Error("The conversation changed. Refresh before downloading.");
  const blob = downloadBlob(response);
  if (!valid()) return false;
  save(blob, response.filename);
  return true;
}
