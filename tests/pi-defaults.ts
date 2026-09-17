import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createAgentboxDefaultsStore, createPiPolicyExtension } from "../extensions/pi-policy.ts"

function harness(saved: unknown, available = true, overrides: any = {}) {
  const handlers = new Map<string, any>(), commands = new Map<string, any>(), events = new Map<string, any>()
  let settings: Record<string, unknown> = { agentboxAutoDefault: saved, theme: "dark" }, writes = 0
  const notices: string[] = [], selected: any[] = []
  let confirmed = false
  const ctx: any = { cwd: "/workspace", hasUI: true, mode: "tui", model: { provider: "example", id: "model" },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
    sessionManager: { getSessionFile: () => undefined, getHeader: () => ({}), getEntries: () => [] },
    ui: { setStatus() {}, select: async () => "Deny", notify: (text: string) => notices.push(text),
      confirm: async (_title: string, warning: string) => { assert.match(warning, /broad authorization/); return confirmed } } }
  createPiPolicyExtension({
    env: {}, argv: [], realpath: async p => p, signal() {},
    readFile: async () => JSON.stringify({ version: 1, defaultDecision: "ask", rules: [
      { tools: ["write"], patterns: ["*"], decision: "deny" },
    ], auto: { enable: available } }),
    defaultsStore: async () => ({ read: () => settings,
      setAuto: async enabled => { writes++; settings.agentboxAutoDefault = enabled },
      setModel: async (provider, model) => { writes++; Object.assign(settings, { defaultProvider: provider, defaultModel: model, agentboxDefaultModel: { provider, model } }) },
    }),
    ...overrides,
  })({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand: (name: string, cmd: any) => commands.set(name, cmd),
    setModel: async (model: any) => { selected.push(model); ctx.model = model; return true },
    events: { on: (name: string, fn: any) => events.set(name, fn) } } as any)
  return { ctx, notices, settings, selected, confirm: () => { confirmed = true }, writes: () => writes,
    start: (reason?: string) => handlers.get("session_start")({ reason }, ctx),
    event: (name: string) => handlers.get(name)({}, ctx),
    command: (args: string) => commands.get("agentbox-defaults").handler(args, ctx),
    enabled: () => { let result = false; events.get("agentbox:auto-query")({ reply: (v: boolean) => result = v }); return result },
    tool: (toolName: string, input: any) => handlers.get("tool_call")({ toolName, input }, ctx),
  }
}
for (const saved of [undefined, false, "true", 1, {}, true]) {
  for (const reason of [undefined, "startup", "new", "resume", "reload", "fork"]) {
    const h = harness(saved)
    await h.start(reason)
    assert.equal(h.enabled(), saved === true && ["startup", "new"].includes(reason!))
  }
}
for (const overrides of [
  { env: { PI_WORKFLOW_CHILD: "1" } },
  { env: { PI_WORKFLOW_APPROVAL_VERSION: "1" } },
  { defaultsStore: async () => { throw Error("unreadable") } },
  { defaultsStore: async () => ({ read() { throw Error("invalid JSON") } }) },
  { readFile: async () => "{" },
]) {
  const probe = harness(true, true, overrides)
  await probe.start("startup")
  assert.equal(probe.enabled(), false)
}
const disabled = harness(true, false)
await disabled.start("new")
assert.equal(disabled.enabled(), false)
for (const type of ["message", "compaction", "branch_summary"]) {
  const h = harness(true)
  h.ctx.sessionManager.getEntries = () => [{ type }]
  await h.start("startup")
  assert.equal(h.enabled(), false)
}
const fork = harness(true)
fork.settings.agentboxDefaultModel = { provider: "saved", model: "saved" }
fork.ctx.sessionManager.getHeader = () => ({ parentSession: "parent" })
await fork.start("startup")
assert.equal(fork.enabled(), false)
assert.deepEqual(fork.selected, [])
const h = harness(true)
await h.start("new")
assert.equal(h.enabled(), true)
assert.equal(await h.tool("read", { path: "README.md" }), undefined)
assert.equal((await h.tool("write", { path: "README.md" })).block, true)
assert.equal((await h.tool("write", { path: "/etc/pi/agentbox-policy.json" })).block, true)
await h.command("auto off")
assert.equal(h.settings.agentboxAutoDefault, false)
assert.equal(h.enabled(), true)
await h.command("auto on")
assert.equal(h.writes(), 1)
h.ctx.hasUI = false
await h.command("auto on")
assert.equal(h.writes(), 1)
h.ctx.hasUI = true
h.confirm()
await h.command("auto on")
await h.command("model current")
assert.equal(h.settings.defaultProvider, "example")
assert.equal(h.settings.defaultModel, "model")
assert.equal(h.settings.theme, "dark")
for (const arg of ["status", "", "model", "auto yes", "model current extra"]) await h.command(arg)
h.ctx.model = undefined
await h.command("model current")
assert.equal(h.writes(), 3)
assert.ok(h.notices.some(text => text.includes("Global defaults")))
await h.event("session_tree")
assert.equal(h.enabled(), false)

