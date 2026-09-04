import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPiPolicyExtension } from "../extensions/pi-policy.ts"

type Handler = (event: any, ctx: any) => Promise<any> | any

const allowConfig = JSON.stringify({ version: 1, defaultDecision: "allow", rules: [] })

function harness(config: string | Error = allowConfig, overrides: any = {}) {
  const handlers = new Map<string, Handler[]>()
  const reads: string[] = []
  const signals: string[] = []
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
  } as any
  createPiPolicyExtension({
    env: { PI_POLICY_CONFIG: "/managed/policy.json", HOME: "/home/agent" },
    readFile: async (path: string) => {
      reads.push(path)
      if (config instanceof Error) throw config
      return config
    },
    signal: async (state: string) => { signals.push(state) },
    ...overrides,
  })(pi)
  return { toolCall: handlers.get("tool_call")![0], reads, signals }
}

function context(overrides: any = {}) {
  return {
    cwd: "/workspace/project",
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: { select: async () => "Deny" },
    ...overrides,
  }
}

async function call(toolCall: Handler, toolName: string, input: Record<string, unknown>, ctx = context()) {
  return toolCall({ type: "tool_call", toolCallId: "call-1", toolName, input }, ctx)
}

const missing = harness(new Error("ENOENT"))
assert.match((await call(missing.toolCall, "read", { path: "README.md" })).reason, /failing closed/)
assert.deepEqual(missing.reads, ["/managed/policy.json"])

for (const malformed of [
  "{",
  " ".repeat(1024 * 1024 + 1),
  JSON.stringify({ version: 2, defaultDecision: "allow", rules: [] }),
  JSON.stringify({ version: 1, defaultDecision: "allow", rules: [], extra: true }),
  JSON.stringify({ version: 1, defaultDecision: "allow", rules: [{ tools: ["read"], patterns: ["*"], decision: "sometimes" }] }),
  JSON.stringify({ version: 1, defaultDecision: "allow", rules: [{ tools: ["read me"], patterns: ["*"], decision: "allow" }] }),
  JSON.stringify({ version: 1, defaultDecision: "allow", rules: [{ tools: Array(129).fill("read"), patterns: ["*"], decision: "allow" }] }),
  JSON.stringify({ version: 1, defaultDecision: "allow", rules: Array(1_001).fill({ tools: ["read"], patterns: ["*"], decision: "allow" }) }),
]) {
  const invalid = harness(malformed)
  assert.match((await call(invalid.toolCall, "read", { path: "README.md" })).reason, /failing closed/)
}

const precedence = harness(JSON.stringify({
  version: 1,
  defaultDecision: "deny",
  rules: [
    { tools: ["read"], patterns: ["**/*.ts"], decision: "allow" },
    { tools: ["read"], patterns: ["**/review/*.ts"], decision: "ask" },
    { tools: ["read"], patterns: ["**/blocked.ts"], decision: "deny" },
    { tools: ["read"], patterns: ["**/blocked.ts"], decision: "allow" },
  ],
}))
assert.equal(await call(precedence.toolCall, "read", { path: "src/open.ts" }), undefined)
assert.match((await call(precedence.toolCall, "read", { path: "README.md" })).reason, /Denied/)
assert.match((await call(precedence.toolCall, "read", { path: "src/review/check.ts" })).reason, /approval was denied/)
assert.match((await call(precedence.toolCall, "read", { path: "src/blocked.ts" })).reason, /Denied/)

