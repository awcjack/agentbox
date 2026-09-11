export function safeHref(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, "https://workspace.invalid/");
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : null;
  } catch { return null; }
}

export function inlineTokens(text) {
  text = String(text ?? "");
  const tokens = [];
  const pattern = /(`+)([^`]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let offset = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > offset) tokens.push({ type: "text", text: text.slice(offset, match.index) });
    if (match[1]) tokens.push({ type: "code", text: match[2] });
    else if (match[3] || match[4]) tokens.push({ type: "strong", text: match[3] || match[4] });
    else if (match[5] || match[6]) tokens.push({ type: "em", text: match[5] || match[6] });
    else {
      const href = safeHref(match[8]);
      tokens.push(href ? { type: "a", text: match[7], href } : { type: "text", text: match[0] });
    }
    offset = match.index + match[0].length;
  }
  if (offset < text.length) tokens.push({ type: "text", text: text.slice(offset) });
  return tokens;
}

export function markdownBlocks(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  const startsBlock = (line) => /^(?:\s*$| {0,3}(?:`{3,}|~{3,}|#{1,6} |>|[-*+] |\d+\. |(?:\*\s*){3,}$|(?:-\s*){3,}$|(?:_\s*){3,}$))/.test(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    if (!line.trim()) continue;
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const content = [];
      const closing = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !closing.test(lines[i])) content.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: "code", language: fence[2].trim().split(/\s/)[0], text: content.join("\n") });
      continue;
    }
    const heading = /^ {0,3}(#{1,6}) (.*)$/.exec(line);
    if (heading) { blocks.push({ type: `h${heading[1].length}`, text: heading[2] }); continue; }
    if (/^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) { blocks.push({ type: "hr" }); continue; }
    if (/^ {0,3}>/.test(line)) {
      const content = [line.replace(/^ {0,3}> ?/, "")];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) content.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      blocks.push({ type: "blockquote", text: content.join("\n") }); continue;
    }
    const list = /^ {0,3}([-*+]|\d+\.) (.*)$/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const itemPattern = ordered ? /^ {0,3}\d+\. (.*)$/ : /^ {0,3}[-*+] (.*)$/;
      const items = [list[2]];
      let next;
      while (i < lines.length && (next = itemPattern.exec(lines[i]))) { items.push(next[1]); i++; }
      blocks.push({ type: ordered ? "ol" : "ul", start: ordered ? Number.parseInt(list[1], 10) : undefined, items }); continue;
    }
    const content = [line];
    while (i < lines.length && !startsBlock(lines[i])) content.push(lines[i++]);
    blocks.push({ type: "p", text: content.join("\n") });
  }
  return blocks;
}

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export async function copyText(text) {
  const focused = document.activeElement;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = element("textarea", "clipboard-copy");
  textarea.value = text; textarea.readOnly = true; textarea.tabIndex = -1;
  try {
    // Run synchronously in the click gesture: this also works on plain HTTP.
    document.body.append(textarea); textarea.focus({ preventScroll: true }); textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (document.execCommand("copy")) return true;
  } catch { /* Try the modern API when legacy copying is unavailable. */ }
  finally {
    textarea.remove();
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
  }
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text); return true;
  } catch { return false; }
}

export function renderMarkdown(source) {
  const root = element("div", "markdown");
  function inline(parent, text) {
    for (const token of inlineTokens(text)) {
      if (token.type === "text") { parent.append(document.createTextNode(token.text)); continue; }
      const child = element(token.type, "", token.text);
      if (token.type === "a") { child.href = token.href; child.target = "_blank"; child.rel = "noopener noreferrer"; }
      parent.append(child);
    }
  }
  for (const block of markdownBlocks(source)) {
    if (block.type === "code") {
      const wrapper = element("div", "code-block");
      const heading = element("div", "code-heading");
      heading.append(element("span", "", block.language || "code"));
      const copy = element("button", "text-button", "Copy");
      copy.type = "button";
      copy.addEventListener("click", async () => {
        if (await copyText(block.text)) copy.textContent = "Copied";
        else {
          const range = document.createRange(); range.selectNodeContents(code);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          copy.textContent = "Selected: copy manually";
        }
        setTimeout(() => { copy.textContent = "Copy"; }, 2500);
      });
      heading.append(copy);
      const pre = element("pre");
      const code = element("code", "", block.text);
      pre.append(code); wrapper.append(heading, pre); root.append(wrapper);
    } else {
      const node = element(block.type);
      if (block.items) {
        if (block.type === "ol") node.start = block.start;
        for (const item of block.items) { const li = element("li"); inline(li, item); node.append(li); }
      } else if (block.text !== undefined) inline(node, block.text);
      root.append(node);
    }
  }
  return root;
}

export function imageSource(image) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(image?.mimeType) || typeof image.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return null;
  return `data:${image.mimeType};base64,${image.data}`;
}
