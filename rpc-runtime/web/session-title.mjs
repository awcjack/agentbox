// Display-only fallbacks never rename the native Pi conversation.
export function messageTitle(messages = []) {
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const text = typeof message.content === "string" ? message.content : Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join(" ") : "";
    if (text.trim()) return text.trim().slice(0, 200);
  }
  return "";
}

export function sessionTitle(session, state = {}, messages = [], saved) {
  return state.sessionName?.trim() || session?.name?.trim() || saved?.name?.trim()
    || messageTitle(messages) || "Untitled session";
}
