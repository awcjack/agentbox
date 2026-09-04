import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile as nodeExecFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"

const DEFAULT_CONFIG_PATH = "/etc/pi/agentbox-policy.json"
const SIGNAL_PATH = "/home/agent/.local/bin/agent-signal.sh"
const MAX_CONFIG_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const MAX_DISPLAY_CHARS = 240
const MAX_RULES = 1_000
const MAX_RULE_ENTRIES = 128
const MAX_POLICY_STRING_CHARS = 4_096
const MAX_TOOL_PATTERN_CHARS = 256
const MAX_GENERIC_TARGETS = 128
const MAX_TARGET_DEPTH = 8
const MAX_TARGET_CHARS = 100_000

type Decision = "allow" | "ask" | "deny"

interface PolicyRule {
  tools: string[]
  patterns: string[]
  decision: Decision
}

interface PolicyConfig {
  version: 1
  defaultDecision: Decision
  timeout: number
  rules: PolicyRule[]
}

interface PolicyTarget {
  value: string
  path: boolean
}

export interface PiPolicyDependencies {
  readFile?: (path: string) => Promise<string | Buffer>
  realpath?: (path: string) => Promise<string>
  signal?: (state: "waiting" | "working") => Promise<void> | void
  env?: NodeJS.ProcessEnv
}

/** Input fields that identify the resource or operation governed by a tool call. */
export const TOOL_INPUT_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  bash: ["command"],
  code_diagnostics: ["path"],
  code_navigation: ["path"],
  edit: ["path", "filePath", "file_path"],
  find: ["path"],
  grep: ["path"],
  ls: ["path"],
  read: ["path", "filePath", "file_path", "notebook_path"],
  task: ["prompt"],
  web_fetch: ["url"],
  web_search: ["query"],
  write: ["path", "filePath", "file_path", "notebook_path"],
})

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "code_diagnostics", "code_navigation"])
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "patch", "delete", "move"])
const DECISIONS = new Set<Decision>(["allow", "ask", "deny"])
const CONFIG_KEYS = new Set(["version", "defaultDecision", "timeout", "rules"])
const RULE_KEYS = new Set(["tools", "patterns", "decision"])

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>) {
  return Object.keys(value).every((key) => allowed.has(key))
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_RULE_ENTRIES) {
    throw new Error(`${name} must be a non-empty array with at most ${MAX_RULE_ENTRIES} entries`)
  }
  if (!value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= MAX_POLICY_STRING_CHARS)) {
    throw new Error(`${name} entries must be non-empty strings of at most ${MAX_POLICY_STRING_CHARS} characters`)
  }
  return [...value] as string[]
}

function toolArray(value: unknown, name: string) {
  const tools = stringArray(value, name)
  if (!tools.every((tool) => tool.length <= MAX_TOOL_PATTERN_CHARS && /^[A-Za-z0-9_.*?:/+\-]+$/u.test(tool))) {
    throw new Error(`${name} entries must be tool-name globs of at most ${MAX_TOOL_PATTERN_CHARS} characters`)
  }
  return tools
}

async function readBoundedFile(path: string) {
  const handle = await fs.open(path, "r")
  const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1)
  let offset = 0
  try {
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset)
  } finally {
    await handle.close()
  }
}

function parseConfig(raw: string | Buffer, path: string): PolicyConfig {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8")
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error(`${path} exceeds ${MAX_CONFIG_BYTES} bytes`)

  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
  if (!isObject(value) || !hasOnlyKeys(value, CONFIG_KEYS)) throw new Error(`${path} has an invalid schema`)
  if (value.version !== 1) throw new Error(`${path} must use schema version 1`)
  if (!DECISIONS.has(value.defaultDecision as Decision)) throw new Error(`${path} has an invalid defaultDecision`)
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) throw new Error(`${path} rules must be an array with at most ${MAX_RULES} entries`)

  const timeout = value.timeout === undefined ? DEFAULT_TIMEOUT_MS : value.timeout
  if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > MAX_TIMEOUT_MS) {
    throw new Error(`${path} timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds`)
  }

  const rules = value.rules.map((candidate, index): PolicyRule => {
    if (!isObject(candidate) || !hasOnlyKeys(candidate, RULE_KEYS)) throw new Error(`${path} rule ${index} has an invalid schema`)
    if (!DECISIONS.has(candidate.decision as Decision)) throw new Error(`${path} rule ${index} has an invalid decision`)
    return {
      tools: toolArray(candidate.tools, `rule ${index} tools`),
      patterns: stringArray(candidate.patterns, `rule ${index} patterns`),
      decision: candidate.decision as Decision,
    }
  })

  return { version: 1, defaultDecision: value.defaultDecision as Decision, timeout: timeout as number, rules }
}

