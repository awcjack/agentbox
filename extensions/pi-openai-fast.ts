import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST_SESSION_ENTRY = "agentbox-fast-mode";

// Fresh parent sessions start off. Managed workflow children receive only a
// spawn-time snapshot of their parent's live mode, not saved session choices.
export default function openaiFast(pi: ExtensionAPI) {
  let enabled = false;
  let effective = false;
  let initialStart = true;
  const workflowChild = process.env.PI_WORKFLOW_CHILD === "1" || process.env.PI_WORKFLOW_APPROVAL_VERSION !== undefined;
  const inherited = process.env.PI_WORKFLOW_CHILD === "1" && process.env.PI_WORKFLOW_FAST_MODE === "on";
  const failedSaves = new Set<string>();
  const persistent = (ctx: ExtensionContext) => ctx.mode === "rpc" && !workflowChild;
  const savedChoice = (ctx: ExtensionContext) => ctx.sessionManager.getEntries().findLast(entry =>
    entry.type === "custom" && entry.customType === FAST_SESSION_ENTRY);
  function save(ctx: ExtensionContext, on: boolean) {
    if (!persistent(ctx)) return true;
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      pi.appendEntry(FAST_SESSION_ENTRY, { version: 1, sessionId, enabled: on, provider: ctx.model?.provider, modelId: ctx.model?.id });
      failedSaves.delete(sessionId);
      return true;
    } catch {
      failedSaves.add(sessionId);
      ctx.ui.notify("Could not save session Fast mode. Live Fast is off; restarting may restore an older choice.", "error");
      return false;
    }
  }
  pi.events.on("agentbox:fast-query", (request: unknown) => {
    if (request && typeof request === "object" && "reply" in request && typeof request.reply === "function") {
      request.reply(effective);
    }
  });
  const available = (ctx: ExtensionContext) => Boolean(ctx.model
    && ["openai", "openai-codex", "codex-work"].includes(ctx.model.provider)
    && ["openai-responses", "openai-codex-responses"].includes(ctx.model.api));
  const publish = (ctx: ExtensionContext) => {
    effective = enabled && available(ctx);
    ctx.ui.setStatus("agentbox-fast", JSON.stringify({ available: available(ctx), enabled: effective }));
  };
  const reset = (_event: unknown, ctx: ExtensionContext) => { enabled = false; publish(ctx); };
  pi.on("session_start", (_event, ctx) => {
    enabled = initialStart && inherited && available(ctx);
    initialStart = false;
    if (persistent(ctx) && available(ctx)) {
      const entry = savedChoice(ctx);
      const data = entry?.type === "custom" ? entry.data : undefined;
      const id = ctx.sessionManager.getSessionId();
      enabled = !failedSaves.has(id) && data?.version === 1 && data.sessionId === id && data.enabled === true
        && data.provider === ctx.model?.provider && data.modelId === ctx.model?.id;
    }
    publish(ctx);
  });
  pi.on("session_shutdown", () => { enabled = false; effective = false; initialStart = false; });
  pi.on("session_switch", reset);
  pi.on("session_fork", reset);
  pi.on("model_select", (_event, ctx) => {
    // Clear the saved opt-in too; returning to an earlier model must not
    // silently reactivate paid mode (even after another restart).
    if (persistent(ctx)) {
      const entry = savedChoice(ctx);
      if (entry?.type === "custom" && entry.data?.enabled === true
        && entry.data.sessionId === ctx.sessionManager.getSessionId()) save(ctx, false);
    }
    reset(_event, ctx);
  });
  pi.registerCommand("fast", {
    description: "OpenAI paid fast mode: /fast on|off|status (off by default)",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!["on", "off", "status"].includes(action)) {
        ctx.ui.notify("Usage: /fast on|off|status", "error");
        return;
      }
      if (action !== "status") {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Wait for the agent to finish before changing fast mode.", "error");
          return;
        }
        if (action === "on" && !available(ctx)) {
          ctx.ui.notify("Fast mode is only available for native OpenAI and Codex providers.", "error");
          return;
        }
        enabled = false;
        if (!save(ctx, action === "on")) { publish(ctx); return; }
        enabled = action === "on";
      }
      publish(ctx);
      ctx.ui.notify(`Fast mode: ${enabled ? "on (paid priority tier; additional charges/credits may apply)" : "off"}. Availability and actual tier depend on OpenAI.`, "info");
    },
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled || !available(ctx) || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return;
    const payload = event.payload as Record<string, unknown>;
    // Do not opt a different model used by a nested operation into paid mode.
    if (payload.model !== ctx.model?.id) return;
    return { ...payload, service_tier: "priority" };
  });
}
