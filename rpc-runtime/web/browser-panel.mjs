// Live browser state is deliberately memory-only and bound to one native conversation.
export const FRAME_TTL = 5_000, LEASE_TTL = 30_000, RENEW_INTERVAL = 10_000;
const id = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const refPattern = /^@e[1-9][0-9]{0,8}$/;
function invalid() { throw new Error("Invalid browser response. Close and reopen Browser to reconnect."); }

export function validateFrame(frame, nativeSessionId, browserSessionId, now = Date.now()) {
  if (frame?.version !== 1 || frame.nativeSessionId !== nativeSessionId || frame.browserSessionId !== browserSessionId
    || !id(frame.frameId) || !Number.isFinite(frame.createdAt) || frame.createdAt > now || now - frame.createdAt >= FRAME_TTL
    || frame.width !== 1280 || frame.height !== 720 || frame.mimeType !== "image/jpeg"
    || typeof frame.data !== "string" || frame.data.length > 819200 || !frame.data.length
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
    || !Array.isArray(frame.refs) || frame.refs.length > 100
    || frame.refs.some((r) => typeof r?.ref !== "string" || !refPattern.test(r.ref) || typeof r.role !== "string" || r.role.length > 512 || typeof r.name !== "string" || r.name.length > 512)
    || new Set(frame.refs.map((r) => r.ref)).size !== frame.refs.length
    || !["agent", "human"].includes(frame.control?.mode)) invalid();
  const bytes = atob(frame.data);
  if (bytes.length > 600 * 1024 || bytes.length < 3 || btoa(bytes) !== frame.data
    || bytes.charCodeAt(0) !== 255 || bytes.charCodeAt(1) !== 216 || bytes.charCodeAt(2) !== 255) invalid();
  return frame;
}

export function validateInput(request, refs) {
  const fields = { open: ["url"], click: ["ref"], fill: ["ref", "text"], press: ["key"], scroll: ["direction", "amount"], back: [], forward: [], reload: [] };
  if (!request || !Object.hasOwn(fields, request.action) || Object.keys(request).some((key) => key !== "action" && !fields[request.action].includes(key))) throw new Error("Unsupported browser action.");
  if (["click", "fill"].includes(request.action) && !refs.some((r) => r.ref === request.ref)) throw new Error("Choose a reference from the current frame.");
  if (request.action === "fill" && (typeof request.text !== "string" || request.text.length > 10000 || request.text.includes("\0"))) throw new Error("Fill text must be at most 10000 characters without NUL.");
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
  let disposed = false, started = false, polling = false, busy = false, revision = 0, failures = 0;
  let status = null, frame = null, lease = null, message = "Connecting to the main conversation's browser…", controlError = "";
  let pollTimer, renewTimer, freshnessTimer;
  function getState() {
    const fresh = Boolean(frame && now() >= frame.createdAt && now() - frame.createdAt < FRAME_TTL);
    const held = Boolean(lease && lease.expiresAt > now());
    const control = status?.permissions.control === true && status?.capabilities.takeover === true;
    return { status, frame, message, busy, disposed, held, fresh,
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
  async function poll() {
    if (disposed || polling) return;
    if (busy) { schedulePoll(); return; }
    polling = true;
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
      schedulePoll(Math.min(8000, 1000 * 2 ** failures));
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
    try { if (operation === "input") action = validateInput(input, frame.refs); }
    catch (error) { message = controlError = error.message; emit(); return false; }
    controlError = "";
    const browserSessionId = status.browserSessionId;
    const body = { operation, browserSessionId, ...(operation !== "acquire" ? { leaseId: lease.leaseId } : {}), ...(action ? { frameId: frame.frameId, request: action } : {}) };
    busy = true;
    // Discard all old/in-flight frames before any attempted mutation, including
    // ambiguous failures. A subsequent input needs a newly acknowledged frame.
    revision++; frame = null;
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
        lease = result; scheduleRenew();
        message = "Control acknowledged. Waiting for a fresh frame…";
      } else {
        if (result.accepted !== true) invalid();
        if (disposed) return false;
        if (operation === "release") { forgetLease(false); message = "Control released to the agent."; }
        else message = "Input accepted. Waiting for a fresh frame…";
      }
      return true;
    } catch (error) {
      if (!disposed) {
        message = `${error.message || "Browser control failed."} Nothing was retried; check the preview before another action.`;
        // Failed renewal/input may have been accepted. Drop authority rather than
        // silently reacquiring it; explicit release is not an input retry.
        forgetLease();
        if (operation === "acquire") message += " If acquisition succeeded, its lease expires within 30 seconds.";
        controlError = message;
      }
      return false;
    } finally {
      busy = false;
      if (!disposed) { emit(); schedulePoll(); }
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
  const age = node("p", "", "field-note");
  const controls = node("div", "", "browser-control-row");
  function button(parent, label, run) {
    const el = node("button", label, "text-button"); el.type = "button"; el.addEventListener("click", run); parent.append(el); return el;
  }
  const acquire = button(controls, "Take control", () => void controller.acquire());
  const release = button(controls, "Release control", () => void controller.release());
  const actions = node("fieldset"); actions.append(node("legend", "Human browser input"));
  function field(label, el) { const wrap = node("label", label); wrap.append(el); actions.append(wrap); return el; }
  const refs = field("Accessibility reference", node("select"));
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
  panel.append(notice, hint, image, age, controls, actions); root.replaceChildren(panel);
  let shownFrame, shownRefs = "";
  const controller = createBrowserController({ ...options, onChange(state) {
    if (notice.textContent !== state.message) notice.textContent = state.message;
    acquire.disabled = !state.canAcquire; release.disabled = !state.canRelease;
    actions.disabled = !state.canInput;
    age.textContent = state.frame ? (state.fresh ? "Fresh frame · preview updates at most once per second." : "Stale frame · inputs disabled until refreshed.") : "Waiting for a fresh frame. Control expires after 30 seconds without renewal.";
    if (shownFrame !== state.frame) {
      shownFrame = state.frame;
      if (state.frame) {
        image.src = `data:image/jpeg;base64,${state.frame.data}`; image.hidden = false;
      } else { image.removeAttribute("src"); image.hidden = true; }
      // Do not disturb keyboard selection on each 1fps poll if the complete
      // reference inventory is unchanged. Any inventory change resets selection.
      const nextRefs = state.frame ? JSON.stringify(state.frame.refs) : "";
      if (shownRefs !== nextRefs) {
        shownRefs = nextRefs;
        refs.replaceChildren();
        const placeholder = node("option", "Choose a current-frame reference"); placeholder.value = ""; refs.append(placeholder);
        for (const ref of state.frame?.refs || []) { const option = node("option", `${ref.ref} · ${ref.role} · ${ref.name}`); option.value = ref.ref; refs.append(option); }
        refs.value = "";
      }
    }
    click.disabled = fill.disabled = !refs.value;
  } });
  refs.addEventListener("change", () => { click.disabled = fill.disabled = !refs.value; });
  controller.start();
  return { dispose() { controller.dispose(); shownFrame = null; shownRefs = ""; image.removeAttribute("src"); text.value = key.value = url.value = ""; root.replaceChildren(); } };
}
