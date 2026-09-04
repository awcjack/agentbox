import { spawn as nodeSpawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { promises as fs } from "node:fs"
import { extname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const DEFAULT_MAX_OUTPUT_BYTES = 30_000
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_DOCUMENTS = 128
const DEFAULT_MAX_RETAINED_DOCUMENT_BYTES = 16 * 1024 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 1_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000

export type LspNavigationAction =
  | "definition"
  | "declaration"
  | "typeDefinition"
  | "implementation"
  | "references"
  | "hover"
  | "documentSymbol"

export interface LspPosition {
  line: number
  character: number
}

export interface LanguageServerDefinition {
  id: string
  command: string
  args?: readonly string[]
  extensionToLanguage: Readonly<Record<string, string>>
  initializationOptions?: unknown
  settings?: unknown
}

export const DEFAULT_LANGUAGE_SERVERS: readonly LanguageServerDefinition[] = [
  {
    id: "gopls",
    command: "gopls",
    extensionToLanguage: { ".go": "go" },
  },
  {
    id: "nil",
    command: "nil",
    extensionToLanguage: { ".nix": "nix" },
  },
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensionToLanguage: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
  },
  {
    id: "yaml",
    command: "yaml-language-server",
    args: ["--stdio"],
    extensionToLanguage: { ".yaml": "yaml", ".yml": "yaml" },
  },
  {
    id: "json",
    command: "vscode-json-language-server",
    args: ["--stdio"],
    extensionToLanguage: { ".json": "json", ".jsonc": "jsonc" },
    initializationOptions: { provideFormatter: false },
  },
  {
    id: "html",
    command: "vscode-html-language-server",
    args: ["--stdio"],
    extensionToLanguage: { ".html": "html", ".htm": "html" },
  },
  {
    id: "css",
    command: "vscode-css-language-server",
    args: ["--stdio"],
    extensionToLanguage: { ".css": "css", ".scss": "scss", ".less": "less" },
  },
]

export type LspSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams

export interface LspClientOptions {
  pathGuard: (path: string) => boolean
  servers?: readonly LanguageServerDefinition[]
  spawn?: LspSpawn
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>
  maxOutputBytes?: number
  maxMessageBytes?: number
  maxDocumentBytes?: number
  maxDocuments?: number
  maxRetainedDocumentBytes?: number
  requestTimeoutMs?: number
  diagnosticsTimeoutMs?: number
  shutdownTimeoutMs?: number
}

export interface LspDocumentRequest {
  path: string
  root: string
  text?: string
  signal?: AbortSignal
}

export interface LspNavigationRequest extends LspDocumentRequest {
  action: LspNavigationAction
  position?: LspPosition
  includeDeclaration?: boolean
}

export interface LspOutput {
  server: string
  root: string
  action: "diagnostics" | LspNavigationAction
  output: string
  truncated: boolean
}

export interface LspClient {
  serverForPath(path: string): LanguageServerDefinition | undefined
  diagnostics(request: LspDocumentRequest): Promise<LspOutput>
  navigate(request: LspNavigationRequest): Promise<LspOutput>
  shutdown(): Promise<void>
}

interface JsonRpcErrorValue {
  code: number
  message: string
  data?: unknown
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

interface PublishedWaiter {
  version: number
  resolve: (diagnostics: unknown[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

interface PublishedHandle {
  promise: Promise<unknown[]>
  cancel: () => void
}

const NAVIGATION_METHODS: Record<LspNavigationAction, string> = {
  definition: "textDocument/definition",
  declaration: "textDocument/declaration",
  typeDefinition: "textDocument/typeDefinition",
  implementation: "textDocument/implementation",
  references: "textDocument/references",
  hover: "textDocument/hover",
  documentSymbol: "textDocument/documentSymbol",
}

const DROP = Symbol("drop")

class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(value: JsonRpcErrorValue) {
    super(value.message)
    this.name = "RpcError"
    this.code = value.code
    this.data = value.data
  }
}

function abortError() {
  const error = new Error("LSP request cancelled")
  error.name = "AbortError"
  return error
}

function positive(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`)
  return result
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function frame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body])
}

function filePath(uri: string): string | undefined {
  if (!/^file:/i.test(uri)) return undefined
  try {
    return resolve(fileURLToPath(uri))
  } catch {
    return undefined
  }
}

function truncate(text: string, maximum: number) {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maximum) return { text, truncated: false }

  const marker = Buffer.from("\n[output truncated]", "utf8")
  if (maximum <= marker.length) {
    return { text: marker.subarray(0, maximum).toString("ascii"), truncated: true }
  }
  let prefix = bytes.subarray(0, maximum - marker.length).toString("utf8")
  if (prefix.endsWith("\ufffd")) prefix = prefix.slice(0, -1)
  return { text: `${prefix}${marker.toString("utf8")}`, truncated: true }
}

function safeJson(value: unknown, maximum: number) {
  const serialized = JSON.stringify(value, null, 2) ?? "null"
  return truncate(serialized, maximum)
}

function sanitize(value: unknown, pathGuard: (path: string) => boolean): unknown | typeof DROP {
  if (typeof value === "string") {
    const path = filePath(value)
    if (path && !guarded(pathGuard, path)) return DROP
    return value.replace(/file:\/\/[^\s<>"')\]}]+/gi, (uri) => {
      const embeddedPath = filePath(uri)
      return embeddedPath && guarded(pathGuard, embeddedPath) ? uri : "[filtered file URI]"
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, pathGuard)).filter((item) => item !== DROP)
  }
  if (!isObject(value)) return value

  for (const key of ["uri", "targetUri", "documentUri"]) {
    const uri = value[key]
    if (typeof uri === "string" && /^file:/i.test(uri)) {
      const path = filePath(uri)
      if (!path || !guarded(pathGuard, path)) return DROP
    }
  }

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (/^file:/i.test(key)) {
      const path = filePath(key)
      if (!path || !guarded(pathGuard, path)) continue
    }
    const sanitized = sanitize(child, pathGuard)
    if (sanitized === DROP && key === "location") return DROP
    if (sanitized !== DROP) result[key] = sanitized
  }
  return result
}

function guarded(pathGuard: (path: string) => boolean, path: string) {
  try {
    return pathGuard(path)
  } catch {
    return false
  }
}

class PersistentServer {
  readonly definition: LanguageServerDefinition
  readonly root: string
  private readonly process: ChildProcessWithoutNullStreams
  private readonly spawn: LspSpawn
  private readonly requestTimeoutMs: number
  private readonly diagnosticsTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly maxMessageBytes: number
  private readonly maxDocumentBytes: number
  private readonly maxDocuments: number
  private readonly maxRetainedDocumentBytes: number
  private readonly pending = new Map<number, PendingRequest>()
  private readonly documents = new Map<string, { text: string; version: number; bytes: number }>()
  private readonly waiters = new Map<string, Set<PublishedWaiter>>()
  private readonly published = new Map<string, { version: number; diagnostics: unknown[] }>()
  private retainedDocumentBytes = 0
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private stopped = false
  private exited = false
  private exitResolve!: () => void
  private readonly exitedPromise: Promise<void>
  private capabilities: Record<string, unknown> = {}

  private constructor(
    definition: LanguageServerDefinition,
    root: string,
    spawn: LspSpawn,
    requestTimeoutMs: number,
    diagnosticsTimeoutMs: number,
    shutdownTimeoutMs: number,
    maxMessageBytes: number,
    maxDocumentBytes: number,
    maxDocuments: number,
    maxRetainedDocumentBytes: number,
  ) {
    this.definition = definition
    this.root = root
    this.spawn = spawn
    this.requestTimeoutMs = requestTimeoutMs
    this.diagnosticsTimeoutMs = diagnosticsTimeoutMs
    this.shutdownTimeoutMs = shutdownTimeoutMs
    this.maxMessageBytes = maxMessageBytes
    this.maxDocumentBytes = maxDocumentBytes
    this.maxDocuments = maxDocuments
    this.maxRetainedDocumentBytes = maxRetainedDocumentBytes
    this.exitedPromise = new Promise((resolveExit) => {
      this.exitResolve = resolveExit
    })
    this.process = this.spawn(definition.command, definition.args ?? [], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.process.stdout.on("data", (chunk: Buffer | string) => this.onData(chunk))
    this.process.stderr.on("data", () => {})
    this.process.on("error", (error) => this.fail(error))
    this.process.on("exit", (code, signal) => {
      this.exited = true
      this.exitResolve()
      const suffix = signal ? ` signal ${signal}` : ` status ${code ?? "unknown"}`
      this.stopWithError(new Error(`LSP server ${definition.id} exited with${suffix}`))
    })
  }

  static async start(
    definition: LanguageServerDefinition,
    root: string,
    spawn: LspSpawn,
    requestTimeoutMs: number,
    diagnosticsTimeoutMs: number,
    shutdownTimeoutMs: number,
    maxMessageBytes: number,
    maxDocumentBytes: number,
    maxDocuments: number,
    maxRetainedDocumentBytes: number,
  ) {
    const server = new PersistentServer(
      definition,
      root,
      spawn,
      requestTimeoutMs,
      diagnosticsTimeoutMs,
      shutdownTimeoutMs,
      maxMessageBytes,
      maxDocumentBytes,
      maxDocuments,
      maxRetainedDocumentBytes,
    )
    try {
      const initialized = await server.request("initialize", {
        processId: process.pid,
        clientInfo: { name: "pi-agentbox", version: "1" },
        rootUri: pathToFileURL(root).href,
        workspaceFolders: [{ uri: pathToFileURL(root).href, name: root.split("/").at(-1) || root }],
        capabilities: {
          workspace: { applyEdit: false, workspaceFolders: true },
          textDocument: {
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
        },
        initializationOptions: definition.initializationOptions,
      })
      if (isObject(initialized) && isObject(initialized.capabilities)) {
        server.capabilities = initialized.capabilities
      }
      server.notify("initialized", {})
      if (definition.settings !== undefined) {
        server.notify("workspace/didChangeConfiguration", { settings: definition.settings })
      }
      return server
    } catch (error) {
      await server.shutdown()
      throw error
    }
  }

  supportsPullDiagnostics() {
    return this.capabilities.diagnosticProvider !== undefined && this.capabilities.diagnosticProvider !== false
  }

  isRunning() {
    return !this.stopped && !this.exited
  }

  sync(uri: string, languageId: string, text: string) {
    const bytes = Buffer.byteLength(text, "utf8")
    if (bytes > this.maxDocumentBytes) {
      throw new Error(`LSP document exceeds ${this.maxDocumentBytes} bytes`)
    }
    const document = this.documents.get(uri)
    if (!document) {
      if (this.documents.size >= this.maxDocuments) {
        throw new Error(`LSP server ${this.definition.id} already has ${this.maxDocuments} open documents`)
      }
      if (this.retainedDocumentBytes + bytes > this.maxRetainedDocumentBytes) {
        throw new Error(`LSP retained document text exceeds ${this.maxRetainedDocumentBytes} bytes`)
      }
      this.documents.set(uri, { text, version: 1, bytes })
      this.retainedDocumentBytes += bytes
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      })
      return 1
    }
    if (document.text === text) return document.version
    if (this.retainedDocumentBytes - document.bytes + bytes > this.maxRetainedDocumentBytes) {
      throw new Error(`LSP retained document text exceeds ${this.maxRetainedDocumentBytes} bytes`)
    }
    this.retainedDocumentBytes += bytes - document.bytes
    document.text = text
    document.bytes = bytes
    document.version += 1
    this.published.delete(uri)
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: document.version },
      contentChanges: [{ text }],
    })
    return document.version
  }

  preparePublished(uri: string, version: number, signal?: AbortSignal): PublishedHandle {
    const cached = this.published.get(uri)
    if (cached?.version === version) {
      return { promise: Promise.resolve(cached.diagnostics), cancel: () => {} }
    }
    let waiter: PublishedWaiter | undefined
    let settled = false
    const cleanup = () => {
      if (!waiter) return
      clearTimeout(waiter.timer)
      waiter.removeAbort?.()
      const uriWaiters = this.waiters.get(uri)
      uriWaiters?.delete(waiter)
      if (uriWaiters?.size === 0) this.waiters.delete(uri)
    }
    const promise = new Promise<unknown[]>((resolveDiagnostics, reject) => {
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const timer = setTimeout(() => {
        finish(() => reject(new Error(
          `LSP publishDiagnostics timed out after ${this.diagnosticsTimeoutMs}ms for document version ${version}`,
        )))
      }, this.diagnosticsTimeoutMs)
      const onAbort = () => finish(() => reject(abortError()))
      waiter = {
        version,
        resolve: (diagnostics) => finish(() => resolveDiagnostics(diagnostics)),
        reject: (error) => finish(() => reject(error)),
        timer,
        ...(signal ? { removeAbort: () => signal.removeEventListener("abort", onAbort) } : {}),
      }
      const uriWaiters = this.waiters.get(uri) ?? new Set<PublishedWaiter>()
      uriWaiters.add(waiter)
      this.waiters.set(uri, uriWaiters)
      if (signal?.aborted) onAbort()
      else signal?.addEventListener("abort", onAbort, { once: true })
    })
    void promise.catch(() => {})
    return {
      promise,
      cancel: () => {
        if (settled) return
        settled = true
        cleanup()
      },
    }
  }

  request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error(`LSP server ${this.definition.id} is not running`))
    if (signal?.aborted) return Promise.reject(abortError())

    const id = this.nextId++
    return new Promise((resolveRequest, reject) => {
      const onAbort = () => {
        finish(() => reject(abortError()))
        try {
          this.notify("$/cancelRequest", { id })
        } catch {
          // Cancellation still completes locally if the server has gone away.
        }
      }
      const finish = (callback: () => void) => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        pending.removeAbort?.()
        this.pending.delete(id)
        callback()
      }
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`LSP ${method} request timed out after ${timeoutMs}ms`)))
        try {
          this.notify("$/cancelRequest", { id })
        } catch {
          // The timeout remains authoritative if the server has gone away.
        }
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => finish(() => resolveRequest(value)),
        reject: (error) => finish(() => reject(error)),
        timer,
        ...(signal ? { removeAbort: () => signal.removeEventListener("abort", onAbort) } : {}),
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        this.write({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))))
      }
    })
  }

  notify(method: string, params: unknown) {
    if (!this.stopped) this.write({ jsonrpc: "2.0", method, params })
  }

  async shutdown() {
    if (this.exited) return
    if (!this.stopped) {
      try {
        await this.request("shutdown", null, undefined, this.shutdownTimeoutMs)
      } catch {
        // A non-responsive server is still given the LSP exit notification below.
      }
      try {
        this.notify("exit", null)
      } catch {
        // The process may have exited between shutdown and exit.
      }
    }

    let exited = await Promise.race([
      this.exitedPromise.then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), this.shutdownTimeoutMs)),
    ])
    if (!exited) {
      this.process.kill("SIGTERM")
      exited = await Promise.race([
        this.exitedPromise.then(() => true),
        new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), this.shutdownTimeoutMs)),
      ])
    }
    if (!exited) {
      this.process.kill("SIGKILL")
      await Promise.race([
        this.exitedPromise,
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, this.shutdownTimeoutMs)),
      ])
    }
    this.stopWithError(new Error(`LSP server ${this.definition.id} shut down`))
  }

  private write(message: unknown) {
    if (this.process.stdin.destroyed || !this.process.stdin.writable) {
      throw new Error(`LSP server ${this.definition.id} stdin is closed`)
    }
    this.process.stdin.write(frame(message))
  }

  private onData(chunk: Buffer | string) {
    if (this.stopped) return
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) {
        if (this.buffer.length > 16 * 1024) this.fail(new Error("LSP response header is too large"))
        return
      }
      const headers = this.buffer.subarray(0, headerEnd).toString("ascii")
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(headers)
      if (!match) {
        this.fail(new Error("LSP response is missing Content-Length"))
        return
      }
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length > this.maxMessageBytes) {
        this.fail(new Error(`LSP response exceeds ${this.maxMessageBytes} bytes`))
        return
      }
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.subarray(bodyStart, bodyStart + length)
      this.buffer = this.buffer.subarray(bodyStart + length)
      try {
        this.onMessage(JSON.parse(body.toString("utf8")))
      } catch (error) {
        this.fail(new Error(`Invalid LSP response: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
    }
  }

  private onMessage(message: unknown) {
    if (!isObject(message)) return
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      this.respondToServerRequest(message.id, message.method, message.params)
      return
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      if (isObject(message.error) && typeof message.error.code === "number" && typeof message.error.message === "string") {
        pending.reject(new RpcError(message.error as unknown as JsonRpcErrorValue))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method === "textDocument/publishDiagnostics" && isObject(message.params)) {
      const uri = message.params.uri
      const diagnostics = message.params.diagnostics
      if (typeof uri !== "string" || !Array.isArray(diagnostics)) return
      const version = message.params.version
      if (!Number.isInteger(version)) return
      const document = this.documents.get(uri)
      if (document?.version === version) this.published.set(uri, { version, diagnostics })
      for (const waiter of [...(this.waiters.get(uri) ?? [])]) {
        if (waiter.version === version) waiter.resolve(diagnostics)
      }
    }
  }

  private respondToServerRequest(id: number | string, method: string, params: unknown) {
    if (method === "workspace/applyEdit") {
      this.write({
        jsonrpc: "2.0",
        id,
        result: { applied: false, failureReason: "pi-agentbox LSP access is read-only" },
      })
      return
    }
    if (method === "workspace/configuration") {
      const count = isObject(params) && Array.isArray(params.items) ? params.items.length : 0
      this.write({ jsonrpc: "2.0", id, result: Array.from({ length: count }, () => null) })
      return
    }
    if (method === "workspace/workspaceFolders") {
      this.write({
        jsonrpc: "2.0",
        id,
        result: [{ uri: pathToFileURL(this.root).href, name: this.root.split("/").at(-1) || this.root }],
      })
      return
    }
    if ([
      "client/registerCapability",
      "client/unregisterCapability",
      "window/workDoneProgress/create",
    ].includes(method)) {
      this.write({ jsonrpc: "2.0", id, result: null })
      return
    }
    if (method === "window/showMessageRequest") {
      this.write({ jsonrpc: "2.0", id, result: null })
      return
    }
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported server request: ${method}` } })
  }

  private stopWithError(error: Error) {
    if (this.stopped) return
    this.stopped = true
    for (const pending of [...this.pending.values()]) pending.reject(error)
    for (const waiters of this.waiters.values()) {
      for (const waiter of [...waiters]) waiter.reject(error)
    }
    this.waiters.clear()
  }

  private fail(error: Error) {
    this.stopWithError(error)
    if (!this.exited) {
      this.process.kill("SIGTERM")
      const forceKill = setTimeout(() => {
        if (!this.exited) this.process.kill("SIGKILL")
      }, this.shutdownTimeoutMs)
      forceKill.unref()
    }
  }
}

export function createLspClient(options: LspClientOptions): LspClient {
  if (typeof options.pathGuard !== "function") throw new Error("pathGuard is required")
  const servers = options.servers ?? DEFAULT_LANGUAGE_SERVERS
  const spawn = options.spawn ?? (nodeSpawn as LspSpawn)
  const maxOutputBytes = positive(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes")
  const maxMessageBytes = positive(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, "maxMessageBytes")
  const maxDocumentBytes = positive(options.maxDocumentBytes, DEFAULT_MAX_DOCUMENT_BYTES, "maxDocumentBytes")
  const maxDocuments = positive(options.maxDocuments, DEFAULT_MAX_DOCUMENTS, "maxDocuments")
  const maxRetainedDocumentBytes = positive(
    options.maxRetainedDocumentBytes,
    DEFAULT_MAX_RETAINED_DOCUMENT_BYTES,
    "maxRetainedDocumentBytes",
  )
  const readFile = options.readFile ?? (async (path: string, encoding: BufferEncoding) => {
    const file = await fs.open(path, "r")
    try {
      const buffer = Buffer.allocUnsafe(maxDocumentBytes + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset > maxDocumentBytes) throw new Error(`LSP document exceeds ${maxDocumentBytes} bytes: ${path}`)
      return buffer.subarray(0, offset).toString(encoding)
    } finally {
      await file.close()
    }
  })
  const requestTimeoutMs = positive(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "requestTimeoutMs")
  const diagnosticsTimeoutMs = positive(
    options.diagnosticsTimeoutMs,
    DEFAULT_DIAGNOSTICS_TIMEOUT_MS,
    "diagnosticsTimeoutMs",
  )
  const shutdownTimeoutMs = positive(options.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, "shutdownTimeoutMs")
  const clients = new Map<string, Promise<PersistentServer>>()
  let closed = false

  const serverForPath = (path: string) => {
    const extension = extname(path).toLowerCase()
    return servers.find((server) => Object.hasOwn(server.extensionToLanguage, extension))
  }

  const context = async (request: LspDocumentRequest) => {
    if (closed) throw new Error("LSP client session is closed")
    if (request.signal?.aborted) throw abortError()
    const root = resolve(request.root)
    const path = resolve(root, request.path)
    if (!guarded(options.pathGuard, root) || !guarded(options.pathGuard, path)) {
      throw new Error(`LSP path is not allowed: ${path}`)
    }
    const definition = serverForPath(path)
    if (!definition) throw new Error(`No language server configured for ${extname(path) || "this file"}`)
    const languageId = definition.extensionToLanguage[extname(path).toLowerCase()]
    const text = request.text ?? await readFile(path, "utf8")
    if (Buffer.byteLength(text, "utf8") > maxDocumentBytes) {
      throw new Error(`LSP document exceeds ${maxDocumentBytes} bytes: ${path}`)
    }
    const key = `${definition.id}\0${root}`
    let client = clients.get(key)
    if (!client) {
      client = PersistentServer.start(
        definition,
        root,
        spawn,
        requestTimeoutMs,
        diagnosticsTimeoutMs,
        shutdownTimeoutMs,
        maxMessageBytes,
        maxDocumentBytes,
        maxDocuments,
        maxRetainedDocumentBytes,
      )
      clients.set(key, client)
      client.catch(() => {
        if (clients.get(key) === client) clients.delete(key)
      })
    }
    let running = await client
    if (!running.isRunning()) {
      clients.delete(key)
      client = PersistentServer.start(
        definition,
        root,
        spawn,
        requestTimeoutMs,
        diagnosticsTimeoutMs,
        shutdownTimeoutMs,
        maxMessageBytes,
        maxDocumentBytes,
        maxDocuments,
        maxRetainedDocumentBytes,
      )
      clients.set(key, client)
      client.catch(() => {
        if (clients.get(key) === client) clients.delete(key)
      })
      running = await client
    }
    return { client: running, definition, languageId, path, root, text, uri: pathToFileURL(path).href }
  }

  const output = (
    server: LanguageServerDefinition,
    root: string,
    action: "diagnostics" | LspNavigationAction,
    value: unknown,
  ): LspOutput => {
    const sanitized = sanitize(value, options.pathGuard)
    const bounded = safeJson(sanitized === DROP ? null : sanitized, maxOutputBytes)
    return { server: server.id, root, action, output: bounded.text, truncated: bounded.truncated }
  }

  return {
    serverForPath,

    async diagnostics(request) {
      const state = await context(request)
      const version = state.client.sync(state.uri, state.languageId, state.text)
      const published = state.client.preparePublished(state.uri, version, request.signal)
      try {
        if (!state.client.supportsPullDiagnostics()) {
          return output(state.definition, state.root, "diagnostics", await published.promise)
        }
        try {
          const result = await state.client.request(
            "textDocument/diagnostic",
            { textDocument: { uri: state.uri } },
            request.signal,
          )
          published.cancel()
          return output(state.definition, state.root, "diagnostics", result)
        } catch (error) {
          if (!(error instanceof RpcError) || error.code !== -32601) throw error
          return output(state.definition, state.root, "diagnostics", await published.promise)
        }
      } catch (error) {
        published.cancel()
        throw error
      }
    },

    async navigate(request) {
      if (!Object.hasOwn(NAVIGATION_METHODS, request.action)) {
        throw new Error(`Unsupported LSP navigation action: ${String(request.action)}`)
      }
      const state = await context(request)
      if (request.action !== "documentSymbol") {
        const position = request.position
        if (!position || !Number.isInteger(position.line) || position.line < 0
          || !Number.isInteger(position.character) || position.character < 0) {
          throw new Error(`${request.action} requires a non-negative integer line and character`)
        }
      }
      state.client.sync(state.uri, state.languageId, state.text)
      const params: Record<string, unknown> = { textDocument: { uri: state.uri } }
      if (request.action !== "documentSymbol") params.position = request.position
      if (request.action === "references") {
        params.context = { includeDeclaration: request.includeDeclaration ?? true }
      }
      const result = await state.client.request(NAVIGATION_METHODS[request.action], params, request.signal)
      return output(state.definition, state.root, request.action, result)
    },

    async shutdown() {
      if (closed) return
      closed = true
      const running = [...clients.values()]
      clients.clear()
      await Promise.allSettled(running.map(async (client) => (await client).shutdown()))
    },
  }
}
