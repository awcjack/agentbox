import { strict as assert } from "node:assert"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { EventEmitter } from "node:events"
import { createPiWorkflowExtension } from "../extensions/pi-workflow.ts"

type Handler = (event: any, ctx: any) => Promise<any> | any

function harness(dependencies: any = {}, commands: any[] = []) {
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, any>()
  const entries: any[] = []
  const registeredCommands = new Map<string, any>()
  const pi = {
    getCommands: () => commands,
    setModel: () => { throw new Error("Must not change parent model") },
    setThinkingLevel: () => { throw new Error("Must not change parent thinking") },
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerCommand(name: string, command: any) { registeredCommands.set(name, command) },
    registerTool(tool: any) {
      tools.set(tool.name, tool)
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data })
    },
  } as any
  createPiWorkflowExtension(dependencies)(pi)
  return { handlers, tools, entries, registeredCommands, handler: (name: string) => handlers.get(name)![0] }
}

function context(entries: any[] = [], overrides: any = {}) {
  return {
    cwd: "/workspace/project",
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    model: { provider: "parent-provider", id: "parent-model" },
    thinkingLevel: "medium",
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: () => {},
      select: async () => undefined,
      input: async () => undefined,
    },
    ...overrides,
  }
}

const workflow = harness()
assert.deepEqual([...workflow.tools.keys()], ["todo", "question", "task"])
await workflow.handler("session_start")({}, context())

const todo = workflow.tools.get("todo")
const added = await todo.execute("todo-1", { action: "add", text: "  Verify workflow  " })
assert.equal(added.details.item.id, 1)
assert.equal(added.details.item.text, "Verify workflow")
assert.equal(workflow.entries.at(-1).customType, "pi-workflow.todos")
assert.equal(workflow.entries.at(-1).data.items[0].status, "pending")

await todo.execute("todo-2", { action: "set_status", id: 1, status: "completed" })
const persistedTodos = workflow.entries.filter((entry) => entry.customType === "pi-workflow.todos")
const restored = harness()
await restored.handler("session_start")({}, context(persistedTodos))
const restoredList = await restored.tools.get("todo").execute("todo-3", { action: "list" })
assert.match(restoredList.content[0].text, /\[x\] #1 Verify workflow/)

// State follows the active branch, not unrelated snapshots later in getEntries().
await restored.handler("session_tree")({}, context([persistedTodos[0]]))
const branchList = await restored.tools.get("todo").execute("todo-4", { action: "list" })
assert.match(branchList.content[0].text, /\[ \] #1 Verify workflow/)

const question = workflow.tools.get("question")
let nonTuiCalled = false
const unsupported = await question.execute("question-1", {
  question: "Proceed?",
  options: [{ label: "Yes" }, { label: "No" }],
}, undefined, undefined, context([], {
  mode: "print",
  hasUI: false,
  ui: { select: async () => { nonTuiCalled = true } },
}))
assert.equal(unsupported.details.status, "unsupported")
assert.equal(nonTuiCalled, false)

let displayedOptions: string[] = []
const selected = await question.execute("question-2", {
  question: "Choose",
  options: [{ label: "Alpha", description: "first" }, { label: "Beta" }],
  allowCustom: false,
}, undefined, undefined, context([], {
  ui: {
    select: async (_title: string, options: string[]) => {
      displayedOptions = options
      return options[1]
    },
  },
}))
assert.deepEqual(displayedOptions, ["1. Alpha - first", "2. Beta"])
assert.equal(selected.details.answer, "Beta")

const customAnswer = await question.execute("question-3", {
  question: "Choose",
  options: [{ label: "Alpha" }],
}, undefined, undefined, context([], {
  ui: {
    select: async (_title: string, options: string[]) => options.at(-1),
    input: async () => "  another answer  ",
  },
}))
assert.equal(customAnswer.details.answer, "another answer")
assert.equal(customAnswer.details.custom, true)

const rpcAnswer = await question.execute("question-rpc", {
  question: "Choose over RPC",
  options: [{ label: "RPC answer" }],
  allowCustom: false,
}, undefined, undefined, context([], {
  mode: "rpc",
  hasUI: true,
  ui: { select: async (_title: string, options: string[]) => options[0] },
}))
assert.equal(rpcAnswer.details.answer, "RPC answer")

const config = JSON.stringify({
  maxConcurrency: 2,
  maxJobs: 4,
  maxOutputBytes: 1024,
  defaultMaxSteps: 7,
  roles: {
    reviewer: {
      provider: "anthropic",
      model: "claude-test",
      thinking: "high",
      systemPrompt: "Review carefully.",
      maxSteps: 3,
    },
    scout: { provider: null, model: null, thinking: null, maxSteps: 2 },
  },
})

interface SpawnCall {
  command: string
  args: string[]
  options: any
  stdin?: string
}

const spawnCalls: SpawnCall[] = []
let active = 0
let peakActive = 0
function successfulSpawn(command: string, args: string[], options: any) {
  const call: SpawnCall = { command, args, options }
  spawnCalls.push(call)
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = new EventEmitter()
  proc.stdin.end = (prompt: string) => { call.stdin = prompt }
  proc.kill = (_signal: string) => true
  active++
  peakActive = Math.max(peakActive, active)
  setTimeout(() => {
    const taskId = args[args.indexOf(args.includes("--session-id") ? "--session-id" : "--session") + 1]
    const notice = `Warning: No project session found with id '${taskId}'; creating a new session with that id.\r\n`
    proc.stderr.emit("data", Buffer.from(notice.slice(0, 35)))
    proc.stderr.emit("data", Buffer.from(notice.slice(35)))
    if (call.stdin === "scout two") proc.stderr.emit("data", "Warning: unrelated diagnostic\n")
    proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: `result for ${call.stdin}` }], stopReason: "stop" },
    })}\n`))
    active--
    proc.emit("close", 0)
  }, 5)
  return proc
}

const tasks = harness({
  readFile: async (path: string) => {
    assert.equal(path, "/managed/workflow.json")
    return config
  },
  randomUUID: (() => {
    let id = 0
    return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`
  })(),
  getPiInvocation: (args: string[]) => ({ command: "/nix/store/pi/bin/node", args: ["/nix/store/pi/dist/cli.js", ...args] }),
  spawn: successfulSpawn,
})
await tasks.handler("session_start")({}, context())
const originalConfigPath = process.env.PI_WORKFLOW_CONFIG
process.env.PI_WORKFLOW_CONFIG = "/managed/workflow.json"

