let mermaidPromise;
let renderCount = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function mermaidGlobal() {
  return globalThis.mermaid;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attrNumber(attrs, name) {
  const match = new RegExp(`\\b${name}="([^"]+)"`, "i").exec(attrs || "");
  const value = match ? Number.parseFloat(match[1]) : Number.NaN;
  return Number.isFinite(value) ? value : 0;
}

// Mermaid defaults to HTML labels inside <foreignObject>. Those do not paint
// inside data:image/svg+xml <img>, and deleting them removes every label.
// Prefer native SVG text via htmlLabels:false, and convert any leftover
// foreignObject content to a plain SVG <text> node.
export function sanitizeMermaidSvg(svg) {
  const text = String(svg ?? "").trim();
  return text
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<foreignObject\b([^>]*)>([\s\S]*?)<\/foreignObject>/gi, (_match, attrs, inner) => {
      const plain = String(inner).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (!plain) return "";
      const width = attrNumber(attrs, "width");
      const height = attrNumber(attrs, "height");
      const x = width / 2;
      const y = height / 2;
      return `<text text-anchor="middle" dominant-baseline="middle" x="${x}" y="${y}">${escapeXml(plain)}</text>`;
    });
}

export function resetMermaidLoader() {
  mermaidPromise = undefined;
  renderCount = 0;
}

function configureMermaid(mermaid) {
  // Native SVG <text> labels survive data: image preview; HTML labels do not.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
    fontFamily: "ui-sans-serif, system-ui, sans-serif",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
  });
  return mermaid;
}

// Lazy-load the vendored tiny IIFE once. Preview stays opt-in so the chat path
// does not pay for Mermaid until a ```mermaid fence is opened.
export function loadMermaid() {
  const existing = mermaidGlobal();
  if (existing?.initialize && existing?.render) return Promise.resolve(configureMermaid(existing));
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Mermaid preview requires a browser document"));
      return;
    }
    const script = document.createElement("script");
    script.src = new URL("./mermaid.tiny.js", import.meta.url).href;
    script.async = true;
    script.addEventListener("load", () => {
      const mermaid = mermaidGlobal();
      if (!mermaid?.initialize || !mermaid?.render) {
        reject(new Error("Mermaid failed to load"));
        return;
      }
      resolve(configureMermaid(mermaid));
    });
    script.addEventListener("error", () => reject(new Error("Mermaid failed to load")));
    document.head.append(script);
  }).catch((error) => {
    mermaidPromise = undefined;
    throw error;
  });
  return mermaidPromise;
}

export async function renderMermaidDiagram(source, { load = loadMermaid } = {}) {
  const mermaid = await load();
  const text = String(source ?? "");
  if (typeof mermaid.parse === "function") await mermaid.parse(text);
  const id = `mermaid-preview-${++renderCount}`;
  const result = await mermaid.render(id, text);
  const svg = typeof result === "string" ? result : result?.svg;
  if (typeof svg !== "string" || !svg.trim()) throw new Error("Mermaid did not return SVG");
  return svg;
}

// Present Mermaid SVG as an isolated image. Scripts and event handlers do not
// run from data: image/svg+xml, which keeps diagram preview free of code execution.
export function mermaidSvgImage(svg, alt = "Mermaid diagram") {
  const text = String(svg ?? "").trim();
  if (!/^<svg[\s>]/i.test(text) && !/^<\?xml[\s\S]*?<svg[\s>]/i.test(text)) {
    throw new Error("Mermaid did not return SVG");
  }
  const cleaned = sanitizeMermaidSvg(text);
  const img = element("img", "mermaid-diagram");
  img.alt = alt;
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cleaned)}`;
  return img;
}

export async function createMermaidPreview(source, { render = renderMermaidDiagram } = {}) {
  const root = element("div", "mermaid-preview markdown-preview");
  try {
    root.append(mermaidSvgImage(await render(source)));
  } catch (error) {
    root.classList.add("mermaid-error");
    root.append(element("p", "", `Mermaid preview failed: ${error?.message || error}`));
  }
  return root;
}
