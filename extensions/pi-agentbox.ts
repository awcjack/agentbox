import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { isIP } from "node:net"
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path"
import {
  createLspClient,
  type LspClient,
  type LspNavigationAction,
} from "./lsp-client.ts"

const SIGNAL = "/home/agent/.local/bin/agent-signal.sh"
const TEST_RUNNER = "/home/agent/.local/bin/shared-test-runner.ts"
const GITLEAKS = "/home/agent/.local/bin/dd-gitleaks-precommit.sh"
const ARCHIVE = "/home/agent/.local/bin/agent-archive-request.sh"

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "code_diagnostics", "code_navigation"])
const EDIT_TOOLS = new Set(["write", "edit"])
const SECRET_READER_RE = /(?:^|[;&|\s])(cat|head|tail|base64|sed|awk|grep|egrep|fgrep|rg|ag|nl|tac|rev|cut|tr|fold|expand|paste|column|col|less|more|most|pg|xxd|od|hexdump|strings|base32|uuencode|vi|vim|nvim|nano|ex|view|emacs|dd|cp|mv|install|rsync|ln)(?:\s|$)/
const GIT_COMMIT_RE = /(?:^|[;&|\s])git\s+commit(?:\s|$)/
const WRITE_COMMAND_RE = /(?:^|[;&|\s])(rm|rmdir|truncate|tee|touch|chmod|chown|dd|cp|mv|install|rsync|ln|sed\s+-i|perl\s+-i)(?:\s|$)|(?:^|[^<])>{1,2}\s*/
const MAX_TOOL_OUTPUT = 30_000

function run(file: string, args: string[], env?: Record<string, string | undefined>, timeout = 90_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(file, args, {
      env: { ...process.env, ...env },
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout,
    }, (error: any, stdout, stderr) => {
      resolveRun({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" })
    })
  })
}

