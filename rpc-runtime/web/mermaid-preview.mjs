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

export function resetMermaidLoader() {
  mermaidPromise = undefined;
  renderCount = 0;
}

// Lazy-load the vendored tiny IIFE once. Preview stays opt-in so the chat path
// does not pay for Mermaid until a ```mermaid fence is opened.
export function loadMermaid() {
  const existing = mermaidGlobal();
  if (existing?.initialize && existing?.render) return Promise.resolve(existing);
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
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      });
      resolve(mermaid);
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
  const cleaned = text
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "");
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
