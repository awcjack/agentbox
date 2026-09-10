export class ApiError extends Error {
  constructor(message, status = 0, code = "network_error") {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// SSE framing is independent of fetch chunk boundaries, including split CRLF.
export function createSSEParser(onEvent, maxSize = 40 * 1024 * 1024) {
  let line = "", data = [], event = "", id, size = 0, skipLF = false;
  function finishLine() {
    if (!line) {
      if (data.length) onEvent({ event: event || "message", data: data.join("\n"), id });
      data = []; event = ""; size = 0;
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      if (field === "event") event = value;
      if (field === "id" && !value.includes("\0")) id = value;
    }
    line = "";
  }
  return {
    feed(chunk) {
      for (const char of chunk) {
        if (skipLF) { skipLF = false; if (char === "\n") continue; }
        if (++size > maxSize) throw new ApiError("Event exceeded the browser's size limit.", 0, "event_too_large");
        if (char === "\r" || char === "\n") {
          finishLine();
          skipLF = char === "\r";
        } else line += char;
      }
    },
  };
}

async function checkResponse(response) {
  if (response.ok) return;
  let body;
  try { body = await response.json(); } catch { /* A proxy may return a non-JSON error. */ }
  throw new ApiError(body?.error?.message || `Request failed (HTTP ${response.status}).`, response.status, body?.error?.code || "http_error");
}

export function createTransport(getToken, fetcher = globalThis.fetch) {
  async function connect(path, { body, signal, nativeSessionId, stream = false, method = body === undefined ? "GET" : "POST" } = {}) {
    if (!path.startsWith("/v1/") || /[\r\n\\]/.test(path)) throw new Error("Only same-origin API paths are allowed.");
    const token = getToken();
    if (!token) throw new ApiError("Log in to connect to the runtime.", 401, "unauthorized");
    const headers = { Authorization: `Bearer ${token}`, Accept: stream ? "text/event-stream" : "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (nativeSessionId) headers["X-Pi-Session-Id"] = nativeSessionId;
    let response;
    try {
      response = await fetcher(path, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body), signal,
        credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiError("Cannot reach the runtime. Check your connection.");
    }
    await checkResponse(response);
    return response;
  }
  return {
    async request(path, options = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      options.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 45_000);
      try {
        const response = await connect(path, { ...options, signal: controller.signal });
        if (response.status === 204) return undefined;
        let value;
        try { value = await response.json(); } catch { throw new ApiError("The runtime returned an invalid response.", 0, "invalid_response"); }
        if (value?.success === false) throw new ApiError(typeof value.error === "string" ? value.error : "The agent rejected the command.", 200, "rpc_error");
        return value;
      } catch (error) {
        if (controller.signal.aborted && !options.signal?.aborted) throw new ApiError("The request timed out. Its outcome may be unknown.", 0, "timeout");
        throw error;
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
      }
    },
    async events(path, { signal, onEvent, onOpen }) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal.aborted) controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      let reader, timer = setTimeout(abort, 45_000);
      try {
        const response = await connect(path, { signal: controller.signal, stream: true });
        if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
          throw new ApiError("Expected an event stream from the runtime.", 0, "invalid_stream");
        }
        onOpen?.();
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSSEParser(onEvent);
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          clearTimeout(timer);
          timer = setTimeout(abort, 45_000);
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.feed(decoder.decode());
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        controller.abort();
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    },
  };
}

export function eventCursor(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
}

export function messageKey(message) {
  if (message.role === "toolResult" && message.toolCallId) return `tool:${message.toolCallId}`;
  if (message.timestamp !== undefined) return `${message.role}:${message.timestamp}`;
  return null;
}

export function messageText(message) {
  return typeof message.content === "string" ? message.content : (message.content || []).filter((block) => block.type === "text").map((block) => block.text || "").join("\n");
}

export function messageEntry(message, entries) {
  // Timestamps alone are not entry IDs. Refuse ambiguous matches, including
  // identical prompts on different branches; the server validates the leaf too.
  const matches = entries.filter((entry) => entry.message?.role === "user" && message.role === "user"
    && entry.message.timestamp === message.timestamp && JSON.stringify(entry.message.content) === JSON.stringify(message.content));
  return matches.length === 1 ? matches[0].entryId : null;
}

export function visibleMessages(messages, partial) {
  if (!partial) return messages;
  const key = messageKey(partial);
  // A replayed partial must never replace an authoritative completed message.
  if (key && messages.some((message) => messageKey(message) === key)) return messages;
  return [...messages, partial];
}

// Pi 0.84 RPC strips cumulative snapshots; older runtimes still send message.
export function updatePartial(partial, event) {
  if (event.message?.role === "assistant") return event.message;
  const delta = event.assistantMessageEvent;
  if (!delta || typeof delta.type !== "string" || !Number.isInteger(delta.contentIndex) || delta.contentIndex < 0 || delta.contentIndex > 4096) return partial;
  const message = { ...(partial || { role: "assistant" }), content: (partial?.content || []).map((block) => ({ ...block })) };
  while (message.content.length <= delta.contentIndex) message.content.push({ type: "text", text: "" });
  const index = delta.contentIndex;
  if (delta.type.startsWith("text_") || delta.type.startsWith("thinking_")) {
    const field = delta.type.startsWith("text_") ? "text" : "thinking";
    const previous = message.content[index][field] || "";
    message.content[index] = { type: field, [field]: delta.type.endsWith("_end") ? delta.content ?? previous : delta.type.endsWith("_delta") ? previous + (delta.delta || "") : previous };
  } else if (delta.type === "toolcall_start") {
    message.content[index] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: "" };
  } else if (delta.type === "toolcall_delta") {
    const previous = message.content[index];
    message.content[index] = { ...previous, type: "toolCall", arguments: (typeof previous.arguments === "string" ? previous.arguments : "") + (delta.delta || "") };
  } else if (delta.type === "toolcall_end" && delta.toolCall) message.content[index] = delta.toolCall;
  if (event.usage) message.usage = event.usage;
  return message;
}