const task = tasks.tools.get("task")
const updates: any[] = []
const parallel = await task.execute("task-1", {
  jobs: [
    { role: "reviewer", prompt: "review one" },
    { role: "scout", prompt: "scout two" },
    { role: "scout", prompt: "scout three" },
  ],
  concurrency: 9,
}, undefined, (update: any) => updates.push(update.details), context())
assert.deepEqual(updates[0].jobs.map((job: any) => job.status), ["queued", "queued", "queued"])
assert.ok(updates.some((update) => update.jobs[0].status === "running" && update.jobs[1].status === "running" && update.jobs[2].status === "queued"))
assert.ok(updates.some((update) => update.jobs[0].status === "running" && update.jobs[0].steps === 1 && update.jobs[0].output === "result for review one"))
assert.deepEqual(parallel.details.jobs.map((job: any) => job.status), ["completed", "completed", "completed"])
assert.deepEqual(parallel.details.jobs.map((job: any) => job.prompt), ["review one", "scout two", "scout three"])
assert.equal(updates[1].jobs[0].steps, 0) // Previously published snapshots must not mutate.
assert.equal(parallel.details.concurrency, 2)
assert.equal(peakActive, 2)
assert.equal(parallel.details.results.length, 3)
assert.equal(parallel.details.results[0].status, "completed")
assert.equal(parallel.details.results[0].stderr, "")
assert.equal(parallel.details.results[1].stderr, "Warning: unrelated diagnostic")
assert.match(parallel.content[0].text, /result for review one/)
assert.equal(tasks.entries.at(-1).customType, "pi-workflow.tasks")

const reviewerCall = spawnCalls[0]
assert.equal(reviewerCall.command, "/nix/store/pi/bin/node")
assert.equal(reviewerCall.args[0], "/nix/store/pi/dist/cli.js")
assert.deepEqual(reviewerCall.args.slice(1), [
  "--mode", "json", "-p", "--exclude-tools", "task",
  "--session-id", parallel.details.results[0].taskId,
  "--provider", "anthropic",
  "--model", "claude-test",
  "--thinking", "high",
  "--system-prompt", "Review carefully.",
])
assert.equal(reviewerCall.args.includes("review one"), false)
assert.equal(reviewerCall.stdin, "review one")
assert.equal(reviewerCall.options.shell, false)
assert.equal(reviewerCall.options.cwd, "/workspace/project")
assert.equal(reviewerCall.options.env.PI_WORKFLOW_CHILD, "1")
assert.deepEqual(reviewerCall.options.stdio, ["pipe", "pipe", "pipe", "pipe", "pipe"])
assert.equal(reviewerCall.options.env.PI_WORKFLOW_APPROVAL_VERSION, "1")

const scoutCall = spawnCalls[1]
assert.deepEqual(scoutCall.args.slice(-6), [
  "--provider", "parent-provider",
  "--model", "parent-model",
  "--thinking", "medium",
])
assert.equal(scoutCall.stdin, "scout two")

