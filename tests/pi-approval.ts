import { strict as assert } from "node:assert"
import { PassThrough, Writable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { createApprovalBroker, createApprovalClient, selectApproval, APPROVAL_TITLE_PREFIX } from "../extensions/pi-approval.ts"
import { createPiWorkflowExtension } from "../extensions/pi-workflow.ts"

const broker = createApprovalBroker()
const identity = { toolCallId: "parent-call", taskId: "parent-task", role: "scout" }
function pair(select: any, hasUI = true, onClosed?: (requestId: string) => void | Promise<void>) {
  const requests = new PassThrough()
  const replies = new PassThrough()
  const close = broker.attach({ input: requests, output: replies }, { hasUI, ui: { select } }, identity, undefined, onClosed)
  const client = createApprovalClient({ input: replies, output: requests })
  return { client, close, requests, replies }
}
for (const answer of ["Allow once", "Deny", "allow", undefined]) {
  const p = pair(async (title: string, choices: string[], options: any) => {
    assert.deepEqual(choices, ["Allow once", "Deny"])
    assert.ok(options.signal instanceof AbortSignal)
    assert.ok(options.timeout > 0 && options.timeout <= 1000)
    const metadata = JSON.parse(title.split("\n")[0].slice(APPROVAL_TITLE_PREFIX.length))
    assert.equal(metadata.toolCallId, identity.toolCallId)
    assert.equal(metadata.role, identity.role)
    return answer
  })
  assert.equal(await p.client.ask("read: README", 1000), answer === "Allow once")
  p.close()
}

let release!: (answer: string) => void
const first = pair(() => new Promise((resolve) => { release = resolve }))
let secondShown = false
const queuedClosed: string[] = []
const second = pair(async () => { secondShown = true; return "Allow once" }, true, (id) => { queuedClosed.push(id) })
const waiting = first.client.ask("first", 200)
assert.equal(await second.client.ask("queued", 10), false)
assert.equal(secondShown, false)
release("Deny")
assert.equal(await waiting, false)
await delay(0)
assert.equal(secondShown, false)
assert.equal(queuedClosed.length, 1)
assert.equal(await second.client.ask("fresh", 1000), true)
first.close(); second.close()

// Closing/erroring a child must release an uncooperative active dialog for other children.
for (const failure of ["close", "error", "abort"]) {
  const input = new PassThrough()
  const output = new PassThrough()
  const parentAbort = new AbortController()
  const closedIds: string[] = []
  let shownSignal: AbortSignal | undefined
  const close = broker.attach({ input, output }, { hasUI: true, ui: { select: async (_t, _c, options) => {
    shownSignal = options.signal
    return new Promise(() => {})
  } } }, identity, parentAbort.signal, (id) => { closedIds.push(id) })
  const client = createApprovalClient({ input: output, output: input })
  const pending = client.ask("will fail", 1000)
  await delay(0)
  if (failure === "abort") parentAbort.abort()
  else if (failure === "error") input.emit("error", new Error("pipe failed"))
  else close()
  assert.equal(await pending, false)
  assert.equal(shownSignal?.aborted, true)
  const next = pair(async () => {
    assert.equal(closedIds.length, 1, "settlement is published before the next dialog")
    return "Allow once"
  })
  assert.equal(await next.client.ask("next child", 1000), true)
  next.close()
  close()
  assert.equal(closedIds.length, 1)
}

const cancellation = new AbortController()
const cancellationClosed: string[] = []
let cancelledRequestId = ""
let uiSignal: AbortSignal | undefined
const cancelled = pair(async (_title: string, _choices: string[], options: any) => {
  cancelledRequestId = JSON.parse(_title.split("\n")[0].slice(APPROVAL_TITLE_PREFIX.length)).requestId
  uiSignal = options.signal
  cancellation.abort()
  return new Promise(() => {})
}, true, (id) => { cancellationClosed.push(id) })
assert.equal(await cancelled.client.ask("cancel", 1000, cancellation.signal), false)
await delay(0)
assert.equal(uiSignal?.aborted, true)
assert.deepEqual(cancellationClosed, [cancelledRequestId])
cancelled.close()
await delay(0)
assert.deepEqual(cancellationClosed, [cancelledRequestId])

for (const onClosed of [() => { throw new Error("callback failed") }, async () => { throw new Error("callback rejected") }]) {
  const failedCallback = pair(async () => "Allow once", true, onClosed)
  assert.equal(await failedCallback.client.ask("callback cannot grant", 1000), false)
  failedCallback.close()
  const next = pair(async () => "Allow once")
  assert.equal(await next.client.ask("queue still drains", 1000), true)
  next.close()
}

const timeout = pair(() => new Promise((resolve) => { release = resolve }))
assert.equal(await timeout.client.ask("timeout", 10), false)
release("Allow once")
timeout.close()
const eof = pair(() => new Promise(() => {}))
const eofPending = eof.client.ask("EOF", 1000)
eof.requests.end()
assert.equal(await eofPending, false)
eof.close()
const invalid = pair(() => new Promise(() => {}))
const invalidPending = invalid.client.ask("bad frame", 1000)
invalid.replies.write('{"version":2}\n')
assert.equal(await invalidPending, false)
invalid.close()
const oversized = pair(() => { throw new Error("must not show") })
oversized.requests.write(Buffer.alloc(4097, 120))
assert.equal(await oversized.client.ask("closed", 100), false)
oversized.close()
const noUi = pair(() => { throw new Error("no UI") }, false)
assert.equal(await noUi.client.ask("headless", 100), false)
noUi.close()

// Byte-wise delivery includes a split multi-byte UTF-8 character.
const splitRequests = new PassThrough()
const splitReplies = new PassThrough()
const splitClose = broker.attach({ input: splitRequests, output: splitReplies }, {
  hasUI: true, ui: { select: async (title) => { assert.ok(title.endsWith("read: \u00e9")); return "Allow once" } },
}, identity)
const reply = new Promise<string>((resolve) => splitReplies.once("data", (chunk) => resolve(chunk.toString())))
for (const byte of Buffer.from(`${JSON.stringify({ version: 1, type: "ask", id: "00000000-0000-4000-8000-000000000001", summary: "read: \u00e9", deadline: Date.now() + 1000 })}\n`)) {
  splitRequests.write(Buffer.from([byte]))
}
assert.equal(JSON.parse(await reply).decision, "Allow once")
splitClose()

// A duplicate request ID closes the transport instead of reusing an approval.
const replay = pair(async () => "Allow once")
const replayFrame = Buffer.from(`${JSON.stringify({ version: 1, type: "ask", id: "00000000-0000-4000-8000-000000000002", summary: "read", deadline: Date.now() + 1000 })}\n`)
replay.requests.write(replayFrame)
replay.requests.write(replayFrame)
assert.equal(await replay.client.ask("after replay", 100), false)
replay.close()

// Both pending request count and writes to a peer that never reads are bounded.
const blockedInput = new PassThrough()
const blockedOutput = new Writable({ write: () => {} })
const blockedClient = createApprovalClient({ input: blockedInput, output: blockedOutput })
const blockedController = new AbortController()
const blockedRequests = Array.from({ length: 32 }, () => blockedClient.ask("bounded", 1000, blockedController.signal))
assert.equal(await blockedClient.ask("over limit", 1000), false)
blockedController.abort()
assert.ok((await Promise.all(blockedRequests)).every((allow) => !allow))
for (let i = 0; i < 1000 && !blockedOutput.destroyed; i++) {
  const controller = new AbortController()
  const request = blockedClient.ask("x".repeat(240), 1000, controller.signal)
  controller.abort()
  assert.equal(await request, false)
}
assert.equal(blockedOutput.destroyed, true)
assert.ok(blockedOutput.writableLength <= 4096 * 32)
blockedClient.close()

const abort = new AbortController()
const direct = selectApproval({ hasUI: true, ui: { select: async () => { abort.abort(); return new Promise(() => {}) } } }, "direct", Date.now() + 1000, abort.signal)
assert.equal(await direct, false)

// Actual extra fds survive a shell exec wrapper, while stdin is prompt + EOF and stdout is Pi JSON only.
const tools = new Map<string, any>()
const fixture = fileURLToPath(new URL("./fixtures/pi-approval-child.ts", import.meta.url))
createPiWorkflowExtension({
  readFile: async () => JSON.stringify({ roles: { scout: {} } }),
  getPiInvocation: (args) => ({ command: "bash", args: ["-c", 'exec "$@"', "approval-wrapper", process.execPath, "--experimental-strip-types", fixture, ...args] }),
})({ on: () => {}, registerTool: (tool: any) => tools.set(tool.name, tool), appendEntry: () => {} } as any)
let active = 0
let peak = 0
const titles: string[] = []
const ctx = { cwd: process.cwd(), hasUI: true, ui: { select: async (title: string) => {
  titles.push(title)
  peak = Math.max(peak, ++active)
  await delay(10)
  active--
  return title.endsWith("read: allow.txt") ? "Allow once" : "Deny"
} } }
const partialUpdates: any[][] = [[], []]
const results = await Promise.all(["allow.txt", "deny.txt"].map((prompt, index) => tools.get("task").execute(
  `spawn-parent-${index}`, { role: "scout", prompt }, undefined, (update: any) => partialUpdates[index].push(update), ctx,
)))
assert.deepEqual(results.map((r) => r.details.results[0].output), ["allowed", "denied"])
assert.ok(results.every((r) => r.details.results[0].status === "completed"))
assert.equal(peak, 1)
assert.equal(titles.length, 2)
for (let index = 0; index < 2; index++) {
  const metadata = titles.map((title) => JSON.parse(title.split("\n")[0].slice(APPROVAL_TITLE_PREFIX.length)))
    .find((entry) => entry.toolCallId === `spawn-parent-${index}`)
  assert.ok(partialUpdates[index].some((update) => update.details.jobs.some((job: any) =>
    job.taskId === metadata.taskId && job.approvalClosed === metadata.requestId
    && typeof job.steps === "number" && typeof job.output === "string" && typeof job.outputTruncated === "boolean")))
}
assert.ok(titles.some((title) => title.includes('"toolCallId":"spawn-parent-0"')))
assert.ok(titles.some((title) => title.includes('"toolCallId":"spawn-parent-1"')))
for (const [prompt, hasUI] of [[".env", true], ["readme.txt", false]] as const) {
  const result = await tools.get("task").execute("spawn-closed", { role: "scout", prompt }, undefined, undefined, {
    ...ctx, hasUI, ui: { select: () => { throw new Error("must fail closed without a dialog") } },
  })
  assert.equal(result.details.results[0].output, "denied")
}
const spawnedAbort = new AbortController()
const cancelledUpdates: any[] = []
let spawnedRequestId = ""
const spawnedCancelled = await tools.get("task").execute("spawn-cancel", { role: "scout", prompt: "cancel.txt" },
  spawnedAbort.signal, (update: any) => cancelledUpdates.push(update), { ...ctx, ui: { select: async (title: string) => {
    spawnedRequestId = JSON.parse(title.split("\n")[0].slice(APPROVAL_TITLE_PREFIX.length)).requestId
    spawnedAbort.abort()
    return new Promise(() => {})
  } } })
assert.equal(spawnedCancelled.details.results[0].status, "cancelled")
assert.ok(cancelledUpdates.some((update) => update.details.jobs.some((job: any) =>
  job.taskId === spawnedCancelled.details.results[0].taskId && job.approvalClosed === spawnedRequestId)))
console.log("pi approval tests passed")