function findUp(start: string, marker: string) {
  let directory = start
  while (true) {
    if (existsSync(join(directory, marker))) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function trimOutput(output: string) {
  const text = output.trim()
  if (text.length <= MAX_TOOL_OUTPUT) return text
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n\n[output truncated]`
}

type DiagnosticResult = {
  status: "passed" | "failed" | "unsupported"
  checker?: string
  output: string
}

async function syntaxDiagnostics(rawPath: string, cwd: string): Promise<DiagnosticResult> {
  const path = normalizePath(rawPath, cwd)
  const extension = extname(path).toLowerCase()
  let checker: string | undefined
  let command: string | undefined
  let args: string[] = []

  if (extension === ".go") {
    checker = "gopls check"
    command = "gopls"
    args = ["check", path]
  } else if ([".ts", ".tsx"].includes(extension)) {
    const project = findUp(dirname(path), "tsconfig.json")
    if (!project) return { status: "unsupported", output: "No tsconfig.json found for this TypeScript file." }
    checker = "tsc --noEmit"
    command = "tsc"
    args = ["--noEmit", "--pretty", "false", "--project", join(project, "tsconfig.json")]
  } else if ([".js", ".mjs", ".cjs"].includes(extension)) {
    checker = "node --check"
    command = "node"
    args = ["--check", path]
  } else if ([".jsx", ".html", ".css"].includes(extension)) {
    checker = "Prettier parser"
    command = "prettier"
    args = [path]
  } else if (extension === ".py") {
    checker = "Python AST parser"
    command = "python3"
    args = [
      "-c",
      "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(), filename=sys.argv[1])",
      path,
    ]
  } else if (extension === ".nix") {
    checker = "nix-instantiate --parse"
    command = "nix-instantiate"
    args = ["--parse", path]
  } else if (extension === ".json") {
    checker = "jq"
    command = "jq"
    args = ["empty", path]
  } else if ([".yaml", ".yml"].includes(extension)) {
    checker = "yq"
    command = "yq"
    args = ["eval", ".", path]
  } else if ([".sh", ".bash"].includes(extension)) {
    checker = "bash -n"
    command = "bash"
    args = ["-n", path]
  } else {
    return { status: "unsupported", output: `No configured diagnostic checker for ${extension || "files without an extension"}.` }
  }

  const result = await run(command, args)
  const output = trimOutput(`${result.stdout}\n${result.stderr}`)
  const hasGoplsDiagnostics = checker === "gopls check" && output.length > 0
  if (result.code === 0 && !hasGoplsDiagnostics) return { status: "passed", checker, output: "No diagnostics." }
  return {
    status: "failed",
    checker,
    output: output || `${checker} exited with status ${result.code}.`,
  }
}

function hasDiagnostics(output: string) {
  try {
    const value = JSON.parse(output)
    if (Array.isArray(value)) return value.length > 0
    if (value && typeof value === "object" && Array.isArray((value as any).items)) return (value as any).items.length > 0
    return value !== null && value !== undefined
  } catch {
    return output.trim() !== "" && output.trim() !== "[]"
  }
}

function validatePublicUrl(rawUrl: string) {
  const url = new URL(rawUrl)
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== "https:") throw new Error("Only public HTTPS URLs can be fetched")
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed")
  if (isIP(hostname) || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("Local, private, and IP-literal URLs are not allowed")
  }
  return url
}

async function jinaRequest(url: URL, signal: AbortSignal | undefined) {
  const headers: Record<string, string> = {
    Accept: "text/plain",
    "X-Retain-Images": "none",
  }
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000)
  const response = await fetch(url, { headers, signal: requestSignal })
  if (!response.ok) throw new Error(`Web request failed with HTTP ${response.status}`)
  const content = trimOutput(await response.text())
  if (!content) throw new Error("Web request returned no content")
  return content
}

function htmlText(html: string) {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "...",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  }
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => entities[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim()
}

async function duckDuckGoSearch(query: string, signal: AbortSignal | undefined) {
  const url = new URL("https://html.duckduckgo.com/html/")
  url.searchParams.set("q", query)
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000)
  const response = await fetch(url, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; Agentbox/1.0)" },
    signal: requestSignal,
  })
  if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}`)

  const html = await response.text()
  const pattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  const results: string[] = []
  for (const match of html.matchAll(pattern)) {
    const redirect = new URL(htmlText(match[1]), "https://duckduckgo.com")
    const resultUrl = redirect.searchParams.get("uddg") ?? redirect.href
    results.push(`${results.length + 1}. [${htmlText(match[2])}](${resultUrl})\n${htmlText(match[3])}`)
    if (results.length === 10) break
  }
  if (results.length === 0) throw new Error("Web search returned no parseable results")
  return trimOutput(results.join("\n\n"))
}

function normalizePath(path: string, cwd: string) {
  return resolve(cwd, path).replaceAll("\\", "/")
}

function expandPath(path: string, cwd: string) {
  if (path === "~") return process.env.HOME ?? "/home/agent"
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? "/home/agent", path.slice(2))
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function isTemplate(path: string) {
  return /\.env\.(example|sample|template)$/i.test(path)
}

function isSecretPath(rawPath: string, cwd: string) {
  const path = expandPath(rawPath, cwd).replaceAll("\\", "/")
  if (isTemplate(path)) return false

  const name = basename(path).toLowerCase()
  const segments = path.toLowerCase().split("/")
  if (segments.some((segment) => [".ssh", ".aws", ".kube", "secrets"].includes(segment))) return true
  if (path.toLowerCase().includes("/.config/gcloud/")) return true
  if ([".env", ".env.local", ".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials.json"].includes(name)) return true
  if (name.startsWith(".env") && /(local|dev|prod|stag|test)/.test(name)) return true
  if (name.startsWith("values") && /(dev|prod|stag|test)/.test(name)) return true
  if (/secret.*\.ya?ml$/i.test(name)) return true
  if (/\.(pem|key|gpg|asc)$/i.test(name)) return true
  if (/^(id_rsa|id_ed25519|id_ecdsa)/i.test(name)) return true
  if (/^(service-account|gcp-key).*\.json$/i.test(name)) return true
  return false
}

function toolPath(input: Record<string, unknown>) {
  for (const key of ["path", "filePath", "file_path", "notebook_path"]) {
    if (typeof input[key] === "string") return input[key] as string
  }
  return undefined
}

function secretPathInCommand(command: string, cwd: string) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return tokens
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .some((token) => isSecretPath(token, cwd))
}

