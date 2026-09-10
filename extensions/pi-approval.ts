import { randomUUID } from "node:crypto"
import { fstatSync } from "node:fs"
import { Socket } from "node:net"
import type { Readable, Writable } from "node:stream"

export const APPROVAL_ENV = "PI_WORKFLOW_APPROVAL_VERSION"
export const APPROVAL_VERSION = "1"
export const APPROVAL_TITLE_PREFIX = "Pi child approval "
const MAX_FRAME = 4096
const MAX_PENDING = 32
const MAX_REQUESTS = 4096
const MAX_TIMEOUT = 300_000
type Transport = { input: Readable; output: Writable }
export type ApprovalContext = {
  hasUI: boolean
  ui: { select: (title: string, choices: string[], options: { signal: AbortSignal; timeout: number }) => Promise<string | undefined> }
}

// Race explicitly: some UI implementations ignore abort, and late answers must never authorize.
export async function selectApproval(ctx: ApprovalContext, title: string, deadline: number, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  const timeout = deadline - Date.now()
  if (signal?.aborted || timeout <= 0 || !ctx.hasUI) {
    signal?.removeEventListener("abort", abort)
    return false
  }
  let cancel!: () => void
  const cancelled = new Promise<undefined>((resolve) => { cancel = () => resolve(undefined) })
  controller.signal.addEventListener("abort", cancel, { once: true })
  const timer = setTimeout(abort, timeout)
  try {
    const selected = await Promise.race([
      ctx.ui.select(title, ["Allow once", "Deny"], { signal: controller.signal, timeout }), cancelled,
    ])
    return !controller.signal.aborted && Date.now() < deadline && selected === "Allow once"
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
    controller.abort()
    controller.signal.removeEventListener("abort", cancel)
  }
}

function channel(transport: Transport, receive: (frame: any) => void, closed: () => void) {
  let buffer = Buffer.alloc(0)
  let stopped = false
  const close = () => {
    if (stopped) return
    stopped = true
    transport.input.removeListener("data", data)
    buffer = Buffer.alloc(0)
    transport.input.destroy()
    transport.output.destroy()
    closed()
  }
  const data = (chunk: Buffer) => {
    if (stopped) return
    let offset = 0
    while (offset < chunk.length && !stopped) {
      const newline = chunk.indexOf(10, offset)
      const end = newline < 0 ? chunk.length : newline
      if (buffer.length + end - offset > MAX_FRAME) return close()
      buffer = Buffer.concat([buffer, chunk.subarray(offset, end)])
      if (newline < 0) return
      try {
        const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer))
        buffer = Buffer.alloc(0)
        if (!frame || Array.isArray(frame) || frame.version !== 1 || typeof frame.id !== "string"
          || !/^[a-f0-9-]{36}$/.test(frame.id)) return close()
        receive(frame)
      } catch { return close() }
      offset = newline + 1
    }
  }
  transport.input.on("data", data)
  transport.input.once("end", close)
  transport.input.once("close", close)
  transport.output.once("close", close)
  transport.input.on("error", close)
  transport.output.on("error", close)
  return {
    close,
    send(frame: unknown) {
      if (stopped) return false
      const bytes = Buffer.from(`${JSON.stringify(frame)}\n`)
      if (bytes.length > MAX_FRAME || transport.output.writableLength + bytes.length > MAX_FRAME * MAX_PENDING) {
        close()
        return false
      }
      try { transport.output.write(bytes); return true } catch { close(); return false }
    },
  }
}

