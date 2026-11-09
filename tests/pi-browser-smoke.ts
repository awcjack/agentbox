// Real headless acceptance test. Requires working unprivileged Chromium sandbox.
// Never retries with --no-sandbox; run as the agent user in the actual container.
// Uses fixture-only CLI diagnostics. Do not adapt this harness to real accounts/pages.
// node --experimental-strip-types tests/pi-browser-smoke.ts /bin/agent-browser /bin/agentbox-browser-chromium
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { BrowserSession } from "../extensions/pi-browser.ts"
import type { BrowserConfig } from "../extensions/pi-browser.ts"
import { snapshotRef, runFixtureBrowser } from "./browser-smoke-helpers.ts"

const [executable, chromium] = process.argv.slice(2)
assert(executable?.startsWith("/") && chromium?.startsWith("/"), "Supply absolute CLI and sandboxed Chromium executable paths")
let disallowedRequests = 0
const html = `<!doctype html><meta charset="utf-8"><title>Agentbox browser fixture</title>
<label>Name<input id="name"></label><button id="save">Save</button><p id="result">initial</p><p id="cookie"></p>
<script>
document.querySelector('#cookie').textContent=document.cookie;
document.querySelector('#save').onclick=()=>{document.querySelector('#result').textContent='saved '+document.querySelector('#name').value;document.cookie='fixture=shared; path=/';};
console.log('fixture console message');
</script>`
const server = createServer((req, res) => {
  if (req.headers.host?.startsWith("localhost:")) disallowedRequests++
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" })
  res.end(html)
})
server.listen(0, "127.0.0.1")
await once(server, "listening")
const address = server.address() as { port: number }
const url = `http://127.0.0.1:${address.port}/`
const config: BrowserConfig = { enable: true, delegation: "tabs", allowedDomains: [], maxOutputChars: 16000, commandTimeoutMs: 30000, idleTimeoutMs: 300000 }
const sessions: BrowserSession[] = []
async function make(overrides: Partial<BrowserConfig> = {}, parent?: BrowserSession) {
  const browser = new BrowserSession({ ...config, ...overrides }, randomUUID(), executable, chromium, runFixtureBrowser)
  await browser.initialize(parent?.root)
  sessions.push(browser)
  return browser
}
function text(result: any) { return result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") }
let phase = "initialize"
function stage(name: string) { phase = name; console.log(`[browser smoke] ${name}`) }
try {
  stage("parent: start and open fixture")
  const parent = await make()
  await parent.execute({ action: "open", url })
  stage("parent: snapshot")
  const snapshot = await parent.execute({ action: "snapshot" })
  stage("parent: fill textbox")
  await parent.execute({ action: "fill", ref: snapshotRef(snapshot, "textbox", "Name"), text: "Alice" })
  stage("parent: refresh snapshot")
  const afterFill = await parent.execute({ action: "snapshot" })
  stage("parent: click Save")
  await parent.execute({ action: "click", ref: snapshotRef(afterFill, "button", "Save") })
  stage("parent: verify saved text")
  assert.match(text(await parent.execute({ action: "get", property: "text" })), /saved Alice/)
  stage("parent: JPEG screenshot")
  const screenshot = await parent.execute({ action: "screenshot" })
  assert(screenshot.content.some(c => c.type === "image" && c.mimeType === "image/jpeg"))
  stage("parent: console capture")
  assert.match(text(await parent.execute({ action: "console" })), /fixture console message/)
  stage("child: attach distinct tab and open fixture")
  const child = await make({}, parent)
  await child.execute({ action: "open", url })
  stage("child: verify shared cookie and independent parent tab")
  assert.notEqual(parent.targetId, child.targetId)
  assert.match(text(await child.execute({ action: "get", property: "text" })), /fixture=shared/)
  assert.match(text(await parent.execute({ action: "get", property: "text" })), /saved Alice/, "child navigation must not move parent tab")
  stage("child: shut down without closing parent")
  await child.shutdown()
  assert.match(text(await parent.execute({ action: "get", property: "text" })), /saved Alice/)
  stage("phase2: main-tab preview and explicit human takeover")
  parent.liveControl = true // Fixture calls the same private handler; HTTP/fd auth is tested separately.
  const principal = "a".repeat(64)
  const control = (operation: string, payload = {}) => parent.control(operation, payload, principal, AbortSignal.timeout(10000))
  const controlChild = await make({}, parent)
  await controlChild.execute({ action: "open", url })
  const status = await control("status")
  assert.equal(status.ready, true)
  const lease = await control("acquire", { browserSessionId: parent.session })
  for (const agent of [parent, controlChild]) await assert.rejects(agent.execute({ action: "snapshot" }), { code: "browser_control_held" })
  for (const [action, role, name, textValue] of [["fill", "textbox", "Name", "Human"], ["click", "button", "Save", undefined]]) {
    const frame = await control("frame")
    assert.equal(frame.mimeType, "image/jpeg")
    assert.equal(Buffer.from(frame.data, "base64")[0], 0xff)
    const ref = frame.refs.find((r: any) => r.role === role && r.name === name)?.ref
    assert(ref, `missing ${role} ${name} in preview`)
    const payload = { browserSessionId: parent.session, leaseId: lease.leaseId, frameId: frame.frameId,
      request: { action, ref, ...(textValue ? { text: textValue } : {}) } }
    assert.equal((await control("input", payload)).accepted, true)
    await assert.rejects(control("input", payload), { code: "browser_frame_stale" })
  }
  await control("release", { browserSessionId: parent.session, leaseId: lease.leaseId })
  assert.match(text(await parent.execute({ action: "get", property: "text" })), /saved Human/)
  await controlChild.execute({ action: "snapshot" })
  await controlChild.shutdown()
  await parent.disconnectControl()
  stage("unrelated conversation: verify cookie isolation")
  const unrelated = await make()
  await unrelated.execute({ action: "open", url })
  assert(!text(await unrelated.execute({ action: "get", property: "text" })).includes("fixture=shared"))
  stage("allowlist: start isolated browser and open allowed fixture")
  const restricted = await make({ allowedDomains: ["127.0.0.1"] })
  await restricted.execute({ action: "open", url })
  assert.equal(restricted.shared, false)
  stage("allowlist: expect forbidden navigation to fail")
  await assert.rejects(restricted.execute({ action: "open", url: `http://localhost:${address.port}/forbidden` }), /Domain 'localhost' is not in the allowed domains list/)
  assert.equal(disallowedRequests, 0)
} catch (error) {
  console.error(`[browser smoke] FAILED during ${phase}`)
  throw error
} finally {
  console.log("[browser smoke] cleanup")
  let cleanupFailed = false
  for (const session of sessions.reverse()) await session.shutdown().catch(e => { cleanupFailed = true; console.error("cleanup:", e.message) })
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  assert(!cleanupFailed, "Browser cleanup must succeed")
}
console.log("Real browser form/screenshot/console, shared-tab login, human preview/takeover, conversation isolation, and allowlist smoke passed")
