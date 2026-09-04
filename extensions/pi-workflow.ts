import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { spawn as nodeSpawn } from "node:child_process"
import { existsSync, promises as fs } from "node:fs"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"

const TODO_ENTRY = "pi-workflow.todos"
const TASK_ENTRY = "pi-workflow.tasks"
const DEFAULT_CONFIG_PATH = "/etc/agentbox/pi-workflow.json"
const DEFAULT_MAX_CONCURRENCY = 4
const DEFAULT_MAX_JOBS = 8
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024
const DEFAULT_MAX_STEPS = 20
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_JSON_EVENT_BYTES = 1024 * 1024
const KILL_GRACE_MS = 5_000
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
const TASK_ID_RE = /^pi-workflow-[A-Za-z0-9][A-Za-z0-9._-]*$/

type Spawn = typeof nodeSpawn

export interface PiWorkflowDependencies {
  spawn?: Spawn
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>
  randomUUID?: () => string
  getPiInvocation?: (args: string[]) => { command: string; args: string[] }
}

interface TodoItem {
  id: number
  text: string
  status: "pending" | "in_progress" | "completed"
}

interface TodoState {
  version: 1
  nextId: number
  items: TodoItem[]
}

interface RoleConfig {
  provider?: string
  model?: string
  thinking?: string
  systemPrompt?: string
  maxSteps: number
}

interface WorkflowConfig {
  maxConcurrency: number
  maxJobs: number
  maxOutputBytes: number
  defaultMaxSteps: number
  roles: Record<string, RoleConfig>
}

interface TaskJob {
  role: string
  prompt: string
  resume?: string
}

interface TaskRecord {
  id: string
  cwd: string
  role: string
}

interface TaskState {
  version: 1
  records: TaskRecord[]
}

interface TaskResult {
  taskId: string
  role: string
  status: "completed" | "failed" | "cancelled" | "step_limit"
  exitCode: number | null
  output: string
  stderr: string
  outputTruncated: boolean
  stderrTruncated: boolean
  steps: number
  resumed: boolean
}

function textResult(text: string, details: unknown, isError = false) {
  return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function positiveInteger(value: unknown, fallback: number, name: string, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`)
  }
  return value as number
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be a non-empty string`)
  return value
}

function parseConfig(raw: string, path: string): WorkflowConfig {
  if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error(`workflow config exceeds ${MAX_CONFIG_BYTES} bytes: ${path}`)
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isObject(value) || !isObject(value.roles)) throw new Error(`${path} must contain a roles object`)

  const defaultMaxSteps = positiveInteger(value.defaultMaxSteps, DEFAULT_MAX_STEPS, "defaultMaxSteps", 1_000)
  const roles: Record<string, RoleConfig> = {}
  for (const [name, candidate] of Object.entries(value.roles)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error(`invalid role name: ${name}`)
    if (!isObject(candidate)) throw new Error(`role ${name} must be an object`)
    const thinking = optionalString(candidate.thinking, `roles.${name}.thinking`)
    if (thinking && !THINKING_LEVELS.has(thinking)) {
      throw new Error(`roles.${name}.thinking must be one of ${[...THINKING_LEVELS].join(", ")}`)
    }
    roles[name] = {
      provider: optionalString(candidate.provider, `roles.${name}.provider`),
      model: optionalString(candidate.model, `roles.${name}.model`),
      thinking,
      systemPrompt: optionalString(candidate.systemPrompt, `roles.${name}.systemPrompt`),
      maxSteps: positiveInteger(candidate.maxSteps, defaultMaxSteps, `roles.${name}.maxSteps`, 1_000),
    }
  }
  if (Object.keys(roles).length === 0) throw new Error(`${path} must define at least one role`)

  return {
    maxConcurrency: positiveInteger(value.maxConcurrency, DEFAULT_MAX_CONCURRENCY, "maxConcurrency", 16),
    maxJobs: positiveInteger(value.maxJobs, DEFAULT_MAX_JOBS, "maxJobs", 32),
    maxOutputBytes: positiveInteger(value.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes", 1024 * 1024),
    defaultMaxSteps,
    roles,
  }
}