const originalWrapper = process.env.PI_AGENTBOX_PI_WRAPPER
process.env.PI_AGENTBOX_PI_WRAPPER = process.execPath
const wrappedSpawnCalls: SpawnCall[] = []
const wrapperChild = harness({
  readFile: async () => config,
  randomUUID: () => "wrapper-child",
  spawn: (command: string, args: string[], options: any) => {
    const proc = successfulSpawn(command, args, options)
    wrappedSpawnCalls.push(spawnCalls.at(-1)!)
    return proc
  },
})
await wrapperChild.handler("session_start")({}, context())
await wrapperChild.tools.get("task").execute("task-wrapper", {
  role: "scout",
  prompt: "use managed wrapper",
}, undefined, undefined, context())
assert.equal(wrappedSpawnCalls[0].command, process.execPath)
assert.equal(wrappedSpawnCalls[0].stdin, "use managed wrapper")
if (originalWrapper === undefined) delete process.env.PI_AGENTBOX_PI_WRAPPER
else process.env.PI_AGENTBOX_PI_WRAPPER = originalWrapper

const taskState = tasks.entries.find((entry) => entry.customType === "pi-workflow.tasks")
const resumeId = parallel.details.results[0].taskId
const resumedHarness = harness({
  readFile: async () => config,
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: successfulSpawn,
})
await resumedHarness.handler("session_start")({}, context([taskState]))
const resumed = await resumedHarness.tools.get("task").execute("task-2", {
  role: "reviewer",
  prompt: "continue review",
  resume: resumeId,
}, undefined, undefined, context([taskState]))
assert.equal(resumed.details.results[0].resumed, true)
assert.match(resumed.details.results[0].stderr, /No project session found/, "resume diagnostics must remain visible")
assert.equal(resumed.details.results[0].taskId, resumeId)
assert.deepEqual(spawnCalls.at(-1)!.args.slice(0, 7), ["--mode", "json", "-p", "--exclude-tools", "task", "--session", resumeId])
assert.equal(spawnCalls.at(-1)!.stdin, "continue review")

const unknownResumeCallCount = spawnCalls.length
const unknownResume = await resumedHarness.tools.get("task").execute("task-3", {
  role: "reviewer",
  prompt: "continue",
  resume: "pi-workflow-not-issued",
}, undefined, undefined, context([taskState]))
assert.equal(unknownResume.details.results[0].status, "failed")
assert.equal(spawnCalls.length, unknownResumeCallCount)

let cancellationSignal = ""
let markCancellationStarted: () => void = () => {}
const cancellationStarted = new Promise<void>((resolve) => {
  markCancellationStarted = resolve
})
const cancellable = harness({
  readFile: async () => config,
  randomUUID: () => "cancel-id",
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: () => {
    markCancellationStarted()
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = new EventEmitter()
    proc.stdin.end = () => {}
    proc.kill = (signal: string) => {
      cancellationSignal = signal
      queueMicrotask(() => proc.emit("close", null))
      return true
    }
    return proc
  },
})
await cancellable.handler("session_start")({}, context())
const controller = new AbortController()
const cancelling = cancellable.tools.get("task").execute("task-4", {
  role: "scout",
  prompt: "wait",
}, controller.signal, undefined, context())
await cancellationStarted
controller.abort()
const cancelled = await cancelling
assert.equal(cancellationSignal, "SIGTERM")
assert.equal(cancelled.details.results[0].status, "cancelled")

let boundedKill = ""
const bounded = harness({
  readFile: async () => JSON.stringify({ maxOutputBytes: 1024, roles: { scout: { maxSteps: 1 } } }),
  randomUUID: () => "bounded-id",
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: () => {
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = new EventEmitter()
    proc.stdin.end = () => {}
    proc.kill = (signal: string) => {
      boundedKill = signal
      queueMicrotask(() => proc.emit("close", null))
      return true
    }
    queueMicrotask(() => {
      proc.stderr.emit("data", Buffer.alloc(4_096, 120))
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "y".repeat(4_096) }], stopReason: "toolUse" },
      })}\n`))
    })
    return proc
  },
})
await bounded.handler("session_start")({}, context())
const limited = await bounded.tools.get("task").execute("task-5", { role: "scout", prompt: "loop" }, undefined, undefined, context())
assert.equal(boundedKill, "SIGTERM")
assert.equal(limited.details.results[0].status, "step_limit")
assert.equal(limited.details.results[0].outputTruncated, true)
assert.equal(limited.details.results[0].stderr.length <= 1024, true)
assert.equal(limited.details.results[0].stderrTruncated, true)

let releaseResume: (() => void) | undefined
let duplicateSpawnCount = 0
const duplicateResume = harness({
  readFile: async () => config,
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: () => {
    duplicateSpawnCount++
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = new EventEmitter()
    proc.stdin.end = () => {}
    proc.kill = () => true
    releaseResume = () => {
      proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "resumed" }], stopReason: "stop" },
      })}\n`))
      proc.emit("close", 0)
    }
    return proc
  },
})
await duplicateResume.handler("session_start")({}, context([taskState]))
const firstResume = duplicateResume.tools.get("task").execute("task-resume-1", {
  role: "reviewer",
  prompt: "first active resume",
  resume: resumeId,
}, undefined, undefined, context([taskState]))
await new Promise((resolve) => setTimeout(resolve, 0))
const rejectedResume = await duplicateResume.tools.get("task").execute("task-resume-2", {
  role: "reviewer",
  prompt: "duplicate active resume",
  resume: resumeId,
}, undefined, undefined, context([taskState]))
assert.equal(rejectedResume.details.results[0].status, "failed")
assert.match(rejectedResume.details.results[0].output, /already being resumed/)
assert.equal(duplicateSpawnCount, 1)
releaseResume!()
assert.equal((await firstResume).details.results[0].status, "completed")

