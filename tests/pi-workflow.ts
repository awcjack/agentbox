import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { createPiWorkflowExtension } from "../extensions/pi-workflow.ts"

type Handler = (event: any, ctx: any) => Promise<any> | any

function harness(dependencies: any = {}) {
  const handlers = new Map<string, Handler[]>()
  const tools = new Map<string, any>()
  const entries: any[] = []
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool)
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data })
    },
  } as any
  createPiWorkflowExtension(dependencies)(pi)
  return { handlers, tools, entries, handler: (name: string) => handlers.get(name)![0] }
}

function context(entries: any[] = [], overrides: any = {}) {
  return {
    cwd: "/workspace/project",
    mode: "tui",
    hasUI: true,
    model: { provider: "parent-provider", id: "parent-model" },
    thinkingLevel: "medium",
    sessionManager: { getBranch: () => entries },
    ui: {
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
const parallel = await task.execute("task-1", {
  jobs: [
    { role: "reviewer", prompt: "review one" },
    { role: "scout", prompt: "scout two" },
    { role: "scout", prompt: "scout three" },
  ],
  concurrency: 9,
}, undefined, undefined, context())
assert.equal(parallel.details.concurrency, 2)
assert.equal(peakActive, 2)
assert.equal(parallel.details.results.length, 3)
assert.equal(parallel.details.results[0].status, "completed")
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
assert.deepEqual(reviewerCall.options.stdio, ["pipe", "pipe", "pipe"])

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