function currentPiInvocation(args: string[]): { command: string; args: string[] } {
  const wrapper = process.env.PI_AGENTBOX_PI_WRAPPER
  if (wrapper && isAbsolute(wrapper) && existsSync(wrapper)) return { command: wrapper, args }
  throw new Error("PI_AGENTBOX_PI_WRAPPER does not identify the managed Pi wrapper")
}

class BoundedBytes {
  private value = Buffer.alloc(0)
  private readonly limit: number
  omitted = 0

  constructor(limit: number) {
    this.limit = limit
  }

  append(chunk: Buffer | string) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (incoming.length >= this.limit) {
      this.omitted += this.value.length + incoming.length - this.limit
      this.value = incoming.subarray(incoming.length - this.limit)
      return
    }
    const excess = this.value.length + incoming.length - this.limit
    if (excess > 0) {
      this.omitted += excess
      this.value = this.value.subarray(excess)
    }
    this.value = Buffer.concat([this.value, incoming], this.value.length + incoming.length)
  }

  text() {
    return this.value.toString("utf8").replace(/^\uFFFD/, "")
  }
}

function validTodoState(value: unknown): value is TodoState {
  if (!isObject(value) || value.version !== 1 || !Number.isInteger(value.nextId) || !Array.isArray(value.items)) return false
  return value.items.every((item) => isObject(item)
    && Number.isInteger(item.id)
    && typeof item.text === "string"
    && ["pending", "in_progress", "completed"].includes(item.status as string))
}

function validTaskState(value: unknown): value is TaskState {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.records)) return false
  return value.records.every((record) => isObject(record)
    && typeof record.id === "string"
    && typeof record.cwd === "string"
    && typeof record.role === "string")
}

