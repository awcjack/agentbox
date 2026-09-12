// Compact display only: full arguments/results remain in the expandable row.
export function toolPreview(call, result) {
  let args = call.arguments ?? result?.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return shorten(args); }
  }
  if (!args || typeof args !== "object") return "";
  const primary = ["command", "path", "file_path", "filePath", "query", "url", "pattern", "description", "prompt", "action"].find((key) => typeof args[key] === "string" && args[key].trim());
  return primary ? shorten(args[primary]) : "";
}

function shorten(text) {
  const compact = text.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
}

function actionOnly(message) {
  if (message?.role !== "assistant" || message.summary || message.errorMessage || ["error", "aborted"].includes(message.stopReason)) return false;
  const content = message.content;
  return Array.isArray(content) && content.length > 0
    && content.every((block) => ["thinking", "toolCall"].includes(block.type) || (block.type === "text" && !block.text?.trim()));
}

// Tool results between messages are rendered inside their original tool rows.
// Do not collapse user turns, prose, errors, or changes of model/provider.
export function canGroupActions(previous, message) {
  return actionOnly(previous) && actionOnly(message)
    && previous.model === message.model && previous.provider === message.provider;
}
