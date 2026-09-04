import { createHash } from "node:crypto"
import { promises as dns } from "node:dns"
import { promises as fs } from "node:fs"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { BlockList, isIP } from "node:net"
import { Readable } from "node:stream"

export const DEFAULT_CONFIG_PATH = "/etc/agentbox/pi-runtime.json"

const MAX_CONFIG_BYTES = 1024 * 1024
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_CALL_TIMEOUT_MS = 60_000
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const DEFAULT_MAX_TOOLS_PER_SERVER = 128
const MAX_LIST_PAGES = 100
const MAX_LIST_PAGE_BYTES = 1024 * 1024
const MAX_ACCUMULATED_TOOL_BYTES = 4 * 1024 * 1024
const MAX_DISCOVERED_TOOL_NAMES = 4_096
const MAX_TOOL_SCHEMA_BYTES = 256 * 1024
const MAX_TOOL_NAME_BYTES = 256
const MAX_TOOL_DESCRIPTION_BYTES = 4_000
const MAX_TOOL_TITLE_BYTES = 500
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const APPROVAL_POLICIES = new Set(["never", "always", "destructive"])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const METADATA_HOSTNAMES = new Set([
  "instance-data",
  "metadata",
  "metadata.aws.internal",
  "metadata.google.internal",
])

const blockedAddresses = new BlockList()
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
]) blockedAddresses.addSubnet(address, prefix, family)
blockedAddresses.addAddress("168.63.129.16", "ipv4")

const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4")
loopbackAddresses.addAddress("::1", "ipv6")

class ProtocolViolationError extends Error {
  constructor(message) {
    super(message)
    this.name = "ProtocolViolationError"
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertOnlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`)
  }
}

function positiveInteger(value, fallback, path, maximum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${path} must be an integer from 1 to ${maximum}`)
  }
  return value
}

function outputByteLimit(value, fallback, path) {
  const result = positiveInteger(value, fallback, path, 1024 * 1024)
  if (result < 1024) throw new Error(`${path} must be at least 1024`)
  return result
}

function responseByteLimit(value, fallback, path) {
  const result = positiveInteger(value, fallback, path, 16 * 1024 * 1024)
  if (result < 1024) throw new Error(`${path} must be at least 1024`)
  return result
}

function stringArray(value, fallback, path, maximum = 256) {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || item.length === 0 || Buffer.byteLength(item, "utf8") > 256)) {
    throw new Error(`${path} must be an array of at most ${maximum} non-empty strings`)
  }
  return [...value]
}

function parseDefaults(value) {
  if (value === undefined) value = {}
  if (!isObject(value)) throw new Error("defaults must be an object")
  assertOnlyKeys(value, new Set([
    "connectTimeoutMs",
    "callTimeoutMs",
    "closeTimeoutMs",
    "maxOutputBytes",
    "maxResponseBytes",
    "maxToolsPerServer",
  ]), "defaults")
  return {
    connectTimeoutMs: positiveInteger(value.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "defaults.connectTimeoutMs", 300_000),
    callTimeoutMs: positiveInteger(value.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS, "defaults.callTimeoutMs", 3_600_000),
    closeTimeoutMs: positiveInteger(value.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, "defaults.closeTimeoutMs", 60_000),
    maxOutputBytes: outputByteLimit(value.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "defaults.maxOutputBytes"),
    maxResponseBytes: responseByteLimit(value.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "defaults.maxResponseBytes"),
    maxToolsPerServer: positiveInteger(value.maxToolsPerServer, DEFAULT_MAX_TOOLS_PER_SERVER, "defaults.maxToolsPerServer", 1024),
  }
}

export function parseConfig(raw, path = DEFAULT_CONFIG_PATH) {
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error(`runtime config exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`)
  }

  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isObject(value)) throw new Error(`${path} must contain an object`)
  assertOnlyKeys(value, new Set(["version", "defaults", "servers", "piRpcApi"]), "config")
  if (value.version !== 1) throw new Error(`${path} version must be 1`)
  if (!isObject(value.servers)) throw new Error(`${path} must contain a servers object`)
  if (Object.keys(value.servers).length > 64) throw new Error(`${path} may define at most 64 servers`)

  return {
    defaults: parseDefaults(value.defaults),
    servers: Object.entries(value.servers),
  }
}