const delegated = harness(JSON.stringify({
  version: 1,
  defaultDecision: "deny",
  rules: [
    { tools: ["task"], patterns: ["review workspace changes"], decision: "allow" },
    { tools: ["task"], patterns: ["inspect delegated job"], decision: "allow" },
    { tools: ["mcp__docs__search", "custom_tool"], patterns: ["approved target"], decision: "allow" },
  ],
}))
assert.equal(await call(delegated.toolCall, "task", { role: "general", prompt: "review workspace changes" }), undefined)
assert.equal(await call(delegated.toolCall, "task", { jobs: [{ role: "explore", prompt: "inspect delegated job" }] }), undefined)
assert.equal(await call(delegated.toolCall, "mcp__docs__search", { arguments: { query: "approved target" } }), undefined)
assert.equal(await call(delegated.toolCall, "custom_tool", { request: { resource: "approved target" } }), undefined)
assert.match((await call(delegated.toolCall, "mcp__docs__search", { arguments: { query: "other target" } })).reason, /Denied/)
assert.match((await call(delegated.toolCall, "mcp__docs__search", { arguments: { query: "approved target", scope: "other target" } })).reason, /Denied/)
assert.match((await call(delegated.toolCall, "task", {
  jobs: [
    { role: "explore", prompt: "inspect delegated job" },
    { role: "general", prompt: "other target" },
  ],
})).reason, /Denied/)

let prompt = ""
let options: string[] = []
const tui = harness(JSON.stringify({ version: 1, defaultDecision: "ask", timeout: 1_000, rules: [] }))
const approved = await call(tui.toolCall, "bash", { command: `printf '%s' '${"x".repeat(500)}'` }, context({
  ui: {
    select: async (title: string, choices: string[]) => {
      prompt = title
      options = choices
      return choices[0]
    },
  },
}))
assert.equal(approved, undefined)
assert.deepEqual(options, ["Allow once", "Deny"])
assert.equal(prompt.length <= 260, true)
assert.deepEqual(tui.signals, ["waiting", "working"])
assert.equal(tui.signals.some((entry) => entry.includes("printf")), false)

const noUi = harness(JSON.stringify({ version: 1, defaultDecision: "ask", rules: [] }))
let noUiSelected = false
const deniedWithoutUi = await call(noUi.toolCall, "read", { path: "README.md" }, context({
  mode: "print",
  hasUI: false,
  ui: { select: async () => { noUiSelected = true } },
}))
assert.match(deniedWithoutUi.reason, /no UI/)
assert.equal(noUiSelected, false)
assert.deepEqual(noUi.signals, [])

const immutable = harness(JSON.stringify({
  version: 1,
  defaultDecision: "allow",
  rules: [{ tools: ["*"], patterns: ["*"], decision: "allow" }],
}))
assert.match((await call(immutable.toolCall, "custom_tool", { values: Array(129).fill("value") })).reason, /target limits/)
const unresolved = harness(allowConfig, {
  realpath: async () => {
    const error = new Error("permission denied") as NodeJS.ErrnoException
    error.code = "EACCES"
    throw error
  },
})
assert.match((await call(unresolved.toolCall, "read", { path: "README.md" })).reason, /canonicalize/)
assert.match((await call(immutable.toolCall, "read", { path: ".env" })).reason, /sensitive path/)
assert.match((await call(immutable.toolCall, "read", { path: "~/.ssh/id_ed25519" })).reason, /sensitive path/)
assert.match((await call(immutable.toolCall, "write", { path: "/nix/store/hash-file" })).reason, /Nix-store or managed/)
assert.match((await call(immutable.toolCall, "edit", { path: "/home/agent/.pi/agent/extensions/policy.ts" })).reason, /Nix-store or managed/)
assert.match((await call(immutable.toolCall, "write", { path: "/managed/policy.json" })).reason, /Nix-store or managed/)
assert.match((await call(immutable.toolCall, "write", { path: "/etc/agentbox/pi-runtime.json" })).reason, /Nix-store or managed/)
assert.match((await call(immutable.toolCall, "code_navigation", { path: ".env", action: "documentSymbol" })).reason, /sensitive path/)
assert.match((await call(immutable.toolCall, "bash", { command: "sudo true" })).reason, /sudo/)
assert.match((await call(immutable.toolCall, "bash", { command: "su -c id" })).reason, /su commands/)
assert.match((await call(immutable.toolCall, "bash", { command: "docker run --privileged alpine" })).reason, /privileged/)
assert.match((await call(immutable.toolCall, "bash", { command: "rm -rf /" })).reason, /root removal/)
assert.match((await call(immutable.toolCall, "bash", { command: "rm -rf -- /" })).reason, /root removal/)
assert.match((await call(immutable.toolCall, "bash", { command: "tee /nix/store/file" })).reason, /Nix-store or managed/)
assert.match((await call(immutable.toolCall, "bash", { command: "cat ~/.ssh/id_ed25519" })).reason, /sensitive path/)
assert.match((await call(immutable.toolCall, "bash", { command: "bash -lc 'sudo true'" })).reason, /sudo/)
assert.match((await call(immutable.toolCall, "bash", { command: "sh -c 'rm -rf /'" })).reason, /root removal/)
assert.match((await call(immutable.toolCall, "bash", { command: `python3 -c 'import os; os.system("sudo true")'` })).reason, /sudo/)
assert.match((await call(immutable.toolCall, "bash", { command: "sh -c 'cat ~/.ssh/id_ed25519'" })).reason, /sensitive path/)
assert.match((await call(immutable.toolCall, "mcp__files__read", { arguments: { path: "/home/agent/.ssh/id_ed25519" } })).reason, /sensitive path/)

