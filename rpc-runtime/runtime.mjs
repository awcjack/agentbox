import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { normalize as normalizePath } from "node:path";
import { listHistory, resolveHistorySession, createConversationHistory, conversationBranch, conversationDraft, NATIVE_SESSION_ID_RE } from "./history.mjs";
import { isDeepStrictEqual } from "node:util";

const WEB_ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app.mjs", "text/javascript; charset=utf-8"]],
  ["/transport.mjs", ["transport.mjs", "text/javascript; charset=utf-8"]],
  ["/markdown.mjs", ["markdown.mjs", "text/javascript; charset=utf-8"]],
  ["/subagents.mjs", ["subagents.mjs", "text/javascript; charset=utf-8"]],
  ["/sidebar.mjs", ["sidebar.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
].map(([path, [file, type]]) => [path, { type, data: readFileSync(new URL(`./web/${file}`, import.meta.url)) }]));

const DEFAULT_ALLOWED_COMMANDS = [
  "abort",
  "abort_bash",
  "abort_retry",
  "clear_queue",
  "compact",
  "cycle_model",
  "cycle_thinking_level",
  "follow_up",
  "get_available_models",
  "get_available_thinking_levels",
  "get_commands",
  "get_entries",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_messages",
  "get_session_stats",
  "get_state",
  "get_tree",
  "prompt",
  "set_auto_compaction",
  "set_auto_retry",
  "set_follow_up_mode",
  "set_model",
  "set_session_name",
  "set_steering_mode",
  "steer",
];

const KNOWN_COMMANDS = new Set([
  ...DEFAULT_ALLOWED_COMMANDS,
  "bash",
  "clone",
  "export_html",
  "extension_ui_response",
  "fork",
  "new_session",
  "switch_session",
]);

// These commands escape the supervisor's session ownership or filesystem policy.
const HARD_FORBIDDEN_COMMANDS = new Set([
  "bash",
  "clone",
  "export_html",
  "extension_ui_response",
  "fork",
  "new_session",
  "switch_session",
]);

const READ_COMMANDS = new Set([
  "get_available_models",
  "get_available_thinking_levels",
  "get_commands",
  "get_entries",
  "get_fork_messages",
  "get_last_assistant_text",
  "get_messages",
  "get_session_stats",
  "get_state",
  "get_tree",
]);

const RESTORE_SETTINGS = Symbol("restore conversation settings");
const RESTORE_COMMANDS = new Set(["set_model", "set_thinking_level", "set_auto_compaction", "set_steering_mode", "set_follow_up_mode"]);

function conversationSettings(state) {
  if (typeof state.model?.provider !== "string" || typeof state.model?.id !== "string"
    || typeof state.thinkingLevel !== "string" || typeof state.autoCompactionEnabled !== "boolean"
    || !["all", "one-at-a-time"].includes(state.steeringMode) || !["all", "one-at-a-time"].includes(state.followUpMode)) {
    throw new HttpError(409, "settings_unavailable", "Pi did not report restorable conversation settings");
  }
  return { model: { provider: state.model.provider, id: state.model.id }, thinkingLevel: state.thinkingLevel,
    autoCompactionEnabled: state.autoCompactionEnabled, steeringMode: state.steeringMode, followUpMode: state.followUpMode };
}

function checkNativePrecondition(request, session, currentSession) {
  const expected = request.headers["x-pi-session-id"];
  if (expected === undefined) return; // Shipped clients did not send this header.
  if (typeof expected !== "string" || !NATIVE_SESSION_ID_RE.test(expected)) throw new HttpError(400, "invalid_session_precondition", "X-Pi-Session-Id must be a native session UUID");
  if (currentSession !== session || expected.toLowerCase() !== session.nativeSessionId.toLowerCase()) {
    throw new HttpError(409, "conversation_stale", "native session changed; refresh before sending a write");
  }
}

const SCOPES = new Set([
  "*",
  "profiles:read",
  "sessions:create",
  "sessions:read",
  "sessions:write",
  "sessions:delete",
]);

const DIALOG_METHODS = new Set(["confirm", "editor", "input", "select"]);
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SAFE_CHILD_ENV = Object.freeze({
  HOME: "/home/agent",
  XDG_CONFIG_HOME: "/home/agent/.config",
  XDG_CACHE_HOME: "/home/agent/.cache",
  USER: "agent",
  LOGNAME: "agent",
  SHELL: "/bin/bash",
  PATH: "/run/wrappers/bin:/home/agent/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/home/agent/.local/bin:/home/agent/.bun/bin:/home/agent/.cargo/bin:/bin:/usr/bin:/usr/local/bin",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  TERM: "xterm-256color",
  TMPDIR: "/tmp",
  SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
});

const DEFAULT_LIMITS = Object.freeze({
  maxSessions: 16,
  maxSseClients: 8,
  maxBodyBytes: 256 * 1024,
  maxRecordBytes: 2 * 1024 * 1024,
  maxEvents: 1_000,
  maxEventBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxPendingCommands: 32,
  maxPendingUi: 32,
  commandTimeoutMs: 30_000,
  idleTimeoutMs: 30 * 60_000,
  cleanupIntervalMs: 30_000,
  sseHeartbeatMs: 15_000,
  shutdownGraceMs: 5_000,
  killGraceMs: 2_000,
  requestTimeoutMs: 35_000,
});

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertKnownKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`${label} contains unknown key ${unknown}`);
}

function integer(value, fallback, label, min, max) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return result;
}

function stringArray(value, fallback, label) {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(result)];
}

function normalizeCommands(value, fallback, label) {
  const commands = stringArray(value, fallback, label);
  for (const command of commands) {
    if (!KNOWN_COMMANDS.has(command)) throw new Error(`${label} contains unknown command ${command}`);
    if (HARD_FORBIDDEN_COMMANDS.has(command)) throw new Error(`${label} contains forbidden command ${command}`);
  }
  return new Set(commands);
}

