import { createPreviewInput, previewPoint, previewWheel } from "./browser-input.mjs";

// Live browser state is deliberately memory-only and bound to one native conversation.
export const FRAME_TTL = 5_000, LEASE_TTL = 30_000, RENEW_INTERVAL = 10_000;
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const refPattern = /^@e[1-9][0-9]{0,8}$/;
function invalid() { throw new Error("Invalid browser response. Close and reopen Browser to reconnect."); }

export function validateFrame(frame, nativeSessionId, browserSessionId, now = Date.now()) {
  if (frame?.version !== 1 || frame.nativeSessionId !== nativeSessionId || frame.browserSessionId !== browserSessionId
    || !id(frame.frameId) || !Number.isFinite(frame.createdAt) || frame.createdAt > now || now - frame.createdAt >= FRAME_TTL
    || !Number.isInteger(frame.width) || frame.width < 320 || frame.width > 2560 || !Number.isInteger(frame.height) || frame.height < 240 || frame.height > 1600 || frame.mimeType !== "image/jpeg"
    || typeof frame.data !== "string" || frame.data.length > 819200 || !frame.data.length
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
    || !Array.isArray(frame.refs) || frame.refs.length > 100
    || frame.refs.some((r) => typeof r?.ref !== "string" || !refPattern.test(r.ref) || typeof r.role !== "string" || r.role.length > 512 || typeof r.name !== "string" || r.name.length > 512)
    || new Set(frame.refs.map((r) => r.ref)).size !== frame.refs.length
    || !["agent", "human"].includes(frame.control?.mode)) invalid();
  const bytes = atob(frame.data);
  if (bytes.length > 600 * 1024 || bytes.length < 3 || btoa(bytes) !== frame.data
    || bytes.charCodeAt(0) !== 255 || bytes.charCodeAt(1) !== 216 || bytes.charCodeAt(2) !== 255) invalid();
  if (frame.url !== undefined && frame.url !== null) {
    let location;
    try { location = new URL(frame.url); } catch { invalid(); }
    if (typeof frame.url !== "string" || frame.url.length > 4096 || (!["http:", "https:"].includes(location.protocol) && location.href !== "about:blank") || location.username || location.password) invalid();
  }
  return frame;
}

