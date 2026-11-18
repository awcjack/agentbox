import { messageText } from "./transport.mjs";

// Conversation-local, in-memory recall. Pending sends keep the composer's clean
// text even when the server stores an expanded prompt (for example, file notes).
export function createPromptHistory({ limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("limit must be a nonnegative integer");
  const seen = new Set();
  let entries = [], navigation = null;
  const append = (entry) => {
    if (!limit) return;
    entries.push(entry);
    if (entries.length > limit) entries.shift();
  };
  return {
    sync(messages) {
      const occurrences = new Map();
      for (const message of messages) {
        if (message?.role !== "user") continue;
        const text = messageText(message);
        if (!text.trim()) continue;
        // Timestamps can collide; occurrences distinguish identical real sends.
        // Only retain extracted text, never uploaded image payloads, in identity.
        const base = JSON.stringify([message.timestamp ?? null, text]);
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        const key = JSON.stringify([base, occurrence]);
        if (seen.has(key)) continue;
        seen.add(key);
        const pending = entries.find((entry) => entry.contentText === text);
        // Confirm in place: an earlier accepted command may never have an echo,
        // but must not move past a newer send when that newer send is confirmed.
        if (pending) delete pending.contentText;
        else append({ text });
      }
    },
    remember(text, content = text) {
      navigation = null;
      if (typeof text !== "string" || !text.trim()) return;
      append({ text, contentText: messageText({ content }) });
    },
    navigate(direction, draftText) {
      if (direction !== "older" && direction !== "newer") return null;
      if (!navigation) {
        if (direction !== "older") return null;
        if (!entries.length) return null;
        navigation = { entries: entries.map((entry) => entry.text), draft: draftText, index: entries.length };
      }
      const browse = navigation;
      if (direction === "older") browse.index = Math.max(0, browse.index - 1);
      else if (++browse.index === browse.entries.length) {
        navigation = null;
        return browse.draft;
      }
      return browse.entries[browse.index];
    },
    resetNavigation() { navigation = null; },
  };
}

// The caller gives menus priority. Only intercept arrows at logical line edges;
// visual wrapping deliberately does not require DOM geometry or browser state.
export function canNavigatePromptHistory(event, input) {
  if (!event || !input || event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
    || input.disabled || input.readOnly
    || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return false;
  const { value, selectionStart: start, selectionEnd: end } = input;
  if (typeof value !== "string" || !Number.isInteger(start) || start !== end || start < 0 || start > value.length) return false;
  return event.key === "ArrowUp"
    ? !value.slice(0, start).includes("\n")
    : !value.slice(start).includes("\n");
}
