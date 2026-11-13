import assert from "node:assert/strict"
import net from "node:net"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// usage: <pi-post package root> <Pi npm package root> <rpc-runtime source root>
const [postDir, piDir, rpcDir] = process.argv.slice(2).map(p => resolve(p))
const load = (path: string) => import(pathToFileURL(path).href)
const { loadExtensions } = await load(join(piDir, "dist/core/extensions/loader.js"))
const { createEventBus } = await load(join(piDir, "dist/core/event-bus.js"))
const { createPostBroker } = await load(join(rpcDir, "post-broker.mjs"))
const { PostClient, createPostRelay } = await load(join(rpcDir, "post-client.mjs"))
const { main: cli } = await load(join(rpcDir, "post-cli.mjs"))
const { isArchived } = await load(join(postDir, "src/archive.mjs"))
const base = mkdtempSync(join(tmpdir(), "pi-post-extension-test-"))
const dir = join(base, "sessions"); mkdirSync(dir)
const saved = { ...process.env }
const id = randomUUID()
const broker = createPostBroker({ root: join(base, "trusted"), profiles: new Map([["fixture", { sessionDir: dir }]]) })
const server = net.createServer(socket => broker.attach(socket, () => ({ sessionId: id, rootSessionId: id, sessionDir: dir, cwd: base, live: true })))
const path = join(base, "upstream.sock")
await new Promise<void>(done => server.listen(path, done))
const parent = new PostClient(net.createConnection(path))
await parent.request("register", { name: "supervisor" })
const relay = await createPostRelay((...args: any[]) => parent.request(...args))
const sessions: any[] = []
async function start(name: string, options: { stage?: boolean, inbound?: string, queued?: boolean, archiveDuringConfirm?: boolean } = {}) {
  const sessionId = randomUUID()
  // Register once so a queued fixture can be sent before extension startup.
  const preparation = new PostClient(net.createConnection(relay.path))
  const record = await preparation.request("register", { sessionId, name })
  if (options.queued) await parent.request("send", { to: name, body: "queued fixture" })
  await preparation.request("offline")
  preparation.close()
  process.env.PI_POST_BROKER_SOCKET = relay.path
  delete process.env.PI_POST_BROKER_FD
  process.env.PI_POST_DIR = join(base, "forbidden-local")
  process.env.PI_POST_RESUME = options.stage ? "stage" : "wake"
  process.env.PI_POST_INBOUND = options.inbound ?? "accept"
  const events = createEventBus()
  const { extensions, errors, runtime } = await loadExtensions([join(postDir, existsSync(join(postDir, "extensions/pi-post.ts")) ? "extensions/pi-post.ts" : "extensions/pi-post-broker.ts")], base, events)
  assert.deepEqual(errors, [])
  const extension = extensions[0], messages: any[] = [], notices: string[] = []
  runtime.getSessionName = () => name
  runtime.sendMessage = (message: any, options: any) => messages.push({ ...message, options })
  runtime.sendUserMessage = () => assert.fail("mail cannot impersonate user")
  const ctx = { cwd: base, hasUI: options.inbound === "ask", ui: { confirm: async () => {
    if (options.archiveDuringConfirm) {
      writeFileSync(join(dir, `.archived-${sessionId}`), "")
      return true
    }
    return false
  }, notify: (text: string) => notices.push(text) }, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined } }
  const emit = async (event: string) => { for (const handler of extension.handlers.get(event) ?? []) await handler({}, ctx) }
  const tool = async (name: string, params: any) => extension.tools.get(name).definition.execute("test", params, undefined, undefined, ctx)
  const session = { record, messages, notices, events, emit, tool, extension, ctx }
  sessions.push(session)
  await emit("session_start")
  return session
}
try {
  const s = await start("worker", { queued: true, stage: true })
  assert.equal(s.messages.length, 1)
  assert.equal(isArchived({ brokerVersion: 1, sessionId: s.record.sessionId, rootSessionId: id, archiveDir: dir, sessionFile: null }), false)
  assert.equal(s.messages[0].options.deliverAs, "nextTurn")
  assert.match(s.messages[0].content, /untrusted peer data/)
  assert.equal((await parent.request("inbox")).messages.length, 0)
  const scope = await new Promise(done => s.events.emit("agentbox:session-message-scope", { to: "supervisor", reply: done }))
  assert.equal(scope, true)
  assert.match((await s.tool("list_sessions", {})).content[0].text, /supervisor.*live/)
  assert.equal(await cli(["whoami"]), s.record.address, "shell CLI authenticates as extension, not supervisor")
  await s.tool("send_message", { to: "supervisor", body: "extension finding" })
  assert.equal((await parent.request("poll")).messages[0].from.address, s.record.address)
  await s.extension.commands.get("inbox").handler("", s.ctx)
  assert.match(s.notices[0], /Inbox empty/)
  const refused = await start("refused", { queued: true, inbound: "refuse" })
  assert.equal(refused.messages.length, 0)
  const ask = await start("ask", { queued: true, inbound: "ask" })
  assert.equal(ask.messages.length, 0, "declined ask must not inject")
  await assert.rejects(start("archive-during-confirm", { queued: true, inbound: "ask", archiveDuringConfirm: true }))
  assert.equal(sessions.at(-1).messages.length, 0, "archiving during confirmation must prevent injection")
  process.env.PI_POST_INBOUND = "accept"
  await parent.request("send", { to: "worker", body: "must never wake archive" })
  writeFileSync(join(dir, `.archived-${s.record.sessionId}`), "")
  await new Promise(done => setTimeout(done, 1100))
  assert.equal(s.messages.length, 1)
  assert.equal(isArchived({ brokerVersion: 1, sessionId: s.record.sessionId, rootSessionId: id, archiveDir: dir, sessionFile: null }), true)
  writeFileSync(join(dir, `.archived-${id}`), "")
  assert.equal(isArchived({ brokerVersion: 1, sessionId: refused.record.sessionId, rootSessionId: id, archiveDir: dir, sessionFile: null }), true)
  assert.equal(existsSync(join(base, "forbidden-local")), false)
  broker.close()
  await assert.rejects(s.tool("list_sessions", {}))
  console.log("pi-post broker extension tests passed")
} finally {
  for (const s of sessions) await s.emit("session_shutdown")
  await relay.close(); parent.close(); broker.close()
  await new Promise<void>(done => server.close(() => done()))
  process.env = saved; rmSync(base, { recursive: true, force: true })
}
