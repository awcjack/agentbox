import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"
import { basename, isAbsolute, resolve } from "node:path"

const SIGNAL = "/home/agent/.local/bin/agent-signal.sh"
const TEST_RUNNER = "/home/agent/.local/bin/shared-test-runner.ts"
const GITLEAKS = "/home/agent/.local/bin/dd-gitleaks-precommit.sh"
const ARCHIVE = "/home/agent/.local/bin/agent-archive-request.sh"

const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"])
const EDIT_TOOLS = new Set(["write", "edit"])
const SECRET_READER_RE = /(?:^|[;&|\s])(cat|head|tail|base64|sed|awk|grep|egrep|fgrep|rg|ag|nl|tac|rev|cut|tr|fold|expand|paste|column|col|less|more|most|pg|xxd|od|hexdump|strings|base32|uuencode|vi|vim|nvim|nano|ex|view|emacs|dd|cp|mv|install|rsync|ln)(?:\s|$)/
const GIT_COMMIT_RE = /(?:^|[;&|\s])git\s+commit(?:\s|$)/
const WRITE_COMMAND_RE = /(?:^|[;&|\s])(rm|rmdir|truncate|tee|touch|chmod|chown|dd|cp|mv|install|rsync|ln|sed\s+-i|perl\s+-i)(?:\s|$)|(?:^|[^<])>{1,2}\s*/

function run(file: string, args: string[], env?: Record<string, string | undefined>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(file, args, { env: { ...process.env, ...env }, encoding: "utf8" }, (error: any, stdout, stderr) => {
      resolveRun({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "" })
    })
  })
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

export default function (pi: ExtensionAPI) {
  let cwd = process.cwd()
  let sessionID = ""
  let sessionFile = ""
  let sessionTitle = ""

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd
    sessionID = ctx.sessionManager.getSessionId()
    sessionFile = ctx.sessionManager.getSessionFile() ?? ""
    sessionTitle = ctx.sessionManager.getSessionName() ?? basename(ctx.cwd)
    process.env.PI_SESSION_ID = sessionID
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

  pi.on("agent_end", async (event, ctx) => {
    const lastAssistant = [...event.messages].reverse().find((message: any) => message.role === "assistant") as any
    if (ctx.hasPendingMessages() || lastAssistant?.stopReason === "error") return

    if (process.env.AGENT_HISTORY_REQUESTS_ENABLED === "true" && sessionID && sessionFile) {
      await run("bash", [
        ARCHIVE,
        "resolve",
        "pi",
        sessionID,
        "agent_end",
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

    const result = await run("bun", [TEST_RUNNER, normalizePath(path, ctx.cwd)])
    if (result.code !== 2 || !result.stderr.trim()) return
    return {
      content: [...event.content, { type: "text", text: result.stderr.trim() }],
    }
  })

}
