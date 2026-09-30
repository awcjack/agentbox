import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Deliberately session-local: resuming/forking or selecting another model never
// silently opts into a paid service tier. Workflow children also start off.
export default function openaiFast(pi: ExtensionAPI) {
  let enabled = false;
  const available = (ctx: ExtensionContext) => Boolean(ctx.model
    && ["openai", "openai-codex", "codex-work"].includes(ctx.model.provider)
    && ["openai-responses", "openai-codex-responses"].includes(ctx.model.api));
  const publish = (ctx: ExtensionContext) => ctx.ui.setStatus("agentbox-fast",
    JSON.stringify({ available: available(ctx), enabled: enabled && available(ctx) }));
  const reset = (_event: unknown, ctx: ExtensionContext) => { enabled = false; publish(ctx); };
  pi.on("session_start", reset);
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