async function terminalReason(stopReason: "error" | "aborted", errorMessage: string) {
  let killSignal = ""
  const notice = `Warning: No project session found with id 'pi-workflow-reason-${stopReason}'; creating a new session with that id.`
  const reasonHarness = harness({
    readFile: async () => config,
    randomUUID: () => `reason-${stopReason}`,
    getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
    spawn: () => {
      const proc = new EventEmitter() as any
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.stdin = new EventEmitter()
      proc.stdin.end = () => {
        queueMicrotask(() => {
          proc.stderr.emit("data", `${notice}\n`)
          proc.stdout.emit("data", Buffer.from(`${JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [], stopReason, errorMessage },
          })}\n`))
          proc.emit("close", 0)
        })
      }
      proc.kill = (signal: string) => { killSignal = signal; return true }
      return proc
    },
  })
  await reasonHarness.handler("session_start")({}, context())
  const result = await reasonHarness.tools.get("task").execute(
    `task-${stopReason}`,
    { role: "reviewer", prompt: "terminal reason" },
    undefined,
    undefined,
    context(),
  )
  assert.equal(killSignal, "")
  assert.equal(result.details.results[0].output, errorMessage)
  assert.equal(result.details.results[0].stderr, notice, "failed and cancelled jobs retain all diagnostics")
  return result.details.results[0].status
}
assert.equal(await terminalReason("error", "provider failed"), "failed")
assert.equal(await terminalReason("aborted", "provider aborted"), "cancelled")

let invalidJsonKill = ""
const invalidJson = harness({
  readFile: async () => config,
  randomUUID: () => "invalid-json",
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: () => {
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = new EventEmitter()
    proc.stdin.end = () => queueMicrotask(() => proc.stdout.emit("data", Buffer.from("not-json\n")))
    proc.kill = (signal: string) => {
      invalidJsonKill = signal
      queueMicrotask(() => proc.emit("close", null))
      return true
    }
    return proc
  },
})
await invalidJson.handler("session_start")({}, context())
const invalidResult = await invalidJson.tools.get("task").execute(
  "task-invalid-json",
  { role: "scout", prompt: "invalid output" },
  undefined,
  undefined,
  context(),
)
assert.equal(invalidJsonKill, "SIGTERM")
assert.equal(invalidResult.details.results[0].status, "failed")
assert.match(invalidResult.details.results[0].output, /Invalid JSON event/)

let oversizedEventKill = ""
const oversizedEvent = harness({
  readFile: async () => config,
  randomUUID: () => "oversized-event",
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: () => {
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = new EventEmitter()
    proc.stdin.end = () => queueMicrotask(() => proc.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1, 120)))
    proc.kill = (signal: string) => {
      oversizedEventKill = signal
      queueMicrotask(() => proc.emit("close", null))
      return true
    }
    return proc
  },
})
await oversizedEvent.handler("session_start")({}, context())
const oversizedResult = await oversizedEvent.tools.get("task").execute(
  "task-oversized-event",
  { role: "scout", prompt: "oversized output" },
  undefined,
  undefined,
  context(),
)
assert.equal(oversizedEventKill, "SIGTERM")
assert.equal(oversizedResult.details.results[0].status, "failed")
assert.match(oversizedResult.details.results[0].output, /JSON event exceeds 1048576 bytes/)

