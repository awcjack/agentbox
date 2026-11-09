// Actual installed-Pi extension loading and argument-validation compatibility.
// No session_start: this must never read the live managed runtime config.
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

assert(process.argv[2], "Provide the installed pi-monorepo package root")
const piRoot = resolve(process.argv[2])
const temporary = await fs.mkdtemp(join(tmpdir(), "browser-loader-test-"))
Object.assign(process.env, { HOME: temporary, PI_CODING_AGENT_DIR: temporary, PI_OFFLINE: "1" })
try {
  const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")))
  const { validateToolArguments } = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/utils/validation.js")))
  const source = fileURLToPath(new URL("../extensions/pi-browser.ts", import.meta.url))
  const loaded = await loadExtensions([source], temporary)
  assert.deepEqual(loaded.errors, [])
  assert.equal(loaded.extensions.length, 1)
  const extension = loaded.extensions[0]
  const tool = extension.tools.get("browser").definition
  assert(extension.handlers.has("session_start"))
  assert(extension.handlers.has("session_shutdown"))
  for (const parameters of [
    { action: "status" }, { action: "open", url: "https://example.com" },
    { action: "fill", ref: "@e1", text: "--literal-data" },
    { action: "scroll", direction: "down", amount: 250 },
  ]) {
    assert.deepEqual(validateToolArguments(tool, { id: "test", name: "browser", arguments: parameters }), parameters)
  }
  for (const parameters of [{ action: "eval" }, { action: "status", cdp: "http://localhost" }]) {
    assert.throws(() => validateToolArguments(tool, { id: "test", name: "browser", arguments: parameters }), /Validation failed/)
  }
  await assert.rejects(tool.execute("test", { action: "status" }, undefined, undefined, {}), /disabled/)
  loaded.runtime.invalidate()
  console.log("Installed Pi browser extension loader and tool-schema validation passed")
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
