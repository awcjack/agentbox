import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import extension, { loginOpenAICodexDevice, refreshOpenAICodexDevice } from "../extensions/pi-agentbox.ts"

type Handler = (event: any, ctx: any) => Promise<any> | any

const handlers = new Map<string, Handler>()
let provider: { name: string; config: any } | undefined
const pi = {
  on(name: string, handler: Handler) {
    handlers.set(name, handler)
  },
  registerProvider(name: string, config: any) {
    provider = { name, config }
  },
} as any

extension(pi)
assert.equal(provider?.name, "openai-codex")
assert.equal(provider?.config.oauth.name, "ChatGPT Plus/Pro (Codex Device Code)")
assert.equal(provider?.config.models, undefined)

const root = mkdtempSync(join(tmpdir(), "pi-agentbox-test-"))
mkdirSync(join(root, "src"))
writeFileSync(join(root, ".env.example"), "SAFE=example\n")
const ctx = { cwd: root }

const toolCall = handlers.get("tool_call")!
const sessionStart = handlers.get("session_start")!

await sessionStart({}, {
  cwd: root,
  sessionManager: {
    getSessionId: () => "pi-session-test",
    getSessionFile: () => join(root, "session.jsonl"),
    getSessionName: () => "Pi test",
  },
})
assert.equal(process.env.PI_SESSION_ID, "pi-session-test")

assert.match(
  (await toolCall({ toolName: "read", input: { path: ".env" } }, ctx)).reason,
  /sensitive path/,
)
assert.equal(await toolCall({ toolName: "read", input: { path: ".env.example" } }, ctx), undefined)
assert.match(
  (await toolCall({ toolName: "bash", input: { command: "sed -n 1p .env" } }, ctx)).reason,
  /sensitive paths/,
)
assert.match(
  (await toolCall({ toolName: "bash", input: { command: "sudo true" } }, ctx)).reason,
  /sudo/,
)
assert.match(
  (await toolCall({ toolName: "write", input: { path: "/nix/store/example" } }, ctx)).reason,
  /Nix store/,
)
assert.match(
  (await toolCall({ toolName: "edit", input: { path: "~/.local/bin/agent-signal.sh" } }, ctx)).reason,
  /managed Pi integration files/,
)
assert.match(
  (await toolCall({ toolName: "bash", input: { command: "rm -f ~/.local/bin/agent-signal.sh" } }, ctx)).reason,
  /managed Pi integration files/,
)
assert.equal(await toolCall({ toolName: "bash", input: { command: "go test ./..." } }, ctx), undefined)

const token = (accountId: string, expires: number) => {
  const payload = Buffer.from(JSON.stringify({
    exp: expires,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url")
  return `header.${payload}.signature`
}

const originalFetch = globalThis.fetch
const requests: Array<{ url: string; init?: RequestInit }> = []
const expires = Math.floor(Date.now() / 1000) + 3600
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  requests.push({ url, init })
  if (url.endsWith("/usercode")) {
    return Response.json({ device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: "5" })
  }
  if (url.endsWith("/deviceauth/token")) {
    return Response.json({ authorization_code: "authorization-code", code_verifier: "verifier" })
  }
  return Response.json({ access_token: token("account-id", expires), refresh_token: "refresh-token" })
}) as typeof fetch

let authInfo: { url: string; instructions?: string } | undefined
const credentials = await loginOpenAICodexDevice({
  onAuth: (info) => { authInfo = info },
  onPrompt: async () => "",
})
assert.equal(authInfo?.url, "https://auth.openai.com/codex/device")
assert.match(authInfo?.instructions ?? "", /ABCD-EFGH/)
assert.equal(credentials.accountId, "account-id")
assert.equal(credentials.refresh, "refresh-token")
assert.equal(credentials.expires, expires * 1000)
assert.equal(requests.length, 3)
assert.equal(new URLSearchParams(requests[2].init?.body as string).get("redirect_uri"), "https://auth.openai.com/deviceauth/callback")

requests.length = 0
const refreshed = await refreshOpenAICodexDevice({ access: "old", refresh: "old-refresh", expires: 0 })
assert.equal(refreshed.accountId, "account-id")
assert.equal(new URLSearchParams(requests[0].init?.body as string).get("grant_type"), "refresh_token")
assert.equal(new URLSearchParams(requests[0].init?.body as string).get("refresh_token"), "old-refresh")
globalThis.fetch = originalFetch

console.log("pi agentbox extension tests passed")