let release!: (store: any) => void
const racing = harness(true, true, { defaultsStore: () => new Promise(resolve => { release = resolve }) })
const pending = racing.start("new")
while (!release) await new Promise(resolve => setTimeout(resolve, 0))
await racing.event("session_shutdown")
release({ read: () => ({ agentboxAutoDefault: true, agentboxDefaultModel: { provider: "saved", model: "saved" } }) })
await pending
assert.equal(racing.enabled(), false)
assert.deepEqual(racing.selected, [])
const failing = harness(false, true, { defaultsStore: async () => ({ setAuto: async () => { throw Error("write failed") } }) })
await failing.command("auto off")
assert.ok(failing.notices.some(text => text.includes("not confirmed saved")))
const cancelled = harness(false)
cancelled.ctx.ui.confirm = async () => { await cancelled.event("session_shutdown"); return true }
await cancelled.command("auto on")
assert.equal(cancelled.writes(), 0)

// An explicitly saved default survives Pi's ordinary last-selected settings.
for (const available of [true, false]) {
  for (const reason of ["startup", "new", "resume", "reload", "fork"]) {
    const probe = harness(false, available)
    await probe.command("model current")
    Object.assign(probe.settings, { defaultProvider: "other", defaultModel: "temporary" })
    probe.ctx.model = { provider: "other", id: "temporary" }
    await probe.start(reason)
    assert.equal(probe.selected.length, ["startup", "new"].includes(reason) ? 1 : 0)
    await probe.command("status")
    assert.match(probe.notices.at(-1)!, /model example\/model;/)
  }
}
for (const overrides of [
  { env: { PI_WORKFLOW_CHILD: "1" } },
  { env: { PI_WORKFLOW_APPROVAL_VERSION: "1" } },
  ...["--model", "--provider", "--models", "--model=x", "--provider=x", "--models=x"].map(flag => ({ argv: [flag] })),
]) {
  const probe = harness(false, true, overrides)
  probe.settings.agentboxDefaultModel = { provider: "saved", model: "saved" }
  await probe.start("startup")
  assert.deepEqual(probe.selected, [])
}
for (const entries of [[{ type: "message" }], [{ type: "compaction" }], [{ type: "branch_summary" }]]) {
  const probe = harness(false)
  probe.settings.agentboxDefaultModel = { provider: "saved", model: "saved" }
  probe.ctx.sessionManager.getEntries = () => entries
  await probe.start("startup")
  assert.deepEqual(probe.selected, [])
}
for (const saved of [undefined, null, [], {}, { provider: "x" }, { provider: "", model: "x" }]) {
  const probe = harness(false)
  probe.settings.agentboxDefaultModel = saved
  await probe.start("startup")
  assert.deepEqual(probe.selected, [])
}
const unavailable = harness(false)
unavailable.settings.agentboxDefaultModel = { provider: "missing", model: "missing" }
unavailable.ctx.modelRegistry.find = () => undefined
await unavailable.start("startup")
assert.deepEqual(unavailable.selected, [])
assert.match(unavailable.notices.at(-1)!, /unavailable/)
assert.deepEqual(unavailable.settings.agentboxDefaultModel, { provider: "missing", model: "missing" })