function managedPaths() {
  const home = process.env.HOME ?? "/home/agent"
  return [
    resolve(home, ".pi/agent/extensions"),
    resolve(home, ".local/bin/agent-signal.sh"),
    resolve(home, ".local/bin/agent-archive-request.sh"),
    resolve(home, ".local/bin/shared-test-runner.ts"),
    resolve(home, ".local/bin/dd-gitleaks-precommit.sh"),
  ].map((path) => path.replaceAll("\\", "/"))
}

function isManagedPath(rawPath: string, cwd: string) {
  const path = expandPath(rawPath, cwd).replaceAll("\\", "/")
  return managedPaths().some((managedPath) => path === managedPath || path.startsWith(`${managedPath}/`))
}

function protectedPathInCommand(command: string, cwd: string) {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return tokens
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .some((path) => isManagedPath(path, cwd))
}

function dangerousReason(command: string) {
  const normalized = command.replace(/\s+/g, " ").trim()
  if (/(?:^|[;&|\s])sudo(?:\s|$)/.test(normalized)) return "sudo is disabled by Agentbox policy"
  if (/(?:^|[;&|\s])su(?:\s|$)/.test(normalized)) return "user switching is disabled by Agentbox policy"
  if (/rm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive\s+--force)\s+(?:\/|\/\*)\s*(?:$|[;&|])/.test(normalized)) return "deleting the filesystem root is prohibited"
  if (/chmod\s+(?:-[^\s]+\s+)*777(?:\s|$)/.test(normalized)) return "world-writable permissions are prohibited"
  if (/(?:^|\s)--privileged(?:\s|$)|--cap-add(?:=|\s+)ALL|(?:^|\s)-v\s+\/:/.test(normalized)) return "privileged container access is prohibited"
  return undefined
}

async function signal(state: "start" | "working" | "done" | "waiting", title?: string) {
  await run("bash", [SIGNAL, state], { AGENT_NAME: "Pi", AGENT_TITLE: title ?? "" })
}

export interface PiAgentboxDependencies {
  createLspClient?: typeof createLspClient
}