export function normalizeConfig(runtimeConfig, environment = process.env) {
  const root = assertObject(runtimeConfig, "runtime config");
  assertKnownKeys(root, new Set(["version", "defaults", "servers", "piRpcApi"]), "runtime config");
  const raw = assertObject(root.piRpcApi, "piRpcApi");
  assertKnownKeys(raw, new Set(["host", "port", "executable", "allowedOrigins", "auth", "allowedCommands", "profiles", "limits"]), "piRpcApi");
  const auth = assertObject(raw.auth, "piRpcApi.auth");
  assertKnownKeys(auth, new Set(["tokens"]), "piRpcApi.auth");
  if (!Array.isArray(auth.tokens) || auth.tokens.length === 0) {
    throw new Error("piRpcApi.auth.tokens must be a non-empty array");
  }

  const seenHashes = new Set();
  const authEnvironmentNames = new Set();
  const tokens = auth.tokens.map((entry, index) => {
    const token = assertObject(entry, `piRpcApi.auth.tokens[${index}]`);
    assertKnownKeys(token, new Set(["sha256", "sha256Env", "tokenEnv", "scopes"]), `piRpcApi.auth.tokens[${index}]`);
    if ([token.sha256, token.sha256Env, token.tokenEnv].filter((value) => value !== undefined).length !== 1) {
      throw new Error(`piRpcApi.auth.tokens[${index}] must set exactly one of sha256, sha256Env or tokenEnv`);
    }
    let hash = token.sha256;
    if (token.sha256Env !== undefined) {
      if (typeof token.sha256Env !== "string" || !ENV_NAME_RE.test(token.sha256Env)) {
        throw new Error(`piRpcApi.auth.tokens[${index}].sha256Env must name an environment variable`);
      }
      authEnvironmentNames.add(token.sha256Env);
      hash = environment[token.sha256Env];
      if (hash === undefined) {
        throw new Error(`piRpcApi.auth.tokens[${index}] requires environment variable ${token.sha256Env}`);
      }
    }
    if (token.tokenEnv !== undefined) {
      if (typeof token.tokenEnv !== "string" || !ENV_NAME_RE.test(token.tokenEnv)) {
        throw new Error(`piRpcApi.auth.tokens[${index}].tokenEnv must name an environment variable`);
      }
      authEnvironmentNames.add(token.tokenEnv);
      const secret = environment[token.tokenEnv];
      if (typeof secret !== "string" || !/^[\x21-\x7e]+$/.test(secret)) {
        throw new Error(`piRpcApi.auth.tokens[${index}] requires a non-empty printable token without whitespace in ${token.tokenEnv}`);
      }
      hash = createHash("sha256").update(secret, "utf8").digest("hex");
    }
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw new Error(`piRpcApi.auth.tokens[${index}].sha256 must be a SHA-256 hex digest`);
    }
    const normalizedHash = hash.toLowerCase();
    if (seenHashes.has(normalizedHash)) throw new Error("piRpcApi.auth.tokens contains a duplicate digest");
    seenHashes.add(normalizedHash);
    const scopes = stringArray(token.scopes, [], `piRpcApi.auth.tokens[${index}].scopes`);
    const unknownScope = scopes.find((scope) => !SCOPES.has(scope));
    if (unknownScope !== undefined) throw new Error(`piRpcApi.auth.tokens[${index}].scopes contains unknown scope ${unknownScope}`);
    return { digest: Buffer.from(normalizedHash, "hex"), scopes: new Set(scopes) };
  });

  const allowedCommands = normalizeCommands(raw.allowedCommands, DEFAULT_ALLOWED_COMMANDS, "piRpcApi.allowedCommands");
  const profilesRaw = assertObject(raw.profiles, "piRpcApi.profiles");
  const profiles = new Map();
  for (const [name, entry] of Object.entries(profilesRaw)) {
    if (!PROFILE_NAME_RE.test(name)) throw new Error(`invalid profile name ${name}`);
    const profile = assertObject(entry, `piRpcApi.profiles.${name}`);
    assertKnownKeys(profile, new Set(["cwd", "sessionDir", "args", "env", "envReferences", "allowedCommands"]), `piRpcApi.profiles.${name}`);
    if (typeof profile.cwd !== "string" || !profile.cwd.startsWith("/")) {
      throw new Error(`piRpcApi.profiles.${name}.cwd must be an absolute path`);
    }
    if (profile.sessionDir !== undefined && (typeof profile.sessionDir !== "string" || !profile.sessionDir.startsWith("/"))) {
      throw new Error(`piRpcApi.profiles.${name}.sessionDir must be an absolute path`);
    }
    const sessionDir = profile.sessionDir === undefined ? undefined : normalizePath(profile.sessionDir);
    if (sessionDir !== undefined && sessionDir !== profile.sessionDir) {
      throw new Error(`piRpcApi.profiles.${name}.sessionDir must be normalized`);
    }
    const args = stringArray(profile.args, [], `piRpcApi.profiles.${name}.args`);
    const ownsSessionOption = (arg) => [
      "--continue",
      "--fork",
      "--mode",
      "--name",
      "--no-session",
      "--resume",
      "--session",
      "--session-id",
      "--session-dir",
      "-c",
      "-n",
      "-r",
    ].some((option) => arg === option || (option.startsWith("--") && arg.startsWith(`${option}=`)));
    if (args.some(ownsSessionOption)) {
      throw new Error(`piRpcApi.profiles.${name}.args contains a supervisor-owned option`);
    }
    const env = profile.env === undefined ? {} : assertObject(profile.env, `piRpcApi.profiles.${name}.env`);
    if (Object.entries(env).some(([key, value]) => !ENV_NAME_RE.test(key) || typeof value !== "string")) {
      throw new Error(`piRpcApi.profiles.${name}.env must map environment variable names to strings`);
    }
    if (Object.keys(env).some((key) => authEnvironmentNames.has(key))) {
      throw new Error(`piRpcApi.profiles.${name}.env must not define an RPC authentication variable`);
    }
    const envReferences = profile.envReferences === undefined
      ? {}
      : assertObject(profile.envReferences, `piRpcApi.profiles.${name}.envReferences`);
    const resolvedEnv = { ...env };
    for (const [destination, source] of Object.entries(envReferences)) {
      if (!ENV_NAME_RE.test(destination) || typeof source !== "string" || !ENV_NAME_RE.test(source)) {
        throw new Error(`piRpcApi.profiles.${name}.envReferences must map environment variable names to environment variable names`);
      }
      if (authEnvironmentNames.has(source) || authEnvironmentNames.has(destination)) {
        throw new Error(`piRpcApi.profiles.${name}.envReferences must not expose an RPC authentication variable`);
      }
      if (Object.hasOwn(resolvedEnv, destination)) {
        throw new Error(`piRpcApi.profiles.${name} defines ${destination} in both env and envReferences`);
      }
      const value = environment[source];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`piRpcApi.profiles.${name}.envReferences requires environment variable ${source}`);
      }
      resolvedEnv[destination] = value;
    }
    const profileCommands = profile.allowedCommands === undefined
      ? new Set(allowedCommands)
      : normalizeCommands(profile.allowedCommands, [], `piRpcApi.profiles.${name}.allowedCommands`);
    for (const command of profileCommands) {
      if (!allowedCommands.has(command)) throw new Error(`profile ${name} cannot add command ${command}`);
    }
    profiles.set(name, {
      cwd: profile.cwd,
      sessionDir,
      args,
      env: resolvedEnv,
      allowedCommands: profileCommands,
    });
  }
  if (profiles.size === 0) throw new Error("piRpcApi.profiles must define at least one profile");
  const ownedSessionDirs = [];
  for (const [name, profile] of profiles) {
    if (profile.sessionDir === undefined) continue;
    for (const owner of ownedSessionDirs) {
      if (profile.sessionDir === owner.path || profile.sessionDir.startsWith(`${owner.path}/`) || owner.path.startsWith(`${profile.sessionDir}/`)) {
        throw new Error(`profile session directories must not overlap (${owner.name} and ${name})`);
      }
    }
    ownedSessionDirs.push({ name, path: profile.sessionDir });
  }

  const limitsRaw = raw.limits === undefined ? {} : assertObject(raw.limits, "piRpcApi.limits");
  assertKnownKeys(limitsRaw, new Set(Object.keys(DEFAULT_LIMITS)), "piRpcApi.limits");
  const limits = {
    maxSessions: integer(limitsRaw.maxSessions, DEFAULT_LIMITS.maxSessions, "limits.maxSessions", 1, 1_000),
    maxSseClients: integer(limitsRaw.maxSseClients, DEFAULT_LIMITS.maxSseClients, "limits.maxSseClients", 1, 1_000),
    maxBodyBytes: integer(limitsRaw.maxBodyBytes, DEFAULT_LIMITS.maxBodyBytes, "limits.maxBodyBytes", 1_024, 16 * 1024 * 1024),
    maxRecordBytes: integer(limitsRaw.maxRecordBytes, DEFAULT_LIMITS.maxRecordBytes, "limits.maxRecordBytes", 1_024, 32 * 1024 * 1024),
    maxEvents: integer(limitsRaw.maxEvents, DEFAULT_LIMITS.maxEvents, "limits.maxEvents", 1, 100_000),
    maxEventBytes: integer(limitsRaw.maxEventBytes, DEFAULT_LIMITS.maxEventBytes, "limits.maxEventBytes", 1_024, 128 * 1024 * 1024),
    maxStderrBytes: integer(limitsRaw.maxStderrBytes, DEFAULT_LIMITS.maxStderrBytes, "limits.maxStderrBytes", 1_024, 16 * 1024 * 1024),
    maxPendingCommands: integer(limitsRaw.maxPendingCommands, DEFAULT_LIMITS.maxPendingCommands, "limits.maxPendingCommands", 1, 10_000),
    maxPendingUi: integer(limitsRaw.maxPendingUi, DEFAULT_LIMITS.maxPendingUi, "limits.maxPendingUi", 1, 10_000),
    commandTimeoutMs: integer(limitsRaw.commandTimeoutMs, DEFAULT_LIMITS.commandTimeoutMs, "limits.commandTimeoutMs", 10, 10 * 60_000),
    idleTimeoutMs: integer(limitsRaw.idleTimeoutMs, DEFAULT_LIMITS.idleTimeoutMs, "limits.idleTimeoutMs", 100, 7 * 24 * 60 * 60_000),
    cleanupIntervalMs: integer(limitsRaw.cleanupIntervalMs, DEFAULT_LIMITS.cleanupIntervalMs, "limits.cleanupIntervalMs", 50, 60 * 60_000),
    sseHeartbeatMs: integer(limitsRaw.sseHeartbeatMs, DEFAULT_LIMITS.sseHeartbeatMs, "limits.sseHeartbeatMs", 100, 60 * 60_000),
    shutdownGraceMs: integer(limitsRaw.shutdownGraceMs, DEFAULT_LIMITS.shutdownGraceMs, "limits.shutdownGraceMs", 10, 60_000),
    killGraceMs: integer(limitsRaw.killGraceMs, DEFAULT_LIMITS.killGraceMs, "limits.killGraceMs", 10, 60_000),
    requestTimeoutMs: integer(limitsRaw.requestTimeoutMs, DEFAULT_LIMITS.requestTimeoutMs, "limits.requestTimeoutMs", 100, 10 * 60_000),
  };

  const host = raw.host ?? "127.0.0.1";
  if (typeof host !== "string" || host.length === 0) throw new Error("piRpcApi.host must be a non-empty string");
  const port = integer(raw.port, 4098, "piRpcApi.port", 0, 65_535);
  const executable = raw.executable ?? "pi";
  if (typeof executable !== "string" || !executable.startsWith("/")) throw new Error("piRpcApi.executable must be an absolute path");
  const allowedOrigins = stringArray(raw.allowedOrigins, [], "piRpcApi.allowedOrigins");
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`invalid allowed origin ${origin}`);
    }
  }

  return { host, port, executable, tokens, profiles, limits, allowedOrigins: new Set(allowedOrigins) };
}

