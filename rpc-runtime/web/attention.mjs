const dialogMethods = new Set(["confirm", "select", "input", "editor"]);

// Page-memory acknowledgements, keyed by native conversation as well as runtime
// slot. Polling the same request/completion must not resurrect a read counter.
export function createAttentionTracker() {
  const seen = new Map();
  return {
    clear() { seen.clear(); },
    update(sessions, viewedId = null) {
      let action = 0, finished = 0;
      const live = new Set();
      for (const session of sessions) {
        const key = `${session.id}:${session.nativeSessionId}`;
        live.add(key);
        const entry = seen.get(key) || { requests: new Set(), settled: null };
        seen.set(key, entry);
        const requests = new Set((session.pendingUi || []).filter((request) => dialogMethods.has(request.method)).map((request) => request.id));
        const settled = Number.isSafeInteger(session.settledEventId) && session.settledEventId > 0 ? session.settledEventId : null;
        // Keep memory bounded to currently pending dialogs, not every request
        // ever answered in a long-running conversation.
        entry.requests = new Set([...entry.requests].filter((id) => requests.has(id)));
        if (session.id === viewedId) {
          entry.requests = requests;
          if (settled !== null) entry.settled = Math.max(entry.settled ?? 0, settled);
        }
        if (session.status !== "running") continue;
        if ([...requests].some((id) => !entry.requests.has(id))) action++;
        else if (!requests.size && session.activity === "idle" && settled !== null && settled > (entry.settled ?? 0)) finished++;
      }
      for (const key of seen.keys()) if (!live.has(key)) seen.delete(key);
      return { action, finished };
    },
  };
}

export function attentionTitle({ action, finished }, baseTitle) {
  const counts = [action ? `${action}!` : "", finished ? String(finished) : ""].filter(Boolean).join(" ");
  return counts ? `${counts} | ${baseTitle}` : baseTitle;
}