function parseEnvironmentReferences(value, path) {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${path} must be an object mapping destination names to environment variable names`)
  if (Object.keys(value).length > 128) throw new Error(`${path} may contain at most 128 entries`)
  const result = {}
  for (const [destination, source] of Object.entries(value)) {
    if (!ENV_NAME_RE.test(destination)) throw new Error(`${path} contains invalid destination variable ${destination}`)
    if (typeof source !== "string" || !ENV_NAME_RE.test(source)) {
      throw new Error(`${path}.${destination} must be an environment variable identifier`)
    }
    result[destination] = source
  }
  return result
}

function parseHeaderReferences(value, path) {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${path} must be an object mapping header names to environment variable names`)
  if (Object.keys(value).length > 64) throw new Error(`${path} may contain at most 64 entries`)
  const result = {}
  for (const [header, source] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) throw new Error(`${path} contains invalid header name ${header}`)
    if (typeof source !== "string" || !ENV_NAME_RE.test(source)) {
      throw new Error(`${path}.${header} must be an environment variable identifier`)
    }
    result[header] = source
  }
  return result
}

function normalizedHostname(value) {
  const hostname = value.toLowerCase().replace(/\.$/, "")
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname
}

function addressFamily(address) {
  const family = isIP(address)
  return family === 4 ? "ipv4" : family === 6 ? "ipv6" : undefined
}

function mappedIpv4(address) {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return match?.[1]
}

function isLoopbackAddress(address) {
  const mapped = mappedIpv4(address)
  if (mapped) return loopbackAddresses.check(mapped, "ipv4")
  const family = addressFamily(address)
  return family ? loopbackAddresses.check(address, family) : false
}

function isBlockedAddress(address) {
  const mapped = mappedIpv4(address)
  if (mapped) return blockedAddresses.check(mapped, "ipv4")
  const family = addressFamily(address)
  return !family || blockedAddresses.check(address, family)
}

function isLoopbackHostname(hostname) {
  const normalized = normalizedHostname(hostname)
  return normalized === "localhost" || normalized.endsWith(".localhost") || isLoopbackAddress(normalized)
}

function assertConfiguredHttpUrl(url, allowInsecureLoopback, path) {
  if (url.username || url.password) throw new Error(`${path} must not contain credentials`)
  if (url.hash) throw new Error(`${path} must not contain a fragment`)
  const hostname = normalizedHostname(url.hostname)
  if (METADATA_HOSTNAMES.has(hostname)) throw new Error(`${path} must not target a metadata service`)

  if (url.protocol === "http:") {
    if (!allowInsecureLoopback || !isLoopbackHostname(hostname)) {
      throw new Error(`${path} must use HTTPS; plain HTTP requires allowInsecureLoopback and a loopback host`)
    }
  } else if (url.protocol !== "https:") {
    throw new Error(`${path} must use HTTPS`)
  }

  if (isIP(hostname) && isBlockedAddress(hostname) && !(allowInsecureLoopback && isLoopbackAddress(hostname))) {
    throw new Error(`${path} must not target a private, link-local, reserved, or metadata address`)
  }
}

function parsePolicy(value, path) {
  if (value === undefined) value = {}
  if (!isObject(value)) throw new Error(`${path} must be an object`)
  assertOnlyKeys(value, new Set(["allow", "deny", "approval"]), path)
  const approval = value.approval ?? "destructive"
  if (!APPROVAL_POLICIES.has(approval)) throw new Error(`${path}.approval must be never, always, or destructive`)
  return {
    allow: stringArray(value.allow, ["*"], `${path}.allow`),
    deny: stringArray(value.deny, [], `${path}.deny`),
    approval,
  }
}

