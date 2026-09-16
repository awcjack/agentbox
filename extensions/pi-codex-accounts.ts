import { createHash } from "node:crypto";
import {
  cleanupSessionResources,
  createProvider,
  lazyStream,
  registerSessionResourceCleanup,
  type AssistantMessageEvent,
  type ProviderStreams,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function codexAccounts(pi: ExtensionAPI) {
  // Use Pi's loader-supported entrypoint, not a second bundled copy of pi-ai.
  const native = builtinProviders().find((provider) => provider.id === "openai-codex");
  if (!native) throw new Error("This Pi build has no native OpenAI Codex provider");
  const sessions = new Map<string, Set<string>>();
  const unregister = registerSessionResourceCleanup((sessionId) => {
    if (sessionId === undefined) {
      sessions.clear(); // Native cleanup already clears all transport resources.
      return;
    }
    const scoped = sessions.get(sessionId);
    sessions.delete(sessionId);
    for (const id of scoped ?? []) cleanupSessionResources(id);
  });
  pi.on("session_shutdown", () => {
    for (const sessionId of sessions.keys()) cleanupSessionResources(sessionId);
    unregister();
  });

  const id = "codex-work";
  const adapt = (method: "stream" | "streamSimple"): ProviderStreams["stream"] =>
    (model, context, options) => lazyStream(model, async () => {
      // Auth has already been resolved under the alias. Only the wire identity
      // changes: Pi 0.84's Codex tool-call normalizer recognizes native IDs.
      const wireModel = { ...model, provider: native.id };
      const wireContext = {
        ...context,
        messages: context.messages.map((message) => message.role !== "assistant" ? message : {
          ...message,
          provider: message.provider === id ? native.id
            : message.provider === native.id ? "agentbox:other-codex-account" : message.provider,
        }),
      };
      let sessionId: string | undefined;
      if (options?.sessionId && options.cacheRetention !== "none") {
        // Include the resolved credential and endpoint so even re-login to the
        // same account cannot reuse a socket authenticated with an old token.
        sessionId = createHash("sha256").update(JSON.stringify([
          id, options.sessionId, options.apiKey, model.baseUrl,
        ])).digest("hex");
        const scoped = sessions.get(options.sessionId) ?? new Set<string>();
        scoped.add(sessionId);
        sessions.set(options.sessionId, scoped);
      }
      const onPayload = options?.onPayload;
      const wireOptions: StreamOptions = {
        ...options,
        sessionId,
        onPayload: onPayload
          ? (payload) => onPayload(payload, model)
          : undefined,
      };
      const source = native[method](wireModel, wireContext, wireOptions);
      return (async function* (): AsyncGenerator<AssistantMessageEvent> {
        for await (const event of source) {
          // Do not mutate native output: its WebSocket history cache uses it.
          if (event.type === "done") yield { ...event, message: { ...event.message, provider: id } };
          else if (event.type === "error") yield { ...event, error: { ...event.error, provider: id } };
          else yield { ...event, partial: { ...event.partial, provider: id } };
        }
      })();
    });
  pi.registerProvider(createProvider({
    id,
    name: "Codex Work",
    baseUrl: native.baseUrl,
    auth: native.auth,
    models: native.getModels().map((model) => ({ ...model, provider: id })),
    api: { stream: adapt("stream"), streamSimple: adapt("streamSimple") },
  }));
}