export function validateInput(request, refs, size = { width: 2560, height: 1600 }) {
  const fields = { open: ["url"], click: ["ref"], fill: ["ref", "text"], pointer: ["x", "y"], wheel: ["x", "y", "deltaX", "deltaY"], resize: ["width", "height"], type: ["text"], press: ["key"], scroll: ["direction", "amount"], back: [], forward: [], reload: [] };
  if (!request || !Object.hasOwn(fields, request.action) || Object.keys(request).some((key) => key !== "action" && !fields[request.action].includes(key))) throw new Error("Unsupported browser action.");
  if (["click", "fill"].includes(request.action) && !refs.some((r) => r.ref === request.ref)) throw new Error("Choose a reference from the current frame.");
  if (request.action === "fill" && (typeof request.text !== "string" || request.text.length > 10000 || request.text.includes("\0"))) throw new Error("Fill text must be at most 10000 characters without NUL.");
  if (["pointer", "wheel"].includes(request.action) && (!Number.isInteger(request.x) || request.x < 0 || request.x >= size.width || !Number.isInteger(request.y) || request.y < 0 || request.y >= size.height)) throw new Error("Point inside the current browser preview.");
  if (request.action === "wheel" && (![request.deltaX, request.deltaY].every(v => Number.isInteger(v) && Math.abs(v) <= 2000) || (!request.deltaX && !request.deltaY))) throw new Error("Invalid wheel movement.");
  if (request.action === "resize" && (!Number.isInteger(request.width) || request.width < 320 || request.width > 2560 || !Number.isInteger(request.height) || request.height < 240 || request.height > 1600)) throw new Error("Use a viewport width of 320–2560 and height of 240–1600 pixels.");
  if (request.action === "type" && (typeof request.text !== "string" || !request.text.length || request.text.length > 10000 || request.text.includes("\0"))) throw new Error("Type at most 10000 characters without NUL.");
  if (request.action === "press" && (typeof request.key !== "string" || !/^[A-Za-z0-9+ _]{1,64}$/.test(request.key))) throw new Error("Enter a key combination (at most 64 characters).");
  if (request.action === "scroll" && (!["up", "down", "left", "right"].includes(request.direction) || !Number.isInteger(request.amount) || request.amount < 1 || request.amount > 2000)) throw new Error("Scroll amount must be 1–2000.");
  if (request.action === "open") {
    let url;
    try { url = new URL(request.url); } catch { /* Fail below. */ }
    if (typeof request.url !== "string" || request.url.length > 4096 || !url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Enter an HTTP(S) URL without embedded credentials.");
  }
  return { ...request };
}

// request must retain the OLD auth/session binding through disposal, including a
// late acquire acknowledgement. Reads abort; mutations never retry. Release is
// best effort (including on hidden/logout); server-side lease expiry is the fallback.
export function createBrowserController({ sessionId, nativeSessionId, request, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!id(sessionId) || !id(nativeSessionId)) throw new Error("A live native session is required.");
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}/browser`;
  const reads = new AbortController();
  let disposed = false, started = false, polling = false, busy = false, revision = 0, failures = 0, pendingOperation = "", lastPollAt = -Infinity;
  let status = null, frame = null, lease = null, message = "Connecting to the main conversation's browser…", controlError = "";
  let pollTimer, renewTimer, freshnessTimer;
  function getState() {
    const fresh = Boolean(frame && now() >= frame.createdAt && now() - frame.createdAt < FRAME_TTL);
    const held = Boolean(lease && lease.expiresAt > now());
    const control = status?.permissions.control === true && status?.capabilities.takeover === true;
    return { status, frame, message, busy, pendingOperation, disposed, held, fresh,
      canAcquire: !disposed && !busy && control && status?.ready === true && status?.control.mode === "agent" && !held,
      canInput: !disposed && !busy && control && held && fresh,
      canRelease: !disposed && !busy && held };
  }
  function emit() {
    clearTimer(freshnessTimer);
    if (disposed) return;
    const deadlines = [frame && frame.createdAt + FRAME_TTL, lease?.expiresAt].filter((v) => v > now());
    if (deadlines.length) freshnessTimer = setTimer(emit, Math.min(...deadlines) - now());
    onChange(getState());
  }
  const call = (suffix, body, signal) => request(`${base}${suffix}`, { nativeSessionId, ...(body ? { body } : {}), ...(signal ? { signal } : {}) });
  function binding(value, browserId = status?.browserSessionId) {
    if (value?.version !== 1 || value.nativeSessionId !== nativeSessionId || !id(value.browserSessionId) || (browserId && value.browserSessionId !== browserId)) invalid();
  }
  function bestRelease(oldLease) {
    if (!oldLease) return;
    void call("/control", { operation: "release", browserSessionId: oldLease.browserSessionId, leaseId: oldLease.leaseId }).catch(() => {});
  }
  function forgetLease(release = true) {
    clearTimer(renewTimer);
    const old = lease; lease = null; frame = null; revision++;
    if (release) bestRelease(old);
  }
  function schedulePoll(delay = 1000) {
    clearTimer(pollTimer);
    if (!disposed) pollTimer = setTimer(poll, delay);
  }
  function refreshSoon() { schedulePoll(lease ? Math.max(0, lastPollAt + 250 - now()) : 1000); }
  async function poll() {
    if (disposed || polling) return;
    if (busy) { schedulePoll(250); return; }
    polling = true;
    lastPollAt = now();
    const ownRevision = revision;
    try {
      const next = await call("", undefined, reads.signal);
      if (disposed || ownRevision !== revision) return;
      binding(next);
      if (next.available !== true || typeof next.ready !== "boolean" || next.permissions?.view !== true
        || typeof next.permissions.control !== "boolean" || next.capabilities?.liveView !== true
        || !["agent", "human"].includes(next.control?.mode)) invalid();
      status = next;
      if (lease && (!next.ready || next.permissions.control !== true || next.capabilities.takeover !== true || next.control.mode !== "human" || lease.expiresAt <= now())) forgetLease();
      message = controlError || (!next.ready ? "The agent has not opened a browser. Preview never starts it."
        : lease ? "You have control. Agent browser actions are paused."
        : next.control.mode === "human" ? "Another human control lease is active."
        : next.permissions.control && next.capabilities.takeover === true ? "Viewing the main conversation's tab. Take control to interact." : "Read-only browser preview (server permission/capability).");
      if (!next.ready) { frame = null; emit(); return; }
      const frameRevision = revision;
      const nextFrame = await call("/frame", undefined, reads.signal);
      if (disposed || frameRevision !== revision) return;
      frame = validateFrame(nextFrame, nativeSessionId, status.browserSessionId, now());
      if (lease && frame.control.mode !== "human") forgetLease();
      failures = 0;
      emit();
    } catch (error) {
      if (disposed || ownRevision !== revision) return;
      frame = null;
      message = error.message || "Browser preview unavailable.";
      failures = Math.min(failures + 1, 4);
      // Auth/identity/protocol errors fail closed until an explicit reopen.
      if ([401, 403, 404, 409].includes(error.status) || ["browser_session_changed", "invalid_browser_request", "browser_bridge_closed"].includes(error.code) || message.startsWith("Invalid browser response")) {
        if (error.code === "browser_bridge_closed") message = "Browser bridge closed. Restart the conversation process to reconnect; reopening this pane cannot reconnect it.";
        status = null; forgetLease(); disposed = true; reads.abort();
        clearTimer(renewTimer); clearTimer(freshnessTimer); onChange(getState());
      } else emit();
    } finally {
      polling = false;
      if (failures) schedulePoll(Math.min(8000, 1000 * 2 ** failures)); else refreshSoon();
    }
  }
  function scheduleRenew(delay = RENEW_INTERVAL) {
    clearTimer(renewTimer);
    if (!disposed && lease) renewTimer = setTimer(() => {
      if (!lease || lease.expiresAt <= now()) { forgetLease(); message = "Control lease expired. Take control again explicitly."; emit(); return; }
      if (busy) { scheduleRenew(250); return; }
      void mutate("renew");
    }, delay);
  }
  async function mutate(operation, input) {
    const state = getState();
    if (disposed || busy || (operation === "acquire" ? !state.canAcquire : operation === "input" ? !state.canInput : !state.held)) return false;
    let action;
    try { if (operation === "input") action = validateInput(input, frame.refs, frame); }
    catch (error) { message = controlError = error.message; emit(); return false; }
    controlError = "";
    const browserSessionId = status.browserSessionId;
    const body = { operation, browserSessionId, ...(operation !== "acquire" ? { leaseId: lease.leaseId } : {}), ...(action ? { frameId: frame.frameId, request: action } : {}) };
    busy = true; pendingOperation = operation;
    // Invalidate in-flight reads. Page input/acquisition/release consume the
    // actionable frame; renewal preserves its original freshness deadline.
    revision++;
    if (operation !== "renew") frame = null;
    // Drop the local lease BEFORE attempting release: a failed release or a
    // concurrent dispose must not retry the same mutation. Expiry is the fallback.
    if (operation === "release") forgetLease(false);
    emit();
    try {
      const result = await call("/control", body);
      binding(result, browserSessionId);
      if (["acquire", "renew"].includes(operation)) {
        if (!id(result.leaseId) || !Number.isFinite(result.expiresAt) || result.expiresAt <= now() || result.expiresAt > now() + LEASE_TTL) invalid();
        if (disposed) { bestRelease(result); return false; }
        if (operation === "renew" && result.leaseId !== lease?.leaseId) invalid();
        lease = result; scheduleRenew();
        message = "You have control. Click, type or scroll in the preview.";
      } else {
        if (result.accepted !== true) invalid();
        if (disposed) return false;
        if (operation === "release") { forgetLease(false); message = "Control released to the agent."; }
        else message = "You have control. Click, type or scroll in the preview.";
      }
      return true;
    } catch (error) {
      if (!disposed) {
        message = `${error.message || "Browser control failed."} Nothing was retried; check the preview before another action.`;
        // Ambiguous failures drop authority. An explicit stale-frame rejection
        // performed no input, so retain the lease but never retry the gesture.
        if (!(operation === "input" && error.code === "browser_frame_stale")) forgetLease();
        else message = "The preview updated before your input arrived. Check the preview and try again. Nothing was retried.";
        if (operation === "acquire") message += " If acquisition succeeded, its lease expires within 30 seconds.";
        controlError = message;
      }
      return false;
    } finally {
      busy = false; pendingOperation = "";
      if (!disposed) { emit(); refreshSoon(); }
    }
  }
  return {
    getState,
    start() { if (!started && !disposed) { started = true; emit(); void poll(); } },
    acquire: () => mutate("acquire"), release: () => mutate("release"), input: (value) => mutate("input", value),
    dispose() {
      if (disposed) return;
      disposed = true; revision++; reads.abort();
      clearTimer(pollTimer); clearTimer(renewTimer); clearTimer(freshnessTimer);
      forgetLease(); status = null; frame = null;
    },
  };
}

// Small DOM adapter: page-sourced accessibility labels are always textContent,
// never HTML. Inputs/drafts belong only to this mounted pane.
export function mountBrowserPanel(root, options) {
  const doc = root.ownerDocument;
  function node(tag, text, className) {
    const el = doc.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  const panel = node("section", "", "browser-panel");
  const notice = node("p"); notice.setAttribute("role", "status");
  const hint = node("p", "Main conversation tab only. Preview is untrusted page content. Human control pauses structured browser actions across the delegated family; website effects are not undone by reverting chat.", "field-note");
  const image = node("img", "", "browser-frame"); image.alt = "Live preview of the main conversation's browser tab"; image.hidden = true;
  image.draggable = false;
  const viewport = node("div", "", "browser-viewport");
  const keyboard = node("textarea", "", "browser-keyboard");
  keyboard.setAttribute("aria-label", "Type in browser preview"); keyboard.tabIndex = -1;
  keyboard.autocomplete = "off"; keyboard.spellcheck = false; keyboard.setAttribute("autocapitalize", "off");
  const directHelp = "Take control, then click, type or scroll in the preview. Paste and editing keys are supported.";
  const directHint = node("p", directHelp, "field-note");
  directHint.setAttribute("role", "status");
  viewport.append(image, keyboard);
  const age = node("p", "", "field-note");
  const controls = node("div", "", "browser-control-row");
  function button(parent, label, run) {
    const el = node("button", label, "text-button"); el.type = "button";
    el.addEventListener("click", () => { if (parent === actions) { direct?.reset(); keyboard.value = ""; } run(); });
    parent.append(el); return el;
  }
  const acquire = button(controls, "Take control", () => void controller.acquire());
  const release = button(controls, "Release control", () => void controller.release());
  let expanded = false;
  function setExpanded(value) {
    expanded = value; viewport.className = `browser-viewport${expanded ? " is-expanded" : ""}`;
    viewport.style.width = ""; viewport.style.height = "";
    expand.textContent = expanded ? "Restore preview" : "Expand preview";
    expand.setAttribute("aria-pressed", String(expanded));
  }
  const expand = button(controls, "Expand preview", () => setExpanded(!expanded));
  expand.setAttribute("aria-pressed", "false");
  const resizeHint = node("span", "↘ Drag corner to resize", "browser-resize-hint");
  viewport.append(controls, resizeHint);
  let addressDraft = false;
  const addressBar = node("div", "", "browser-address-bar");
  addressBar.setAttribute("role", "group"); addressBar.setAttribute("aria-label", "Browser navigation");
  function navigate(request) {
    if (!controller.getState().canInput) return;
    direct.reset(); keyboard.value = "";
    void controller.input(request).then(accepted => { if (accepted && request.action === "open") { addressDraft = false; address.blur?.(); } });
  }
  const navigation = [];
  for (const [action, label, symbol] of [["back", "Browser back", "←"], ["forward", "Browser forward", "→"], ["reload", "Reload browser", "↻"]]) {
    const control = button(addressBar, symbol, () => navigate({ action }));
    control.setAttribute("aria-label", label); control.title = label; navigation.push(control);
  }
  const address = node("input"); address.type = "text"; address.inputMode = "url"; address.maxLength = 4096;
  address.setAttribute("aria-label", "Browser URL"); address.placeholder = "Page address · http:// or https://";
  address.autocomplete = "off"; address.spellcheck = false;
  address.addEventListener("input", () => { addressDraft = true; });
  address.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); navigate({ action: "open", url: address.value.trim() }); } });
  addressBar.append(address);
  const go = button(addressBar, "Go", () => navigate({ action: "open", url: address.value.trim() }));
  go.setAttribute("aria-label", "Go to URL"); navigation.push(go);
  const previewOptions = node("div", "", "browser-preview-options");
  button(previewOptions, "Fit preview", () => setExpanded(false));
  const dimensions = node("span", "", "field-note"); previewOptions.append(dimensions);
  const resolutionFields = node("fieldset", "", "browser-resolution"); resolutionFields.append(node("legend", "Browser viewport"));
  function resolutionField(label, input) { const wrap = node("label", label); wrap.append(input); resolutionFields.append(wrap); return input; }
  const preset = resolutionField("Resolution preset", node("select"));
  for (const [value, label] of [["1280x720", "Desktop · 1280 × 720"], ["1920x1080", "Full HD · 1920 × 1080"], ["1440x900", "Laptop · 1440 × 900"], ["1366x768", "Laptop · 1366 × 768"], ["768x1024", "Tablet · 768 × 1024"], ["390x844", "Phone · 390 × 844"], ["360x800", "Small phone · 360 × 800"], ["custom", "Custom"]]) {
    const option = node("option", label); option.value = value; preset.append(option);
  }
  const width = resolutionField("Viewport width", node("input")), height = resolutionField("Viewport height", node("input"));
  width.type = height.type = "number"; width.min = "320"; width.max = "2560"; height.min = "240"; height.max = "1600";
  width.value = "1280"; height.value = "720";
  let resolutionDraft = false, resizing = false;
  preset.addEventListener("change", () => {
    resolutionDraft = true;
    if (preset.value !== "custom") [width.value, height.value] = preset.value.split("x");
  });
  for (const input of [width, height]) input.addEventListener("input", () => { resolutionDraft = true; preset.value = "custom"; });
  const applyResolution = button(resolutionFields, "Apply resolution", () => {
    if (!controller.getState().canInput || resizing) return;
    direct.reset(); keyboard.value = ""; resizing = true;
    void controller.input({ action: "resize", width: Number(width.value), height: Number(height.value) }).then((accepted) => {
      if (accepted) resolutionDraft = false;
    }).finally(() => { resizing = false; applyResolution.disabled = !controller.getState().canInput; });
  });
  const resolutionNote = node("p", "Viewport size in CSS pixels. Take control to apply. Dragging the preview changes its display size.", "field-note");
  const actions = node("fieldset"); actions.append(node("legend", "Human browser input"));
  function field(label, el) { const wrap = node("label", label); wrap.append(el); actions.append(wrap); return el; }
  const refs = field("Accessibility reference", node("select"));
  refs.setAttribute("aria-label", "Accessibility reference");
  const click = button(actions, "Click reference", () => void controller.input({ action: "click", ref: refs.value }));
  const text = field("Fill text", node("textarea")); text.maxLength = 10000;
  const fill = button(actions, "Fill reference", () => void controller.input({ action: "fill", ref: refs.value, text: text.value }));
  const key = field("Key combination (e.g. Enter or Control+a)", node("input")); key.maxLength = 64;
  button(actions, "Send key", () => void controller.input({ action: "press", key: key.value }));
  const direction = field("Scroll direction", node("select"));
  for (const value of ["down", "up", "left", "right"]) { const option = node("option", value); option.value = value; direction.append(option); }
  const amount = field("Scroll amount", node("input")); amount.type = "number"; amount.min = "1"; amount.max = "2000"; amount.value = "500";
  button(actions, "Scroll", () => void controller.input({ action: "scroll", direction: direction.value, amount: Number(amount.value) }));
  const url = field("Navigate to HTTP(S) URL", node("input")); url.type = "url"; url.maxLength = 4096;
  button(actions, "Open URL", () => void controller.input({ action: "open", url: url.value }));
  for (const action of ["back", "forward", "reload"]) button(actions, action[0].toUpperCase() + action.slice(1), () => void controller.input({ action }));
  for (const input of [text, key, url]) { input.autocomplete = "off"; input.spellcheck = false; }
  const advanced = node("details"); advanced.append(node("summary", "Reference and navigation controls"), hint, actions);
  panel.append(notice, addressBar, viewport, age, previewOptions, directHint, resolutionFields, resolutionNote, advanced); root.replaceChildren(panel);
  let shownFrame, shownRefs = "";
  let direct, wheelX = 0, wheelY = 0;
  const controller = createBrowserController({ ...options, onChange(state) {
    if (notice.textContent !== state.message) notice.textContent = state.message;
    acquire.disabled = !state.canAcquire; release.disabled = !state.canRelease;
    acquire.textContent = state.pendingOperation === "acquire" ? "Taking control…" : "Take control";
    controls.setAttribute("data-held", String(state.held));
    applyResolution.disabled = !state.canInput || resizing;
    for (const control of navigation) control.disabled = !state.canInput;
    address.readOnly = !state.held;
    if (!state.held) { addressDraft = false; address.value = state.status?.ready ? state.frame?.url || shownFrame?.url || "" : ""; }
    actions.disabled = !state.canInput;
    keyboard.disabled = !state.held || state.disposed;
    if (keyboard.disabled) { keyboard.value = ""; wheelX = wheelY = 0; }
    image.setAttribute("data-interactive", String(state.canInput));
    direct?.update(state);
    // A control request consumes the actionable frame, but need not blank the
    // preview or reset a reference the operator is using on every lease renewal.
    // Retained pixels/refs are display-only until a fresh frame is acknowledged.
    const preview = state.frame || (!state.disposed && state.status?.ready ? shownFrame : null);
    const stale = preview && (options.now || Date.now)() - preview.createdAt >= FRAME_TTL;
    image.setAttribute("data-stale", String(Boolean(stale)));
    age.textContent = !preview ? "Waiting for browser preview…" : stale ? "Preview is stale · waiting to reconnect." : state.pendingOperation === "acquire" ? "Taking control…" : state.held ? "Live · you have control" : "Live · viewing browser";
    if (state.frame) {
      if (shownFrame && (shownFrame.width !== state.frame.width || shownFrame.height !== state.frame.height)) wheelX = wheelY = 0;
      if (!addressDraft && doc.activeElement !== address) address.value = state.frame.url || "";
      const size = `${state.frame.width}x${state.frame.height}`;
      viewport.style.aspectRatio = `${state.frame.width} / ${state.frame.height}`;
      dimensions.textContent = `${state.frame.width} × ${state.frame.height} CSS pixels`;
      if (!resolutionDraft) {
        width.value = String(state.frame.width); height.value = String(state.frame.height);
        preset.value = ["1280x720", "1920x1080", "1440x900", "1366x768", "768x1024", "390x844", "360x800"].includes(size) ? size : "custom";
      }
    }
    if (shownFrame !== preview) {
      shownFrame = preview;
      if (preview) {
        image.src = `data:image/jpeg;base64,${preview.data}`; image.hidden = false;
      } else { image.removeAttribute("src"); image.hidden = true; }
      // Do not disturb keyboard selection on each 1fps poll if the complete
      // reference inventory is unchanged. Any inventory change resets selection.
      const nextRefs = preview ? JSON.stringify(preview.refs) : "";
      if (shownRefs !== nextRefs) {
        shownRefs = nextRefs;
        refs.replaceChildren();
        const placeholder = node("option", "Choose a current-frame reference"); placeholder.value = ""; refs.append(placeholder);
        for (const ref of preview?.refs || []) { const option = node("option", `${ref.ref} · ${ref.role} · ${ref.name}`); option.value = ref.ref; refs.append(option); }
        refs.value = "";
      }
    }
    if (!state.held) refs.value = "";
    click.disabled = fill.disabled = !state.canInput || !refs.value;
  } });
  direct = createPreviewInput({ getState: controller.getState, send: controller.input,
    ...(options.now ? { now: options.now } : {}), ...(options.setTimer ? { setTimer: options.setTimer } : {}), ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
    onStatus(message) { directHint.textContent = message || directHelp; } });
  image.addEventListener("click", (event) => {
    const state = controller.getState();
    if (!state.canInput) return;
    const point = previewPoint(state.frame, image.getBoundingClientRect(), event.clientX, event.clientY);
    if (point && direct.click(point.x, point.y)) { keyboard.value = ""; keyboard.focus({ preventScroll: true }); }
  });
  image.addEventListener("wheel", (event) => {
    const state = controller.getState();
    if (!state.held || state.disposed || event.ctrlKey) return;
    const movement = previewWheel(event, state.frame || shownFrame, image.getBoundingClientRect());
    if (!movement) return;
    event.preventDefault();
    wheelX += movement.deltaX; wheelY += movement.deltaY;
    const deltaX = Math.trunc(wheelX), deltaY = Math.trunc(wheelY);
    wheelX -= deltaX; wheelY -= deltaY;
    if (deltaX || deltaY) direct.wheel(movement.x, movement.y, deltaX, deltaY);
  }, { passive: false });
  const insertText = () => { const value = keyboard.value; keyboard.value = ""; if (value) direct.type(value); };
  keyboard.addEventListener("input", (event) => { if (!event.isComposing) insertText(); });
  keyboard.addEventListener("compositionend", insertText);
  keyboard.addEventListener("paste", (event) => { event.preventDefault(); direct.type(event.clipboardData?.getData("text/plain") || ""); keyboard.value = ""; });
  keyboard.addEventListener("beforeinput", (event) => {
    const key = { deleteContentBackward: "Backspace", deleteContentForward: "Delete", insertLineBreak: "Enter", insertParagraph: "Enter" }[event.inputType];
    if (key && !event.isComposing) { event.preventDefault(); direct.press(key); }
  });
  keyboard.addEventListener("keydown", (event) => {
    if (event.isComposing || event.key === "Process" || event.key === "Unidentified") return;
    if (event.getModifierState?.("AltGraph")) return;
    const special = { Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Escape: "Escape", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" }[event.key];
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return; // Native paste event supplies text.
    if (special || ((event.ctrlKey || event.metaKey) && /^[A-Za-z0-9 ]$/.test(event.key))) {
      event.preventDefault();
      direct.press([...(event.ctrlKey || event.metaKey ? ["Control"] : []), ...(event.altKey ? ["Alt"] : []), ...(event.shiftKey ? ["Shift"] : []), special || event.key.toLowerCase()].join("+"));
    }
  });
  refs.addEventListener("change", () => { click.disabled = fill.disabled = !controller.getState().canInput || !refs.value; });
  controller.start();
  return { dispose() { direct.dispose(); controller.dispose(); shownFrame = null; shownRefs = ""; image.removeAttribute("src"); address.value = keyboard.value = text.value = key.value = url.value = ""; root.replaceChildren(); } };
}