export function parseServer(name, value, defaults) {
  if (!SERVER_NAME_RE.test(name)) throw new Error(`invalid server name: ${name}`)
  if (!isObject(value)) throw new Error(`servers.${name} must be an object`)
  assertOnlyKeys(value, new Set([
    "disabled",
    "transport",
    "policy",
    "connectTimeoutMs",
    "callTimeoutMs",
    "closeTimeoutMs",
    "maxOutputBytes",
    "maxResponseBytes",
    "maxTools",
  ]), `servers.${name}`)
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") throw new Error(`servers.${name}.disabled must be boolean`)
  if (!isObject(value.transport)) throw new Error(`servers.${name}.transport must be an object`)

  const transportPath = `servers.${name}.transport`
  let transport
  if (value.transport.type === "stdio") {
    assertOnlyKeys(value.transport, new Set(["type", "command", "args", "cwd", "env"]), transportPath)
    if (typeof value.transport.command !== "string" || value.transport.command.length === 0) throw new Error(`${transportPath}.command must be a non-empty string`)
    if (value.transport.cwd !== undefined && (typeof value.transport.cwd !== "string" || value.transport.cwd.length === 0)) throw new Error(`${transportPath}.cwd must be a non-empty string`)
    transport = {
      type: "stdio",
      command: value.transport.command,
      args: stringArray(value.transport.args, [], `${transportPath}.args`, 256),
      cwd: value.transport.cwd,
      env: parseEnvironmentReferences(value.transport.env, `${transportPath}.env`),
    }
  } else if (value.transport.type === "http") {
    assertOnlyKeys(value.transport, new Set(["type", "url", "headers", "allowInsecureLoopback"]), transportPath)
    if (value.transport.allowInsecureLoopback !== undefined && typeof value.transport.allowInsecureLoopback !== "boolean") {
      throw new Error(`${transportPath}.allowInsecureLoopback must be boolean`)
    }
    let url
    try {
      url = new URL(value.transport.url)
    } catch {
      throw new Error(`${transportPath}.url must be a valid URL`)
    }
    const allowInsecureLoopback = value.transport.allowInsecureLoopback === true
    assertConfiguredHttpUrl(url, allowInsecureLoopback, `${transportPath}.url`)
    transport = {
      type: "http",
      url,
      headers: parseHeaderReferences(value.transport.headers, `${transportPath}.headers`),
      allowInsecureLoopback,
    }
  } else {
    throw new Error(`${transportPath}.type must be stdio or http`)
  }

  return {
    name,
    disabled: value.disabled === true,
    transport,
    policy: parsePolicy(value.policy, `servers.${name}.policy`),
    connectTimeoutMs: positiveInteger(value.connectTimeoutMs, defaults.connectTimeoutMs, `servers.${name}.connectTimeoutMs`, 300_000),
    callTimeoutMs: positiveInteger(value.callTimeoutMs, defaults.callTimeoutMs, `servers.${name}.callTimeoutMs`, 3_600_000),
    closeTimeoutMs: positiveInteger(value.closeTimeoutMs, defaults.closeTimeoutMs, `servers.${name}.closeTimeoutMs`, 60_000),
    maxOutputBytes: outputByteLimit(value.maxOutputBytes, defaults.maxOutputBytes, `servers.${name}.maxOutputBytes`),
    maxResponseBytes: responseByteLimit(value.maxResponseBytes, defaults.maxResponseBytes, `servers.${name}.maxResponseBytes`),
    maxTools: positiveInteger(value.maxTools, defaults.maxToolsPerServer, `servers.${name}.maxTools`, 1024),
  }
}

function resolveReferences(references, environment, path) {
  const resolved = {}
  for (const [destination, source] of Object.entries(references)) {
    const value = environment[source]
    if (typeof value !== "string" || value.length === 0) throw new Error(`${path} requires environment variable ${source}`)
    resolved[destination] = value
  }
  return resolved
}

function formatError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length <= 2_000 ? message : `${message.slice(0, 2_000)} [truncated]`
}

function jsonFitsWithin(value, maximum) {
  let remaining = maximum
  const seen = new Set()
  const stack = [value]
  const consume = (bytes) => {
    remaining -= bytes
    return remaining >= 0
  }

  while (stack.length > 0) {
    const current = stack.pop()
    if (current === null || typeof current === "boolean") {
      if (!consume(5)) return false
    } else if (typeof current === "number") {
      if (!consume(32)) return false
    } else if (typeof current === "string") {
      if (!consume(Buffer.byteLength(current, "utf8") + 2)) return false
    } else if (Array.isArray(current)) {
      if (seen.has(current)) return false
      seen.add(current)
      if (!consume(current.length + 2)) return false
      for (const item of current) stack.push(item)
    } else if (isObject(current)) {
      if (seen.has(current)) return false
      seen.add(current)
      const entries = Object.entries(current)
      if (!consume(entries.length + 2)) return false
      for (const [key, item] of entries) {
        if (!consume(Buffer.byteLength(key, "utf8") + 3)) return false
        stack.push(item)
      }
    } else if (!consume(4)) {
      return false
    }
  }
  return true
}

