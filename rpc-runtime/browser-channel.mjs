import { randomUUID } from "node:crypto";

// Private fd-only protocol. Never forward exception messages from either peer.
const MAX_RECORD = 1024 * 1024;
const MAX_BACKLOG = 2 * MAX_RECORD;
const OPERATIONS = new Set(["status", "frame", "acquire", "renew", "release", "input"]);
const MESSAGES = Object.freeze({
  browser_unavailable: "Browser bridge is unavailable",
  browser_busy: "Browser is busy",
  browser_control_held: "Browser control is held",
  browser_lease_invalid: "Browser lease is invalid",
  browser_frame_stale: "Browser frame is stale",
  invalid_browser_request: "Invalid browser request",
  browser_session_changed: "Browser session changed",
  browser_failed: "Browser operation failed",
});
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const text = (value, max) => typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const nativeId = (value) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function safeError(code) {
  if (typeof code !== "string" || !Object.hasOwn(MESSAGES, code)) code = "browser_failed";
  return Object.assign(new Error(MESSAGES[code]), { code });
}
function requestShape(value) {
  return keys(value, ["version", "type", "id", "nativeSessionId", "operation", "payload", "principal"])
    && value.version === 1 && value.type === "request" && text(value.id, 128) && value.id.length > 0
    && nativeId(value.nativeSessionId) && OPERATIONS.has(value.operation) && object(value.payload) && text(value.principal, 256);
}
function responseShape(value) {
  return value?.version === 1 && value.type === "response" && text(value.id, 128) && value.id.length > 0
    && (value.ok === true ? keys(value, ["version", "type", "id", "ok", "data"])
      : value.ok === false && keys(value, ["version", "type", "id", "ok", "error"])
        && keys(value.error, ["code", "message"]) && typeof value.error.code === "string"
        && Object.hasOwn(MESSAGES, value.error.code) && text(value.error.message, 512));
}

function transport(stream, onRecord, onClose) {
  let closed = false;
  let buffer = Buffer.alloc(0);
  const close = () => {
    if (closed) return;
    closed = true;
    buffer = Buffer.alloc(0);
    onClose();
    stream.destroy();
  };
  stream.on("error", close);
  stream.on("end", close);
  stream.on("close", close);
  stream.on("data", (chunk) => {
    if (closed) return;
    // Scan each chunk before concatenation, never retain an oversized record.
    chunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (!closed && start < chunk.length) {
      const lf = chunk.indexOf(10, start);
      const end = lf === -1 ? chunk.length : lf;
      const part = chunk.subarray(start, end);
      if (buffer.length + part.length > MAX_RECORD || part.includes(13)) return close();
      buffer = Buffer.concat([buffer, part]);
      if (lf === -1) break;
      try {
        const record = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer));
        buffer = Buffer.alloc(0);
        onRecord(record);
      } catch { close(); }
      start = lf + 1;
    }
  });
  return {
    close,
    get closed() { return closed; },
    write(record) {
      if (closed || stream.destroyed || stream.writableEnded) { close(); return false; }
      try {
        const encoded = JSON.stringify(record);
        const size = Buffer.byteLength(encoded);
        if (size > MAX_RECORD || stream.writableLength + size + 1 > MAX_BACKLOG) { close(); return false; }
        stream.write(`${encoded}\n`, (error) => { if (error) close(); });
        return true;
      } catch { close(); return false; }
    },
  };
}

export function createBrowserClient(stream, { timeoutMs = 10000, maxPending = 4 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
    || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 4) throw new TypeError("Invalid browser channel limits");
  const pending = new Map();
  const wire = transport(stream, (record) => {
    if (!responseShape(record) || !pending.has(record.id)) return wire.close();
    const entry = pending.get(record.id);
    pending.delete(record.id);
    clearTimeout(entry.timer);
    if (record.ok) entry.resolve(record.data);
    else entry.reject(safeError(record.error.code));
  }, () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(safeError("browser_unavailable")); }
    pending.clear();
  });
  return {
    request(nativeSessionId, operation, payload = {}, principal = "") {
      if (wire.closed) return Promise.reject(safeError("browser_unavailable"));
      const record = { version: 1, type: "request", id: randomUUID(), nativeSessionId, operation, payload, principal };
      if (!requestShape(record)) return Promise.reject(safeError("invalid_browser_request"));
      if (pending.size >= maxPending) return Promise.reject(safeError("browser_busy"));
      return new Promise((resolve, reject) => {
        // Timeout closes the whole bridge: a timed-out mutation must never be
        // reused, and EOF aborts the peer handler/lease. No wire cancellation API.
        const timer = setTimeout(() => wire.close(), timeoutMs);
        timer.unref?.();
        pending.set(record.id, { resolve, reject, timer });
        wire.write(record);
      });
    },
    close: wire.close,
    get closed() { return wire.closed; },
    get pendingCount() { return pending.size; },
  };
}

export function serveBrowserChannel(stream, handler) {
  const pending = new Map();
  const wire = transport(stream, (record) => {
    if (!requestShape(record) || pending.has(record.id)) return wire.close();
    if (pending.size >= 4) {
      wire.write({ version: 1, type: "response", id: record.id, ok: false, error: { code: "browser_busy", message: MESSAGES.browser_busy } });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => wire.close(), 10000);
    timer.unref?.();
    pending.set(record.id, { controller, timer });
    const { nativeSessionId, operation, payload, principal } = record;
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw safeError("browser_unavailable");
      return handler({ nativeSessionId, operation, payload, principal }, controller.signal);
    }).then((data) => {
      if (!controller.signal.aborted) wire.write({ version: 1, type: "response", id: record.id, ok: true, data: data ?? null });
    }, (error) => {
      if (controller.signal.aborted) return;
      const safe = safeError(error?.code);
      wire.write({ version: 1, type: "response", id: record.id, ok: false, error: { code: safe.code, message: safe.message } });
    }).finally(() => { clearTimeout(timer); pending.delete(record.id); });
  }, () => {
    for (const { controller, timer } of pending.values()) { clearTimeout(timer); controller.abort(safeError("browser_unavailable")); }
    pending.clear();
  });
  return { close: wire.close };
}
