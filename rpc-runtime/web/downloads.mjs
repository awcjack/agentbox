// Classification only: the server remains authoritative for workspace/symlink checks.
export const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

export function localDownloadPath(value, { encoded = false, explicit = false } = {}) {
  if (typeof value !== "string") return null;
  let path = value.trim();
  if (encoded) {
    // URL fragments/query strings are not part of the filename; percent-encoded
    // literal # and ? characters still survive decoding below.
    path = path.split(/[?#]/, 1)[0];
    try { path = decodeURIComponent(path); } catch { return null; }
  }
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1, -1);
  if (!path || /[\x00-\x1f\x7f\\]/.test(path) || /^(?:[a-z][a-z\d+.-]*:|\/\/|#|~)/i.test(path) || path.endsWith("/")) return null;
  if (!explicit && !path.includes("/") && !/\.[a-z\d_-]{1,16}$/i.test(path)) return null;
  return path;
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
