// OpenCode/Pi TUI parity: a leading ! or !! runs a shell command via RPC bash
// instead of prompting the model. !! excludes the output from model context.
export function bangCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^(!!?)([\s\S]*)$/.exec(text);
  if (!match) return null;
  return {
    command: match[2].replace(/^\s+/, ""),
    excludeFromContext: match[1] === "!!",
  };
}

// Frontend-only End & archive. Exact `/archive` never becomes a model prompt;
// host collector upload remains `/skill:archive-conversation`.
export function archiveCommand(text) {
  return typeof text === "string" && /^\/archive\s*$/.test(text);
}

// Only complete an initial slash command, never prose, selected text, or a
// command's ordinary arguments. Auto has explicit, discoverable mode arguments.
export function commandQuery(text, start = text.length, end = start) {
  if (start !== end || end !== text.length) return null;
  if (/^\/[A-Za-z0-9_:/.-]*$/.test(text) || /^\/auto (?:on|off|status)?$/.test(text)
    || /^\/auto (?:o|of|s|st|sta|stat|statu)$/.test(text)) return text.slice(1).toLowerCase();
  return null;
}

export function commandSuggestions(text, commands) {
  if (commandQuery(text) === null) return [];
  const query = text.slice(1).toLowerCase();
  const known = new Map();
  // Always advertise the local archive action; it is not a Pi catalog entry.
  known.set("archive", {
    name: "archive",
    description: "End and archive this session (stops Pi; keeps history under Archived).",
  });
  for (const command of Array.isArray(commands) ? commands.slice(0, 2000) : []) {
    if (!command || typeof command.name !== "string" || !/^[A-Za-z0-9_:/.-]{1,200}$/.test(command.name)) continue;
    if (!known.has(command.name)) known.set(command.name, {
      name: command.name,
      description: typeof command.description === "string" ? command.description.slice(0, 300) : "",
    });
  }
  // Do not advertise /auto on an older Pi process that does not register it.
  if (known.has("auto")) {
    known.set("auto on", { name: "auto on", description: "Enable auto-approval for this session; unresolved calls still ask you." });
    known.set("auto off", { name: "auto off", description: "Disable auto-approval and use normal permission rules." });
    known.set("auto status", { name: "auto status", description: "Show the current auto-permission mode." });
  }
  return [...known.values()].filter((command) => command.name.toLowerCase().startsWith(query))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 12);
}

// Billing-affecting state is authoritative only when supplied by metadata.
export function fastModeControl(mode, { supported = false, writable = false, refreshing = false } = {}) {
  return {
    disabled: !supported || !writable || refreshing || mode?.available !== true || typeof mode?.enabled !== "boolean",
    pressed: mode?.enabled === true,
    text: refreshing ? "Fast: refreshing..." : !mode ? "Fast: unknown" : !mode.available ? "Fast: unavailable" : mode.enabled ? "Fast: on" : "Fast: off",
    help: refreshing ? "Waiting for confirmed session metadata..." : !mode ? "This process has not reported fast-mode support. Start an updated Pi process to use this option." : !mode.available || !supported ? "OpenAI fast mode is unavailable in this session." : "New parent sessions start off; subagents inherit this session's mode when spawned. No chat draft or attachments are sent.",
  };
}
