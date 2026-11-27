export function contextWidth(requested, workspaceWidth, sidebarWidth) {
  const max = Math.max(240, workspaceWidth - sidebarWidth - 280);
  return Math.round(Math.max(240, Math.min(max, requested)));
}

export function initContextResize(doc = document) {
  const win = doc.defaultView;
  const workspace = doc.getElementById("workspace");
  const pane = doc.getElementById("context-pane");
  const separator = doc.getElementById("context-resizer");
  const sidebar = doc.getElementById("sidebar");
  let drag;
  function stop() {
    if (!drag) return;
    const { pointerId } = drag;
    drag = null;
    workspace.classList.remove("context-resizing");
    if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId);
  }
  const getWidth = () => pane.getBoundingClientRect().width;
  function setWidth(requested) {
    const width = contextWidth(requested, workspace.clientWidth, sidebar.getBoundingClientRect().width);
    workspace.style.setProperty("--context-width", `${width}px`);
    separator.setAttribute("aria-valuemin", "240");
    separator.setAttribute("aria-valuemax", String(contextWidth(Infinity, workspace.clientWidth, sidebar.getBoundingClientRect().width)));
    separator.setAttribute("aria-valuenow", String(width));
  }
  separator.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || drag) return;
    event.preventDefault(); separator.focus();
    drag = { pointerId: event.pointerId, x: event.clientX, width: getWidth() };
    separator.setPointerCapture(event.pointerId);
    workspace.classList.add("context-resizing");
  });
  separator.addEventListener("pointermove", event => {
    if (drag?.pointerId === event.pointerId) setWidth(drag.width + drag.x - event.clientX);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    separator.addEventListener(type, event => { if (drag?.pointerId === event.pointerId) stop(); });
  }
  separator.addEventListener("keydown", event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const width = getWidth(), step = event.shiftKey ? 40 : 10;
    const next = { ArrowLeft: width + step, ArrowRight: width - step, Home: 240, End: Infinity }[event.key];
    if (next === undefined) return;
    event.preventDefault(); setWidth(next);
  });
  win.addEventListener("blur", stop);
  win.addEventListener("resize", () => {
    stop();
    if (!pane.hidden && workspace.style.getPropertyValue("--context-width")) setWidth(getWidth());
  });
  return { getWidth, setWidth };
}
