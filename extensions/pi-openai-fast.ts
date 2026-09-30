import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Parent sessions start off. Managed workflow children receive a spawn-time
// snapshot of their parent's live mode, never a global/browser preference.
export default function openaiFast(pi: ExtensionAPI) {
  let enabled = false;
  let effective = false;
  let initialStart = true;
  const inherited = process.env.PI_WORKFLOW_CHILD === "1" && process.env.PI_WORKFLOW_FAST_MODE === "on";
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
    publish(ctx);
  });
  pi.on("session_shutdown", () => { enabled = false; effective = false; initialStart = false; });
  pi.on("session_switch", reset);
  pi.on("session_fork", reset);
  pi.on("model_select", reset);
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
