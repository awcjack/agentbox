import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPiAgentboxExtension } from "../extensions/pi-agentbox.ts"

type Handler = (event: any, ctx: any) => Promise<any> | any

const handlers = new Map<string, Handler[]>()
const tools = new Map<string, any>()
let lspCreated = 0
let lspClosed = 0
const lspRequests: any[] = []
const pi = {
  on(name: string, handler: Handler) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler])
  },
  registerTool(tool: any) {
    tools.set(tool.name, tool)
  },
} as any

createPiAgentboxExtension({
  createLspClient: (() => {
    lspCreated++
    return {
      serverForPath: (path: string) => path.endsWith(".js") ? { id: "test-lsp" } : undefined,
      diagnostics: async (request: any) => {
        lspRequests.push({ type: "diagnostics", ...request })
        return {
          server: "test-lsp",
          root: request.root,
          action: "diagnostics",
          output: request.path.endsWith("bad.js") ? JSON.stringify([{ message: "broken declaration" }]) : "[]",
          truncated: false,
        }
      },
      navigate: async (request: any) => {
        lspRequests.push({ type: "navigation", ...request })
        return { server: "test-lsp", root: request.root, action: request.action, output: "definition result", truncated: false }
      },
      shutdown: async () => { lspClosed++ },
    }
  }) as any,
})(pi)

const root = mkdtempSync(join(tmpdir(), "pi-agentbox-test-"))
mkdirSync(join(root, "src"))
writeFileSync(join(root, ".env.example"), "SAFE=example\n")
writeFileSync(join(root, "src", "bad.js"), "const = broken\n")
writeFileSync(join(root, "src", "good.js"), "const answer = 42\n")
const ctx = { cwd: root }

const handler = (name: string) => handlers.get(name)![0]
const toolCall = handler("tool_call")
const toolResult = handler("tool_result")
const sessionStart = handler("session_start")

await sessionStart({}, {
  cwd: root,
  sessionManager: {
    getSessionId: () => "pi-session-test",
    getSessionFile: () => join(root, "session.jsonl"),
    getSessionName: () => "Pi test",
  },
})
assert.equal(process.env.PI_SESSION_ID, "pi-session-test")
assert.equal(handlers.has("session_info_changed"), true)
assert.equal(handlers.has("agent_settled"), true)

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

assert.deepEqual([...tools.keys()], ["web_search", "web_fetch", "code_diagnostics", "code_navigation"])
assert.equal(lspCreated, 0, "the persistent LSP client must be initialized lazily")
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
assert.equal(lspCreated, 1)
assert.equal(lspRequests.filter((request) => request.type === "diagnostics").length, 2)

const navigation = await tools.get("code_navigation").execute("navigation", {
  path: "src/good.js",
  action: "definition",
  line: 0,
  character: 6,
}, undefined, undefined, ctx)
assert.equal(navigation.details.server, "test-lsp")
assert.match(navigation.content[0].text, /definition result/)
assert.deepEqual(lspRequests.at(-1).position, { line: 0, character: 6 })
assert.match(
  (await toolCall({ toolName: "code_navigation", input: { path: ".env", action: "documentSymbol" } }, ctx)).reason,
  /sensitive path/,
)

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

await handler("session_shutdown")({}, ctx)
assert.equal(lspClosed, 1)

console.log("pi agentbox extension tests passed")
