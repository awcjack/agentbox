const activitySymbols = new Map([
  ["starting", "◷"],
  ["running", "▶"],
  ["waiting_reply", "?"],
  ["waiting_action", "!"],
  ["finished", "✓"],
  ["idle", "○"],
  ["stopping", "■"],
  ["exited", "×"],
  ["history", "/"],
]);

export function sessionActivitySymbol(activity) {
  return activitySymbols.get(activity) || ">";
}

// History timestamps are normalized UTC strings. Older servers only expose modifiedAt.
export function compareArchivedSessions(a, b) {
  return String(b.createdAt || b.modifiedAt || "").localeCompare(String(a.createdAt || a.modifiedAt || ""));
}

// Folder membership follows the native conversation across runtime restarts.
export function sessionFolderKey(session, historical = false) {
  return JSON.stringify([session.profile, historical ? session.id : session.nativeSessionId || `runtime:${session.id}`]);
}
export function normalizeFolder(value) {
  const parts = value.trim().split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 12 || parts.some((part) => part === "." || part === ".." || part.length > 80)) {
    throw new Error("Use up to 12 folder levels, with names of at most 80 characters (not . or ..).");
  }
  return parts.join("/");
}
export function readSessionFolders(storage) {
  try {
    const entries = JSON.parse(storage?.getItem("agentbox.pi.session-folders.v1") || "[]");
    return new Map(entries.filter((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string").map(([key, value]) => [key, normalizeFolder(value)]));
  } catch { return new Map(); }
}
export function saveSessionFolders(storage, folders) {
  try {
    if (!storage) return false;
    storage.setItem("agentbox.pi.session-folders.v1", JSON.stringify([...folders]));
    return true;
  } catch { return false; }
}

// Transfer data is only a compatibility marker, never a session identity.
export function initSessionDragDrop(root, { getSource, canMove, move, onEnd }) {
  let source;
  let highlighted;
  function highlight(target) {
    if (highlighted === target) return;
    highlighted?.classList.remove("drag-over");
    highlighted = target;
    highlighted?.classList.add("drag-over");
  }
  function closest(node, selector) {
    const target = node?.closest?.(selector);
    return target && root.contains(target) ? target : undefined;
  }
  function clear() {
    const previous = source;
    source = undefined;
    highlight(undefined);
    return previous;
  }
  function cancel() {
    if (clear()) onEnd?.();
  }
  root.addEventListener("dragstart", (event) => {
    cancel();
    const button = closest(event.target, ".session-item");
    if (!button) return;
    const candidate = getSource(button.dataset.sessionKey);
    if (!button.draggable || !candidate || !canMove(candidate)) {
      event.preventDefault();
      return;
    }
    source = candidate;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      // Some browsers restrict custom transfer formats.
      try { event.dataTransfer.setData("application/x-agentbox-session", "session"); } catch {}
      try { event.dataTransfer.setData("text/plain", "session"); } catch {}
    }
  });
  root.addEventListener("dragover", (event) => {
    const target = closest(event.target, "[data-folder-path]");
    if (!source || !canMove(source) || !target) {
      highlight(undefined);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    highlight(target);
  });
  root.addEventListener("dragleave", (event) => {
    if (highlighted && highlighted.contains(event.target) && !highlighted.contains(event.relatedTarget)) {
      highlight(undefined);
    }
  });
  root.addEventListener("drop", (event) => {
    const target = closest(event.target, "[data-folder-path]");
    const allowed = source && target && canMove(source);
    const folder = target?.dataset.folderPath;
    const previous = clear();
    if (!previous) return;
    try {
      if (allowed) {
        event.preventDefault();
        move(previous, folder);
      }
    } finally {
      onEnd?.();
    }
  });
  root.addEventListener("dragend", cancel);
  (root.ownerDocument || root).addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancel();
  });
  return { isDragging: () => Boolean(source), cancel };
}

export function initSidebarResize(doc = document) {
  const win = doc.defaultView;
  const workspace = doc.getElementById("workspace");
  const sidebar = doc.getElementById("sidebar");
  const separator = doc.getElementById("sidebar-resizer");
  const mobile = win.matchMedia("(max-width: 720px)");
  let preferredWidth;
  let drag;

  function stopDrag() {
    if (!drag) return;
    const { pointerId } = drag;
    drag = undefined;
    workspace.classList.remove("sidebar-resizing");
    if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId);
  }

  function update(width) {
    separator.hidden = mobile.matches;
    if (mobile.matches) {
      stopDrag();
      return;
    }
    const max = Math.min(480, win.innerWidth - 420);
    const requested = width ?? preferredWidth ?? sidebar.getBoundingClientRect().width;
    const collapsed = requested < 180;
    const current = collapsed ? 64 : Math.round(Math.max(220, Math.min(max, requested)));
    workspace.classList.toggle("sidebar-collapsed", collapsed);
    if (width !== undefined) preferredWidth = current;
    // Keep the user's desktop preference across temporary viewport constraints.
    if (preferredWidth !== undefined) workspace.style.setProperty("--sidebar-width", `${current}px`);
    separator.setAttribute("aria-valuemin", "64");
    separator.setAttribute("aria-valuemax", String(max));
    separator.setAttribute("aria-valuenow", String(current));
    separator.setAttribute("aria-valuetext", collapsed ? "Collapsed conversation rail" : `${current} pixels`);
  }

  separator.addEventListener("pointerdown", (event) => {
    if (mobile.matches || event.button !== 0 || !event.isPrimary || drag) return;
    event.preventDefault();
    separator.focus();
    drag = { pointerId: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width };
    separator.setPointerCapture(event.pointerId);
    workspace.classList.add("sidebar-resizing");
  });
  separator.addEventListener("pointermove", (event) => {
    if (drag?.pointerId === event.pointerId) update(drag.width + event.clientX - drag.x);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    separator.addEventListener(type, (event) => {
      if (drag?.pointerId === event.pointerId) stopDrag();
    });
  }
  separator.addEventListener("keydown", (event) => {
    if (mobile.matches || event.altKey || event.ctrlKey || event.metaKey) return;
    const width = sidebar.getBoundingClientRect().width;
    const step = event.shiftKey ? 40 : 10;
    const next = { ArrowLeft: width <= 220 ? 64 : width - step, ArrowRight: width < 220 ? 220 : width + step, Home: 64, End: 480 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    update(next);
  });
  win.addEventListener("blur", stopDrag);
  win.addEventListener("resize", () => { stopDrag(); update(); });
  mobile.addEventListener("change", () => update());
  update();
}