function globRegex(pattern: string): RegExp {
  let expression = "^"
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === "*") {
      if (pattern[index + 1] === "*") index++
      expression += ".*"
    } else if (character === "?") {
      expression += "."
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    }
  }
  return new RegExp(`${expression}$`, "u")
}

function matches(pattern: string, value: string) {
  try {
    return globRegex(pattern).test(value)
  } catch {
    return false
  }
}

function collectStringTargets(value: unknown, targets: PolicyTarget[], depth = 0, path = false): boolean {
  if (depth > MAX_TARGET_DEPTH) return false
  if (typeof value === "string") {
    if (value.length === 0) return true
    if (value.length > MAX_TARGET_CHARS || targets.length >= MAX_GENERIC_TARGETS) return false
    targets.push({ value, path })
    return true
  }
  if (Array.isArray(value)) {
    return value.every((entry) => collectStringTargets(entry, targets, depth + 1, path))
  }
  if (isObject(value)) {
    return Object.entries(value).every(([key, entry]) => (
      collectStringTargets(entry, targets, depth + 1, path || /^(?:path|filePath|file_path|notebook_path|cwd|directory|dir|source|destination|dest)$/i.test(key))
    ))
  }
  return true
}

function rawTargets(toolName: string, input: Record<string, unknown>) {
  const targets: PolicyTarget[] = []
  let complete = true
  const configured = TOOL_INPUT_TARGETS[toolName]
  if (configured) {
    for (const key of configured) complete = collectStringTargets(input[key], targets, 0, FILE_TOOLS.has(toolName)) && complete
    if (toolName === "task" && Array.isArray(input.jobs)) {
      for (const job of input.jobs) {
        if (isObject(job)) complete = collectStringTargets(job.prompt, targets) && complete
      }
    }
  } else {
    // MCP and custom tools have arbitrary schemas, so all bounded string leaves
    // are policy targets rather than silently falling back to the tool name.
    complete = collectStringTargets(input, targets)
  }
  const unique = new Map<string, PolicyTarget>()
  for (const target of targets) {
    const existing = unique.get(target.value)
    if (!existing || (!existing.path && target.path)) unique.set(target.value, target)
  }
  return { targets: [...unique.values()], complete }
}

function looksLikePath(target: string) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(target)) return false
  return target.startsWith("/") || target.startsWith(".") || target.startsWith("~") || target.includes("/") || target.includes("\\")
}

