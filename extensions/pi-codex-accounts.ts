import { createHash } from "node:crypto";
import {
  cleanupSessionResources,
  InMemoryCredentialStore,
  lazyStream,
  registerSessionResourceCleanup,
  type AssistantMessageEvent,
  type Provider,
  type ProviderStreams,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function codexAccounts(pi: ExtensionAPI) {
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
  // Pi resolves CLI/default/restored models BEFORE session_start. Bootstrap the
  // local catalog here, using Pi's own cache + models.json composition instead
  // of only the bundled list. No login, token refresh or network is needed.
  // The managed CLI uses PI_CODING_AGENT_DIR for both this and its main runtime.
  const catalog = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  await catalog.refresh({ providers: [native.id], allowNetwork: false });
  const initialModels = catalog.getProvider(native.id)?.getModels() ?? native.getModels();
  let getModels = () => initialModels;
  const provider: Provider = {
    id,
    name: "Codex Work",
    baseUrl: native.baseUrl,
    auth: native.auth,
    getModels: () => getModels().map((model) => ({ ...model, provider: id })),
    stream: adapt("stream"),
    streamSimple: adapt("streamSimple"),
  };
  pi.registerProvider(provider);
  pi.on("session_start", (_event, ctx) => {
    // The runtime adds remote catalogs and models.json overlays to the builtin.
    // Resolve on every read so refresh/recomposition cannot leave a stale list.
    getModels = () => ctx.modelRegistry.getProvider(native.id)?.getModels() ?? native.getModels();
    pi.registerProvider(provider);
  });
}
