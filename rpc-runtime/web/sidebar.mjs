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

// Resolve browser Recents against live + history. Archived conversations belong
// under Archived, not Recents, even when includeArchived history still lists them.
export function resolveRecentEntries(recentSessions, {
  sessions = [],
  history = [],
  filter = "",
  activeNative = new Set(),
  isArchived = () => false,
  limit = 8,
} = {}) {
  return recentSessions
    .map((entry) => {
      const liveMatch = sessions.find((session) => session.id === entry.id);
      if (liveMatch) return { session: liveMatch, historical: false };
      const historyMatch = history.find((session) => session.id === entry.id && (!filter || session.profile === filter));
      if (
        historyMatch
        && !activeNative.has(`${historyMatch.profile}:${historyMatch.id}`)
        && !isArchived(historyMatch)
      ) {
        return { session: historyMatch, historical: true };
      }
      return null;
    })
    .filter(Boolean)
    .filter((entry, index, list) => list.findIndex((item) => item.session.id === entry.session.id) === index)
    .slice(0, limit);
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

// Collapse/open state is shared across live + history in one sidebar tree.
// Profile scopes Projects roots and the folders nested under each project.
export function folderOpenKey(sectionKey, path = "", profile = "") {
  const scope = profile ? `${sectionKey}:${profile}` : sectionKey;
  return `${scope}:${path ? `/${path}` : ""}`;
}

export function isFolderOpen(map, sectionKey, path = "", profile = "") {
  const key = folderOpenKey(sectionKey, path, profile);
  if (map.has(key)) return map.get(key) !== false;
  // Prefer the merged main tree; fall back to pre-merge live/past keys and
  // pre-project (profile-less) keys so existing open state survives upgrade.
  if (profile) {
    const legacyProfileKey = folderOpenKey(sectionKey, path);
    if (map.has(legacyProfileKey)) return map.get(legacyProfileKey) !== false;
  }
  if (sectionKey === "main") {
    for (const legacy of ["live", "past"]) {
      const legacyKey = folderOpenKey(legacy, path, profile);
      if (map.has(legacyKey)) return map.get(legacyKey) !== false;
      if (profile) {
        const flat = folderOpenKey(legacy, path);
        if (map.has(flat)) return map.get(flat) !== false;
      }
    }
  }
  return true;
}

// Profiles become Projects. Keep configured order, then any unexpected names.
export function partitionProjectEntries(entries, profileOrder = []) {
  const byProfile = new Map();
  for (const name of profileOrder) byProfile.set(name, []);
  for (const entry of entries) {
    const profile = entry?.session?.profile;
    if (typeof profile !== "string" || !profile) continue;
    if (!byProfile.has(profile)) byProfile.set(profile, []);
    byProfile.get(profile).push(entry);
  }
  return byProfile;
}

// One folder tree for live + resumeable history. Returns leaf assignments only;
// the renderer still creates nested parents via ensurePath.
export function partitionFolderEntries(entries, getFolder, pinned = []) {
  const folders = new Map();
  const ungrouped = [];
  for (const path of [...pinned].filter(Boolean).sort((a, b) => a.localeCompare(b))) {
    if (!folders.has(path)) folders.set(path, []);
  }
  for (const entry of entries) {
    const path = getFolder(entry) || "";
    if (!path) {
      ungrouped.push(entry);
      continue;
    }
    if (!folders.has(path)) folders.set(path, []);
    folders.get(path).push(entry);
  }
  return { folders, ungrouped };
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

// Explicit empty folders are a browser preference until a session is assigned.
// Prefer [profile, folder] tuples so Projects keep pins under the right cwd.
// Legacy string entries still load and appear under every visible project.
const pinnedFoldersKey = "agentbox.pi.pinned-folders.v1";
export function normalizePinnedEntry(entry) {
  if (typeof entry === "string") {
    const folder = normalizeFolder(entry);
    return folder ? { profile: null, folder } : null;
  }
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    if (entry.profile != null && typeof entry.profile !== "string") return null;
    if (typeof entry.folder !== "string") return null;
    const folder = normalizeFolder(entry.folder);
    if (!folder) return null;
    return { profile: entry.profile || null, folder };
  }
  if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || !entry[0]) {
    return null;
  }
  const folder = normalizeFolder(entry[1]);
  return folder ? { profile: entry[0], folder } : null;
}
export function readPinnedFolders(storage) {
  try {
    const entries = JSON.parse(storage?.getItem(pinnedFoldersKey) || "[]");
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => {
      try { return normalizePinnedEntry(entry); }
      catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
export function pinnedFoldersForProfile(pins, profile) {
  const folders = new Set();
  for (const entry of pins || []) {
    if (!entry?.folder) continue;
    if (entry.profile === null || entry.profile === profile) folders.add(entry.folder);
  }
  return folders;
}
export function savePinnedFolders(storage, pins) {
  try {
    if (!storage) return false;
    const values = [];
    const seen = new Set();
    for (const entry of pins || []) {
      let item;
      try { item = normalizePinnedEntry(entry); }
      catch { continue; }
      if (!item?.folder) continue;
      const key = item.profile == null ? `\0${item.folder}` : `${item.profile}\0${item.folder}`;
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(item.profile == null ? item.folder : [item.profile, item.folder]);
    }
    values.sort((a, b) => {
      // Legacy bare strings sort as profile "" so they stay before scoped tuples.
      const leftProfile = Array.isArray(a) ? a[0] : "";
      const leftFolder = Array.isArray(a) ? a[1] : a;
      const rightProfile = Array.isArray(b) ? b[0] : "";
      const rightFolder = Array.isArray(b) ? b[1] : b;
      const byProfile = leftProfile.localeCompare(rightProfile);
      return byProfile || leftFolder.localeCompare(rightFolder);
    });
    if (!values.length) {
      try { storage.removeItem(pinnedFoldersKey); }
      catch { storage.setItem(pinnedFoldersKey, "[]"); }
    } else {
      storage.setItem(pinnedFoldersKey, JSON.stringify(values));
    }
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
  function dropTargetAllows(sourceEntry, target) {
    if (!sourceEntry || !target || !canMove(sourceEntry)) return false;
    const project = target.dataset.projectProfile;
    // Cross-project moves rewrite persisted history into another profile cwd.
    // Live runtime rows keep the process cwd, so only historical rows may leave.
    if (project && project !== sourceEntry.session.profile && !sourceEntry.historical) return false;
    return true;
  }
  root.addEventListener("dragover", (event) => {
    const target = closest(event.target, "[data-folder-path]");
    if (!dropTargetAllows(source, target)) {
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
    const allowed = dropTargetAllows(source, target);
    const folder = target?.dataset.folderPath;
    const profile = target?.dataset.projectProfile;
    const previous = clear();
    if (!previous) return;
    try {
      if (allowed) {
        event.preventDefault();
        move(previous, { folder, profile });
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