// Per-invocation routing is independent for each field and never changes the parent.
const parent = context()
Object.freeze(parent.model)
Object.freeze(parent)
const routed = harness({
  readFile: async () => config,
  randomUUID: (() => { let id = 0; return () => `routing-${++id}` })(),
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: successfulSpawn,
})
const route = (params: any) => routed.tools.get("task").execute("routing", params, undefined, undefined, parent)
const flag = (call: SpawnCall, name: string) => call.args[call.args.indexOf(name) + 1]
const firstRoute = await route({ role: "reviewer", prompt: "override", provider: "custom-provider", model: "vendor/model:v2" })
assert.equal(flag(spawnCalls.at(-1)!, "--provider"), "custom-provider")
assert.equal(flag(spawnCalls.at(-1)!, "--model"), "vendor/model:v2")
assert.equal(flag(spawnCalls.at(-1)!, "--thinking"), "high")
const batchStart = spawnCalls.length
await route({ jobs: [
  { role: "reviewer", prompt: "model only", model: "other-model" },
  { role: "scout", prompt: "provider only", provider: "other-provider" },
  { role: "reviewer", prompt: "both", provider: "batch-provider", model: "batch-model" },
  { role: "scout", prompt: "inherit" },
] })
assert.deepEqual(spawnCalls.slice(batchStart).map((call) => [flag(call, "--provider"), flag(call, "--model")]), [
  ["anthropic", "other-model"], ["other-provider", "parent-model"], ["batch-provider", "batch-model"], ["parent-provider", "parent-model"],
])
const routingId = firstRoute.details.results[0].taskId
await route({ role: "reviewer", prompt: "resume override", resume: routingId, provider: "resume-provider", model: "resume-model" })
assert.equal(flag(spawnCalls.at(-1)!, "--session"), routingId)
assert.equal(flag(spawnCalls.at(-1)!, "--provider"), "resume-provider")
assert.equal(flag(spawnCalls.at(-1)!, "--model"), "resume-model")
await route({ jobs: [{ role: "reviewer", prompt: "resume default", resume: routingId }] })
assert.equal(flag(spawnCalls.at(-1)!, "--model"), "claude-test", "overrides are not persisted across invocations")
assert.deepEqual(parent.model, { provider: "parent-provider", id: "parent-model" })
assert.equal(parent.thinkingLevel, "medium")
for (const bad of ["", " ", null, 42, " model", "model\nname", "-p", "nul\0value", "x".repeat(257)]) {
  for (const key of ["provider", "model", "skill"]) {
    const before = spawnCalls.length
    const invalid = await route({ jobs: [{ role: "scout", prompt: "valid" }, { role: "scout", prompt: "invalid", [key]: bad }] })
    assert.equal(invalid.isError, true, `${key}: ${JSON.stringify(bad)}`)
    assert.equal(spawnCalls.length, before, "preflight must not start part of an invalid batch")
  }
}
for (const invalid of [
  { jobs: [], provider: "ignored" }, { jobs: [] }, { jobs: "bad" },
  { jobs: [{ role: "scout", prompt: "ok" }], model: "ignored" },
  { role: "scout" }, { jobs: [null] }, { role: "scout", prompt: " " },
]) {
  const before = spawnCalls.length
  assert.equal((await route(invalid)).isError, true)
  assert.equal(spawnCalls.length, before)
}

// Real files, with the same metadata shape supplied by Pi's discovered commands.
const skillDir = await mkdtemp(join(tmpdir(), "pi-workflow-skill-"))
try {
  const skillPath = join(skillDir, "SKILL.md")
  const content = "---\nname: test-skill\ndescription: Test skill\n---\nFollow references/guide.md and output SKILL_LOADED.\n"
  await writeFile(skillPath, content)
  let sourceInfo = { path: skillPath, scope: "project", source: "local", origin: "top-level", baseDir: skillDir }
  // Nix supplies the pinned Pi module so this also checks its real discovery metadata.
  if (process.argv[2]) {
    const { loadSkillsFromDir } = await import(pathToFileURL(join(process.argv[2], "dist/core/skills.js")).href)
    const discovered = loadSkillsFromDir({ dir: skillDir, source: "project" })
    assert.equal(discovered.skills.length, 1)
    assert.equal(discovered.skills[0].name, "test-skill", "name comes from frontmatter, not the directory")
    sourceInfo = discovered.skills[0].sourceInfo
    assert.equal(sourceInfo.path, skillPath)
  }
  const commands: any[] = [
    { name: "skill:test-skill", source: "prompt", sourceInfo: { path: "/not-a-skill" } },
    { name: "skill:test-skill", source: "skill", sourceInfo },
  ]
  const skillHarness = harness({
    readFile: async (path: string) => path === "/managed/workflow.json" ? config : readFile(path, "utf8"),
    randomUUID: (() => { let id = 0; return () => `skill-${++id}` })(),
    getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
    spawn: successfulSpawn,
  }, commands)
  const runSkill = (params: any) => skillHarness.tools.get("task").execute("skill", params, undefined, undefined, parent)
  const skillResult = await runSkill({ role: "scout", skill: "test-skill", provider: "skill-provider", model: "skill-model" })
  assert.equal(skillResult.details.results[0].status, "completed")
  assert.ok(spawnCalls.at(-1)!.stdin!.includes(content))
  assert.ok(spawnCalls.at(-1)!.stdin!.includes(`location="${skillPath}"`))
  assert.ok(spawnCalls.at(-1)!.stdin!.includes(`resolve against: ${skillDir}`))
  assert.equal(flag(spawnCalls.at(-1)!, "--provider"), "skill-provider")
  assert.equal(flag(spawnCalls.at(-1)!, "--model"), "skill-model")
  assert.equal(spawnCalls.at(-1)!.args.some((arg) => arg.includes(content)), false)
  await runSkill({ jobs: [{ role: "scout", skill: "test-skill", prompt: "review file.ts", resume: skillResult.details.results[0].taskId, model: "new-skill-model" }] })
  assert.ok(spawnCalls.at(-1)!.stdin!.endsWith("User: review file.ts"))
  assert.equal(flag(spawnCalls.at(-1)!, "--model"), "new-skill-model")
  for (const name of ["missing", "../test-skill", "/skill:test-skill", skillPath]) {
    const before = spawnCalls.length
    const result = await runSkill({ role: "scout", skill: name })
    assert.equal(result.isError, true)
    assert.equal(spawnCalls.length, before)
  }
  // Discovery metadata is queried on each call, so reload/removal is respected.
  commands.pop()
  assert.equal((await runSkill({ role: "scout", skill: "test-skill" })).isError, true)
  commands.push({ name: "skill:test-skill", source: "skill", sourceInfo: { path: "relative/SKILL.md" } })
  assert.equal((await runSkill({ role: "scout", skill: "test-skill" })).isError, true)
  commands.at(-1).sourceInfo.path = skillPath
  for (const body of ["", "x".repeat(1024 * 1024 + 1)]) {
    await writeFile(skillPath, body)
    const before = spawnCalls.length
    assert.equal((await runSkill({ role: "scout", skill: "test-skill" })).isError, true)
    assert.equal(spawnCalls.length, before)
  }
  await rm(skillPath)
  const before = spawnCalls.length
  assert.equal((await runSkill({ role: "scout", skill: "test-skill" })).isError, true)
  assert.equal(spawnCalls.length, before)
} finally {
  await rm(skillDir, { recursive: true, force: true })
}