function knownBodyBytes(body) {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8")
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString(), "utf8")
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size
  return undefined
}

function limitResponse(response, maximum) {
  const declared = response.headers.get("content-length")
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximum) {
    response.body?.cancel().catch(() => {})
    throw new ProtocolViolationError(`HTTP response exceeds ${maximum} bytes`)
  }
  if (!response.body) return response

  let received = 0
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength
      if (received > maximum) {
        controller.error(new ProtocolViolationError(`HTTP response exceeds ${maximum} bytes`))
        return
      }
      controller.enqueue(chunk)
    },
  }))
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function createSecureFetch({ baseUrl, allowInsecureLoopback, maxResponseBytes, fetch: fetchImpl, lookup = dns.lookup }) {
  const resolveSafeHostname = async (hostname) => {
    const normalized = normalizedHostname(hostname)
    const literalFamily = addressFamily(normalized)
    const addresses = literalFamily
      ? [{ address: normalized, family: literalFamily === "ipv4" ? 4 : 6 }]
      : await lookup(normalized, { all: true, verbatim: true })
    if (!Array.isArray(addresses) || addresses.length === 0) throw new Error(`HTTP MCP target ${normalized} resolved to no addresses`)
    const mayUseLoopback = allowInsecureLoopback && isLoopbackHostname(normalized)
    for (const result of addresses) {
      if (typeof result?.address !== "string") throw new Error(`HTTP MCP target ${normalized} returned an invalid DNS result`)
      if (isBlockedAddress(result.address) && !(mayUseLoopback && isLoopbackAddress(result.address))) {
        throw new Error(`HTTP MCP target ${normalized} resolves to a private, link-local, reserved, or metadata address`)
      }
    }
    return addresses
  }

  const assertSafeTarget = async (url) => {
    assertConfiguredHttpUrl(url, allowInsecureLoopback, "HTTP MCP target")
    await resolveSafeHostname(url.hostname)
  }

  const secureLookup = (hostname, options, callback) => {
    resolveSafeHostname(hostname).then((addresses) => {
      const requestedFamily = typeof options === "object" ? options.family : options
      const eligible = requestedFamily ? addresses.filter((result) => result.family === requestedFamily) : addresses
      if (eligible.length === 0) {
        callback(new Error(`HTTP MCP target ${hostname} has no address for IPv${requestedFamily}`))
      } else if (typeof options === "object" && options.all) {
        callback(null, eligible)
      } else {
        callback(null, eligible[0].address, eligible[0].family)
      }
    }, callback)
  }

  const networkFetch = (url, init) => new Promise((resolve, reject) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: init.method,
      headers,
      signal: init.signal,
      lookup: secureLookup,
    }, (response) => {
      const responseHeaders = new Headers()
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1])
      }
      const status = response.statusCode ?? 500
      const hasBody = init.method?.toUpperCase() !== "HEAD" && ![204, 205, 304].includes(status)
      resolve(new Response(hasBody ? Readable.toWeb(response) : null, {
        status,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }))
    })
    request.on("error", reject)
    if (init.body === undefined || init.body === null) request.end()
    else if (typeof init.body === "string" || init.body instanceof Uint8Array) request.end(init.body)
    else if (init.body instanceof ArrayBuffer) request.end(new Uint8Array(init.body))
    else if (init.body instanceof URLSearchParams) request.end(init.body.toString())
    else request.destroy(new ProtocolViolationError("unsupported streaming HTTP request body"))
  })

  return async (input, initial = {}) => {
    let url = new URL(input instanceof Request ? input.url : input, baseUrl)
    let init = { ...initial }
    const originalOrigin = new URL(baseUrl).origin

    for (let redirects = 0; redirects <= 5; redirects++) {
      if (url.origin !== originalOrigin) throw new Error("HTTP MCP cross-origin redirects are not allowed")
      await assertSafeTarget(url)
      const bodyBytes = knownBodyBytes(init.body)
      if (bodyBytes !== undefined && bodyBytes > maxResponseBytes) {
        throw new ProtocolViolationError(`HTTP request body exceeds ${maxResponseBytes} bytes`)
      }
      const response = await (fetchImpl ?? networkFetch)(url, { ...init, redirect: "manual" })
      if (!REDIRECT_STATUSES.has(response.status)) return limitResponse(response, maxResponseBytes)

      const location = response.headers.get("location")
      await response.body?.cancel()
      if (!location) throw new Error("HTTP MCP redirect did not include a Location header")
      if (redirects === 5) throw new Error("HTTP MCP redirect limit exceeded")
      const next = new URL(location, url)
      if (next.origin !== originalOrigin) throw new Error("HTTP MCP cross-origin redirects are not allowed")
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && init.method?.toUpperCase() === "POST")) {
        const headers = new Headers(init.headers)
        headers.delete("content-length")
        headers.delete("content-type")
        init = { ...init, method: "GET", body: undefined, headers }
      }
      url = next
    }
    throw new Error("HTTP MCP redirect limit exceeded")
  }
}