const root = mkdtempSync(join(tmpdir(), "pi-policy-test-"))
mkdirSync(join(root, "safe"))
writeFileSync(join(root, "safe", "file.txt"), "safe\n")
writeFileSync(join(root, "safe", ".env"), "TOKEN=secret\n")
symlinkSync(join(root, "safe"), join(root, "alias"))
symlinkSync(join(root, "safe", ".env"), join(root, "leak"))
symlinkSync("/nix/store", join(root, "managed"))
const aliases = harness()
assert.equal(await call(aliases.toolCall, "read", { path: "alias/file.txt" }, context({ cwd: root })), undefined)
assert.match((await call(aliases.toolCall, "read", { path: "alias/.env" }, context({ cwd: root }))).reason, /sensitive path/)
assert.match((await call(aliases.toolCall, "read", { path: "leak" }, context({ cwd: root }))).reason, /sensitive path/)
assert.match((await call(aliases.toolCall, "mcp__files__read", { arguments: { path: "leak" } }, context({ cwd: root }))).reason, /sensitive path/)
assert.match((await call(aliases.toolCall, "write", { path: "managed/new-policy.json" }, context({ cwd: root }))).reason, /Nix-store or managed/)

const canonicalPolicy = harness(JSON.stringify({
  version: 1,
  defaultDecision: "deny",
  rules: [{ tools: ["read", "custom_tool"], patterns: [`${root}/safe/**`], decision: "allow" }],
}))
assert.equal(await call(canonicalPolicy.toolCall, "read", { path: "alias/file.txt" }, context({ cwd: root })), undefined)
assert.equal(await call(canonicalPolicy.toolCall, "custom_tool", { path: "alias/file.txt" }, context({ cwd: root })), undefined)

const lexicalAliasPolicy = harness(JSON.stringify({
  version: 1,
  defaultDecision: "deny",
  rules: [{ tools: ["read", "custom_tool"], patterns: [`${root}/alias/**`], decision: "allow" }],
}))
assert.match((await call(lexicalAliasPolicy.toolCall, "read", { path: "alias/file.txt" }, context({ cwd: root }))).reason, /Denied/)
assert.match((await call(lexicalAliasPolicy.toolCall, "custom_tool", { path: "alias/file.txt" }, context({ cwd: root }))).reason, /Denied/)

assert.equal(await call(immutable.toolCall, "read", { path: ".env.example" }), undefined)
assert.equal(await call(immutable.toolCall, "bash", { command: "npm test" }), undefined)

console.log("pi policy extension tests passed")