export function createPiWorkflowExtension(dependencies: PiWorkflowDependencies = {}) {
  const spawn = dependencies.spawn ?? nodeSpawn
  const readFile = dependencies.readFile ?? ((path: string, encoding: BufferEncoding) => fs.readFile(path, encoding))
  const makeUUID = dependencies.randomUUID ?? randomUUID
  const getPiInvocation = dependencies.getPiInvocation ?? currentPiInvocation

  return function piWorkflow(pi: ExtensionAPI) {
    let todoState: TodoState = { version: 1, nextId: 1, items: [] }
    let taskRecords = new Map<string, TaskRecord>()
    let reservedTaskIds = new Set<string>()
    const activeResumeIds = new Set<string>()

    const restoreState = (ctx: any) => {
      todoState = { version: 1, nextId: 1, items: [] }
      taskRecords = new Map()
      reservedTaskIds = new Set()
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom") continue
        if (entry.customType === TODO_ENTRY && validTodoState(entry.data)) {
          todoState = {
            version: 1,
            nextId: entry.data.nextId,
            items: entry.data.items.map((item) => ({ ...item })),
          }
        }
        if (entry.customType === TASK_ENTRY && validTaskState(entry.data)) {
          taskRecords = new Map(entry.data.records.map((record) => [record.id, { ...record }]))
          reservedTaskIds = new Set(taskRecords.keys())
        }
      }
    }

    const persistTodos = () => {
      pi.appendEntry<TodoState>(TODO_ENTRY, {
        version: 1,
        nextId: todoState.nextId,
        items: todoState.items.map((item) => ({ ...item })),
      })
    }

    const persistTasks = () => {
      pi.appendEntry<TaskState>(TASK_ENTRY, {
        version: 1,
        records: [...taskRecords.values()].map((record) => ({ ...record })),
      })
    }

    pi.on("session_start", async (_event, ctx) => restoreState(ctx))
    pi.on("session_tree", async (_event, ctx) => restoreState(ctx))

    pi.registerTool({
      name: "todo",
      label: "Todo",
      description: "Manage the session todo list. Use list, add, update, set_status, remove, or clear. Status is pending, in_progress, or completed.",
      promptSnippet: "todo: persist and manage a branch-aware session todo list",
      executionMode: "sequential",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["list", "add", "update", "set_status", "remove", "clear"] },
          id: { type: "number", minimum: 1, description: "Todo ID for update, set_status, or remove" },
          text: { type: "string", minLength: 1, maxLength: 2_000, description: "Todo text for add or update" },
          status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "New status for set_status" },
        },
        required: ["action"],
      },
      async execute(_toolCallId, params: any) {
        const snapshot = () => todoState.items.map((item) => ({ ...item }))
        const format = () => todoState.items.length === 0
          ? "No todos."
          : todoState.items.map((item) => `[${item.status === "completed" ? "x" : item.status === "in_progress" ? "~" : " "}] #${item.id} ${item.text}`).join("\n")

        if (params.action === "list") return textResult(format(), { action: "list", items: snapshot() })
        if (params.action === "clear") {
          const count = todoState.items.length
          todoState = { version: 1, nextId: 1, items: [] }
          persistTodos()
          return textResult(`Cleared ${count} todo${count === 1 ? "" : "s"}.`, { action: "clear", items: [] })
        }
        if (params.action === "add") {
          const value = typeof params.text === "string" ? params.text.trim() : ""
          if (!value) return textResult("Todo text is required for add.", { action: "add", items: snapshot() }, true)
          const item: TodoItem = { id: todoState.nextId++, text: value, status: "pending" }
          todoState.items.push(item)
          persistTodos()
          return textResult(`Added todo #${item.id}: ${item.text}`, { action: "add", item: { ...item }, items: snapshot() })
        }

        if (!Number.isInteger(params.id)) return textResult(`Todo ID is required for ${params.action}.`, { action: params.action, items: snapshot() }, true)
        const index = todoState.items.findIndex((item) => item.id === params.id)
        if (index < 0) return textResult(`Todo #${params.id} was not found.`, { action: params.action, items: snapshot() }, true)
        const item = todoState.items[index]
        if (params.action === "remove") {
          todoState.items.splice(index, 1)
          persistTodos()
          return textResult(`Removed todo #${item.id}: ${item.text}`, { action: "remove", item: { ...item }, items: snapshot() })
        }
        if (params.action === "update") {
          const value = typeof params.text === "string" ? params.text.trim() : ""
          if (!value) return textResult("Todo text is required for update.", { action: "update", items: snapshot() }, true)
          item.text = value
          persistTodos()
          return textResult(`Updated todo #${item.id}: ${item.text}`, { action: "update", item: { ...item }, items: snapshot() })
        }
        if (params.action === "set_status") {
          if (!["pending", "in_progress", "completed"].includes(params.status)) {
            return textResult("A valid status is required for set_status.", { action: "set_status", items: snapshot() }, true)
          }
          item.status = params.status
          persistTodos()
          return textResult(`Todo #${item.id} is now ${item.status}.`, { action: "set_status", item: { ...item }, items: snapshot() })
        }
        return textResult(`Unknown todo action: ${params.action}`, { action: params.action, items: snapshot() }, true)
      },
    })

    pi.registerTool({
      name: "question",
      label: "Question",
      description: "Ask the user one structured multiple-choice question through the active UI, optionally allowing a custom answer.",
      promptSnippet: "question: ask the interactive user a structured question",
      executionMode: "sequential",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string", minLength: 1, maxLength: 2_000 },
          options: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string", minLength: 1, maxLength: 200 },
                description: { type: "string", maxLength: 500 },
              },
              required: ["label"],
            },
          },
          allowCustom: { type: "boolean", description: "Offer a free-text answer. Defaults to true." },
        },
        required: ["question", "options"],
      },
      async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
        const labels = params.options.map((option: any, index: number) => `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`)
        if (!ctx.hasUI) {
          return textResult("Question unsupported: an interactive UI is not available.", {
            status: "unsupported",
            question: params.question,
            answer: null,
          })
        }

        const allowCustom = params.allowCustom !== false
        const customChoice = `${labels.length + 1}. Other (type an answer)`
        const selected = await ctx.ui.select(params.question, allowCustom ? [...labels, customChoice] : labels, { signal })
        if (selected === undefined) {
          return textResult("User cancelled the question.", { status: "cancelled", question: params.question, answer: null })
        }
        if (allowCustom && selected === customChoice) {
          const custom = await ctx.ui.input(params.question, "Type your answer", { signal })
          if (custom === undefined || custom.trim() === "") {
            return textResult("User cancelled the question.", { status: "cancelled", question: params.question, answer: null })
          }
          return textResult(`User answered: ${custom.trim()}`, {
            status: "answered",
            question: params.question,
            answer: custom.trim(),
            custom: true,
          })
        }
        const index = labels.indexOf(selected)
        const answer = index >= 0 ? params.options[index].label : selected
        return textResult(`User selected: ${answer}`, {
          status: "answered",
          question: params.question,
          answer,
          optionIndex: index,
          custom: false,
        })
      },
    })

    if (process.env.PI_WORKFLOW_CHILD === "1") {
      pi.on("tool_call", async (event) => {
        if (event.toolName === "task") return { block: true, reason: "Recursive task delegation is disabled in workflow children", terminate: true }
      })
      return
    }

    const runJob = async (
      job: TaskJob,
      config: WorkflowConfig,
      cwd: string,
      signal: AbortSignal | undefined,
      inherited: { provider?: string; model?: string; thinking?: string },
    ): Promise<TaskResult> => {
      let taskId: string
      if (job.resume) {
        taskId = job.resume
      } else {
        do taskId = `pi-workflow-${makeUUID()}`
        while (reservedTaskIds.has(taskId))
        reservedTaskIds.add(taskId)
      }

      const role = config.roles[job.role]
      if (!role) {
        return {
          taskId,
          role: job.role,
          status: "failed",
          exitCode: null,
          output: `Unknown role ${job.role}. Available roles: ${Object.keys(config.roles).join(", ")}`,
          stderr: "",
          outputTruncated: false,
          stderrTruncated: false,
          steps: 0,
          resumed: Boolean(job.resume),
        }
      }

      if (signal?.aborted) {
        return {
          taskId,
          role: job.role,
          status: "cancelled",
          exitCode: null,
          output: "Task cancelled before start.",
          stderr: "",
          outputTruncated: false,
          stderrTruncated: false,
          steps: 0,
          resumed: Boolean(job.resume),
        }
      }

      if (job.resume) {
        const record = taskRecords.get(taskId)
        if (!TASK_ID_RE.test(taskId) || !record || record.cwd !== cwd || record.role !== job.role) {
          return {
            taskId,
            role: job.role,
            status: "failed",
            exitCode: null,
            output: "Resume requires a task ID previously created for this role and working directory in the current session branch.",
            stderr: "",
            outputTruncated: false,
            stderrTruncated: false,
            steps: 0,
            resumed: true,
          }
        }
        if (activeResumeIds.has(taskId)) {
          return {
            taskId,
            role: job.role,
            status: "failed",
            exitCode: null,
            output: `Task ${taskId} is already being resumed by an active workflow job.`,
            stderr: "",
            outputTruncated: false,
            stderrTruncated: false,
            steps: 0,
            resumed: true,
          }
        }
        activeResumeIds.add(taskId)
      }

      const args = ["--mode", "json", "-p", "--exclude-tools", "task"]
      if (job.resume) args.push("--session", taskId)
      else args.push("--session-id", taskId)
      const provider = role.provider ?? inherited.provider
      const model = role.model ?? inherited.model
      const thinking = role.thinking ?? inherited.thinking
      if (provider) args.push("--provider", provider)
      if (model) args.push("--model", model)
      if (thinking) args.push("--thinking", thinking)
      if (role.systemPrompt) args.push("--system-prompt", role.systemPrompt)

      let invocation: { command: string; args: string[] }
      try {
        invocation = getPiInvocation(args)
      } catch (error) {
        if (job.resume) activeResumeIds.delete(taskId)
        return {
          taskId,
          role: job.role,
          status: "failed",
          exitCode: null,
          output: error instanceof Error ? error.message : String(error),
          stderr: "",
          outputTruncated: false,
          stderrTruncated: false,
          steps: 0,
          resumed: Boolean(job.resume),
        }
      }

      const stdout = new BoundedBytes(config.maxOutputBytes)
      const stderr = new BoundedBytes(config.maxOutputBytes)
      let steps = 0
      let pendingEvent = Buffer.alloc(0)
      let cancelled = false
      let stepLimited = false
      let parserFailure = ""
      let assistantStopReason = ""
      let assistantOutput = ""
      let assistantOutputTruncated = false
      let killTimer: ReturnType<typeof setTimeout> | undefined

      return new Promise<TaskResult>((resolve) => {
        let settled = false
        let abort = () => {}
        let terminate = (_reason: "cancelled" | "step_limit" | "failed") => {}
        let proc: ReturnType<Spawn>

        const setAssistantOutput = (text: string) => {
          const bounded = new BoundedBytes(config.maxOutputBytes)
          bounded.append(text)
          assistantOutput = bounded.text()
          assistantOutputTruncated = bounded.omitted > 0
        }

        const inspectEvent = (line: Buffer) => {
          if (line.length === 0 || parserFailure) return
          try {
            const text = line.toString("utf8").trim()
            if (!text) return
            const event = JSON.parse(text)
            if (event?.type !== "message_end" || event.message?.role !== "assistant") return
            steps++
            assistantStopReason = typeof event.message.stopReason === "string" ? event.message.stopReason : ""
            const content = event.message.content
            if (typeof content === "string") setAssistantOutput(content)
            else if (Array.isArray(content)) {
              const text = content
                .filter((part) => part?.type === "text" && typeof part.text === "string")
                .map((part) => part.text)
                .join("\n")
              if (text) setAssistantOutput(text)
            }
            if (typeof event.message.errorMessage === "string" && event.message.errorMessage) {
              setAssistantOutput(event.message.errorMessage)
            }
            if (steps >= role.maxSteps && event.message.stopReason === "toolUse") terminate("step_limit")
          } catch (error) {
            parserFailure = `Invalid JSON event from workflow child: ${error instanceof Error ? error.message : String(error)}`
            terminate("failed")
          }
        }

        const inspectChunk = (chunk: Buffer | string) => {
          if (parserFailure) return
          const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          let offset = 0
          while (offset < incoming.length) {
            const newline = incoming.indexOf(10, offset)
            const end = newline < 0 ? incoming.length : newline
            const segment = incoming.subarray(offset, end)
            if (pendingEvent.length + segment.length > MAX_JSON_EVENT_BYTES) {
              parserFailure = `Workflow child JSON event exceeds ${MAX_JSON_EVENT_BYTES} bytes`
              terminate("failed")
              return
            }
            if (segment.length > 0) pendingEvent = Buffer.concat([pendingEvent, segment])
            if (newline < 0) return
            inspectEvent(pendingEvent)
            pendingEvent = Buffer.alloc(0)
            if (parserFailure) return
            offset = newline + 1
          }
        }

        const finish = (exitCode: number | null, spawnError?: Error) => {
          if (settled) return
          settled = true
          if (killTimer) clearTimeout(killTimer)
          signal?.removeEventListener("abort", abort)
          if (pendingEvent.length > 0 && !parserFailure) inspectEvent(pendingEvent)
          if (job.resume) activeResumeIds.delete(taskId)
          const stdoutText = stdout.text().trim()
          const stderrText = stderr.text().trim()
          const output = spawnError?.message || parserFailure || assistantOutput || stdoutText || stderrText || "(no output)"
          const status = cancelled || assistantStopReason === "aborted"
            ? "cancelled"
            : stepLimited
              ? "step_limit"
              : parserFailure || assistantStopReason === "error" || exitCode !== 0
                ? "failed"
                : "completed"
          resolve({
            taskId,
            role: job.role,
            status,
            exitCode,
            output,
            stderr: stderrText,
            outputTruncated: stdout.omitted > 0 || assistantOutputTruncated,
            stderrTruncated: stderr.omitted > 0,
            steps,
            resumed: Boolean(job.resume),
          })
        }

        try {
          proc = spawn(invocation.command, invocation.args, {
            cwd,
            env: { ...process.env, PI_WORKFLOW_CHILD: "1" },
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
          })
        } catch (error) {
          finish(null, error instanceof Error ? error : new Error(String(error)))
          return
        }

        terminate = (reason: "cancelled" | "step_limit" | "failed") => {
          if (settled || cancelled || stepLimited) return
          if (reason === "cancelled") cancelled = true
          else if (reason === "step_limit") stepLimited = true
          proc.kill("SIGTERM")
          killTimer = setTimeout(() => {
            if (!settled) proc.kill("SIGKILL")
          }, KILL_GRACE_MS)
          killTimer.unref?.()
        }

        proc.stdout?.on("data", (chunk: Buffer | string) => {
          stdout.append(chunk)
          inspectChunk(chunk)
        })
        proc.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk))

        abort = () => terminate("cancelled")
        if (signal) {
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
        }
        proc.once("error", (error) => finish(null, error))
        proc.once("close", (code) => finish(code))
        if (!proc.stdin) {
          parserFailure = "Failed to send workflow prompt: child stdin is unavailable"
          terminate("failed")
          return
        }
        proc.stdin.once("error", (error) => {
          parserFailure = `Failed to send workflow prompt on stdin: ${error.message}`
          terminate("failed")
        })
        proc.stdin.end(job.prompt)
      })
    }

    pi.registerTool({
      name: "task",
      label: "Task",
      description: `Run one child job (role + prompt) or multiple bounded-parallel jobs (jobs). Roles and provider/model/thinking/systemPrompt/maxSteps settings come from PI_WORKFLOW_CONFIG (default ${DEFAULT_CONFIG_PATH}). Resume with a task ID returned by an earlier call on this session branch.`,
      promptSnippet: "task: delegate isolated child jobs to managed workflow roles",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", description: "Managed role name for single-job mode" },
          prompt: { type: "string", minLength: 1, maxLength: 100_000, description: "Child prompt for single-job mode" },
          resume: { type: "string", description: "Prior task ID to resume in single-job mode" },
          jobs: {
            type: "array",
            minItems: 1,
            maxItems: 32,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                role: { type: "string" },
                prompt: { type: "string", minLength: 1, maxLength: 100_000 },
                resume: { type: "string", description: "Prior task ID to resume" },
              },
              required: ["role", "prompt"],
            },
          },
          concurrency: { type: "number", minimum: 1, maximum: 16, description: "Requested parallelism, capped by managed config" },
        },
      },
      async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
        const hasSingle = typeof params.role === "string" && typeof params.prompt === "string"
        const hasJobs = Array.isArray(params.jobs) && params.jobs.length > 0
        if (hasSingle === hasJobs) {
          return textResult("Provide exactly one mode: role + prompt, or jobs.", { results: [] }, true)
        }

        const configPath = process.env.PI_WORKFLOW_CONFIG || DEFAULT_CONFIG_PATH
        let config: WorkflowConfig
        try {
          config = parseConfig(await readFile(configPath, "utf8"), configPath)
        } catch (error) {
          return textResult(`Workflow config error: ${error instanceof Error ? error.message : String(error)}`, {
            configPath,
            results: [],
          }, true)
        }

        const jobs: TaskJob[] = hasSingle
          ? [{ role: params.role, prompt: params.prompt, resume: params.resume }]
          : params.jobs
        if (jobs.length > config.maxJobs) {
          return textResult(`Too many jobs: ${jobs.length}; managed maximum is ${config.maxJobs}.`, { configPath, results: [] }, true)
        }

        const requested = Number.isInteger(params.concurrency) ? params.concurrency : config.maxConcurrency
        const concurrency = Math.max(1, Math.min(requested, config.maxConcurrency, jobs.length))
        const inherited = {
          provider: typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined,
          model: typeof ctx.model?.id === "string" ? ctx.model.id : undefined,
          thinking: typeof ctx.thinkingLevel === "string" ? ctx.thinkingLevel : undefined,
        }
        const results: TaskResult[] = new Array(jobs.length)
        let next = 0
        let completed = 0
        const workers = Array.from({ length: concurrency }, async () => {
          while (true) {
            const index = next++
            if (index >= jobs.length) return
            results[index] = await runJob(jobs[index], config, ctx.cwd, signal, inherited)
            completed++
            onUpdate?.(textResult(`${completed}/${jobs.length} child jobs finished.`, {
              configPath,
              concurrency,
              results: results.filter(Boolean),
            }) as any)
          }
        })
        await Promise.all(workers)

        let changed = false
        for (const result of results) {
          if (!result.taskId || result.resumed || result.status === "cancelled") continue
          taskRecords.set(result.taskId, { id: result.taskId, cwd: ctx.cwd, role: result.role })
          changed = true
        }
        if (changed) persistTasks()

        const formatted = results.map((result) => {
          const truncation = result.outputTruncated || result.stderrTruncated ? " (captured output truncated)" : ""
          return `### ${result.role} [${result.taskId || "no task ID"}] ${result.status}${truncation}\n\n${result.output}`
        }).join("\n\n---\n\n")
        const failed = results.filter((result) => result.status !== "completed").length
        return textResult(`${jobs.length - failed}/${jobs.length} child jobs completed.\n\n${formatted}`, {
          configPath,
          concurrency,
          results,
        }, failed === results.length)
      },
    })
  }
}

export default createPiWorkflowExtension()