class EventRing {
  constructor(maxRecords, maxBytes) {
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.records = [];
    this.bytes = 0;
    this.nextId = 1;
  }

  push(value) {
    const data = JSON.stringify(value);
    const size = Buffer.byteLength(data);
    const record = { id: this.nextId++, data, size };
    this.records.push(record);
    this.bytes += size;
    while (this.records.length > this.maxRecords || this.bytes > this.maxBytes) {
      this.bytes -= this.records.shift().size;
    }
    return record;
  }
}

class ByteRing {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (input.length >= this.maxBytes) {
      this.buffer = input.subarray(input.length - this.maxBytes);
      return;
    }
    const combined = Buffer.concat([this.buffer, input]);
    this.buffer = combined.length > this.maxBytes ? combined.subarray(combined.length - this.maxBytes) : combined;
  }

  text() {
    return this.buffer.toString("utf8");
  }
}

function attachLfJsonReader(stream, maxBytes, onRecord, onError, onOversized) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  let discarding = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const fail = (message) => {
    if (failed) return;
    failed = true;
    onError(new Error(message));
  };
  stream.on("data", (chunk) => {
    if (failed) return;
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, input]);
    while (true) {
      const lf = buffer.indexOf(0x0a);
      if (discarding) {
        buffer = lf === -1 ? Buffer.alloc(0) : buffer.subarray(lf + 1);
        if (lf === -1) return;
        discarding = false;
        continue;
      }
      if (lf === -1) break;
      if (lf > maxBytes) {
        if (!onOversized?.(buffer.subarray(0, maxBytes))) return fail("Pi RPC stdout record exceeded maxRecordBytes");
        buffer = buffer.subarray(lf + 1);
        continue;
      }
      let line = buffer.subarray(0, lf);
      buffer = buffer.subarray(lf + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
      if (line.length === 0) return fail("Pi RPC stdout contained an empty record");
      let value;
      try {
        value = JSON.parse(decoder.decode(line));
      } catch {
        return fail("Pi RPC stdout contained invalid UTF-8 or JSON");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return fail("Pi RPC stdout record was not a JSON object");
      }
      onRecord(value);
      if (failed) return;
    }
    if (buffer.length > maxBytes) {
      if (!onOversized?.(buffer.subarray(0, maxBytes))) return fail("Pi RPC stdout unterminated record exceeded maxRecordBytes");
      buffer = Buffer.alloc(0);
      discarding = true;
    }
  });
  stream.on("end", () => {
    if (!failed && (buffer.length !== 0 || discarding)) fail("Pi RPC stdout ended without an LF delimiter");
  });
  stream.on("error", (error) => fail(`Pi RPC stdout error: ${error.message}`));
}

function safeWrite(stream, object) {
  if (!stream || stream.destroyed || stream.writableEnded) throw new Error("Pi RPC stdin is closed");
  const data = JSON.stringify(object);
  if (data.includes("\n") || data.includes("\r")) {
    // JSON.stringify escapes string newlines, so this only guards exotic monkey-patching.
    throw new Error("unable to frame Pi RPC command");
  }
  stream.write(`${data}\n`);
}

