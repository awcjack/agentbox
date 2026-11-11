// Offline contract check against the pinned CLI: no Chromium or public network.
// node --experimental-strip-types tests/pi-browser-native.ts /absolute/agent-browser
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { BrowserSession, browserArgs } from "../extensions/pi-browser.ts"

const executable = process.argv[2]
assert(executable?.startsWith("/"), "Pass the packaged agent-browser executable")
const session = new BrowserSession({ enable: true, delegation: "isolated", allowedDomains: [], maxOutputChars: 16000, commandTimeoutMs: 3000, idleTimeoutMs: 10000 }, "native-protocol-check", executable, "/nonexistent-agentbox-test-chromium")
await session.initialize()
const env = { HOME: join(session.root, "home"), TMPDIR: join(session.root, "tmp"), PATH: "/bin:/usr/bin", AGENT_BROWSER_SOCKET_DIR: join(session.root, "sockets"), AGENT_BROWSER_NO_STREAM: "1", AGENT_BROWSER_NO_VERSION_CHECK: "1" }
async function invoke(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(executable, ["--config", join(session.root, "config.json"), "--session", "protocol", "--json", ...args], { env, cwd: session.root, timeout: 15000, maxBuffer: 256 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error?.killed) return reject(error)
      resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr })
    })
  })
}
try {
  const info = await invoke(["session", "info"])
  assert.equal(info.code, 0, info.stderr)
  assert.equal(info.stderr, "", "managed config must not contain ignored/unknown fields")
  assert.equal(JSON.parse(info.stdout).data.active, false)
  const requests = [
    { action: "open", url: "http://127.0.0.1/" }, { action: "snapshot" }, { action: "click", ref: "@e1" },
    { action: "fill", ref: "@e1", text: "--config /not-loaded --cdp ws://not-connected" }, { action: "press", key: "Enter" },
    { action: "scroll" }, { action: "wait", milliseconds: 1 }, { action: "get", property: "text" },
    { action: "get", property: "url" }, { action: "get", property: "title" }, { action: "back" },
    { action: "forward" }, { action: "reload" }, { action: "console" }, { action: "errors" },
  ]
  // Bare open is the internal launch-only operation, including with containment.
  // Verify the pinned CLI accepts it and reaches launch, not a URL/policy error.
  const startup = [["open"], ["--allowed-domains", "127.0.0.1", "open"]]
  const visual = [["mouse", "move", "100", "100"], ["mouse", "down", "left"], ["mouse", "up", "left"], ["mouse", "wheel", "300", "100"], ["keyboard", "inserttext", "literal text"]]
  for (const args of [...startup, ...requests.map(p => browserArgs(p as any)), ...visual, ["screenshot", join(session.root, "tmp", "test.jpg")], browserArgs({ action: "resize", width: 390, height: 844 }), ["tab", "list"]]) {
    const result = await invoke(args)
    const response = JSON.parse(result.stdout)
    assert.equal(response.success, false, `test Chromium deliberately missing: ${args[0]}`)
    assert(!/policy|allow list|config file|unknown|invalid value/i.test(response.error), `${args.join(" ")}: ${response.error}`)
    assert.match(response.error, /browser|executable|launch|chrome|ENOENT|No such file/i)
  }
  for (const args of [["eval", "1+1"], ["cookies"], ["state", "save", join(session.root, "tmp", "state.json")], ["stream", "enable"]]) {
    const result = await invoke(args)
    assert.match(JSON.parse(result.stdout).error, /allow list|denied by policy/i, `${args[0]} must be denied`)
  }
  // Exercise live policy replacement on the existing daemon, not just startup
  // environment. Preview/control must not auto-launch local OR attached Chrome.
  for (const args of [["open"], ["open", "http://127.0.0.1/"], ["--cdp", "ws://127.0.0.1:1/fixture", "--pin-tab", "tab", "list"]]) {
    const result = await invoke(["--action-policy", join(session.root, "control-policy.json"), ...args])
    assert.match(JSON.parse(result.stdout).error, /allow list|denied by policy/i, `no-launch policy: ${args[0]}`)
  }
  const restored = await invoke(["open"])
  assert.doesNotMatch(JSON.parse(restored.stdout).error, /allow list|denied by policy/i, "model policy must be restored from managed config")
  console.log("Pinned browser CLI config, exact action policy, literal fill and no-launch control policy contract passed")
} finally {
  await invoke(["close"]).catch(() => {})
  await session.shutdown()
  await fs.rm(session.root, { recursive: true, force: true })
}
