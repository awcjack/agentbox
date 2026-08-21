import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import extension from "../extensions/pi-agentbox.ts"

type Handler = (event: any, ctx: any) => Promise<any> | any

const handlers = new Map<string, Handler>()
const pi = {
  on(name: string, handler: Handler) {
    handlers.set(name, handler)
  },
} as any

extension(pi)

const root = mkdtempSync(join(tmpdir(), "pi-agentbox-test-"))
mkdirSync(join(root, "src"))
writeFileSync(join(root, ".env.example"), "SAFE=example\n")
const ctx = { cwd: root }

const toolCall = handlers.get("tool_call")!
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

console.log("pi agentbox extension tests passed")
