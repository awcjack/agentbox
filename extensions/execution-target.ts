import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process"
import { realpath, stat } from "node:fs/promises"
import { isAbsolute, normalize, relative, resolve } from "node:path"
import { isSensitivePath } from "./path-policy.ts"

export const EXECUTION_TARGET_ENTRY = "agentbox.execution-target.v1"
const MAX_PATH = 4096
const CONTROL = /[\u0000-\u001f\u007f\\]/

export interface ExecutionTargetReport {
  version: 1
  worktreeRoot: string
  productPath: "."
  productRelativeCwd: string
  workingDirectory: string
  sessionId: string
  toolCallId: string
}

function pathString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH && !CONTROL.test(value)
}

function absolutePath(value: unknown): value is string {
  return pathString(value) && isAbsolute(value) && normalize(value) === value
    && (value === "/" || !value.endsWith("/"))
}

function relativePath(value: unknown): value is string {
  return pathString(value) && !isAbsolute(value) && normalize(value) === value && !value.endsWith("/")
    && value !== ".." && !value.startsWith("../")
}

function within(path: string, root: string) {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`)
}

/** Wire validation only. Consumers must independently authorize and revalidate
 * the report against the expected repository and their existing filesystem scope. */
export function isExecutionTargetReport(value: unknown): value is ExecutionTargetReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const report = value as Record<string, unknown>
  const keys = ["version", "worktreeRoot", "productPath", "productRelativeCwd", "workingDirectory", "sessionId", "toolCallId"]
  return Object.keys(report).length === keys.length && keys.every(key => Object.hasOwn(report, key))
    && report.version === 1 && absolutePath(report.worktreeRoot) && absolutePath(report.workingDirectory)
    && report.productPath === "." && relativePath(report.productRelativeCwd)
    && resolve(report.worktreeRoot, report.productPath, report.productRelativeCwd) === report.workingDirectory
    && typeof report.sessionId === "string" && /^[^\u0000-\u001f\u007f]{1,256}$/.test(report.sessionId)
    && typeof report.toolCallId === "string" && /^[^\u0000-\u001f\u007f]{1,1024}$/.test(report.toolCallId)
}

export const executionTargetSchema = {
  type: "object", additionalProperties: false,
  properties: {
    version: { type: "integer", const: 1 },
    worktreeRoot: { type: "string", minLength: 1, maxLength: MAX_PATH },
    productPath: { type: "string", const: "." },
    productRelativeCwd: { type: "string", minLength: 1, maxLength: MAX_PATH },
    workingDirectory: { type: "string", minLength: 1, maxLength: MAX_PATH },
    sessionId: { type: "string", minLength: 1, maxLength: 256 },
    toolCallId: { type: "string", minLength: 1, maxLength: 1024 },
  },
  required: ["version", "worktreeRoot", "productPath", "productRelativeCwd", "workingDirectory", "sessionId", "toolCallId"],
}

async function directory(path: string): Promise<string> {
  if (!absolutePath(path) || isSensitivePath(path)) throw new Error("Execution target contains an invalid or sensitive directory")
  const canonical = await realpath(path)
  if (!absolutePath(canonical) || isSensitivePath(canonical) || !(await stat(canonical)).isDirectory()) {
    throw new Error("Execution target must resolve to an existing non-sensitive directory")
  }
  return canonical
}

async function gitPath(cwd: string, option: string, signal?: AbortSignal): Promise<string> {
  // Parent shell Git overrides must not redirect inspection to another checkout.
  // No shell, hooks, index changes, credential lookup, or network operation.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")))
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" })
  return new Promise((done, reject) => {
    execFile("git", ["-C", cwd, "rev-parse", "--path-format=absolute", option], {
      env, signal, timeout: 10_000, maxBuffer: 16 * 1024, encoding: "utf8",
    }, (error, stdout) => {
      if (error) return reject(new Error("Cannot inspect execution target Git metadata in the existing filesystem scope"))
      // Strip only Git's record terminator: spaces are valid directory names.
      const path = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout
      if (!absolutePath(path)) return reject(new Error("Git returned an invalid execution target path"))
      done(path)
    })
  })
}

export function registerExecutionTargetTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "report_execution_target",
    label: "Report execution target",
    description: "Report an explicitly selected implementation directory for a fresh verification session. The Product is the Git repository/worktree, not a literal Product subdirectory; its root is derived from Git with no environment configuration. Inspects existing directories/Git metadata only; does not change cwd, create a checkout, authorize access, or start review.",
    promptSnippet: "report_execution_target: report the worktree root and Product-relative implementation directory as structured metadata",
    promptGuidelines: [
      "When an implementation task requests a verification handoff, call report_execution_target after all edits and checks, before the final response. Supply the explicit directory containing the implementation, including any new worktree or nested working directory; shell cd does not update Pi's cwd.",
      "Call report_execution_target again if the selected implementation directory changes. A report is metadata, not authorization or proof of completion; never infer a target from prose or expand filesystem access to make reporting succeed.",
    ],
    executionMode: "sequential",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        workingDirectory: { type: "string", minLength: 1, maxLength: MAX_PATH, description: "Explicit absolute implementation directory; not the original session cwd unless that is still the correct target" },
      },
      required: ["workingDirectory"],
    },
    outputSchema: executionTargetSchema,
    async execute(toolCallId, params: { workingDirectory: string }, signal, _onUpdate, ctx) {
      signal?.throwIfAborted()
      if (!params || Object.keys(params).length !== 1 || typeof params.workingDirectory !== "string") throw new Error("An explicit workingDirectory is required")
      // Accept only literal absolute paths. In particular, an @-prefixed path
      // must not be authorized as relative by policy then opened as absolute.
      const workingDirectory = await directory(params.workingDirectory)
      const worktreeRoot = await directory(await gitPath(workingDirectory, "--show-toplevel", signal))
      // Linked worktrees need both their private gitdir and shared metadata to be
      // present in the current sandbox. Reporting must not add missing mounts.
      await directory(await gitPath(workingDirectory, "--absolute-git-dir", signal))
      await directory(await gitPath(workingDirectory, "--git-common-dir", signal))
      if (!within(workingDirectory, worktreeRoot)) throw new Error("Execution directory must be inside its reported Git worktree")
      const report: ExecutionTargetReport = {
        version: 1, worktreeRoot, productPath: ".",
        productRelativeCwd: relative(worktreeRoot, workingDirectory) || ".",
        workingDirectory, sessionId: ctx.sessionManager.getSessionId(), toolCallId,
      }
      if (!isExecutionTargetReport(report)) throw new Error("Cannot construct a valid execution target report")
      signal?.throwIfAborted()
      pi.appendEntry(EXECUTION_TARGET_ENTRY, report)
      return {
        content: [{ type: "text", text: `Execution target reported: ${workingDirectory}. The controller must validate and authorize it before starting fresh verification.` }],
        details: report,
        structuredContent: report,
      }
    },
  })
}