// With no configured override the managed default is four across calls, not four per call.
peakActive = 0
const defaultShared = harness({
  readFile: async () => JSON.stringify({ roles: { scout: {} } }),
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: successfulSpawn,
})
await Promise.all(Array.from({ length: 3 }, (_, index) => defaultShared.tools.get("task").execute(`default-${index}`, {
  jobs: Array.from({ length: 3 }, (_, job) => ({ role: "scout", prompt: `${index}/${job}` })),
}, undefined, () => { throw new Error("broken UI observer") }, context())))
assert.equal(peakActive, 4)
assert.equal(active, 0)
peakActive = 0
await Promise.all(Array.from({ length: 2 }, (_, index) => defaultShared.tools.get("task").execute(`serial-${index}`, {
  jobs: Array.from({ length: 3 }, (_, job) => ({ role: "scout", prompt: `${index}/${job}` })), concurrency: 1,
}, undefined, undefined, context())))
assert.equal(peakActive, 2, "per-call concurrency can still lower parallelism")

// Shared FIFO spans overlapping calls, honors per-call limits, and skips aborted waiters.
const held: Array<{ prompt: string; close: () => void }> = []
let live = 0
let peak = 0
let throwSpawn = false
const shared = harness({
  readFile: async () => config,
  getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
  spawn: () => {
    if (throwSpawn) { throwSpawn = false; throw new Error("spawn failed") }
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = new EventEmitter()
    live++
    peak = Math.max(peak, live)
    const call = { prompt: "", close: () => { live--; proc.emit("close", 0) } }
    held.push(call)
    proc.stdin.end = (prompt: string) => { call.prompt = prompt }
    proc.kill = () => { queueMicrotask(call.close); return true }
    return proc
  },
})
const notices: Array<{ text: string; level: string }> = []
const settingsContext = context([], { ui: { notify: (text: string, level: string) => notices.push({ text, level }) } })
const settings = (args = "", ctx = settingsContext) => shared.registeredCommands.get("agentbox-subagents").handler(args, ctx)
const runShared = (prompt: string, signal?: AbortSignal) => shared.tools.get("task").execute(prompt,
  { role: "scout", prompt }, signal, undefined, context())
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
await settings()
assert.match(notices.at(-1)!.text, /concurrency: 2 .*session: default/)
await settings("1")
assert.deepEqual(shared.entries.at(-1), { type: "custom", customType: "pi-workflow.settings", data: { version: 1, maxConcurrency: 1 } })
const savedSetting = shared.entries.at(-1)
for (const value of ["0", "3", "-1", "1.5", "1e0", "NaN", "1 2", "bogus", "9007199254740993"]) {
  const before = shared.entries.length
  await settings(value)
  assert.equal(notices.at(-1)!.level, "error", value)
  assert.equal(shared.entries.length, before)
}
await settings("reset", { ...settingsContext, isIdle: () => false })
assert.equal(notices.at(-1)!.level, "warning")
assert.equal(shared.entries.at(-1), savedSetting)
const alreadyAborted = new AbortController()
alreadyAborted.abort()
assert.equal((await runShared("pre-aborted", alreadyAborted.signal)).details.results[0].status, "cancelled")
assert.equal(held.length, 0)
const first = runShared("first")
const abortQueued = new AbortController()
const skipped = runShared("skip", abortQueued.signal)
const third = runShared("third")
await tick()
assert.deepEqual(held.map((call) => call.prompt), ["first"])
await settings("reset")
assert.equal(notices.at(-1)!.level, "warning")
await settings("status")
assert.match(notices.at(-1)!.text, /running: 1; queued: 2/)
abortQueued.abort()
assert.equal((await skipped).details.results[0].status, "cancelled")
assert.equal(held.length, 1)
const fourth = runShared("fourth")
held[0].close()
await first
await tick()
assert.deepEqual(held.map((call) => call.prompt), ["first", "third"])
held[1].close()
await third
await tick()
assert.equal(held[2].prompt, "fourth")
held[2].close()
await fourth
assert.equal(peak, 1)
// Cancellation after a permit is granted but before the async continuation must not spawn.
const grantBlocker = runShared("grant blocker")
const grantAbort = new AbortController()
const grantWaiter = runShared("abort at grant", grantAbort.signal)
await tick()
const beforeGrant = held.length
held.at(-1)!.close()
grantAbort.abort()
await grantBlocker
assert.equal((await grantWaiter).details.results[0].status, "cancelled")
assert.equal(held.length, beforeGrant)
// Running cancellation keeps the permit until close, then unblocks the FIFO.
const runningAbort = new AbortController()
const runningCancelled = runShared("cancel running", runningAbort.signal)
const afterRunningCancel = runShared("after running cancellation")
await tick()
runningAbort.abort()
assert.equal((await runningCancelled).details.results[0].status, "cancelled")
await tick()
assert.equal(held.at(-1)!.prompt, "after running cancellation")
held.at(-1)!.close()
await afterRunningCancel
// A synchronous spawn failure must return its permit to the next caller.
throwSpawn = true
const failedSpawn = runShared("failure")
const afterFailure = runShared("after failure")
assert.equal((await failedSpawn).details.results[0].status, "failed")
await tick()
assert.equal(held.at(-1)!.prompt, "after failure")
held.at(-1)!.close()
await afterFailure
await settings("reset")
assert.deepEqual(shared.entries.at(-1).data, { version: 1, maxConcurrency: null })
const resetSetting = shared.entries.at(-1)
const a = runShared("a")
const b = runShared("b")
const c = runShared("c")
await tick()
assert.equal(live, 2)
assert.equal(peak, 2)
held.at(-2)!.close()
await a
await tick()
assert.equal(held.at(-1)!.prompt, "c")
held.at(-2)!.close()
held.at(-1)!.close()
await Promise.all([b, c])
// Restoration uses only the branch and ignores malformed settings snapshots.
await shared.handler("session_start")({}, context([savedSetting]))
await settings()
assert.match(notices.at(-1)!.text, /concurrency: 1/)
for (const data of [{ version: 2, maxConcurrency: 2 }, { version: 1, maxConcurrency: 0 }, { version: 1, maxConcurrency: "2" }]) {
  await shared.handler("session_tree")({}, context([savedSetting, { ...savedSetting, data }]))
  await settings()
  assert.match(notices.at(-1)!.text, /concurrency: 1/)
}
await shared.handler("session_tree")({}, context([savedSetting, resetSetting]))
await settings()
assert.match(notices.at(-1)!.text, /concurrency: 2 .*session: default/)
await shared.handler("session_tree")({}, context([]))
await settings()
assert.match(notices.at(-1)!.text, /session: default/)
// Old overrides can never raise a newly lowered managed cap.
await shared.handler("session_start")({}, context([{ ...savedSetting, data: { version: 1, maxConcurrency: 16 } }]))
await settings()
assert.match(notices.at(-1)!.text, /concurrency: 2/)
assert.ok(shared.tools.get("task").promptGuidelines.length >= 5)
// An invocation awaiting config is already busy, even before it has queued jobs.
let releaseConfig: (value: string) => void = () => {}
let configReads = 0
const preflight = harness({
  readFile: async () => ++configReads === 1 ? new Promise<string>((resolve) => { releaseConfig = resolve }) : config,
})
const invalidPreflight = preflight.tools.get("task").execute("preflight", { jobs: [] }, undefined, undefined, context())
await preflight.registeredCommands.get("agentbox-subagents").handler("1", settingsContext)
assert.equal(notices.at(-1)!.level, "warning")
assert.equal(preflight.entries.length, 0)
releaseConfig(config)
assert.equal((await invalidPreflight).isError, true)
await preflight.registeredCommands.get("agentbox-subagents").handler("1", settingsContext)
assert.deepEqual(preflight.entries.at(-1).data, { version: 1, maxConcurrency: 1 })
const badConfig = harness({ readFile: async () => "invalid json" })
await badConfig.registeredCommands.get("agentbox-subagents").handler("1", settingsContext)
assert.equal(notices.at(-1)!.level, "error")
assert.equal(badConfig.entries.length, 0)