export function createApprovalClient(transport: Transport) {
  const pending = new Map<string, (allow: boolean, cancel?: boolean) => void>()
  let stopped = false
  let count = 0
  const wire = channel(transport, (frame) => {
    if (Object.keys(frame).sort().join() !== "decision,id,type,version" || frame.type !== "reply"
      || !["Allow once", "Deny"].includes(frame.decision)) return wire.close()
    pending.get(frame.id)?.(frame.decision === "Allow once")
  }, () => {
    stopped = true
    for (const finish of pending.values()) finish(false)
  })
  return {
    close: wire.close,
    ask(summary: string, timeout: number, signal?: AbortSignal): Promise<boolean> {
      if (stopped || signal?.aborted || pending.size >= MAX_PENDING || ++count > MAX_REQUESTS
        || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT || summary.length > 240) return Promise.resolve(false)
      const id = randomUUID()
      const deadline = Date.now() + timeout
      return new Promise((resolve) => {
        const abort = () => finish(false, true)
        const timer = setTimeout(abort, timeout)
        const finish = (allow: boolean, cancel = false) => {
          if (!pending.delete(id)) return
          clearTimeout(timer)
          signal?.removeEventListener("abort", abort)
          if (cancel) wire.send({ version: 1, type: "cancel", id })
          resolve(allow && !signal?.aborted && Date.now() < deadline)
        }
        pending.set(id, finish)
        signal?.addEventListener("abort", abort, { once: true })
        if (!wire.send({ version: 1, type: "ask", id, summary, deadline })) finish(false)
      })
    },
  }
}

export function openApprovalClient(env: NodeJS.ProcessEnv = process.env) {
  if (env[APPROVAL_ENV] !== APPROVAL_VERSION) return undefined
  let output: Socket | undefined
  try {
    if (![3, 4].every((fd) => fstatSync(fd).isSocket() || fstatSync(fd).isFIFO())) return undefined
    output = new Socket({ fd: 3, readable: false, writable: true })
    return createApprovalClient({ output, input: new Socket({ fd: 4, readable: true, writable: false }) })
  } catch { output?.destroy(); return undefined }
}

// One broker per workflow extension instance, shared across concurrent task.execute calls.
export function createApprovalBroker() {
  const queue: Array<() => Promise<void>> = []
  let active = false
  let pendingCount = 0
  const drain = async () => {
    if (active) return
    active = true
    try { while (queue.length) await queue.shift()!() } finally { active = false }
  }
  return {
    attach(transport: Transport, ctx: ApprovalContext, identity: { toolCallId: string; taskId: string; role: string }, signal?: AbortSignal,
      onClosed?: (requestId: string) => void | Promise<void>) {
      const pending = new Map<string, AbortController>()
      const seen = new Set<string>()
      const abort = () => wire.close()
      const wire = channel(transport, (frame) => {
        if (frame.type === "cancel" && Object.keys(frame).sort().join() === "id,type,version") {
          pending.get(frame.id)?.abort()
          return
        }
        if (frame.type !== "ask" || Object.keys(frame).sort().join() !== "deadline,id,summary,type,version"
          || typeof frame.summary !== "string" || frame.summary.length > 240
          || !Number.isSafeInteger(frame.deadline) || frame.deadline > Date.now() + MAX_TIMEOUT
          || seen.has(frame.id) || seen.size >= MAX_REQUESTS || pendingCount >= MAX_PENDING) return wire.close()
        seen.add(frame.id)
        const controller = new AbortController()
        pending.set(frame.id, controller)
        pendingCount++
        const timer = setTimeout(() => controller.abort(), Math.max(0, frame.deadline - Date.now()))
        queue.push(async () => {
          try {
            const title = `${APPROVAL_TITLE_PREFIX}${JSON.stringify({ version: 1, ...identity, requestId: frame.id })}\n${frame.summary.replace(/[\u0000-\u001f\u007f]/g, " ")}`
            const allow = await selectApproval(ctx, title, frame.deadline, controller.signal)
            await onClosed?.(frame.id)
            wire.send({ version: 1, type: "reply", id: frame.id,
              decision: allow && !controller.signal.aborted && Date.now() < frame.deadline ? "Allow once" : "Deny" })
          } catch {
            wire.close()
          } finally {
            clearTimeout(timer)
            pending.delete(frame.id)
            pendingCount--
          }
        })
        void drain()
      }, () => {
        signal?.removeEventListener("abort", abort)
        for (const controller of pending.values()) controller.abort()
      })
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      return wire.close
    },
  }
}
