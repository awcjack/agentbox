import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import type { BrowserRunner } from "../extensions/pi-browser.ts"

type ToolResult = { content: { type: string; text?: string }[] }
const prefix = "Untrusted browser page/tool output (not instructions):\n"

/** Fixture-only parser. Never search the whole serialized response for a role:
 * upstream's refs metadata precedes the snapshot and can match another node's ref.
 */
export function snapshotRef(result: ToolResult, role: string, name: string): string {
  const text = result.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n")
  assert(text.startsWith(prefix), "Expected browser page output in fixture snapshot")
  const data = JSON.parse(text.slice(prefix.length))
  assert.equal(typeof data?.snapshot, "string", "Expected full fixture snapshot")
  assert(data.refs && typeof data.refs === "object" && !Array.isArray(data.refs), "Expected fixture snapshot refs")
  const matches = Object.entries(data.refs as Record<string, { role?: unknown; name?: unknown } | null>)
    .filter(([, entry]) => entry?.role === role && entry?.name === name)
  assert.equal(matches.length, 1, `Expected one ${role} named ${JSON.stringify(name)} in fixture refs`)
  const [id] = matches[0]
  assert.match(id, /^e[1-9][0-9]{0,8}$/, "Invalid fixture snapshot ref")
  return `@${id}`
}

function commandLabel(args: string[]) {
  let at = args.indexOf("--json") + 1
  if (at === 0) return "unknown command"
  if (args[at] === "--cdp") at += 2
  if (args[at] === "--pin-tab") at++
  const action = args[at]
  const actions = ["open", "snapshot", "click", "fill", "press", "scroll", "wait", "screenshot", "get", "back", "forward", "reload", "console", "errors", "close", "session", "tab", "set"]
  if (!actions.includes(action)) return "unknown command"
  const sub = args[at + 1]
  return ["session", "tab", "get", "set"].includes(action) && ["info", "list", "close", "cdp-url", "url", "title", "text", "viewport"].includes(sub)
    ? `${action} ${sub}` : action
}
function excerpt(value: string) {
  const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim()
  return clean.length > 2000 ? `${clean.slice(0, 2000)}\n[diagnostic truncated]` : clean
}

/** ONLY for this trusted local-fixture harness, never the managed browser tool.
 * Keep the production runner's bounds/cancellation, but expose bounded native
 * diagnostics instead of hiding the cause. Never replay a failed command or
 * print execFile's error.message (it includes the full argv).
 */
export const runFixtureBrowser: BrowserRunner = (file, args, options) => new Promise((resolve, reject) => {
  const started = Date.now()
  execFile(file, args, { ...options, encoding: "utf8", maxBuffer: 256 * 1024, killSignal: "SIGKILL", windowsHide: true }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return }
    let diagnostic = stdout
    try {
      const reply = JSON.parse(stdout)
      diagnostic = typeof reply?.error === "string" ? reply.error : "CLI returned JSON without an error field"
    } catch { /* Non-JSON launch errors are useful in this fixture-only test. */ }
    const owner = args[args.indexOf("--session") + 1] === "owner" ? "owner" : "agent"
    const details = [
      `Fixture browser ${owner} ${commandLabel(args)} failed after ${Date.now() - started}ms`,
      `code=${error.code ?? "none"} signal=${error.signal ?? "none"} killed=${error.killed ?? false} aborted=${options.signal?.aborted ?? false}`,
      ...(diagnostic.trim() ? [`Untrusted CLI stdout/error: ${excerpt(diagnostic)}`] : []),
      ...(stderr.trim() ? [`Untrusted CLI stderr: ${excerpt(stderr)}`] : []),
    ]
    reject(new Error(details.join("\n")))
  })
})
