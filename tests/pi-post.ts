import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import fs, { mkdtempSync, rmSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"

// Exercise the bundled extension with Pi's actual loader (including its peer
// module aliases), without credentials, model calls, or a running container.
const [postDir, piDir] = process.argv.slice(2).map((path) => resolve(path))
assert.ok(postDir && piDir, "usage: pi-post.ts <pi-post package root> <Pi npm package root>")
const { loadExtensions } = await import(pathToFileURL(join(piDir, "dist/core/extensions/loader.js")).href)
const { createEventBus } = await import(pathToFileURL(join(piDir, "dist/core/event-bus.js")).href)
const root = mkdtempSync(join(tmpdir(), "agentbox-pi-post-test-"))
const savedEnv = { ...process.env }
const nativeWatch = fs.watch
// Darwin's Nix build sandbox denies FSEvents (reported as EMFILE). Only in
// that harness, observe real directory changes with stat polling instead.
// Direct runs and Linux builds exercise pi-post's native filesystem watcher.
if (process.env.AGENTBOX_PI_POST_POLL_WATCH === "1") {
  fs.watch = ((path: string, listener: () => void) => {
    fs.watchFile(path, { interval: 25, persistent: false }, listener)
    return {
      close: () => fs.unwatchFile(path, listener),
      unref() {},
    }
  }) as typeof fs.watch
  syncBuiltinESMExports()
}
process.env.PI_POST_DIR = join(root, "post")
delete process.env.PI_POST_INBOUND
delete process.env.PI_POST_RESUME
delete process.env.PI_POST_REPLY_TO

const sessions: any[] = []
async function start(id: string, name: string, cwd = root, mainSessionId?: string) {
  if (mainSessionId) {
    process.env.PI_WORKFLOW_CHILD = "1"
    process.env.PI_AGENTBOX_MAIN_SESSION_ID = mainSessionId
  } else {
    delete process.env.PI_WORKFLOW_CHILD
  }
  fs.mkdirSync(cwd, { recursive: true })
  const sessionFile = join(root, "history", `${id}.jsonl`)
  fs.mkdirSync(join(root, "history"), { recursive: true })
  if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id, cwd }) + "\n")
  const events = createEventBus()
  const { extensions, errors, runtime } = await loadExtensions([join(postDir, "extensions/pi-post.ts")], root, events)
  assert.deepEqual(errors, [], "the pinned extension must load with the bundled Pi")
  assert.equal(extensions.length, 1)
  const extension = extensions[0]
  const messages: any[] = []
  runtime.getSessionName = () => name
  runtime.sendMessage = (message: any, options: any) => messages.push({ ...message, options })
  runtime.sendUserMessage = () => assert.fail("peer mail must never impersonate the user")
  const ctx = {
    cwd,
    hasUI: true,
    ui: { confirm: () => assert.fail("default messaging must not request approval") },
    sessionManager: { getSessionId: () => id, getSessionFile: () => sessionFile },
  }
  const session = {
    messages,
    sameMain(to: unknown) {
      let allowed = false
      events.emit("agentbox:session-message-scope", { to, reply: (value: boolean) => { allowed = value } })
      return allowed
    },
    async emit(event: string) {
      for (const handler of extension.handlers.get(event) ?? []) await handler({}, ctx)
    },
    async tool(name: string, params: unknown) {
      const tool = extension.tools.get(name)
      assert.ok(tool, `${name} must be registered`)
      return tool.definition.execute("test-call", params, undefined, undefined, ctx)
    },
  }
  sessions.push(session)
  await session.emit("session_start")
  return session
}