// Integration against the installed Pi package; no global user files touched.
if (process.argv[2]) {
  const root = mkdtempSync(join(tmpdir(), "pi-defaults-"))
  try {
    const agentDir = join(root, "agent"), cwd = join(root, "project")
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ agentboxAutoDefault: true }))
    const emptySession = join(root, "empty-session.jsonl")
    writeFileSync(emptySession, "")
    const restored = harness(true)
    restored.settings.agentboxDefaultModel = { provider: "saved", model: "saved" }
    restored.ctx.sessionManager.getSessionFile = () => emptySession
    await restored.start("startup")
    assert.equal(restored.enabled(), false)
    assert.deepEqual(restored.selected, [])
    const freshFile = harness(true)
    freshFile.ctx.sessionManager.getSessionFile = () => join(root, "not-yet-written.jsonl")
    await freshFile.start("startup")
    assert.equal(freshFile.enabled(), true)
    const sdk = await import(pathToFileURL(join(process.argv[2], "dist/index.js")).href)
    const load = async () => ({ ...sdk, getAgentDir: () => agentDir })
    const store = await createAgentboxDefaultsStore(cwd, load)
    assert.deepEqual(store.read(), {}) // project value is ignored
    await store.setAuto(true)
    const path = join(agentDir, "settings.json")
    const other = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: false })
    await store.setModel("example", "model-id")
    other.setTheme("light") // stale SDK instance must preserve our fields
    await other.flush()
    assert.deepEqual(store.read(), { agentboxAutoDefault: true, defaultProvider: "example", defaultModel: "model-id", theme: "light",
      agentboxDefaultModel: { provider: "example", model: "model-id" } })
    other.setDefaultModelAndProvider("temporary", "selection")
    await other.flush()
    assert.deepEqual(store.read().agentboxDefaultModel, { provider: "example", model: "model-id" })
    await store.setAuto(false)
    assert.equal(store.read().agentboxAutoDefault, false)
    // Exercise actual Jiti SDK import resolution, not only the injected store.
    const envKeys = ["PI_CODING_AGENT_DIR", "PI_WORKFLOW_CHILD", "PI_WORKFLOW_APPROVAL_VERSION"]
    const originalEnv = envKeys.map(key => process.env[key])
    try {
      process.env.PI_CODING_AGENT_DIR = agentDir
      delete process.env.PI_WORKFLOW_CHILD
      delete process.env.PI_WORKFLOW_APPROVAL_VERSION
      const { loadExtensions } = await import(pathToFileURL(join(process.argv[2], "dist/core/extensions/loader.js")).href)
      const loaded = await loadExtensions([new URL("../extensions/pi-policy.ts", import.meta.url).pathname], cwd)
      assert.deepEqual(loaded.errors, [])
      const command = loaded.extensions[0].commands.get("agentbox-defaults")
      assert.ok(command)
      const ctx = harness(false).ctx
      const notifications: string[] = []
      ctx.cwd = cwd
      ctx.ui.notify = (text: string) => notifications.push(text)
      await command.handler("model current", ctx)
      assert.equal(store.read().defaultProvider, "example")
      assert.equal(store.read().defaultModel, "model")
      assert.ok(notifications.some(text => text.includes("Global defaults")), notifications.join("\n"))
    } finally {
      envKeys.forEach((key, index) => {
        if (originalEnv[index] === undefined) delete process.env[key]
        else process.env[key] = originalEnv[index]
      })
    }
    for (const malformed of ["{", "[]", "null"]) {
      writeFileSync(path, malformed)
      assert.throws(() => store.read())
      await assert.rejects(store.setAuto(true))
      await assert.rejects(store.setModel("x", "y"))
      assert.equal(readFileSync(path, "utf8"), malformed)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}
console.log("pi persistent defaults tests passed")