function abortError(signal, fallback) {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error(fallback)
  error.name = "AbortError"
  return error
}

async function withDeadline(operation, timeoutMs, parentSignal, label) {
  if (parentSignal?.aborted) throw abortError(parentSignal, `${label} cancelled`)
  const controller = new AbortController()
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal
  let rejectAbort
  const aborted = new Promise((_, reject) => {
    rejectAbort = () => reject(abortError(signal, `${label} cancelled`))
    signal.addEventListener("abort", rejectAbort, { once: true })
  })
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([Promise.resolve().then(() => operation(signal)), aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", rejectAbort)
  }
}

function globMatches(pattern, value) {
  let expression = "^"
  for (const character of pattern) {
    if (character === "*") expression += ".*"
    else if (character === "?") expression += "."
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
  }
  return new RegExp(`${expression}$`, "u").test(value)
}

export function toolAllowed(policy, name) {
  return policy.allow.some((pattern) => globMatches(pattern, name))
    && !policy.deny.some((pattern) => globMatches(pattern, name))
}

function requiresApproval(policy, tool) {
  return policy.approval === "always"
    || (policy.approval === "destructive" && tool.annotations?.destructiveHint !== false)
}

function toolNameSegment(value) {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_") || "unnamed"
  return sanitized
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10)
}

function candidateToolName(server, tool) {
  const value = `mcp__${toolNameSegment(server)}__${toolNameSegment(tool)}`
  if (value.length <= 128) return value
  return `${value.slice(0, 115)}__${shortHash(`${server}\0${tool}`)}`
}

function assignToolNames(discovered) {
  const counts = new Map()
  for (const item of discovered) counts.set(item.candidate, (counts.get(item.candidate) ?? 0) + 1)
  return discovered.map((item) => {
    if (counts.get(item.candidate) === 1) return { ...item, registeredName: item.candidate }
    const suffix = `__${shortHash(`${item.server.name}\0${item.tool.name}`)}`
    return { ...item, registeredName: `${item.candidate.slice(0, 128 - suffix.length)}${suffix}` }
  })
}

function truncateUtf8(text, maximum) {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maximum) return { text, truncated: false }
  const marker = Buffer.from("\n\n[output truncated]", "utf8")
  if (maximum <= marker.length) {
    let body = bytes.subarray(0, maximum).toString("utf8")
    if (body.endsWith("\uFFFD")) body = body.slice(0, -1)
    return { text: body, truncated: true }
  }
  const end = Math.max(0, maximum - marker.length)
  let body = bytes.subarray(0, end).toString("utf8")
  if (body.endsWith("\uFFFD")) body = body.slice(0, -1)
  return { text: `${body}${marker}`, truncated: true }
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return "[unserializable MCP value]"
  }
}

export function formatToolResult(result, maximum) {
  const parts = []
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (part?.type === "text" && typeof part.text === "string") parts.push(part.text)
      else if (part?.type === "resource" && typeof part.resource?.text === "string") parts.push(part.resource.text)
      else if (part?.type === "resource_link") parts.push(`[resource: ${part.name ?? "unnamed"} ${part.uri ?? ""}]`)
      else if (part?.type === "image" || part?.type === "audio") parts.push(`[${part.type} omitted${part.mimeType ? `: ${part.mimeType}` : ""}]`)
      else if (part?.type === "resource" && typeof part.resource?.blob === "string") parts.push(`[binary resource omitted${part.resource.mimeType ? `: ${part.resource.mimeType}` : ""}]`)
      else parts.push(safeJson(part))
    }
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) parts.push(safeJson(result.structuredContent))
  if (parts.length === 0 && result?.toolResult !== undefined) parts.push(safeJson(result.toolResult))
  if (parts.length === 0) parts.push("(MCP tool returned no content.)")
  return truncateUtf8(parts.join("\n\n"), maximum)
}