class Session extends EventEmitter {
  constructor({ id, profileName, profile, resume, resumePath, name, config, spawnProcess, signalProcessGroup, now, uuid }) {
    super();
    this.id = id;
    this.profileName = profileName;
    this.profile = profile;
    this.resume = resume ?? null;
    this.nativeSessionId = resume ?? id;
    this.name = name ?? null;
    this.config = config;
    this.now = now;
    this.uuid = uuid;
    this.signalProcessGroup = signalProcessGroup;
    this.createdAt = now();
    this.lastActivityAt = this.createdAt;
    this.status = "running";
    this.exit = null;
    this.pending = new Map();
    this.lateReads = new Map();
    this.pendingUi = new Map();
    this.clients = new Set();
    this.events = new EventRing(config.limits.maxEvents, config.limits.maxEventBytes);
    this.stderr = new ByteRing(config.limits.maxStderrBytes);
    this.stopping = null;
    this.conversationLocked = false;
    this.conversationReplacing = false;
    this.uncertainWrite = false;
    this.agentBusy = false;
    this.revision = 0;

    const args = ["--mode", "rpc"];
    if (profile.sessionDir) args.push("--session-dir", profile.sessionDir);
    if (resume) args.push("--session", resumePath);
    else args.push("--session-id", this.nativeSessionId);
    if (name) args.push("--name", name);
    args.push(...profile.args);
    this.child = spawnProcess(config.executable, args, {
      cwd: profile.cwd,
      env: { ...SAFE_CHILD_ENV, ...profile.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    this.child.stderr.on("data", (chunk) => {
      this.lastActivityAt = this.now();
      this.stderr.push(chunk);
    });
    this.child.stderr.on("error", () => {});
    attachLfJsonReader(
      this.child.stdout,
      config.limits.maxRecordBytes,
      (record) => this.onRecord(record),
      (error) => this.protocolFailure(error),
      (prefix) => this.oversizedRead(prefix),
    );
    this.child.once("error", (error) => this.onExit(null, null, error));
    this.child.once("exit", (code, signal) => this.onExit(code, signal, null));
    this.publish({ type: "supervisor", event: "session_started", sessionId: id });
  }

  metadata(includeStderr = false) {
    const result = {
      id: this.id,
      profile: this.profileName,
      cwd: this.profile.cwd,
      name: this.name,
      nativeSessionId: this.nativeSessionId,
      conversationReplacing: this.conversationReplacing,
      latestEventId: this.events.nextId - 1,
      status: this.status,
      createdAt: new Date(this.createdAt).toISOString(),
      lastActivityAt: new Date(this.lastActivityAt).toISOString(),
      pendingUi: [...this.pendingUi.values()].map((entry) => entry.request),
      exit: this.exit,
    };
    if (includeStderr) result.stderr = this.stderr.text();
    return result;
  }

  touch() {
    this.lastActivityAt = this.now();
  }

  publish(value) {
    this.touch();
    const event = this.events.push(value);
    for (const client of this.clients) {
      this.writeSse(client, `id: ${event.id}\nevent: pi\ndata: ${event.data}\n\n`);
    }
    return event;
  }

  writeSse(client, data) {
    // write(false) means buffered, not disconnected. Allow ordinary backpressure
    // but bound each slow client's queue to one replay window plus one record.
    if (client.destroyed || client.writableEnded || client.writableLength + Buffer.byteLength(data) > this.config.limits.maxEventBytes + this.config.limits.maxRecordBytes) {
      client.destroy();
      return false;
    }
    client.write(data);
    return true;
  }

  oversizedRead(prefix) {
    // Pi 0.84 serializes response metadata before data. Drain an oversized read
    // without buffering its payload or killing an otherwise healthy agent.
    const text = prefix.toString("utf8");
    const end = text.indexOf(',"data":');
    if (end === -1) return false;
    let header;
    try { header = JSON.parse(`${text.slice(0, end)}}`); } catch { return false; }
    const key = String(header.id), pending = this.pending.get(key);
    if (header.type !== "response" || header.success !== true || !READ_COMMANDS.has(header.command) || (pending?.command ?? this.lateReads.get(key)) !== header.command) return false;
    this.lateReads.delete(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(key);
      pending.reject(new HttpError(413, "snapshot_too_large", "Pi history exceeds this runtime's record limit. The agent is still running; end this session and start a new one, or ask the administrator to raise maxRecordBytes."));
    }
    return true;
  }

  onRecord(record) {
    if (record.type !== "response") this.revision++;
    if (["agent_start", "auto_retry_start", "auto_compaction_start"].includes(record.type)) this.agentBusy = true;
    if (record.type === "agent_settled") this.agentBusy = false;
    if (record.type === "response" && record.command === "get_state" && record.success && record.data) {
      if (typeof record.data.sessionName === "string") this.name = record.data.sessionName;
      if (NATIVE_SESSION_ID_RE.test(record.data.sessionId ?? "")) this.nativeSessionId = record.data.sessionId;
    }
    // Snapshot responses already travel over HTTP. Replaying them over SSE
    // doubles transcripts and can evict the cursor used to request the snapshot.
    if (record.type !== "response" || !READ_COMMANDS.has(record.command)) this.publish(record);
    if (record.type === "extension_ui_request" && DIALOG_METHODS.has(record.method)) {
      if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 256) {
        return this.protocolFailure(new Error("Pi emitted an invalid extension UI request id"));
      }
      if (this.pendingUi.size >= this.config.limits.maxPendingUi) {
        return this.protocolFailure(new Error("Pi exceeded maxPendingUi"));
      }
      if (this.pendingUi.has(record.id)) {
        return this.protocolFailure(new Error("Pi reused a pending extension UI request id"));
      }
      let timer = null;
      if (Number.isSafeInteger(record.timeout) && record.timeout > 0) {
        timer = setTimeout(() => {
          if (!this.pendingUi.delete(record.id)) return;
          this.publish({ type: "supervisor", event: "extension_ui_expired", id: record.id });
        }, record.timeout);
        timer.unref?.();
      }
      this.pendingUi.set(record.id, { request: record, timer });
    }
    if (record.type !== "response" || !("id" in record)) return;
    const key = String(record.id);
    const pending = this.pending.get(key);
    if (!pending) {
      if (this.lateReads.get(key) === record.command) this.lateReads.delete(key);
      return;
    }
    if (record.command !== pending.command) {
      return this.protocolFailure(new Error("Pi RPC response command did not match its request"));
    }
    this.pending.delete(key);
    clearTimeout(pending.timer);
    const response = { ...record };
    if (pending.generated) delete response.id;
    pending.resolve(response);
  }

  protocolFailure(error) {
    if (this.status === "exited") return;
    this.status = "failed";
    this.publish({ type: "supervisor", event: "protocol_error", error: error.message });
    this.signal("SIGKILL");
  }

  signal(signal) {
    if (process.platform !== "win32" && Number.isSafeInteger(this.child.pid) && this.child.pid > 0) {
      try {
        this.signalProcessGroup(this.child.pid, signal);
        return;
      } catch {}
    }
    this.child.kill(signal);
  }

  onExit(code, signal, error) {
    if (this.exit) return;
    this.status = this.status === "failed" || error || (code !== 0 && code !== null) ? "failed" : "exited";
    this.exit = { code, signal, error: error?.message ?? null };
    this.publish({ type: "supervisor", event: this.conversationReplacing ? "conversation_source_exited" : "child_exit", ...this.exit });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new HttpError(502, "pi_exited", "Pi RPC process exited before responding"));
    }
    this.pending.clear();
    this.lateReads.clear();
    for (const entry of this.pendingUi.values()) clearTimeout(entry.timer);
    this.pendingUi.clear();
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.emit("exit");
  }