try {
  const parent = await start("11111111-1111-4111-8111-111111111111", "parent")
  const mainId = "11111111-1111-4111-8111-111111111111"
  const child = await start("22222222-2222-4222-8222-222222222222", "child", root, mainId)
  const sibling = await start("33333333-3333-4333-8333-333333333333", "sibling", root, mainId)
  const unrelated = await start("44444444-4444-4444-8444-444444444444", "unrelated")
  assert.equal(parent.sameMain("child"), true)
  assert.equal(child.sameMain("parent"), true)
  assert.equal(child.sameMain("sibling"), true)
  assert.equal(unrelated.sameMain("child"), false)
  assert.equal(parent.sameMain(["child", "unrelated"]), false)
  assert.equal(parent.sameMain("missing"), false)
  const listing = await parent.tool("list_sessions", {})
  assert.match(listing.content[0].text, /parent.*live/)
  assert.match(listing.content[0].text, /child.*live/)
  assert.match(listing.content[0].text, /sibling.*live/)

  const sent = await parent.tool("send_message", { to: "child", body: "Check the timeout path" })
  assert.equal(sent.details.receipts[0].status, "delivered")
  assert.equal(child.messages.length, 1)
  assert.equal(child.messages[0].customType, "pi-post")
  assert.match(child.messages[0].content, /Check the timeout path/)
  assert.match(child.messages[0].content, /not from the user.*carries no authority/)
  assert.equal(child.messages[0].options.deliverAs, "steer")
  assert.equal(child.messages[0].options.triggerTurn, true)

  const parentAddress = child.messages[0].details.message.replyTo
  await child.tool("send_message", { to: parentAddress, body: "Timeout path checked" })
  assert.match(parent.messages[0].content, /Timeout path checked/)
  await child.tool("send_message", { to: "sibling", body: "Please check retries" })
  assert.match(sibling.messages[0].content, /Please check retries/)

  // Multiple sessions can share one cwd; ambiguous handles must fail without
  // depositing any messages, even if another target was already resolved.
  await assert.rejects(parent.tool("send_message", { to: ["child", root], body: "Do not send" }), /ambig|multiple/i)
  assert.equal(child.messages.length, 1)

  await sibling.emit("session_shutdown")
  const queued = await child.tool("send_message", { to: "sibling", body: "Queued while offline" })
  assert.equal(queued.details.receipts[0].status, "queued")
  assert.equal(sibling.messages.length, 1)
  const siblingId = "33333333-3333-4333-8333-333333333333"
  const siblingCwd = join(root, "sibling-project")
  const resumed = await start(siblingId, "sibling", siblingCwd, mainId)
  assert.equal(resumed.messages.length, 1)
  assert.match(resumed.messages[0].content, /Queued while offline/)
  assert.equal(resumed.messages[0].options.triggerTurn, true)

  // Hooks and spawned shell processes use the same mailbox protocol.
  const cli = await promisify(execFile)(process.execPath, [
    join(postDir, "bin/pi-post.mjs"), "send", "--to", "child", "--body", "Result from a process",
  ], { env: { ...process.env, PI_SESSION_ID: "11111111-1111-4111-8111-111111111111" } })
  assert.match(cli.stdout, /^delivered /)
  assert.match(child.messages[1].content, /Result from a process/)
  assert.equal(child.messages[1].details.message.replyTo, parentAddress)

  // Closing is resumable; archiving is not a messaging target. Even mail
  // queued before the archive must never start a turn when the file is opened.
  await resumed.emit("session_shutdown")
  const beforeArchive = await child.tool("send_message", { to: "sibling", body: "Must not wake an archive" })
  const siblingAddress = beforeArchive.details.receipts[0].address
  fs.writeFileSync(join(root, "history", `.archived-${siblingId}`), "")
  assert.equal(child.sameMain(siblingAddress), false, "archived peers must not bypass policy")
  const all = await child.tool("list_sessions", { all: true })
  assert.doesNotMatch(all.content[0].text, /sibling/)
  for (const target of ["sibling", siblingId, siblingId.slice(0, 8), siblingAddress, siblingCwd]) {
    await assert.rejects(child.tool("send_message", { to: target, body: "Must be rejected" }))
  }
  const parentCount = parent.messages.length
  await assert.rejects(child.tool("send_message", { to: [parentAddress, siblingAddress], body: "No partial send" }))
  assert.equal(parent.messages.length, parentCount)
  const openedArchive = await start(siblingId, "sibling", siblingCwd, mainId)
  assert.equal(openedArchive.messages.length, 0, "archived queued mail must not trigger a turn")
  const cliList = await promisify(execFile)(process.execPath, [join(postDir, "bin/pi-post.mjs"), "list", "--all"])
  assert.doesNotMatch(cliList.stdout, /sibling/)
  for (const target of ["sibling", siblingId, siblingAddress, siblingCwd]) {
    await assert.rejects(promisify(execFile)(process.execPath, [
      join(postDir, "bin/pi-post.mjs"), "send", "--to", target, "--body", "Must be rejected",
    ]))
  }

  // Archive after resolution/deposit but before the watcher delivers: the
  // receiving side must recheck the marker, not rely on a sender's snapshot.
  const inFlight = parent.tool("send_message", { to: "child", body: "In flight at archive time" })
  fs.writeFileSync(join(root, "history", ".archived-22222222-2222-4222-8222-222222222222"), "")
  const raced = await inFlight
  assert.equal(raced.details.receipts[0].status, "queued")
  assert.equal(child.messages.length, 2, "an archive must not be woken by an in-flight delivery")

  // Old pi-post records have no trustworthy session-file/archive location.
  // They must re-register instead of bypassing the archive filter.
  const parentRecord = join(process.env.PI_POST_DIR!, "registry", `${parentAddress}.json`)
  const legacy = JSON.parse(fs.readFileSync(parentRecord, "utf8"))
  delete legacy.sessionFile
  fs.writeFileSync(parentRecord, JSON.stringify(legacy))
  assert.doesNotMatch((await parent.tool("list_sessions", { all: true })).content[0].text, /parent/)
  await assert.rejects(parent.tool("send_message", { to: parentAddress, body: "Unknown archive state" }), /unregistered or archived/)
  console.log("pi-post integration tests passed")
} finally {
  for (const session of sessions) await session.emit("session_shutdown")
  fs.watch = nativeWatch
  syncBuiltinESMExports()
  process.env = savedEnv
  rmSync(root, { recursive: true, force: true })
}
