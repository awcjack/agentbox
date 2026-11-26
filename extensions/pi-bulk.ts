import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent"

const MAX_FILES = 100
const MAX_PATH = 4096
const MAX_EDITS = 1000
const pathSchema = { type: "string", minLength: 1, maxLength: MAX_PATH }
const replacementSchema = {
  type: "object", additionalProperties: false,
  properties: { oldText: { type: "string", minLength: 1 }, newText: { type: "string" } },
  required: ["oldText", "newText"],
}
const fileSchema = (kind: "edit" | "write") => ({
  type: "object", additionalProperties: false,
  properties: kind === "edit"
    ? { path: pathSchema, edits: { type: "array", minItems: 1, maxItems: MAX_EDITS, items: replacementSchema } }
    : { path: pathSchema, content: { type: "string" } },
  required: kind === "edit" ? ["path", "edits"] : ["path", "content"],
})

type EditFile = { path: string; edits: Array<{ oldText: string; newText: string }> }
type WriteFile = { path: string; content: string }
type FileOutcome = { path: string; status: "completed" | "failed" | "skipped" }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Validate the entire shape again: tool_call hooks may mutate arguments after Pi's
// schema validation. Snapshot only supported fields before the first nested call.
function validate(input: unknown, kind: "edit" | "write"): Array<EditFile | WriteFile> {
  if (!object(input) || Object.keys(input).some(key => key !== "files") || !Array.isArray(input.files)
    || !input.files.length || input.files.length > MAX_FILES) throw new Error(`files must contain 1–${MAX_FILES} entries`)
  return input.files.map(file => {
    if (!object(file) || typeof file.path !== "string" || !file.path.trim()
      || file.path.length > MAX_PATH || file.path.includes("\0")
      || Object.keys(file).some(key => !["path", kind === "edit" ? "edits" : "content"].includes(key))) {
      throw new Error("Each file needs a non-empty path of at most 4096 characters and only supported fields")
    }
    if (kind === "write") {
      if (typeof file.content !== "string") throw new Error(`Missing string content for ${file.path}`)
      return { path: file.path, content: file.content }
    }
    if (!Array.isArray(file.edits) || !file.edits.length || file.edits.length > MAX_EDITS) {
      throw new Error(`edits must contain 1–${MAX_EDITS} replacements for ${file.path}`)
    }
    const edits = file.edits.map(edit => {
      if (!object(edit) || typeof edit.oldText !== "string" || !edit.oldText.length || typeof edit.newText !== "string"
        || Object.keys(edit).some(key => key !== "oldText" && key !== "newText")) throw new Error(`Invalid replacement for ${file.path}`)
      return { oldText: edit.oldText, newText: edit.newText }
    })
    return { path: file.path, edits }
  })
}

function displayPath(path: string) {
  const quoted = JSON.stringify(path)
  return quoted.length > 80 ? `${quoted.slice(0, 76)}…"` : quoted
}

function bounded(text: string) {
  const lines = text.split("\n")
  const result = lines.slice(0, 1800).join("\n").slice(0, 12000)
  return result.length < text.length ? `${result}\n[Bulk output truncated; inspect individual files/diagnostics.]` : result
}

async function execute(kind: "edit" | "write", input: unknown, signal: AbortSignal | undefined, ctx: ExtensionToolContext) {
  const files = validate(input, kind)
  const outcomes: FileOutcome[] = files.map(file => ({ path: file.path, status: "skipped" }))
  const feedback: string[] = []
  let failed = false
  for (const [index, file] of files.entries()) {
    if (signal?.aborted) {
      failed = true
      feedback.unshift("Cancelled; remaining files skipped.")
      break
    }
    try {
      // Never invoke built-in execute() or fs directly: nested calls preserve the
      // live policy, approvals, mutation queues, diagnostics and execution events.
      const outcome = await ctx.executeTool(kind, file, { signal })
      outcomes[index].status = outcome.isError ? "failed" : "completed"
      for (const block of outcome.result.content) {
        if (block.type !== "text") continue
        // Omit only the stock success acknowledgement, never hook feedback.
        if (!outcome.isError && /^(?:Successfully replaced \d+ block\(s\) in [^\n]+\.|Successfully wrote \d+ bytes to [^\n]+)$/.test(block.text)) continue
        const message = `${displayPath(file.path)}: ${block.text}`
        if (outcome.isError) feedback.unshift(message)
        else feedback.push(message)
      }
      if (outcome.isError) { failed = true; break }
    } catch (error) {
      // Defensive: Pi normally returns isError, but never lose the record of
      // earlier completed files if the runtime itself rejects unexpectedly.
      outcomes[index].status = "failed"
      feedback.unshift(`${displayPath(file.path)}: ${error instanceof Error ? error.message : String(error)}`)
      failed = true
      break
    }
  }
  const summary = outcomes.map((file, index) => `${index + 1}. ${file.status}: ${displayPath(file.path)}`).join("\n")
  return {
    content: [{ type: "text" as const, text: bounded([
      ...(failed ? ["Batch stopped; completed files are NOT rolled back. A failed file may have changed; read it before retrying."] : []),
      summary,
      ...feedback,
    ].join("\n")) }],
    details: { files: outcomes },
    isError: failed,
  }
}

export function registerBulkTools(pi: ExtensionAPI) {
  for (const kind of ["edit", "write"] as const) {
    const name = `bulk_${kind}`
    pi.registerTool({
      name,
      label: kind === "edit" ? "Bulk edit" : "Bulk write",
      description: kind === "edit"
        ? "Edit multiple files in one call using per-file edits[]. Each oldText must uniquely match the original file and replacements within a file cannot overlap."
          + " Processes files in order via edit; stops on first error/cancellation. NOT atomic: earlier files remain changed, and a failed file may have changed. Shape is checked upfront, matches and permissions per file. Output capped at 12000 characters/1800 lines."
        : "Create or overwrite multiple complete files in one call using files: [{path, content}]."
          + " Processes files in order via write; stops on first error/cancellation. NOT atomic: earlier files remain changed, and a failed file may have changed. Output capped at 12000 characters/1800 lines.",
      promptSnippet: kind === "edit" ? "Apply targeted replacements across multiple files in one call" : "Create or overwrite multiple files in one call",
      promptGuidelines: kind === "edit"
        ? ["Prefer bulk_edit over separate edit calls for changes across multiple files. Keep oldText short, unique and non-overlapping within each original file.",
          "After a bulk_edit error, inspect completed/failed/skipped statuses; do not blindly retry the entire batch."]
        : ["Use bulk_write only for multiple new files or complete rewrites; prefer bulk_edit for targeted changes.",
          "After a bulk_write error, inspect completed/failed/skipped statuses; do not blindly retry the entire batch."],
      exposure: "model-only",
      executionMode: "sequential",
      reachesTools: () => [kind],
      parameters: {
        type: "object", additionalProperties: false,
        properties: { files: { type: "array", minItems: 1, maxItems: MAX_FILES, items: fileSchema(kind) } },
        required: ["files"],
      },
      async execute(_id, input: { files: Array<EditFile | WriteFile> }, signal, _onUpdate, ctx) {
        return execute(kind, input, signal, ctx)
      },
    })
  }
}

export default registerBulkTools