function expandPath(path: string, cwd: string, home: string) {
  if (path === "~") return home
  if (path.startsWith("~/")) return resolve(home, path.slice(2))
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

async function canonicalPath(rawPath: string, cwd: string, home: string, realpath: (path: string) => Promise<string>) {
  const lexical = expandPath(rawPath, cwd, home).replaceAll("\\", "/")
  let probe = lexical
  const missing: string[] = []

  while (true) {
    try {
      const existing = (await realpath(probe)).replaceAll("\\", "/")
      const canonical = resolve(existing, ...missing.reverse()).replaceAll("\\", "/")
      return { lexical, canonical, alias: canonical !== lexical, resolved: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== "ENOENT" && code !== "ENOTDIR") return { lexical, canonical: lexical, alias: false, resolved: false }
      const parent = dirname(probe)
      if (parent === probe) return { lexical, canonical: lexical, alias: false, resolved: false }
      missing.push(basename(probe))
      probe = parent
    }
  }
}

function isWithin(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`)
}

function isSensitivePath(path: string, writing: boolean) {
  const normalized = path.toLowerCase().replaceAll("\\", "/")
  const name = basename(normalized)
  if (!writing && name.endsWith(".pub")) return false
  if (/\.env\.(?:example|sample|template)$/.test(name)) return false

  const sensitiveDirectories = [
    "/.ssh/", "/.gnupg/", "/.aws/", "/.azure/", "/.kube/", "/.docker/",
    "/.config/gcloud/", "/.local/share/keyrings/", "/.password-store/", "/secrets/",
  ]
  if (sensitiveDirectories.some((segment) => normalized.includes(segment))) return true
  if (["/.ssh", "/.gnupg", "/.aws", "/.azure", "/.kube", "/.docker", "/secrets"].some((suffix) => normalized.endsWith(suffix))) return true
  if (/\/(?:proc\/[^/]+\/environ|etc\/(?:shadow|gshadow|sudoers))$/.test(normalized)) return true
  if (/\/\.git\/(?:config|credentials)$/.test(normalized)) return true
  if (/\/\.pi\/(?:auth|credentials)\.json$/.test(normalized)) return true
  if ([".env", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials.json", "auth.json"].includes(name)) return true
  if (name.startsWith(".env.")) return true
  if (/^(?:id_rsa|id_ed25519|id_ecdsa)(?:\.|$)/.test(name)) return true
  if (/\.(?:pem|key|p12|pfx|gpg)$/.test(name)) return true
  if (/^(?:secret|secrets|credentials?|service-account|gcp-key)(?:[._-].*)?\.ya?ml$/.test(name)) return true
  if (/^(?:service-account|gcp-key)(?:[._-].*)?\.json$/.test(name)) return true
  return false
}

function managedPaths(configPath: string) {
  return [
    "/etc/agentbox",
    "/etc/pi",
    "/home/agent/.pi/agent/extensions",
    SIGNAL_PATH,
    "/home/agent/.local/bin/agent-archive-request.sh",
    "/home/agent/.local/bin/shared-test-runner.ts",
    "/home/agent/.local/bin/dd-gitleaks-precommit.sh",
    resolve(configPath),
  ]
}

function isManagedWrite(path: string, configPath: string) {
  return isWithin(path, "/nix/store") || managedPaths(configPath).some((managed) => isWithin(path, managed))
}

function shellTokens(command: string) {
  return (command.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|<>]+/g) ?? [])
    .map((token) => token.replace(/^['"]|['"]$/g, "").replace(/[),]+$/g, ""))
}

function commandInspectionVariants(command: string) {
  const variants = [command]
  const seen = new Set(variants)

  for (let index = 0; index < variants.length && variants.length < 16; index++) {
    const tokens = shellTokens(variants[index])
    for (let tokenIndex = 0; tokenIndex < tokens.length - 1; tokenIndex++) {
      const interpreter = basename(tokens[tokenIndex]).toLowerCase()
      const shell = /^(?:ba|da|a|z|k|fi)?sh$/.test(interpreter)
      const code = /^(?:python(?:\d+(?:\.\d+)?)?|node|ruby|perl|php)$/.test(interpreter)
      if (!shell && !code) continue

      for (let argumentIndex = tokenIndex + 1; argumentIndex < Math.min(tokens.length - 1, tokenIndex + 4); argumentIndex++) {
        const argument = tokens[argumentIndex]
        const executesText = shell ? /^-[^-]*c/.test(argument) : /^(?:-c|-e|--eval)$/.test(argument)
        if (!executesText) continue

        const payload = tokens[argumentIndex + 1]
        if (payload && !seen.has(payload)) {
          seen.add(payload)
          variants.push(payload)
        }
        if (code && payload) {
          const normalizedCode = payload.replace(/[^A-Za-z0-9_./~*=$+\-]+/g, " ")
          if (normalizedCode && !seen.has(normalizedCode)) {
            seen.add(normalizedCode)
            variants.push(normalizedCode)
          }
        }
        break
      }
    }
  }

  return variants
}

function shellPathTokens(command: string) {
  const paths: string[] = []
  for (const token of shellTokens(command)) {
    const value = /^(?:of|if|target|dest|destination)=(.+)$/.exec(token)?.[1] ?? token
    if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~") || value.startsWith(".")) {
      paths.push(value)
    }
  }
  return paths
}

function shellWrites(command: string) {
  return /(?:^|[;&|\s])(?:rm|rmdir|mv|cp|install|ln|touch|truncate|tee|dd|chmod|chown|chgrp|setfacl)(?:\s|$)|(?:^|[;&|\s])(?:sed|perl)\s+[^;&|]*-[^;&|\s]*i|(?:^|[^<])>{1,2}(?!>)/i.test(command)
}

function removesFilesystemRoot(command: string) {
  return command.split(/[;&|]+/).some((segment) => {
    const tokens = shellTokens(segment)
    const commandIndex = tokens.findIndex((token) => basename(token) === "rm")
    if (commandIndex < 0) return false
    const arguments_ = tokens.slice(commandIndex + 1)
    const recursive = arguments_.some((argument) => argument === "--recursive" || /^-[^-]*r/.test(argument))
    const forced = arguments_.some((argument) => argument === "--force" || /^-[^-]*f/.test(argument))
    const root = arguments_.some((argument) => /^\/+\*?$/.test(argument) || /^\/+\.$/.test(argument))
    return recursive && forced && root
  })
}

function immutableCommandReason(command: string) {
  for (const variant of commandInspectionVariants(command)) {
    const normalized = variant.replace(/\s+/g, " ").trim()
    if (/(?:^|[;&|\s])(?:\/[^\s;&|]+\/)?sudo(?:\s|$)/.test(normalized)) return "sudo commands are prohibited"
    if (/(?:^|[;&|\s])(?:\/[^\s;&|]+\/)?su(?:\s|$)/.test(normalized)) return "su commands are prohibited"
    if (/(?:^|[;&|\s])(?:doas|pkexec|nsenter|unshare|chroot)(?:\s|$)/.test(normalized)) return "privilege escalation commands are prohibited"
    if (/(?:^|\s)--privileged(?:=true)?(?:\s|$)|(?:^|\s)--cap-add(?:=|\s+)ALL(?:\s|$)|(?:^|\s)--device(?:=|\s+)\/dev\//i.test(normalized)) return "privileged container commands are prohibited"
    if (/(?:^|\s)(?:-v|--volume)(?:=|\s+)\/(?:\*?)?:[^\s]+/.test(normalized)) return "host-root container mounts are prohibited"
    if (removesFilesystemRoot(normalized)) return "destructive root removal is prohibited"
    if (/(?:^|[;&|])\s*find\s+\/(?:\s|$)[^;&|]*\s-delete(?:\s|$)/.test(normalized)) return "destructive root traversal is prohibited"
    if (/(?:^|[;&|\s])(?:mkfs(?:\.[a-z0-9]+)?|wipefs)(?:\s|$)/i.test(normalized)) return "filesystem-destructive commands are prohibited"
    if (/(?:^|[;&|\s])dd(?:\s|$)[^;&|]*\bof=\/dev\//.test(normalized)) return "raw device writes are prohibited"
  }
  return undefined
}

async function immutableReason(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  configPath: string,
  home: string,
  realpath: (path: string) => Promise<string>,
) {
  const extracted = rawTargets(toolName, input)
  if (!extracted.complete) return "Pi policy cannot safely inspect this tool input within its target limits"
  const targets = extracted.targets
  const isWrite = WRITE_TOOLS.has(toolName)
  const pathTargets = FILE_TOOLS.has(toolName)
    ? targets
    : targets.filter((target) => target.path || looksLikePath(target.value))

  if (pathTargets.length > 0) {
    for (const target of pathTargets) {
      const path = await canonicalPath(target.value, cwd, home, realpath)
      if (!path.resolved) return "Pi policy cannot safely canonicalize a file target"
      if (isSensitivePath(path.lexical, isWrite) || isSensitivePath(path.canonical, isWrite)) return "Pi policy blocks access to a sensitive path"
      if (isWrite && (isManagedWrite(path.lexical, configPath) || isManagedWrite(path.canonical, configPath))) {
        return "Pi policy blocks writes to Nix-store or managed paths"
      }
    }
  }

  if (toolName !== "bash") return undefined
  const command = typeof input.command === "string" ? input.command : ""
  const dangerous = immutableCommandReason(command)
  if (dangerous) return dangerous

  const variants = commandInspectionVariants(command)
  const writing = variants.some(shellWrites)
  for (const target of [...new Set(variants.flatMap(shellPathTokens))]) {
    const path = await canonicalPath(target, cwd, home, realpath)
    if (!path.resolved) return "Pi policy cannot safely canonicalize a shell file target"
    if (isSensitivePath(path.lexical, writing) || isSensitivePath(path.canonical, writing)) return "Pi policy blocks shell access to a sensitive path"
    if (writing && (isManagedWrite(path.lexical, configPath) || isManagedWrite(path.canonical, configPath))) {
      return "Pi policy blocks shell writes to Nix-store or managed paths"
    }
  }
  return undefined
}

async function matchTargetGroups(toolName: string, input: Record<string, unknown>, cwd: string, home: string, realpath: (path: string) => Promise<string>) {
  const targets = rawTargets(toolName, input).targets
  if (targets.length === 0) return [["(no target)"]]
  const fileTool = FILE_TOOLS.has(toolName)
  const genericTool = TOOL_INPUT_TARGETS[toolName] === undefined

  const groups: string[][] = []
  for (const target of targets) {
    if (!fileTool && (!genericTool || (!target.path && !looksLikePath(target.value)))) {
      groups.push([target.value])
      continue
    }
    const path = await canonicalPath(target.value, cwd, home, realpath)
    if (!path.resolved) return undefined
    const values = path.alias
      ? [path.canonical]
      : [target.value.replaceAll("\\", "/"), path.lexical, path.canonical]
    groups.push([...new Set(values)])
  }
  return groups
}

function targetDecision(config: PolicyConfig, toolName: string, targets: string[]) {
  let decision = config.defaultDecision
  for (const rule of config.rules) {
    if (!rule.tools.some((tool) => matches(tool, toolName))) continue
    if (!rule.patterns.some((pattern) => targets.some((target) => matches(pattern, target)))) continue
    if (rule.decision === "deny") return "deny" as const
    decision = rule.decision
  }
  return decision
}

function managedDecision(config: PolicyConfig, toolName: string, targetGroups: string[][]) {
  const decisions = targetGroups.map((targets) => targetDecision(config, toolName, targets))
  if (decisions.includes("deny")) return "deny"
  if (decisions.includes("ask")) return "ask"
  return "allow"
}

function boundedDisplay(toolName: string, targets: string[]) {
  const target = (targets[0] ?? "(no target)").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  const display = `${toolName}: ${target}`
  return display.length <= MAX_DISPLAY_CHARS ? display : `${display.slice(0, MAX_DISPLAY_CHARS - 3)}...`
}

function defaultSignal(state: "waiting" | "working") {
  return new Promise<void>((resolveSignal) => {
    nodeExecFile("bash", [SIGNAL_PATH, state], {
      env: { ...process.env, AGENT_NAME: "Pi", AGENT_TITLE: "Permission approval" },
      timeout: 5_000,
    }, () => resolveSignal())
  })
}

async function selectWithTimeout(ctx: any, title: string, timeout: number) {
  const controller = new AbortController()
  const signals = ctx.signal ? [ctx.signal, controller.signal] : [controller.signal]
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<undefined>((resolveTimeout) => {
    timer = setTimeout(() => {
      controller.abort()
      resolveTimeout(undefined)
    }, timeout)
  })
  try {
    return await Promise.race([
      ctx.ui.select(title, ["Allow once", "Deny"], { signal }),
      expired,
    ])
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createPiPolicyExtension(dependencies: PiPolicyDependencies = {}) {
  const readFile = dependencies.readFile ?? readBoundedFile
  const realpath = dependencies.realpath ?? ((path: string) => fs.realpath(path))
  const signal = dependencies.signal ?? defaultSignal
  const env = dependencies.env ?? process.env

  return function piPolicy(pi: ExtensionAPI) {
    pi.on("tool_call", async (event, ctx) => {
      const input = event.input as Record<string, unknown>
      const configPath = env.PI_POLICY_CONFIG || DEFAULT_CONFIG_PATH
      const home = env.HOME || process.env.HOME || "/home/agent"

      const immutable = await immutableReason(event.toolName, input, ctx.cwd, configPath, home, realpath)
      if (immutable) return { block: true, reason: immutable }

      let config: PolicyConfig
      try {
        config = parseConfig(await readFile(configPath), configPath)
      } catch {
        return { block: true, reason: "Pi managed policy is missing or invalid; failing closed" }
      }

      const targetGroups = await matchTargetGroups(event.toolName, input, ctx.cwd, home, realpath)
      if (!targetGroups) return { block: true, reason: "Pi policy cannot safely canonicalize a policy target" }
      const targets = targetGroups.flat()
      const decision = managedDecision(config, event.toolName, targetGroups)
      if (decision === "allow") return
      if (decision === "deny") return { block: true, reason: "Denied by managed Pi policy" }
      if (!ctx.hasUI) return { block: true, reason: "Managed Pi policy requires approval, but no UI is available" }

      try {
        await Promise.resolve(signal("waiting")).catch(() => undefined)
        const selected = await selectWithTimeout(ctx, `Approve tool call? ${boundedDisplay(event.toolName, targets)}`, config.timeout)
        if (selected === "Allow once") return
        return { block: true, reason: "Managed Pi policy approval was denied, cancelled, or timed out" }
      } finally {
        await Promise.resolve(signal("working")).catch(() => undefined)
      }
    })
  }
}

export default createPiPolicyExtension()
