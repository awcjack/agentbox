import { createPiPolicyExtension } from "../../extensions/pi-policy.ts"

let prompt = ""
for await (const chunk of process.stdin) prompt += chunk
let handler: any
let shutdown: any
createPiPolicyExtension({
  readFile: async () => JSON.stringify({ version: 1, defaultDecision: "ask", timeout: 2000, rules: [] }),
  realpath: async (path) => path,
})({ on: (name: string, callback: any) => {
  if (name === "tool_call") handler = callback
  if (name === "session_shutdown") shutdown = callback
} } as any)
const result = await handler({ toolName: "read", input: { path: prompt }, toolCallId: "child-call" }, {
  cwd: "/workspace", hasUI: false, ui: { select: () => { throw new Error("child UI forbidden") } },
})
process.stdout.write(`${JSON.stringify({ type: "message_end", message: {
  role: "assistant", stopReason: "stop", content: [{ type: "text", text: result?.block ? "denied" : "allowed" }],
} })}\n`)
await shutdown()
