import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import http2 from "node:http2"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Load all three bundled extensions with Pi's real peer-import aliases. This
// catches missing transitive dependencies and incompatible provider APIs,
// without using an account, OAuth browser, or model request.
const [cursorExtension, piDir, agentboxExtension, postExtension] = process.argv.slice(2).map((path) => resolve(path))
assert.ok(cursorExtension && piDir && agentboxExtension && postExtension,
  "usage: pi-cursor.ts <Cursor extension> <Pi package root> <Agentbox extension> <pi-post extension>")
const root = mkdtempSync(join(tmpdir(), "agentbox-pi-cursor-test-"))
const savedEnv = { ...process.env }
const nativeFetch = globalThis.fetch
const nativeConnect = http2.connect
let networkAttempts = 0

try {
  process.env.PI_CODING_AGENT_DIR = join(root, "agent")
  process.env.CURSOR_CONFIG_DIR = join(root, "cursor")
  process.env.PI_CURSOR_CACHE_DIR = join(root, "cache")
  process.env.PI_CURSOR_LIFECYCLE_LOG = join(root, "lifecycle.jsonl")
  process.env.PI_CURSOR_SYSTEM_CREDENTIALS = "0"
  process.env.PI_OFFLINE = "1"
  delete process.env.CURSOR_ACCESS_TOKEN

  const rejectNetwork = () => {
    networkAttempts++
    throw new Error("Extension loading must not contact Cursor")
  }
  globalThis.fetch = rejectNetwork
  http2.connect = rejectNetwork as typeof http2.connect
  syncBuiltinESMExports()

  const { loadExtensions } = await import(pathToFileURL(join(piDir, "dist/core/extensions/loader.js")).href)
  const { extensions, errors, runtime } = await loadExtensions(
    [agentboxExtension, postExtension, cursorExtension], root,
  )
  assert.deepEqual(errors, [], "all bundled extensions must load together")
  assert.equal(extensions.length, 3)
  assert.ok(extensions[0].handlers.has("tool_call"), "Agentbox guards remain registered")
  assert.ok(extensions[1].tools.has("send_message"), "pi-post remains available")

  const cursor = extensions[2]
  const registration = runtime.pendingProviderRegistrations.find(({ name }: any) => name === "cursor")
  assert.ok(registration, "Cursor provider must be registered without credentials")
  const { config } = registration
  assert.ok(config.models.length > 0, "offline fallback models must be available")
  assert.equal(typeof config.streamSimple, "function", "native streaming must be registered")
  assert.equal(typeof config.oauth.login, "function", "Cursor browser login must be available")
  assert.equal(typeof config.oauth.refreshToken, "function", "stored credentials must support refresh")

  const notices: string[] = []
  const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } }
  for (const name of ["cursor.models", "cursor.doctor", "cursor.usage"]) {
    assert.ok(cursor.commands.has(name), `${name} must be available`)
  }
  await cursor.commands.get("cursor.models").handler("", ctx)
  assert.match(notices.pop()!, /Cursor models \([1-9]/)
  await cursor.commands.get("cursor.doctor").handler("", ctx)
  const diagnostics = notices.pop()!
  assert.match(diagnostics, /provider=cursor/)
  assert.match(diagnostics, /tokenSource=none/)
  assert.equal(networkAttempts, 0, "loading and offline diagnostics must work without network")
  console.log("pi-cursor integration tests passed")
} finally {
  globalThis.fetch = nativeFetch
  http2.connect = nativeConnect
  syncBuiltinESMExports()
  process.env = savedEnv
  rmSync(root, { recursive: true, force: true })
}