  sendCommand(command, conversationRead = false) {
    const restoring = conversationRead === RESTORE_SETTINGS && this.conversationLocked && RESTORE_COMMANDS.has(command?.type);
    if (this.status !== "running") throw new HttpError(409, "session_not_running", "session is not running");
    if (this.conversationLocked && !restoring && !(conversationRead === true && READ_COMMANDS.has(command?.type))) {
      throw new HttpError(409, "conversation_locked", "conversation operation is in progress");
    }
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      throw new HttpError(400, "invalid_command", "RPC command must be a JSON object");
    }
    if (typeof command.type !== "string") throw new HttpError(400, "invalid_command", "RPC command type is required");
    if (HARD_FORBIDDEN_COMMANDS.has(command.type) || (!restoring && !this.profile.allowedCommands.has(command.type))) {
      throw new HttpError(403, "command_forbidden", `RPC command ${command.type} is forbidden`);
    }
    if (this.pending.size >= this.config.limits.maxPendingCommands) {
      throw new HttpError(429, "too_many_commands", "too many RPC commands are pending");
    }
    if (READ_COMMANDS.has(command.type) && this.pending.size + this.lateReads.size >= this.config.limits.maxPendingCommands) {
      throw new HttpError(429, "too_many_commands", "waiting for outstanding Pi read responses");
    }
    if (command.id !== undefined && !["string", "number"].includes(typeof command.id)) {
      throw new HttpError(400, "invalid_command", "RPC command id must be a string or number");
    }
    const generated = command.id === undefined;
    const id = generated ? `runtime-${this.uuid()}` : command.id;
    const key = String(id);
    if (this.pending.has(key) || this.lateReads.has(key)) throw new HttpError(409, "duplicate_command_id", "RPC command id is already pending");
    const forwarded = generated ? { ...command, id } : command;
    this.touch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        if (READ_COMMANDS.has(command.type)) this.lateReads.set(key, command.type);
        else this.uncertainWrite = true;
        reject(new HttpError(504, "pi_timeout", "Pi RPC command timed out"));
      }, this.config.limits.commandTimeoutMs);
      timer.unref?.();
      this.pending.set(key, { resolve, reject, timer, generated, command: command.type });
      try {
        safeWrite(this.child.stdin, forwarded);
      } catch (error) {
        if (!READ_COMMANDS.has(command.type)) this.uncertainWrite = true;
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new HttpError(502, "pi_unavailable", error.message));
      }
    });
  }

  respondUi(body) {
    if (this.conversationLocked) throw new HttpError(409, "conversation_locked", "conversation operation is in progress");
    if (this.status !== "running") throw new HttpError(409, "session_not_running", "session is not running");
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.id !== "string") {
      throw new HttpError(400, "invalid_ui_response", "extension UI response id is required");
    }
    const entry = this.pendingUi.get(body.id);
    if (!entry) throw new HttpError(404, "ui_request_not_found", "pending extension UI request not found");
    const request = entry.request;
    if (Object.keys(body).some((key) => !["id", "cancelled", "confirmed", "value"].includes(key))) {
      throw new HttpError(400, "invalid_ui_response", "extension UI response contains an unknown field");
    }
    const response = { type: "extension_ui_response", id: body.id };
    if (body.cancelled === true && body.confirmed === undefined && body.value === undefined) {
      response.cancelled = true;
    } else if (request.method === "confirm" && typeof body.confirmed === "boolean" && body.cancelled === undefined && body.value === undefined) {
      response.confirmed = body.confirmed;
    } else if (["editor", "input", "select"].includes(request.method) && typeof body.value === "string" && body.cancelled === undefined && body.confirmed === undefined) {
      if (request.method === "select" && (!Array.isArray(request.options) || !request.options.includes(body.value))) {
        throw new HttpError(400, "invalid_ui_response", "select response must match an offered option");
      }
      response.value = body.value;
    } else {
      throw new HttpError(400, "invalid_ui_response", `invalid response for ${request.method} dialog`);
    }
    safeWrite(this.child.stdin, response);
    clearTimeout(entry.timer);
    this.pendingUi.delete(body.id);
    this.publish({ type: "supervisor", event: "extension_ui_resolved", id: body.id });
  }

  addSseClient(response, afterId) {
    if (this.clients.size >= this.config.limits.maxSseClients) {
      throw new HttpError(429, "too_many_streams", "too many event streams are open for this session");
    }
    // Some browser/proxy paths buffer header-only responses until body data arrives.
    if (!this.writeSse(response, ": connected\n\n")) return;
    const oldest = this.events.records[0]?.id ?? this.events.nextId;
    if (afterId > 0 && afterId < oldest - 1) {
      if (!this.writeSse(response, `event: reset\ndata: ${JSON.stringify({ oldestEventId: oldest })}\n\n`)) return;
    }
    for (const event of this.events.records) {
      if (event.id > afterId && !this.writeSse(response, `id: ${event.id}\nevent: pi\ndata: ${event.data}\n\n`)) return;
    }
    if (this.status !== "running") {
      response.end();
      return;
    }
    this.clients.add(response);
    this.touch();
    const heartbeat = setInterval(() => {
      this.writeSse(response, ": keepalive\n\n");
    }, this.config.limits.sseHeartbeatMs);
    heartbeat.unref?.();
    const remove = () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
      this.touch();
    };
    response.once("close", remove);
    response.once("finish", remove);
    response.once("error", remove);
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = new Promise((resolve) => {
      if (this.exit) return resolve();
      this.status = "stopping";
      try {
        safeWrite(this.child.stdin, { type: "abort" });
        this.child.stdin.end();
      } catch {}
      const termTimer = setTimeout(() => this.signal("SIGTERM"), this.config.limits.shutdownGraceMs);
      const killTimer = setTimeout(() => this.signal("SIGKILL"), this.config.limits.shutdownGraceMs + this.config.limits.killGraceMs);
      const doneTimer = setTimeout(resolve, this.config.limits.shutdownGraceMs + this.config.limits.killGraceMs + 1_000);
      this.once("exit", () => {
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        clearTimeout(doneTimer);
        resolve();
      });
    });
    return this.stopping;
  }
}

function securityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(encoded));
  response.end(encoded);
}

async function readJson(request, maxBytes) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, "body_too_large", "request body is too large");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "body_too_large", "request body is too large");
    chunks.push(chunk);
  }
  if (size === 0) throw new HttpError(400, "invalid_json", "request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "request body is not valid JSON");
  }
}

