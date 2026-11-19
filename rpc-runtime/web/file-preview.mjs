const MAX_TEXT_BYTES = 1024 * 1024;
const RASTER_TYPES = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
};
const SOURCE_EXTENSIONS = new Set(["svg", "svgz", "html", "htm", "xhtml"]);
const SOURCE_TYPES = new Set(["image/svg+xml", "text/html", "application/xhtml+xml"]);

/** Local-only preview. renderMarkdown must be a safe renderer and receives only text,
 * never file-link callbacks. The caller owns dispose(), including on stale results.
 */
export async function createFilePreview(blob, filename, {
  document: doc = document, URL: urls = URL, renderMarkdown, valid = () => true,
} = {}) {
  const node = doc.createElement("div");
  node.className = "file-preview";
  const objectUrls = [];
  let disposed = false;
  const current = () => !disposed && valid();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const url of objectUrls) urls.revokeObjectURL(url);
    objectUrls.length = 0;
    node.textContent = "";
  };
  const result = { node, dispose };
  const message = (text) => {
    const paragraph = doc.createElement("p");
    paragraph.textContent = text;
    node.append(paragraph);
  };
  if (!current()) return result;

  const extension = String(filename ?? "").split(/[\\/]/).pop().split(".").pop().toLowerCase();
  const mime = String(blob.type || "").split(";", 1)[0].trim().toLowerCase();
  // Active source formats must never be promoted to an image/frame by a conflicting MIME.
  const sourceOnly = SOURCE_EXTENSIONS.has(extension) || SOURCE_TYPES.has(mime);
  const raster = sourceOnly ? null : (Object.hasOwn(RASTER_TYPES, extension) ? RASTER_TYPES[extension] : null)
    || Object.values(RASTER_TYPES).find(type => type === mime);
  const pdf = !sourceOnly && (extension === "pdf" || mime === "application/pdf");
  if (raster || pdf) {
    const media = doc.createElement(raster ? "img" : "iframe");
    if (raster) {
      media.alt = String(filename ?? "Image preview");
    } else {
      media.title = "PDF preview";
      media.setAttribute("sandbox", "");
    }
    media.setAttribute("referrerpolicy", "no-referrer");
    if (!current()) return result;
    const url = urls.createObjectURL(blob.slice(0, blob.size, raster || "application/pdf"));
    objectUrls.push(url);
    media.src = url;
    node.append(media);
    if (pdf) message("If your browser cannot display this sandboxed PDF preview, use Download file to view it locally.");
    return result;
  }

  let text;
  const truncated = blob.size > MAX_TEXT_BYTES;
  try {
    // Do not read the entire file just to decide whether it can be previewed.
    const bytes = new Uint8Array(await blob.slice(0, MAX_TEXT_BYTES).arrayBuffer());
    if (!current()) return result;
    // A partial final UTF-8 sequence at the truncation boundary is omitted, not
    // replaced with garbage. All complete sequences still receive fatal validation.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
      throw new Error("Binary control characters");
    }
  } catch {
    if (current()) message("Preview unavailable: unsupported binary file or unreadable text. Download the file to view it.");
    return result;
  }
  if (!current()) return result;
  if (!sourceOnly && ["md", "markdown"].includes(extension) && typeof renderMarkdown === "function") {
    const rendered = await renderMarkdown(text);
    if (!current()) return result;
    node.append(rendered);
  } else {
    const pre = doc.createElement("pre");
    pre.textContent = text;
    node.append(pre);
  }
  if (truncated) message("Preview truncated at 1 MiB. Download the file to view its full contents.");
  return result;
}
