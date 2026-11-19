import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import "@earendil-works/pi-mcp"
import { createPiMcpExtension } from "../pi-mcp.mjs"

// Packaged checks must exercise the pinned dependency, never silently skip it.

async function fixture(transport, options = {}) {
  const handlers = new Map(), tools = new Map(), logs = []
  createPiMcpExtension({
    env: { PATH: "/fixture/bin", TOKEN_SOURCE: "synthetic-fixture-token", EXCLUDED: "not-forwarded" },
    readFile: async () => JSON.stringify({ version: 1, servers: { fixture: {
      transport, policy: { approval: "never" }, connectTimeoutMs: 1000,
      callTimeoutMs: options.callTimeoutMs ?? 500, closeTimeoutMs: 1000,
      maxResponseBytes: options.maxResponseBytes ?? 4096,
    } } }),
    fetch: options.fetch,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    log: (message) => logs.push(message),
  })({
    events: new EventEmitter(),
    on: (name, handler) => handlers.set(name, handler),
    registerTool: (tool) => tools.set(tool.name, tool),
  })
  await handlers.get("session_start")()
  return { tools, logs, shutdown: () => handlers.get("session_shutdown")() }
}

function httpFixture(call) {
  const requests = [], signals = []
  return {
    requests, signals,
    fetch: async (_url, init) => {
      signals.push(init.signal)
      if (init.method === "DELETE") { requests.push({ method: "DELETE" }); return new Response(null, { status: 204 }) }
      assert.equal(init.method, "POST", "GET streams and resumption must remain disabled")
      const message = JSON.parse(init.body)
      requests.push(message)
      const json = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), {
        headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" },
      })
      if (message.method === "initialize") return json({
        protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
      })
      if (message.method === "tools/list") {
        return json(message.params?.cursor
          ? { tools: [{ name: "second", inputSchema: {} }] }
          : { tools: [{ name: "mutate", inputSchema: {} }], nextCursor: "page2" })
      }
      if (message.method === "tools/call") return call(message, init, json)
      return new Response(null, { status: 202 })
    },
  }
}
const http = { type: "http", url: "https://fixture.example.test/mcp" }

for (const failure of [401, 404, 503, "network", "dropped SSE"]) {
  test(`real native HTTP dispatches a failed mutating call only once: ${failure}`, async () => {
    const network = httpFixture(() => {
      if (failure === "network") throw new TypeError("fixture network error")
      if (failure === "dropped SSE") return new Response("id: fixture-event\n\n", { headers: { "content-type": "text/event-stream" } })
      return new Response("fixture rejection", { status: failure })
    })
    const runtime = await fixture(http, network)
    try {
      assert.deepEqual([...runtime.tools.keys()], ["mcp__fixture__mutate", "mcp__fixture__second"])
      assert.deepEqual(network.requests.filter(({ method }) => method === "tools/list").map(({ params }) => params), [undefined, { cursor: "page2" }])
      const tool = runtime.tools.get("mcp__fixture__mutate")
      assert.equal((await tool.execute("id", {})).isError, true)
      assert.equal((await tool.execute("again", {})).isError, true)
      assert.equal(network.requests.filter(({ method }) => method === "tools/call").length, 1)
      assert.equal(network.requests.filter(({ method }) => method === "initialize").length, 1)
      assert.equal(network.requests.filter(({ method }) => method === "DELETE").length, 1)
    } finally { await runtime.shutdown() }
  })
}

test("real native HTTP cancellation aborts transport I/O and cleans up once", async () => {
  let dispatched
  const started = new Promise((resolve) => { dispatched = resolve })
  let callSignal
  const network = httpFixture((_message, init) => {
    callSignal = init.signal
    dispatched()
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
    })
  })
  const runtime = await fixture(http, network)
  try {
    const controller = new AbortController()
    const pending = runtime.tools.get("mcp__fixture__mutate").execute("id", {}, controller.signal)
    await started
    controller.abort(new Error("fixture cancellation"))
    assert.equal((await pending).isError, true)
    assert.equal(callSignal.aborted, true)
    await runtime.shutdown()
    assert.equal(network.requests.filter(({ method }) => method === "tools/call").length, 1)
    assert.equal(network.requests.filter(({ method }) => method === "DELETE").length, 1)
  } finally { await runtime.shutdown() }
})

test("real native progress cannot renew the managed absolute deadline", async () => {
  let interval, updates = 0
  const network = httpFixture((message, init) => new Response(new ReadableStream({
    start(controller) {
      interval = setInterval(() => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: message.params._meta.progressToken, progress: 1 },
      })}\n\n`)), 5)
      init.signal.addEventListener("abort", () => { clearInterval(interval); controller.close() }, { once: true })
    },
    cancel() { clearInterval(interval) },
  }), { headers: { "content-type": "text/event-stream" } }))
  const runtime = await fixture(http, { ...network, callTimeoutMs: 50 })
  try {
    const result = await runtime.tools.get("mcp__fixture__mutate").execute("id", {}, undefined, () => { updates++ })
    assert.match(result.content[0].text, /timed out after 50ms/)
    assert.ok(updates > 0)
    assert.equal(network.requests.filter(({ method }) => method === "tools/call").length, 1)
  } finally { clearInterval(interval); await runtime.shutdown() }
})

test("real native stdio isolates environment and closes the fixture process", async () => {
  // Only synthetic values are sent; the fixture reports variable names, never host values.
  const script = `
    import { createInterface } from 'node:readline';
    const lines = createInterface({ input: process.stdin });
    lines.on('line', line => {
      const m = JSON.parse(line);
      let result;
      if (m.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (m.method === 'tools/list') result = { tools: [{ name: 'env', inputSchema: {} }] };
      if (m.method === 'tools/call') result = { structuredContent: { keys: Object.keys(process.env).sort(), token: process.env.TOKEN } };
      if (result) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });
    lines.on('close', () => process.exit(0));
  `
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-stdio-test-"))
  let runtime
  try {
    const path = join(directory, "fixture.mjs")
    await writeFile(path, script)
    runtime = await fixture({ type: "stdio", command: process.execPath, args: [path], env: { TOKEN: "TOKEN_SOURCE" } })
    assert.equal(runtime.tools.size, 1, runtime.logs.join("\n"))
    const result = await runtime.tools.get("mcp__fixture__env").execute("id", {})
    assert.deepEqual(JSON.parse(result.content[0].text), { keys: ["PATH", "TOKEN"], token: "synthetic-fixture-token" })
    await runtime.shutdown()
    assert.match((await runtime.tools.get("mcp__fixture__env").execute("closed", {})).content[0].text, /unavailable/)
  } finally {
    await runtime?.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