function authenticate(request, config, requiredScope) {
  const header = request.headers.authorization;
  const match = typeof header === "string" ? /^Bearer ([^\s]+)$/.exec(header) : null;
  const candidate = match?.[1] ?? "";
  const digest = createHash("sha256").update(candidate, "utf8").digest();
  let matched = null;
  for (const token of config.tokens) {
    if (timingSafeEqual(digest, token.digest)) matched = token;
  }
  if (!match || !matched) throw new HttpError(401, "unauthorized", "valid bearer token required");
  if (!matched.scopes.has("*") && !matched.scopes.has(requiredScope)) {
    throw new HttpError(403, "insufficient_scope", `scope ${requiredScope} is required`);
  }
}

function parseAfterId(request, url) {
  const raw = request.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
  if (Array.isArray(raw) || !/^\d+$/.test(raw)) throw new HttpError(400, "invalid_event_id", "event cursor must be a non-negative integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new HttpError(400, "invalid_event_id", "event cursor is too large");
  return value;
}

export function createRuntime(runtimeConfig, dependencies = {}) {
  const normalizedConfig = normalizeConfig(runtimeConfig, dependencies.environment ?? process.env);
  const resolveExecutable = dependencies.realpath ?? realpathSync;
  let executable;
  try {
    executable = resolveExecutable(normalizedConfig.executable);
  } catch (error) {
    throw new Error(`piRpcApi.executable could not be resolved: ${error.message}`);
  }
  if (typeof executable !== "string" || !executable.startsWith("/nix/store/")) {
    throw new Error("piRpcApi.executable must resolve to an immutable Nix store path");
  }
  const config = { ...normalizedConfig, executable };
  const spawnProcess = dependencies.spawn;
  if (typeof spawnProcess !== "function") throw new Error("createRuntime requires dependencies.spawn");
  const now = dependencies.now ?? Date.now;
  const uuid = dependencies.randomUUID ?? randomUUID;
  const signalProcessGroup = dependencies.signalProcessGroup ?? ((pid, signal) => process.kill(-pid, signal));
  const sessions = new Map();
  const creating = new Set();
  const conversationSources = new Set();
  const preparing = new Set();
  let shuttingDown = false;
  let closePromise = null;

  const server = createServer(async (request, response) => {
    securityHeaders(response);
    try {
      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (typeof origin !== "string" || !config.allowedOrigins.has(origin)) {
          throw new HttpError(403, "origin_forbidden", "request origin is not allowed");
        }
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
      }
      const url = new URL(request.url, "http://runtime.invalid");
      const asset = WEB_ASSETS.get(url.pathname);
      if (asset && ["GET", "HEAD"].includes(request.method)) {
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        response.setHeader("Content-Type", asset.type);
        response.setHeader("Content-Length", asset.data.length);
        return response.end(request.method === "HEAD" ? undefined : asset.data);
      }
      if (url.pathname === "/health/live" && request.method === "GET") {
        return json(response, 200, { status: "alive" });
      }
      if (url.pathname === "/health/ready" && request.method === "GET") {
        return json(response, shuttingDown ? 503 : 200, { status: shuttingDown ? "shutting_down" : "ready" });
      }
      if (request.method === "OPTIONS") {
        if (origin === undefined) throw new HttpError(400, "origin_required", "Origin is required for preflight");
        response.statusCode = 204;
        response.setHeader("Access-Control-Allow-Headers", "authorization, content-type, last-event-id, x-pi-session-id");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        response.setHeader("Access-Control-Max-Age", "600");
        return response.end();
      }
      if (shuttingDown) throw new HttpError(503, "shutting_down", "runtime is shutting down");

      if (url.pathname === "/v1/profiles" && request.method === "GET") {
        authenticate(request, config, "profiles:read");
        return json(response, 200, { profiles: [...config.profiles.keys()] });
      }
      if (url.pathname === "/v1/history" && request.method === "GET") {
        authenticate(request, config, "sessions:read");
        const profileName = url.searchParams.get("profile");
        if (!config.profiles.has(profileName)) throw new HttpError(400, "invalid_profile", "a configured profile is required");
        return json(response, 200, await listHistory(config.profiles.get(profileName), profileName));
      }
      if (url.pathname === "/v1/sessions" && request.method === "GET") {
        authenticate(request, config, "sessions:read");
        return json(response, 200, { sessions: [...sessions.values()].map((session) => session.metadata()) });
      }
      if (url.pathname === "/v1/sessions" && request.method === "POST") {
        authenticate(request, config, "sessions:create");
        const body = await readJson(request, config.limits.maxBodyBytes);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_session", "session request must be an object");
        const keys = Object.keys(body);
        if (keys.some((key) => !["profile", "resume", "name"].includes(key))) throw new HttpError(400, "invalid_session", "session request contains an unknown field");
        if (typeof body.profile !== "string" || !config.profiles.has(body.profile)) throw new HttpError(400, "invalid_profile", "a configured profile is required");
        if (body.resume !== undefined && (typeof body.resume !== "string" || !NATIVE_SESSION_ID_RE.test(body.resume))) {
          throw new HttpError(400, "invalid_resume", "resume must be an exact UUID session ID");
        }
        const profile = config.profiles.get(body.profile);
        if (body.resume !== undefined && profile.sessionDir === undefined) {
          throw new HttpError(400, "invalid_resume", "resume requires a profile-owned session directory");
        }
        if (body.resume !== undefined && [...sessions.values(), ...preparing].some((session) => session.nativeSessionId.toLowerCase() === body.resume.toLowerCase() && session.exit === null)) {
          throw new HttpError(409, "resume_in_use", "Pi session is already active");
        }
        if (body.name !== undefined && (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200 || /[\u0000-\u001f\u007f]/.test(body.name))) {
          throw new HttpError(400, "invalid_name", "name must be 1-200 characters without controls");
        }
        // Native IDs are exclusive across profiles too, including canonical
        // directory aliases and copied session files with the same ID.
        const resumeKey = `resume:${body.resume?.toLowerCase()}`;
        if (body.resume && (creating.has(resumeKey) || conversationSources.has(resumeKey))) throw new HttpError(409, "resume_in_use", "Pi session is already being resumed or switched");
        const activeSessions = creating.size + [...sessions.values()].filter((session) => session.exit === null).length;
        if (activeSessions >= config.limits.maxSessions) throw new HttpError(429, "session_limit", "maximum active session count reached");
        const id = uuid();
        let session;
        const creationKey = body.resume ? resumeKey : id;
        creating.add(creationKey);
        try {
          const resumePath = body.resume ? await resolveHistorySession(profile, body.resume) : undefined;
          if (body.resume && !resumePath) throw new HttpError(404, "resume_not_found", "an exact, unique Pi session for this profile was not found");
          if (shuttingDown) throw new HttpError(503, "shutting_down", "runtime is shutting down");
          session = new Session({ id, profileName: body.profile, profile, resume: body.resume, resumePath, name: body.name, config, spawnProcess, signalProcessGroup, now, uuid });
          sessions.set(id, session);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(502, "spawn_failed", `failed to start Pi RPC process: ${error.message}`);
        } finally {
          creating.delete(creationKey);
        }
        return json(response, 201, { session: session.metadata() });
      }

      const match = /^\/v1\/sessions\/([^/]+)(?:\/(rpc|events|ui|conversation))?$/.exec(url.pathname);
      if (!match || !SESSION_ID_RE.test(match[1])) throw new HttpError(404, "not_found", "route not found");
      const session = sessions.get(match[1]);
      if (!session) throw new HttpError(404, "session_not_found", "session not found");
      const action = match[2];
      if (action === "conversation" && ["GET", "POST"].includes(request.method)) {
        authenticate(request, config, "sessions:read");
        const mutate = request.method === "POST";
        let body;
        if (mutate) {
          authenticate(request, config, "sessions:write");
          body = await readJson(request, config.limits.maxBodyBytes);
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).some((key) => !["action", "entryId", "expectedNativeSessionId", "expectedLeafId"].includes(key))
            || !["revert", "fork"].includes(body.action)
            || typeof body.entryId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(body.entryId)
            || typeof body.expectedNativeSessionId !== "string" || !NATIVE_SESSION_ID_RE.test(body.expectedNativeSessionId)
            || !(body.expectedLeafId === null || (typeof body.expectedLeafId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(body.expectedLeafId)))) {
            throw new HttpError(400, "invalid_conversation", "action, entryId, expectedNativeSessionId and expectedLeafId are required; paths are not accepted");
          }
          if (body.action === "fork") authenticate(request, config, "sessions:create");
        }
        for (const command of mutate ? ["get_state", "get_entries", "prompt"] : ["get_state", "get_entries"]) {
          if (!session.profile.allowedCommands.has(command)) throw new HttpError(403, "command_forbidden", `conversation requires allowed command ${command}`);
        }
        if (mutate && !session.profile.sessionDir) throw new HttpError(409, "history_unavailable", "conversation changes require a profile-owned session directory");
        if (session.conversationLocked) throw new HttpError(409, "conversation_locked", "conversation operation is in progress");
        if (session.status !== "running" || sessions.get(session.id) !== session) throw new HttpError(409, "session_not_running", "session is not running");
        if (session.pending.size || session.lateReads.size || session.pendingUi.size || session.uncertainWrite || session.agentBusy) {
          throw new HttpError(409, "conversation_busy", "wait for Pi to settle and resolve pending commands or dialogs; uncertain writes require restarting the session");
        }
        session.conversationLocked = true;
        let child, reservation, sourceReservation, committed = false;
        const readSnapshot = async (target) => {
          const state = await target.sendCommand({ type: "get_state" }, true);
          if (!state.success || !NATIVE_SESSION_ID_RE.test(state.data?.sessionId ?? "")) throw new HttpError(502, "invalid_snapshot", "Pi did not return a valid session state");
          if (state.data.isStreaming !== false || state.data.isCompacting !== false || state.data.pendingMessageCount !== 0
            || target.pendingUi.size || target.agentBusy || target.uncertainWrite) {
            throw new HttpError(409, "conversation_busy", "Pi must be idle with no queued messages or dialogs");
          }
          const entries = await target.sendCommand({ type: "get_entries" }, true);
          let branch;
          try {
            if (!entries.success) throw new Error();
            branch = conversationBranch(entries.data);
          } catch { throw new HttpError(502, "invalid_snapshot", "Pi did not return a valid conversation tree"); }
          return { nativeSessionId: state.data.sessionId, state: state.data, data: entries.data, branch };
        };
        try {
          const revision = session.revision;
          const snapshot = await readSnapshot(session);
          if (revision !== session.revision || session.pendingUi.size || session.agentBusy) throw new HttpError(409, "conversation_busy", "conversation changed while reading");
          if (!mutate) {
            return json(response, 200, {
              nativeSessionId: snapshot.nativeSessionId, leafId: snapshot.data.leafId,
              messages: snapshot.branch.filter((entry) => entry.type === "message").map(({ id, parentId, message }) => ({ entryId: id, parentId, message })),
            });
          }
          if (body.expectedNativeSessionId !== snapshot.nativeSessionId || body.expectedLeafId !== snapshot.data.leafId) {
            throw new HttpError(409, "conversation_stale", "conversation identity or leaf changed; refresh before retrying");
          }
          const settings = conversationSettings(snapshot.state);
          const index = snapshot.branch.findIndex((entry) => entry.id === body.entryId && entry.type === "message" && entry.message?.role === "user");
          if (index < 0) throw new HttpError(400, "invalid_entry", "entryId must select a user message on the current branch");
          let draft;
          try { draft = conversationDraft(snapshot.branch[index].message); }
          catch { throw new HttpError(409, "unsupported_message", "selected message cannot be restored losslessly as a draft"); }
          if (creating.size + [...sessions.values()].filter((value) => value.exit === null).length >= config.limits.maxSessions) {
            throw new HttpError(429, "session_limit", "conversation changes require capacity for one replacement child");
          }
          const nativeId = uuid();
          reservation = `resume:${nativeId.toLowerCase()}`;
          sourceReservation = `resume:${snapshot.nativeSessionId.toLowerCase()}`;
          if (creating.has(sourceReservation) || conversationSources.has(sourceReservation) || [...sessions.values()].some((value) => value !== session && value.exit === null && value.nativeSessionId.toLowerCase() === snapshot.nativeSessionId.toLowerCase())) {
            sourceReservation = null;
            throw new HttpError(409, "resume_in_use", "source native session has another owner");
          }
          creating.add(reservation);
          conversationSources.add(sourceReservation);
          const prefix = snapshot.branch.slice(0, index);
          let path;
          try { path = await createConversationHistory(session.profile, snapshot.nativeSessionId, snapshot.data, prefix, nativeId, config.limits.maxRecordBytes); }
          catch { throw new HttpError(409, "history_unavailable", "source must have complete, unique v3 persisted history within maxRecordBytes; no source files were changed"); }
          if (shuttingDown) throw new HttpError(503, "shutting_down", "runtime is shutting down");
          try {
            child = new Session({ id: body.action === "fork" ? uuid() : session.id, profileName: session.profileName, profile: session.profile,
              resume: nativeId, resumePath: path, config, spawnProcess, signalProcessGroup, now, uuid });
          } catch { throw new HttpError(502, "spawn_failed", "failed to start conversation child; source is unchanged"); }
          child.conversationLocked = true;
          preparing.add(child);
          // Retain ownership after a bounded stop timeout, then release it on
          // the actual late exit rather than leaking capacity until restart.
          child.once("exit", () => {
            preparing.delete(child);
            creating.delete(reservation);
          });
          const initial = await readSnapshot(child);
          if (initial.nativeSessionId !== nativeId || !isDeepStrictEqual(initial.branch.slice(0, prefix.length), prefix)) {
            throw new HttpError(409, "conversation_changed", "child did not load the requested conversation identity and prefix");
          }
          for (const command of [
            { type: "set_model", provider: settings.model.provider, modelId: settings.model.id },
            { type: "set_thinking_level", level: settings.thinkingLevel },
            { type: "set_auto_compaction", enabled: settings.autoCompactionEnabled },
            { type: "set_steering_mode", mode: settings.steeringMode },
            { type: "set_follow_up_mode", mode: settings.followUpMode },
          ]) {
            const result = await child.sendCommand(command, RESTORE_SETTINGS);
            if (!result.success) throw new HttpError(409, "settings_restore_failed", "Pi rejected restoring conversation settings; source was not stopped");
          }
          const loaded = await readSnapshot(child);
          if (!isDeepStrictEqual(conversationSettings(loaded.state), settings)) throw new HttpError(409, "settings_restore_failed", "Pi did not preserve conversation settings; source was not stopped");
          const childRevision = child.revision;
          // Extensions may append startup metadata, but cannot replace or trim the prefix.
          if (loaded.nativeSessionId !== nativeId || !isDeepStrictEqual(loaded.branch.slice(0, prefix.length), prefix)
            || loaded.branch.slice(prefix.length).some((entry) => !["session_info", "model_change", "thinking_level_change", "custom", "label"].includes(entry.type))) {
            throw new HttpError(409, "conversation_changed", "child did not load the requested conversation prefix");
          }
          const current = await readSnapshot(session);
          if (shuttingDown || revision !== session.revision || current.nativeSessionId !== snapshot.nativeSessionId
            || !isDeepStrictEqual(current.data, snapshot.data) || !isDeepStrictEqual(conversationSettings(current.state), settings)
            || child.status !== "running" || child.pendingUi.size || child.agentBusy || child.revision !== childRevision) {
            throw new HttpError(409, "conversation_changed", "source or child changed while preparing conversation");
          }
          if (body.action === "revert") {
            session.conversationReplacing = true;
            session.publish({ type: "supervisor", event: "conversation_replacing", sessionId: session.id,
              previousNativeSessionId: snapshot.nativeSessionId, nativeSessionId: nativeId });
            await session.stop();
            if (!session.exit) throw new HttpError(502, "stop_failed", "source did not exit; replacement was not activated");
            if (shuttingDown || child.status !== "running" || child.pendingUi.size || child.agentBusy || child.revision !== childRevision) throw new HttpError(409, "conversation_changed", "replacement is no longer ready; original history is retained");
            const startupEvents = child.events.records.map((event) => JSON.parse(event.data));
            // Keep cursors monotonic, but never replay the abandoned transcript
            // or share a ring with stdout still draining from the old process.
            child.events = new EventRing(config.limits.maxEvents, config.limits.maxEventBytes);
            child.events.nextId = session.events.nextId;
            child.createdAt = session.createdAt;
            for (const event of startupEvents) child.publish(event);
          }
          child.conversationLocked = false;
          sessions.set(child.id, child);
          committed = true;
          child.publish({ type: "supervisor", event: "conversation_changed", action: body.action,
            sessionId: child.id, nativeSessionId: nativeId, previousNativeSessionId: snapshot.nativeSessionId, sourceSessionId: session.id });
          return json(response, 200, { session: child.metadata(), draft });
        } finally {
          if (child && !committed) await child.stop();
          // A child that has not actually exited still owns its native ID and
          // capacity, even if the bounded shutdown wait expired.
          if (!child || committed || child.exit) {
            preparing.delete(child);
            if (reservation) creating.delete(reservation);
          }
          if (sourceReservation) conversationSources.delete(sourceReservation);
          if (session.conversationReplacing) {
            session.conversationReplacing = false;
            if (!committed) session.publish({ type: "supervisor", event: "conversation_replace_failed", sessionId: session.id, nativeSessionId: session.nativeSessionId });
          }
          session.conversationLocked = false;
        }
      }
      if (!action && request.method === "GET") {
        authenticate(request, config, "sessions:read");
        session.touch();
        return json(response, 200, { session: session.metadata(true) });
      }
      if (!action && request.method === "DELETE") {
        authenticate(request, config, "sessions:delete");
        if (session.conversationLocked) throw new HttpError(409, "conversation_locked", "conversation operation is in progress");
        await session.stop();
        if (!session.exit) throw new HttpError(502, "stop_failed", "Pi has not exited; session ownership is retained");
        sessions.delete(session.id);
        response.statusCode = 204;
        return response.end();
      }
      if (action === "rpc" && request.method === "POST") {
        const command = await readJson(request, config.limits.maxBodyBytes);
        const requiredScope = command && typeof command === "object" && READ_COMMANDS.has(command.type)
          ? "sessions:read"
          : "sessions:write";
        authenticate(request, config, requiredScope);
        if (requiredScope === "sessions:write") checkNativePrecondition(request, session, sessions.get(session.id));
        const result = await session.sendCommand(command);
        return json(response, 200, result);
      }
      if (action === "ui" && request.method === "POST") {
        authenticate(request, config, "sessions:write");
        const body = await readJson(request, config.limits.maxBodyBytes);
        checkNativePrecondition(request, session, sessions.get(session.id));
        session.respondUi(body);
        return json(response, 202, { accepted: true });
      }
      if (action === "events" && request.method === "GET") {
        authenticate(request, config, "sessions:read");
        const afterId = parseAfterId(request, url);
        if (session.clients.size >= config.limits.maxSseClients) {
          throw new HttpError(429, "too_many_streams", "too many event streams are open for this session");
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Connection", "keep-alive");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders();
        session.addSseClient(response, afterId);
        return;
      }
      throw new HttpError(405, "method_not_allowed", "method not allowed");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      if (status === 401) response.setHeader("WWW-Authenticate", 'Bearer realm="pi-rpc-runtime"');
      json(response, status, { error: { code, message: status === 500 ? "internal server error" : error.message } });
    }
  });

  server.requestTimeout = config.limits.requestTimeoutMs;
  server.headersTimeout = Math.min(config.limits.requestTimeoutMs, 60_000);
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;

  const cleanupTimer = setInterval(() => {
    const cutoff = now() - config.limits.idleTimeoutMs;
    for (const [id, session] of sessions) {
      if (!session.conversationLocked && session.clients.size === 0 && session.pending.size === 0 && session.lastActivityAt < cutoff) {
        session.stop().then(() => {
          if (session.exit && sessions.get(id) === session && !session.conversationLocked) sessions.delete(id);
        }).catch(() => {});
      }
    }
  }, config.limits.cleanupIntervalMs);
  cleanupTimer.unref?.();

  async function listen() {
    if (server.listening) return server.address();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server.address();
  }

  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      shuttingDown = true;
      clearInterval(cleanupTimer);
      for (const session of sessions.values()) {
        const clients = [...session.clients];
        session.clients.clear();
        for (const client of clients) client.end();
      }
      const forceClose = setTimeout(() => server.closeAllConnections(), config.limits.shutdownGraceMs + config.limits.killGraceMs + 1_000);
      forceClose.unref?.();
      const closeServer = server.listening
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve();
      await Promise.allSettled([...sessions.values(), ...preparing].map((session) => session.stop()));
      await closeServer;
      clearTimeout(forceClose);
      sessions.clear();
    })();
    return closePromise;
  }

  return { config, server, sessions, listen, close };
}

export const internals = { attachLfJsonReader, HARD_FORBIDDEN_COMMANDS };