function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

// A command belongs to the branch on which it started, not the branch at read completion.
for (const event of ["session_start", "session_tree"]) {
  for (const value of ["2", "reset"]) {
    const pendingConfig = deferred<string>()
    let reads = 0
    const staleCommand = harness({ readFile: async () => ++reads === 1 ? pendingConfig.promise : config })
    const update = staleCommand.registeredCommands.get("agentbox-subagents").handler(value, settingsContext)
    await staleCommand.handler(event)({}, context([savedSetting]))
    pendingConfig.resolve(config)
    await update
    assert.equal(staleCommand.entries.length, 0, `${event}/${value} must not write to the new branch`)
    assert.match(notices.at(-1)!.text, /Session or branch changed/)
    await staleCommand.registeredCommands.get("agentbox-subagents").handler("", settingsContext)
    assert.match(notices.at(-1)!.text, /concurrency: 1/)
  }
}

// Older task config must not raise a newer cap after either skill I/O or an out-of-order read.
for (const pause of ["skill", "config"]) {
  const olderRead = deferred<string>()
  const skillRead = deferred<string>()
  let reads = 0
  const closes: Array<() => void> = []
  let running = 0
  let maximum = 0
  const cap = (maxConcurrency: number) => JSON.stringify({ maxConcurrency, roles: { scout: {} } })
  const racing = harness({
    readFile: async (path: string) => {
      if (path === "/skills/race/SKILL.md") return skillRead.promise
      if (++reads === 1) return pause === "config" ? olderRead.promise : cap(4)
      return cap(1)
    },
    getPiInvocation: (args: string[]) => ({ command: "/exact/pi", args }),
    spawn: () => {
      const proc = new EventEmitter() as any
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.stdin = new EventEmitter()
      proc.stdin.end = () => {}
      proc.kill = () => true
      maximum = Math.max(maximum, ++running)
      closes.push(() => { running--; proc.emit("close", 0) })
      return proc
    },
  }, [{ name: "skill:race", source: "skill", sourceInfo: { path: "/skills/race/SKILL.md" } }])
  const execute = (params: any) => racing.tools.get("task").execute("race", params, undefined, undefined, context())
  const older = execute({ role: "scout", prompt: "older", ...(pause === "skill" ? { skill: "race" } : {}) })
  await tick()
  const newer = execute({ role: "scout", prompt: "newer" })
  await tick()
  assert.equal(closes.length, 1)
  olderRead.resolve(cap(4))
  skillRead.resolve("Review independently.")
  await tick()
  assert.equal(closes.length, 1, `${pause}: stale config must not raise the shared limit`)
  closes[0]()
  await newer
  await tick()
  assert.equal(closes.length, 2)
  closes[1]()
  await older
  assert.equal(maximum, 1)
}

