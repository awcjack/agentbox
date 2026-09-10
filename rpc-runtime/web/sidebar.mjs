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
    const current = Math.round(Math.max(220, Math.min(max, width ?? preferredWidth ?? sidebar.getBoundingClientRect().width)));
    if (width !== undefined) preferredWidth = current;
    // Keep the user's desktop preference across temporary viewport constraints.
    if (preferredWidth !== undefined) workspace.style.setProperty("--sidebar-width", `${current}px`);
    separator.setAttribute("aria-valuemin", "220");
    separator.setAttribute("aria-valuemax", String(max));
    separator.setAttribute("aria-valuenow", String(current));
    separator.setAttribute("aria-valuetext", `${current} pixels`);
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
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: 220, End: 480 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    update(next);
  });
  win.addEventListener("blur", stopDrag);
  win.addEventListener("resize", () => { stopDrag(); update(); });
  mobile.addEventListener("change", () => update());
  update();
}
