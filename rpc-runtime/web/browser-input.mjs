// Direct input stays local to a mounted preview and never retries a mutation.
export function previewPoint(frame, rect, clientX, clientY) {
  if (!frame || ![rect.width, rect.height, clientX, clientY, rect.left, rect.top].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  const x = (clientX - rect.left - (rect.width - frame.width * scale) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - frame.height * scale) / 2) / scale;
  return x >= 0 && x < frame.width && y >= 0 && y < frame.height ? { x: Math.floor(x), y: Math.floor(y) } : null;
}

export function previewWheel(event, frame, rect) {
  const point = previewPoint(frame, rect, event.clientX, event.clientY)
    || (frame && event.clientX >= rect.left && event.clientX < rect.left + rect.width && event.clientY >= rect.top && event.clientY < rect.top + rect.height ? { x: Math.floor(frame.width / 2), y: Math.floor(frame.height / 2) } : null);
  if (!point || ![event.deltaX, event.deltaY].every(Number.isFinite) || event.ctrlKey) return null;
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
  const unit = event.deltaMode === 1 ? 16 : 1;
  return { ...point,
    deltaX: Math.max(-2000, Math.min(2000, event.deltaX * (event.deltaMode === 2 ? frame.width : unit / scale))),
    deltaY: Math.max(-2000, Math.min(2000, event.deltaY * (event.deltaMode === 2 ? frame.height : unit / scale))) };
}

export function createPreviewInput({ getState, send, onStatus = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let active = false, disposed = false, pumping = false, generation = 0, timer, geometry = "";
  const queue = [];
  function clear(message = "") {
    generation++; active = false; queue.length = 0; clearTimer(timer);
    if (!disposed) onStatus(message);
  }
  function deadline() {
    clearTimer(timer);
    if (queue.length) timer = setTimer(() => clear("Input expired while waiting for a fresh preview. Check the preview before continuing."), Math.max(0, queue[0].at + 5000 - now()));
  }
  function pump() {
    if (disposed || pumping || !queue.length || !getState().canInput) return;
    if (now() - queue[0].at >= 5000) { clear("Input expired. Check the preview before continuing."); return; }
    const item = queue.shift(), own = generation;
    deadline(); pumping = true;
    Promise.resolve().then(() => {
      // Disposal/control loss before dispatch must discard the queued input.
      if (disposed || own !== generation) return false;
      if (!getState().canInput) { queue.unshift(item); deadline(); return null; }
      return send(item.request);
    }).then((accepted) => {
      if (!disposed && own === generation && accepted === false) clear("Direct input stopped. Check the preview, then click to focus again. Nothing was retried.");
    }, () => {
      if (!disposed && own === generation) clear("Direct input failed. Click the preview to focus again. Nothing was retried.");
    }).finally(() => { pumping = false; if (!disposed && own === generation) pump(); });
  }
  function enqueue(request, needsFocus = true) {
    if (disposed || (needsFocus && !active) || !getState().held) return false;
    const total = queue.reduce((sum, item) => sum + (item.request.text?.length || 0), 0) + (request.text?.length || 0);
    if (queue.length >= 64 || total > 10000) { clear("Direct input buffer is full. Check the preview, then click to focus again."); return false; }
    const last = queue.at(-1);
    if (request.action === "wheel" && last?.request.action === "wheel"
      && last.request.deltaX * request.deltaX >= 0 && last.request.deltaY * request.deltaY >= 0
      && Math.abs(last.request.deltaX + request.deltaX) <= 2000 && Math.abs(last.request.deltaY + request.deltaY) <= 2000) {
      Object.assign(last.request, { x: request.x, y: request.y, deltaX: last.request.deltaX + request.deltaX, deltaY: last.request.deltaY + request.deltaY });
    } else if (request.action === "type" && last?.request.action === "type") last.request.text += request.text;
    else queue.push({ request, at: now() });
    deadline(); pump(); return true;
  }
  return {
    click(x, y) {
      if (disposed || pumping || queue.length || !getState().canInput) return false;
      clear(); active = true; onStatus("Typing in the browser. Keyboard input follows the focused page control.");
      return enqueue({ action: "pointer", x, y });
    },
    type(text) {
      if (!text) return false;
      if (typeof text !== "string" || text.length > 10000 || text.includes("\0")) { clear("Direct input text exceeds 10000 characters or contains unsupported data. Click the preview to focus again."); return false; }
      return enqueue({ action: "type", text });
    },
    press(key) { return enqueue({ action: "press", key }); },
    wheel(x, y, deltaX, deltaY) { return enqueue({ action: "wheel", x, y, deltaX, deltaY }, false); },
    reset: () => clear(),
    update(state) {
      if (disposed) return;
      const next = state.frame ? `${state.frame.width}x${state.frame.height}` : geometry;
      if (geometry && next !== geometry) clear("Browser resolution changed. Click the preview to focus again.");
      geometry = next;
      if (!state.held || state.disposed) clear(); else pump();
    },
    dispose() { disposed = true; clear(); },
  };
}