function textResult(text, details, isError = false) {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) }
}

async function defaultLoadSdk() {
  const [{ Client }, { StdioClientTransport, getDefaultEnvironment }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ])
  return { Client, StdioClientTransport, StreamableHTTPClientTransport, getDefaultEnvironment }
}

async function defaultRequestApproval({ context, server, tool, signal }) {
  if (!context?.hasUI || typeof context.ui?.confirm !== "function") return false
  try {
    return await context.ui.confirm(
      `Approve MCP tool: ${server}/${tool.name}`,
      typeof tool.description === "string"
        ? tool.description.slice(0, 4_000)
        : "This MCP tool requires approval before it can run.",
      { signal },
    ) === true
  } catch {
    return false
  }
}

export function createPiMcpExtension(dependencies = {}) {
  const readFile = dependencies.readFile ?? ((path, encoding) => fs.readFile(path, encoding))
  const environment = dependencies.env ?? process.env
  const loadSdk = dependencies.loadSdk ?? defaultLoadSdk
  const requestApproval = dependencies.requestApproval ?? defaultRequestApproval
  const log = dependencies.log ?? ((message) => console.error(`[pi-mcp] ${message}`))
  const fetchImpl = dependencies.fetch
  const lookup = dependencies.lookup ?? dns.lookup

  return function piMcp(pi) {
    const connections = new Map()
    const closingClients = new WeakMap()
    const lifecycleController = new AbortController()
    let initialized = false
    let shuttingDown = false

    const closeClient = async (name, client, timeoutMs) => {
      const existing = closingClients.get(client)
      if (existing) return existing
      const pending = (async () => {
        try {
          await withDeadline(() => client.close(), timeoutMs, undefined, `closing MCP server ${name}`)
        } catch (error) {
          log(`failed to close server ${name}: ${formatError(error)}`)
        } finally {
          if (connections.get(name)?.client === client) connections.delete(name)
        }
      })()
      closingClients.set(client, pending)
      return pending
    }

    const connectServer = async (server, sdk) => {
      let client
      try {
        let transport
        if (server.transport.type === "stdio") {
          const referenced = resolveReferences(server.transport.env, environment, `server ${server.name}`)
          transport = new sdk.StdioClientTransport({
            command: server.transport.command,
            args: server.transport.args,
            cwd: server.transport.cwd,
            env: { ...sdk.getDefaultEnvironment(), ...referenced },
            stderr: "ignore",
            maxBufferSize: server.maxResponseBytes,
          })
        } else {
          const headers = resolveReferences(server.transport.headers, environment, `server ${server.name}`)
          transport = new sdk.StreamableHTTPClientTransport(server.transport.url, {
            requestInit: { headers },
            fetch: createSecureFetch({
              baseUrl: server.transport.url,
              allowInsecureLoopback: server.transport.allowInsecureLoopback,
              maxResponseBytes: server.maxResponseBytes,
              fetch: fetchImpl,
              lookup,
            }),
            reconnectionOptions: {
              initialReconnectionDelay: 1_000,
              maxReconnectionDelay: 30_000,
              reconnectionDelayGrowFactor: 1.5,
              maxRetries: 0,
            },
          })
        }

        client = new sdk.Client({ name: "pi-agentbox-mcp-runtime", version: "1.0.0" }, { capabilities: {} })
        await withDeadline(
          (signal) => client.connect(transport, { signal, timeout: server.connectTimeoutMs }),
          server.connectTimeoutMs,
          undefined,
          `connecting MCP server ${server.name}`,
        )
        if (shuttingDown) {
          await closeClient(server.name, client, server.closeTimeoutMs)
          return undefined
        }
        connections.set(server.name, { client, closeTimeoutMs: server.closeTimeoutMs })
        client.onclose = () => {
          if (connections.get(server.name)?.client === client) connections.delete(server.name)
        }
        client.onerror = (error) => {
          log(`server ${server.name} protocol error: ${formatError(error)}`)
          void closeClient(server.name, client, server.closeTimeoutMs)
        }

        const tools = []
        const seen = new Set()
        let accumulatedToolBytes = 0
        let cursor
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const response = await withDeadline(
            (signal) => client.listTools(cursor ? { cursor } : undefined, { signal, timeout: server.connectTimeoutMs }),
            server.connectTimeoutMs,
            undefined,
            `listing tools from MCP server ${server.name}`,
          )
          if (!Array.isArray(response?.tools)) throw new Error("tools/list returned no tools array")
          if (!jsonFitsWithin(response, MAX_LIST_PAGE_BYTES)) {
            throw new ProtocolViolationError(`tools/list page exceeds ${MAX_LIST_PAGE_BYTES} serialized bytes`)
          }
          for (const tool of response.tools) {
            if (!tool || typeof tool.name !== "string" || !isObject(tool.inputSchema)) continue
            if (Buffer.byteLength(tool.name, "utf8") > MAX_TOOL_NAME_BYTES) {
              log(`tool from ${server.name} ignored because its name exceeds ${MAX_TOOL_NAME_BYTES} bytes`)
              continue
            }
            if (seen.has(tool.name)) continue
            if (seen.size >= MAX_DISCOVERED_TOOL_NAMES) {
              throw new ProtocolViolationError(`tools/list exposes more than ${MAX_DISCOVERED_TOOL_NAMES} distinct names`)
            }
            seen.add(tool.name)
            if (!toolAllowed(server.policy, tool.name)) continue
            if (!jsonFitsWithin(tool.inputSchema, MAX_TOOL_SCHEMA_BYTES)) {
              log(`tool ${server.name}/${tool.name} ignored because its input schema exceeds ${MAX_TOOL_SCHEMA_BYTES} bytes`)
              continue
            }
            if (tools.length >= server.maxTools) throw new ProtocolViolationError(`server exposes more than the configured ${server.maxTools} allowed tools`)
            const retained = {
              name: tool.name,
              inputSchema: tool.inputSchema,
              ...(typeof tool.description === "string" && tool.description.length > 0
                ? { description: truncateUtf8(tool.description, MAX_TOOL_DESCRIPTION_BYTES).text }
                : {}),
              ...(typeof tool.title === "string" && tool.title.length > 0
                ? { title: truncateUtf8(tool.title, MAX_TOOL_TITLE_BYTES).text }
                : {}),
              ...(typeof tool.annotations?.destructiveHint === "boolean"
                ? { annotations: { destructiveHint: tool.annotations.destructiveHint } }
                : {}),
            }
            accumulatedToolBytes += Buffer.byteLength(JSON.stringify(retained), "utf8")
            if (accumulatedToolBytes > MAX_ACCUMULATED_TOOL_BYTES) {
              throw new ProtocolViolationError(`accumulated tool metadata exceeds ${MAX_ACCUMULATED_TOOL_BYTES} bytes`)
            }
            tools.push(retained)
          }
          cursor = response.nextCursor
          if (cursor !== undefined && (typeof cursor !== "string" || Buffer.byteLength(cursor, "utf8") > 1_024)) {
            throw new ProtocolViolationError("tools/list returned an invalid or oversized cursor")
          }
          if (!cursor) return { server, client, tools }
        }
        throw new Error(`tools/list exceeded ${MAX_LIST_PAGES} pages`)
      } catch (error) {
        log(`server ${server.name} unavailable: ${formatError(error)}`)
        if (client) await closeClient(server.name, client, server.closeTimeoutMs)
        return undefined
      }
    }

    const registerDiscoveredTool = ({ server, client, tool, registeredName }) => {
      const description = typeof tool.description === "string" && tool.description.length > 0
        ? tool.description
        : `MCP tool ${tool.name} from ${server.name}`
      pi.registerTool({
        name: registeredName,
        label: tool.title || truncateUtf8(`${server.name}: ${tool.name}`, MAX_TOOL_TITLE_BYTES).text,
        description,
        promptSnippet: `${registeredName}: ${description}`.slice(0, 4_000),
        parameters: tool.inputSchema,
        async execute(toolCallId, params, signal, onUpdate, context) {
          const requestSignal = signal
            ? AbortSignal.any([signal, lifecycleController.signal])
            : lifecycleController.signal
          if (shuttingDown || connections.get(server.name)?.client !== client) {
            return textResult(`MCP server ${server.name} is unavailable.`, { server: server.name, tool: tool.name }, true)
          }
          if (requestSignal.aborted) return textResult(`MCP tool ${tool.name} was cancelled.`, { server: server.name, tool: tool.name }, true)

          if (requiresApproval(server.policy, tool)) {
            let approved = false
            try {
              approved = await requestApproval({
                context,
                server: server.name,
                tool,
                arguments: params,
                signal: requestSignal,
              }) === true
            } catch {
              // Approval errors and unavailable user interfaces deny execution.
            }
            if (approved !== true) {
              return textResult(`Approval denied for MCP tool ${server.name}/${tool.name}.`, {
                server: server.name,
                tool: tool.name,
                approval: "denied",
              }, true)
            }
          }

          try {
            const result = await withDeadline(
              (requestSignal) => client.callTool(
                { name: tool.name, arguments: params, _meta: { progressToken: toolCallId } },
                undefined,
                {
                  signal: requestSignal,
                  timeout: server.callTimeoutMs,
                  maxTotalTimeout: server.callTimeoutMs,
                  onprogress: onUpdate
                    ? () => {
                      try {
                        onUpdate(textResult(`MCP tool ${server.name}/${tool.name} is running.`, {
                          server: server.name,
                          tool: tool.name,
                        }))
                      } catch {
                        // UI update failures must not fail the underlying tool call.
                      }
                    }
                    : undefined,
                },
              ),
              server.callTimeoutMs,
              requestSignal,
              `MCP tool ${server.name}/${tool.name}`,
            )
            if (!isObject(result) || (result.content !== undefined && !Array.isArray(result.content))) {
              throw new ProtocolViolationError(`MCP tool ${server.name}/${tool.name} returned an invalid result`)
            }
            const output = formatToolResult(result, server.maxOutputBytes)
            return textResult(output.text, {
              server: server.name,
              tool: tool.name,
              outputTruncated: output.truncated,
            }, result?.isError === true)
          } catch (error) {
            await closeClient(server.name, client, server.closeTimeoutMs)
            const output = truncateUtf8(`MCP tool ${server.name}/${tool.name} failed: ${formatError(error)}`, server.maxOutputBytes)
            return textResult(output.text, {
              server: server.name,
              tool: tool.name,
              outputTruncated: output.truncated,
            }, true)
          }
        },
      })
    }

    pi.on("session_start", async () => {
      if (initialized || shuttingDown) return
      initialized = true
      const configPath = environment.PI_AGENTBOX_RUNTIME_CONFIG || DEFAULT_CONFIG_PATH
      let config
      try {
        config = parseConfig(await readFile(configPath, "utf8"), configPath)
      } catch (error) {
        log(`configuration error: ${formatError(error)}`)
        return
      }

      let sdk
      try {
        sdk = await loadSdk()
      } catch (error) {
        log(`could not load MCP SDK: ${formatError(error)}`)
        return
      }

      const servers = []
      for (const [name, value] of config.servers) {
        try {
          const server = parseServer(name, value, config.defaults)
          if (!server.disabled) servers.push(server)
        } catch (error) {
          log(`server ${name} ignored: ${formatError(error)}`)
        }
      }

      const connected = (await Promise.all(servers.map((server) => connectServer(server, sdk)))).filter(Boolean)
      if (shuttingDown) return
      const discovered = []
      for (const connection of connected) {
        for (const tool of connection.tools) {
          discovered.push({
            ...connection,
            tool,
            candidate: candidateToolName(connection.server.name, tool.name),
          })
        }
      }

      const registered = new Set()
      for (const item of assignToolNames(discovered)) {
        if (registered.has(item.registeredName)) {
          log(`tool ${item.server.name}/${item.tool.name} ignored due to an unresolvable name collision`)
          continue
        }
        try {
          registerDiscoveredTool(item)
          registered.add(item.registeredName)
        } catch (error) {
          log(`tool ${item.server.name}/${item.tool.name} could not be registered: ${formatError(error)}`)
        }
      }
    })

    pi.on("session_shutdown", async () => {
      if (shuttingDown) return
      shuttingDown = true
      lifecycleController.abort(new Error("MCP runtime is shutting down"))
      const pending = [...connections.entries()].map(([name, connection]) => closeClient(name, connection.client, connection.closeTimeoutMs))
      await Promise.allSettled(pending)
    })
  }
}

export default createPiMcpExtension()