// Branch restoration invalidates pending task reads and respects reset without stale spawns.
for (const entry of [savedSetting, resetSetting]) {
  const pendingConfig = deferred<string>()
  let reads = 0
  let spawned = false
  const changedBranch = harness({
    readFile: async () => ++reads === 1 ? pendingConfig.promise : config,
    spawn: () => { spawned = true; throw new Error("stale task spawned") },
  })
  const pendingTask = changedBranch.tools.get("task").execute("old branch", { role: "scout", prompt: "stale" }, undefined, undefined, context())
  await changedBranch.handler("session_tree")({}, context([entry]))
  pendingConfig.resolve(config)
  const staleResult = await pendingTask
  assert.equal(staleResult.isError, true)
  assert.match(staleResult.content[0].text, /Session or branch changed/)
  assert.equal(spawned, false)
  assert.equal(changedBranch.entries.length, 0)
  await changedBranch.registeredCommands.get("agentbox-subagents").handler("", settingsContext)
  assert.match(notices.at(-1)!.text, entry === savedSetting ? /concurrency: 1/ : /concurrency: 2/)
}
assert.ok(shared.tools.get("task").promptGuidelines.every((guideline: string) => /\btask\b/.test(guideline)))


const originalChild = process.env.PI_WORKFLOW_CHILD
process.env.PI_WORKFLOW_CHILD = "1"
const child = harness()
assert.deepEqual([...child.tools.keys()], ["todo", "question"])
const blocked = await child.handler("tool_call")({ toolName: "task" }, context())
assert.equal(blocked.block, true)
if (originalChild === undefined) delete process.env.PI_WORKFLOW_CHILD
else process.env.PI_WORKFLOW_CHILD = originalChild

if (originalConfigPath === undefined) delete process.env.PI_WORKFLOW_CONFIG
else process.env.PI_WORKFLOW_CONFIG = originalConfigPath

console.log("pi workflow extension tests passed")