export function createPiAgentboxExtension(dependencies: PiAgentboxDependencies = {}) {
  return function piAgentbox(pi: ExtensionAPI) {
  let cwd = process.cwd()
  let sessionID = ""
  let sessionFile = ""
  let sessionTitle = ""
  let lastRunFailed = false
  let lsp: LspClient | undefined

  const pathAllowed = (path: string) => !isSecretPath(path, cwd)
  const lspClient = () => {
    lsp ??= (dependencies.createLspClient ?? createLspClient)({ pathGuard: pathAllowed })
    return lsp
  }

  const diagnosticsFor = async (rawPath: string, requestCwd: string, signal?: AbortSignal): Promise<DiagnosticResult> => {
    const path = normalizePath(rawPath, requestCwd)
    if (isSecretPath(path, requestCwd)) {
      return { status: "failed", checker: "Agentbox path policy", output: `Sensitive path is not available to diagnostics: ${rawPath}` }
    }

    const client = lspClient()
    if (!client.serverForPath(path)) return syntaxDiagnostics(path, requestCwd)
    const root = findUp(dirname(path), ".git") ?? resolve(requestCwd)
    try {
      const result = await client.diagnostics({ path, root, signal })
      return {
        status: hasDiagnostics(result.output) ? "failed" : "passed",
        checker: `LSP (${result.server})`,
        output: hasDiagnostics(result.output) ? result.output : "No diagnostics.",
      }
    } catch (error) {
      const fallback = await syntaxDiagnostics(path, requestCwd)
      if (fallback.status !== "unsupported") return fallback
      return {
        status: "failed",
        checker: "LSP",
        output: `Language server failed and no syntax fallback is available: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description: "Search the public web for current information. Returns titles, snippets, and source URLs.",
    promptSnippet: "web_search: search the public web for current information with source URLs",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500, description: "Search query" },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params: { query: string }, signal) {
      if (process.env.JINA_API_KEY) {
        const url = new URL("https://s.jina.ai/")
        url.searchParams.set("q", params.query)
        const content = await jinaRequest(url, signal)
        return { content: [{ type: "text", text: content }], details: { query: params.query, provider: "jina" } }
      }
      const content = await duckDuckGoSearch(params.query, signal)
      return { content: [{ type: "text", text: content }], details: { query: params.query, provider: "duckduckgo" } }
    },
  })

  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description: "Fetch readable Markdown from a public HTTPS page through Jina Reader. Local and private addresses are blocked.",
    promptSnippet: "web_fetch: fetch readable content from a public HTTPS URL",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", minLength: 1, maxLength: 2_000, description: "Public HTTPS URL" },
      },
      required: ["url"],
    },
    async execute(_toolCallId, params: { url: string }, signal) {
      const target = validatePublicUrl(params.url)
      const content = await jinaRequest(new URL(`https://r.jina.ai/${target.href}`), signal)
      return { content: [{ type: "text", text: content }], details: { url: target.href, provider: "jina" } }
    },
  })

  pi.registerTool({
    name: "code_diagnostics",
    label: "Code diagnostics",
    description: "Check one file with a persistent language server when mapped, falling back to deterministic type or syntax checks.",
    promptSnippet: "code_diagnostics: run language-aware diagnostics for one source file",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "File path relative to the working directory, or an absolute path" },
      },
      required: ["path"],
    },
    async execute(_toolCallId, params: { path: string }, signal, _onUpdate, ctx) {
      const result = await diagnosticsFor(params.path, ctx.cwd, signal)
      const text = result.status === "failed"
        ? `<diagnostics checker="${result.checker}">\n${result.output}\n</diagnostics>`
        : `${result.checker ? `${result.checker}: ` : ""}${result.output}`
      return { content: [{ type: "text", text }], details: result }
    },
  })

  pi.registerTool({
    name: "code_navigation",
    label: "Code navigation",
    description: "Query the persistent language server for definitions, declarations, type definitions, implementations, references, hover information, or document symbols. Line and character positions are zero-based.",
    promptSnippet: "code_navigation: navigate source definitions, references, symbols, and hover information through LSP",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1, description: "File path relative to the working directory, or an absolute path" },
        action: { type: "string", enum: ["definition", "declaration", "typeDefinition", "implementation", "references", "hover", "documentSymbol"] },
        line: { type: "number", minimum: 0, description: "Zero-based line; omitted only for documentSymbol" },
        character: { type: "number", minimum: 0, description: "Zero-based character; omitted only for documentSymbol" },
        includeDeclaration: { type: "boolean", description: "Include declarations in references; defaults to true" },
      },
      required: ["path", "action"],
    },
    async execute(_toolCallId, params: {
      path: string
      action: LspNavigationAction
      line?: number
      character?: number
      includeDeclaration?: boolean
    }, signal, _onUpdate, ctx) {
      const path = normalizePath(params.path, ctx.cwd)
      if (isSecretPath(path, ctx.cwd)) {
        return {
          content: [{ type: "text", text: `Code navigation blocked for sensitive path: ${params.path}` }],
          details: { status: "failed", path: params.path },
          isError: true,
        }
      }
      const root = findUp(dirname(path), ".git") ?? resolve(ctx.cwd)
      try {
        const result = await lspClient().navigate({
          path,
          root,
          action: params.action,
          signal,
          includeDeclaration: params.includeDeclaration,
          ...(params.action === "documentSymbol" ? {} : {
            position: { line: params.line as number, character: params.character as number },
          }),
        })
        return {
          content: [{ type: "text", text: result.output }],
          details: { status: "passed", ...result },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: "text", text: `Code navigation failed: ${message}` }],
          details: { status: "failed", path: params.path, action: params.action },
          isError: true,
        }
      }
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd
    sessionID = ctx.sessionManager.getSessionId()
    sessionFile = ctx.sessionManager.getSessionFile() ?? ""
    sessionTitle = ctx.sessionManager.getSessionName() ?? basename(ctx.cwd)
    process.env.PI_SESSION_ID = sessionID
  })

  pi.on("session_info_changed", async (event, ctx) => {
    sessionTitle = event.name ?? basename(ctx.cwd)
  })

  pi.on("session_shutdown", async () => {
    const client = lsp
    lsp = undefined
    await client?.shutdown()
  })

  pi.on("before_agent_start", async () => {
    if (process.env.AGENT_HISTORY_REQUESTS_ENABLED === "true" && sessionID) {
      await run("bash", [ARCHIVE, "cancel", "pi", sessionID])
    }
    await signal("start", sessionTitle)
  })

  pi.on("agent_start", async () => {
    await signal("working", sessionTitle)
  })

  pi.on("agent_end", async (event) => {
    const lastAssistant = [...event.messages].reverse().find((message: any) => message.role === "assistant") as any
    lastRunFailed = lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted"
  })

  pi.on("agent_settled", async (_event, ctx) => {
    if (!ctx.isIdle() || lastRunFailed) return

    if (process.env.AGENT_HISTORY_REQUESTS_ENABLED === "true" && sessionID && sessionFile) {
      await run("bash", [
        ARCHIVE,
        "resolve",
        "pi",
        sessionID,
        "agent_settled",
        cwd,
        sessionFile,
        sessionID,
      ])
    }
    await signal("done", sessionTitle)
  })

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown>

    if (FILE_TOOLS.has(event.toolName)) {
      const path = toolPath(input)
      if (path && EDIT_TOOLS.has(event.toolName) && normalizePath(path, ctx.cwd).startsWith("/nix/store/")) {
        return { block: true, reason: "Agentbox policy blocks edits to immutable Nix store paths" }
      }
      if (path && EDIT_TOOLS.has(event.toolName) && isManagedPath(path, ctx.cwd)) {
        return { block: true, reason: "Agentbox policy blocks edits to managed Pi integration files" }
      }
      if (path && isSecretPath(path, ctx.cwd)) {
        const publicKey = path.toLowerCase().endsWith(".pub") && !EDIT_TOOLS.has(event.toolName)
        if (!publicKey) return { block: true, reason: `Agentbox policy blocks access to sensitive path: ${path}` }
      }
    }

    if (event.toolName !== "bash") return
    const command = typeof input.command === "string" ? input.command : ""
    const blocked = dangerousReason(command)
    if (blocked) return { block: true, reason: blocked }
    if (WRITE_COMMAND_RE.test(command) && (protectedPathInCommand(command, ctx.cwd) || command.includes("/nix/store/"))) {
      return { block: true, reason: "Agentbox policy blocks shell access to managed Pi integration files" }
    }
    if (SECRET_READER_RE.test(command) && secretPathInCommand(command, ctx.cwd)) {
      return { block: true, reason: "Agentbox policy blocks shell-based access to sensitive paths" }
    }
    if (!GIT_COMMIT_RE.test(command)) return

    const result = await run("bash", [GITLEAKS, ctx.cwd])
    if (result.code === 2) {
      return { block: true, reason: result.stderr.trim() || "gitleaks blocked the commit" }
    }
  })

  pi.on("tool_result", async (event, ctx) => {
    if (!EDIT_TOOLS.has(event.toolName) || event.isError) return
    const path = toolPath(event.input)
    if (!path) return

    const normalizedPath = normalizePath(path, ctx.cwd)
    const [diagnostics, tests] = await Promise.all([
      diagnosticsFor(normalizedPath, ctx.cwd),
      run("bun", [TEST_RUNNER, normalizedPath]),
    ])
    const feedback: Array<{ type: "text"; text: string }> = []
    if (diagnostics.status === "failed") {
      feedback.push({
        type: "text",
        text: `<diagnostics checker="${diagnostics.checker}">\nDiagnostics failed after editing ${path}:\n\n${diagnostics.output}\n</diagnostics>`,
      })
    }
    if (tests.code === 2 && tests.stderr.trim()) {
      feedback.push({ type: "text", text: tests.stderr.trim() })
    }
    if (feedback.length === 0) return
    return {
      content: [...event.content, ...feedback],
    }
  })

  }
}

export default createPiAgentboxExtension()
