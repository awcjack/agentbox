import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import extension from "../extensions/pi-agentbox.ts"

type Handler = (event: any, ctx: any) => Promise<any> | any

const handlers = new Map<string, Handler>()
const tools = new Map<string, any>()
const pi = {
  on(name: string, handler: Handler) {
    handlers.set(name, handler)
  },
  registerTool(tool: any) {
    tools.set(tool.name, tool)
  },
} as any

extension(pi)

const root = mkdtempSync(join(tmpdir(), "pi-agentbox-test-"))
mkdirSync(join(root, "src"))
writeFileSync(join(root, ".env.example"), "SAFE=example\n")
writeFileSync(join(root, "src", "bad.js"), "const = broken\n")
writeFileSync(join(root, "src", "good.js"), "const answer = 42\n")
const ctx = { cwd: root }

const toolCall = handlers.get("tool_call")!
const toolResult = handlers.get("tool_result")!
const sessionStart = handlers.get("session_start")!

await sessionStart({}, {
  cwd: root,
  sessionManager: {
    getSessionId: () => "pi-session-test",
    getSessionFile: () => join(root, "session.jsonl"),
    getSessionName: () => "Pi test",
  },
})
assert.equal(process.env.PI_SESSION_ID, "pi-session-test")

assert.match(
  (await toolCall({ toolName: "read", input: { path: ".env" } }, ctx)).reason,
  /sensitive path/,
)
assert.equal(await toolCall({ toolName: "read", input: { path: ".env.example" } }, ctx), undefined)
assert.match(
  (await toolCall({ toolName: "bash", input: { command: "sed -n 1p .env" } }, ctx)).reason,
  /sensitive paths/,
)
assert.match(
  (await toolCall({ toolName: "bash", input: { command: "sudo true" } }, ctx)).reason,
  /sudo/,
)
assert.match(
  (await toolCall({ toolName: "write", input: { path: "/nix/store/example" } }, ctx)).reason,
  /Nix store/,
)
assert.match(
  (await toolCall({ toolName: "edit", input: { path: "~/.local/bin/agent-signal.sh" } }, ctx)).reason,
  /managed Pi integration files/,
)
assert.match(
  (await toolCall({ toolName: "bash", input: { command: "rm -f ~/.local/bin/agent-signal.sh" } }, ctx)).reason,
  /managed Pi integration files/,
)
assert.equal(await toolCall({ toolName: "bash", input: { command: "go test ./..." } }, ctx), undefined)

assert.deepEqual([...tools.keys()], ["web_search", "web_fetch", "code_diagnostics"])
assert.match(
  (await toolCall({ toolName: "code_diagnostics", input: { path: ".env" } }, ctx)).reason,
  /sensitive path/,
)

const diagnostics = await tools.get("code_diagnostics").execute("diagnostics", { path: "src/bad.js" }, undefined, undefined, ctx)
assert.equal(diagnostics.details.status, "failed")
assert.match(diagnostics.content[0].text, /diagnostics/)
const validDiagnostics = await tools.get("code_diagnostics").execute("diagnostics", { path: "src/good.js" }, undefined, undefined, ctx)
assert.equal(validDiagnostics.details.status, "passed")
assert.match(validDiagnostics.content[0].text, /No diagnostics/)

const editResult = await toolResult({
  toolName: "write",
  input: { path: "src/bad.js" },
  isError: false,
  content: [{ type: "text", text: "wrote file" }],
}, ctx)
assert.match(editResult.content.at(-1).text, /Diagnostics failed after editing/)

const originalFetch = globalThis.fetch
const originalJinaKey = process.env.JINA_API_KEY
delete process.env.JINA_API_KEY
let requestedUrl = ""
globalThis.fetch = async (input) => {
  requestedUrl = String(input)
  return new Response(`
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fresult">Search result</a>
    <a class="result__snippet">Result snippet with a <b>citation</b>.</a>
  `, { status: 202 })
}

const search = await tools.get("web_search").execute("search", { query: "pi agent web tools" }, undefined)
assert.match(requestedUrl, /^https:\/\/html\.duckduckgo\.com\/html\//)
assert.match(requestedUrl, /pi\+agent\+web\+tools/)
assert.equal(search.details.provider, "duckduckgo")
assert.match(search.content[0].text, /https:\/\/example.com\/result/)

process.env.JINA_API_KEY = "test-key"
const jinaSearch = await tools.get("web_search").execute("search", { query: "authenticated search" }, undefined)
assert.match(requestedUrl, /^https:\/\/s\.jina\.ai\//)
assert.equal(jinaSearch.details.provider, "jina")
delete process.env.JINA_API_KEY

await assert.rejects(
  tools.get("web_fetch").execute("fetch", { url: "http://localhost:8080/private" }, undefined),
  /public HTTPS|Local/,
)
await assert.rejects(
  tools.get("web_fetch").execute("fetch", { url: "https://127.0.0.1/private" }, undefined),
  /Local, private/,
)

const fetched = await tools.get("web_fetch").execute("fetch", { url: "https://example.com/docs" }, undefined)
assert.equal(requestedUrl, "https://r.jina.ai/https://example.com/docs")
assert.match(fetched.content[0].text, /citation/)
globalThis.fetch = originalFetch
if (originalJinaKey) process.env.JINA_API_KEY = originalJinaKey

console.log("pi agentbox extension tests passed")
