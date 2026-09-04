import { strict as assert } from "node:assert"
import { createServer } from "node:http"
import test from "node:test"

import {
  createSecureFetch,
  createPiMcpExtension,
  DEFAULT_CONFIG_PATH,
  formatToolResult,
  parseConfig,
  parseServer,
  toolAllowed,
} from "../pi-mcp.mjs"

function makePi() {
  const handlers = new Map()
  const tools = new Map()
  return {
    handlers,
    tools,
    api: {
      on(name, handler) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
      },
      registerTool(tool) {
        if (tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`)
        tools.set(tool.name, tool)
      },
    },
  }
}

function config(servers, defaults = {}) {
  return JSON.stringify({ version: 1, defaults, servers })
}

function stdio(command = "fake-server", extra = {}) {
  return { transport: { type: "stdio", command }, policy: { approval: "never" }, ...extra }
}

function fakeSdk(behaviors, records = {}) {
  records.clients = []
  records.transports = []
  class StdioClientTransport {
    constructor(options) {
      this.kind = "stdio"
      this.options = options
      records.transports.push(this)
    }
  }
  class StreamableHTTPClientTransport {
    constructor(url, options) {
      this.kind = "http"
      this.url = url
      this.options = options
      records.transports.push(this)
    }
  }
  class Client {
    constructor() {
      this.closed = 0
      records.clients.push(this)
    }
    async connect(transport, options) {
      this.transport = transport
      this.behavior = behaviors[transport.kind === "stdio" ? transport.options.command : transport.url.href]
      this.connectOptions = options
      if (!this.behavior) throw new Error("missing fake behavior")
      if (this.behavior.connectError) throw this.behavior.connectError
    }
    async listTools(params, options) {
      this.listOptions = options
      return this.behavior.listTools(params)
    }
    async callTool(params, schema, options) {
      this.call = { params, schema, options }
      return this.behavior.callTool(params, options)
    }
    async close() {
      this.closed++
    }
  }
  return {
    Client,
    StdioClientTransport,
    StreamableHTTPClientTransport,
    getDefaultEnvironment: () => ({ PATH: "/safe/bin" }),
  }
}

async function setup(rawConfig, behaviors, options = {}) {
  const pi = makePi()
  const records = {}
  const logs = []
  const env = { ...options.env }
  const sdk = fakeSdk(behaviors, records)
  createPiMcpExtension({
    readFile: async (path) => {
      records.configPath = path
      return rawConfig
    },
    env,
    loadSdk: async () => sdk,
    requestApproval: options.requestApproval,
    log: (message) => logs.push(message),
  })(pi.api)
  await pi.handlers.get("session_start")[0]({}, {})
  return { ...pi, records, logs }
}

test("loads the default path and resolves stdio and HTTP secrets from env", async () => {
  const behaviors = {
    "fake-server": { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) },
    "https://mcp.example.test/rpc": { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }) },
  }
  const runtime = await setup(config({
    local: { transport: { type: "stdio", command: "fake-server", env: { TOKEN: "MCP_TOKEN" } } },
    remote: { transport: { type: "http", url: "https://mcp.example.test/rpc", headers: { Authorization: "MCP_AUTH" } } },
  }), behaviors, { env: { MCP_TOKEN: "stdio-secret", MCP_AUTH: "Bearer http-secret" } })

  assert.equal(runtime.records.configPath, DEFAULT_CONFIG_PATH)
  assert.deepEqual(runtime.records.transports[0].options.env, { PATH: "/safe/bin", TOKEN: "stdio-secret" })
  assert.equal(runtime.records.transports[0].options.stderr, "ignore")
  assert.equal(runtime.records.transports[0].options.maxBufferSize, 1024 * 1024)
  assert.deepEqual(runtime.records.transports[1].options.requestInit.headers, { Authorization: "Bearer http-secret" })
  assert.equal(typeof runtime.records.transports[1].options.fetch, "function")
  assert.equal(runtime.records.transports[1].options.reconnectionOptions.maxRetries, 0)
  assert.equal(JSON.stringify(runtime.records.transports).includes("MCP_TOKEN"), false)
})

test("honors the configured path, allow/deny policy, and pagination", async () => {
  let pages = 0
  const behavior = {
    async listTools(params) {
      pages++
      if (!params) return { tools: [{ name: "read_file", inputSchema: { type: "object" } }], nextCursor: "next" }
      return { tools: [
        { name: "write_file", inputSchema: { type: "object" } },
        { name: "read_secret", inputSchema: { type: "object" } },
      ] }
    },
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] }
    },
  }
  const runtime = await setup(config({
    files: stdio("files", { policy: { allow: ["read_*", "write_*"], deny: ["*_secret"], approval: "never" } }),
  }), { files: behavior }, { env: { PI_AGENTBOX_RUNTIME_CONFIG: "/managed/runtime.json" } })

  assert.equal(runtime.records.configPath, "/managed/runtime.json")
  assert.equal(pages, 2)
  assert.deepEqual([...runtime.tools.keys()].sort(), ["mcp__files__read_file", "mcp__files__write_file"])
  assert.equal(toolAllowed({ allow: ["read_*"], deny: ["*_secret"] }, "read_file"), true)
  assert.equal(toolAllowed({ allow: ["read_*"], deny: ["*_secret"] }, "read_secret"), false)
})

test("isolates malformed and failed servers", async () => {
  const runtime = await setup(config({
    malformed: { transport: { type: "bogus" } },
    failed: stdio("failed"),
    healthy: stdio("healthy"),
  }), {
    failed: { connectError: new Error("connection refused"), listTools: async () => ({ tools: [] }) },
    healthy: {
      listTools: async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    },
  })

  assert.deepEqual([...runtime.tools.keys()], ["mcp__healthy__ping"])
  assert.equal(runtime.logs.some((line) => line.includes("server malformed ignored")), true)
  assert.equal(runtime.logs.some((line) => line.includes("server failed unavailable")), true)
  assert.equal(runtime.records.clients.find((client) => client.behavior?.connectError).closed, 1)
})

test("uses deterministic collision-safe names", async () => {
  const tool = (name) => ({ listTools: async () => ({ tools: [{ name, inputSchema: { type: "object" } }] }), callTool: async () => ({ content: [] }) })
  const runtime = await setup(config({
    "a.b": stdio("one"),
    a_b: stdio("two"),
  }), { one: tool("run"), two: tool("run") })

  const names = [...runtime.tools.keys()].sort()
  assert.equal(names.length, 2)
  assert.equal(new Set(names).size, 2)
  assert.equal(names.every((name) => /^mcp__a_b__run__[a-f0-9]{10}$/.test(name)), true)
})

test("fails approval closed without an affirmative approver", async () => {
  let calls = 0
  const behavior = {
    listTools: async () => ({ tools: [{
      name: "delete_all",
      description: "Deletes data",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: true },
    }] }),
    callTool: async () => {
      calls++
      return { content: [{ type: "text", text: "deleted" }] }
    },
  }
  const runtime = await setup(config({ dangerous: {
    transport: { type: "stdio", command: "dangerous" },
  } }), { dangerous: behavior })
  const result = await runtime.tools.get("mcp__dangerous__delete_all").execute("call", {}, undefined, undefined, { mode: "json" })

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Approval denied/)
  assert.equal(calls, 0)
})

test("uses an available RPC UI for approval", async () => {
  let calls = 0
  const behavior = {
    listTools: async () => ({ tools: [{
      name: "change",
      inputSchema: { type: "object" },
      annotations: { destructiveHint: true },
    }] }),
    callTool: async () => {
      calls++
      return { content: [{ type: "text", text: "changed" }] }
    },
  }
  const runtime = await setup(config({ rpc: stdio("rpc") }), { rpc: behavior })
  const result = await runtime.tools.get("mcp__rpc__change").execute("call", {}, undefined, undefined, {
    mode: "rpc",
    hasUI: true,
    ui: { confirm: async () => true },
  })

  assert.equal(result.isError, undefined)
  assert.equal(calls, 1)
})

test("destructive approval treats missing annotations conservatively", async () => {
  let calls = 0
  const behavior = {
    listTools: async () => ({ tools: [
      { name: "unknown", inputSchema: { type: "object" } },
      { name: "read_only", inputSchema: { type: "object" }, annotations: { destructiveHint: false } },
    ] }),
    callTool: async () => {
      calls++
      return { content: [{ type: "text", text: "ok" }] }
    },
  }
  const runtime = await setup(config({ conservative: {
    transport: { type: "stdio", command: "conservative" },
  } }), { conservative: behavior })

  const unknown = await runtime.tools.get("mcp__conservative__unknown").execute("unknown", {}, undefined, undefined, { mode: "json" })
  const readOnly = await runtime.tools.get("mcp__conservative__read_only").execute("read", {}, undefined, undefined, { mode: "json" })
  assert.equal(unknown.isError, true)
  assert.match(unknown.content[0].text, /Approval denied/)
  assert.equal(readOnly.isError, undefined)
  assert.equal(calls, 1)
})

test("passes cancellation and timeout options and bounds all output", async () => {
  const behavior = {
    listTools: async () => ({ tools: [{ name: "large", inputSchema: { type: "object" } }] }),
    callTool: async (_params, options) => {
      assert.equal(options.timeout, 50)
      assert.equal(options.maxTotalTimeout, 50)
      assert.ok(options.signal instanceof AbortSignal)
      return {
        content: [
          { type: "text", text: "x".repeat(4_000) },
          { type: "image", mimeType: "image/png", data: "y".repeat(100_000) },
        ],
        structuredContent: { ignored: "z".repeat(100_000) },
      }
    },
  }
  const runtime = await setup(config({ bounded: stdio("bounded", { callTimeoutMs: 50, maxOutputBytes: 1024 }) }), { bounded: behavior })
  const result = await runtime.tools.get("mcp__bounded__large").execute("call-id", {}, undefined)

  assert.equal(Buffer.byteLength(result.content[0].text), 1024)
  assert.equal(result.details.outputTruncated, true)
  assert.match(result.content[0].text, /\[output truncated\]$/)
  assert.equal(JSON.stringify(result.details).length < 200, true)
})

test("cancels hung calls and closes every client on session shutdown", async () => {
  const behavior = {
    listTools: async () => ({ tools: [{ name: "wait", inputSchema: { type: "object" } }] }),
    callTool: async (_params, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
    }),
  }
  const runtime = await setup(config({ waiting: stdio("waiting", { callTimeoutMs: 5_000 }) }), { waiting: behavior })
  const controller = new AbortController()
  const pending = runtime.tools.get("mcp__waiting__wait").execute("call", {}, controller.signal)
  controller.abort(new Error("user cancelled"))
  const result = await pending

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /user cancelled/)
  await runtime.handlers.get("session_shutdown")[0]()
  assert.equal(runtime.records.clients[0].closed, 1)
  const afterClose = await runtime.tools.get("mcp__waiting__wait").execute("call", {}, undefined)
  assert.equal(afterClose.isError, true)
  assert.match(afterClose.content[0].text, /unavailable/)
})

test("enforces a deadline when a client ignores cancellation", async () => {
  const behavior = {
    listTools: async () => ({ tools: [{ name: "hang", inputSchema: { type: "object" } }] }),
    callTool: async () => new Promise(() => {}),
  }
  const runtime = await setup(config({ hanging: stdio("hanging", { callTimeoutMs: 10 }) }), { hanging: behavior })
  const result = await runtime.tools.get("mcp__hanging__hang").execute("call", {}, undefined)

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /timed out after 10ms/)
  assert.equal(runtime.records.clients[0].closed, 1)
  const afterTimeout = await runtime.tools.get("mcp__hanging__hang").execute("call", {}, undefined)
  assert.match(afterTimeout.content[0].text, /unavailable/)
})

test("validates config version, environment identifiers, and HTTP URL policy", () => {
  assert.throws(() => parseConfig(JSON.stringify({ version: 2, servers: {} }), "/test.json"), /version must be 1/)
  assert.equal(parseConfig(JSON.stringify({ version: 1, servers: {}, piRpcApi: { managed: true } })).servers.length, 0)
  const defaults = parseConfig(config({})).defaults
  assert.throws(() => parseServer("bad name", stdio(), defaults), /invalid server name/)
  assert.throws(() => parseServer("literal", {
    transport: { type: "stdio", command: "server", env: { TOKEN: "literal token" } },
  }, defaults), /environment variable identifier/)
  assert.throws(() => parseServer("remote", {
    transport: { type: "http", url: "https://user:secret@example.test/mcp" },
  }, defaults), /must not contain credentials/)
  assert.throws(() => parseServer("plaintext", {
    transport: { type: "http", url: "http://example.test/mcp" },
  }, defaults), /must use HTTPS/)
  assert.throws(() => parseServer("private", {
    transport: { type: "http", url: "https://169.254.169.254/latest/meta-data" },
  }, defaults), /private, link-local, reserved, or metadata/)
  assert.throws(() => parseServer("metadata", {
    transport: { type: "http", url: "https://metadata.google.internal/computeMetadata" },
  }, defaults), /metadata service/)
  assert.equal(parseServer("loopback", {
    transport: { type: "http", url: "http://localhost:3000/mcp", allowInsecureLoopback: true },
  }, defaults).transport.url.href, "http://localhost:3000/mcp")
})

test("secure HTTP fetch rejects private DNS answers and cross-origin redirects", async () => {
  let requests = 0
  const privateFetch = createSecureFetch({
    baseUrl: new URL("https://mcp.example.test/rpc"),
    allowInsecureLoopback: false,
    maxResponseBytes: 1024,
    lookup: async () => [{ address: "10.0.0.8", family: 4 }],
    fetch: async () => {
      requests++
      return new Response("unreachable")
    },
  })
  await assert.rejects(() => privateFetch("https://mcp.example.test/rpc"), /resolves to a private/)
  assert.equal(requests, 0)

  const disguisedLoopback = createSecureFetch({
    baseUrl: new URL("https://public.example.test/rpc"),
    allowInsecureLoopback: true,
    maxResponseBytes: 1024,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    fetch: async () => {
      requests++
      return new Response("unreachable")
    },
  })
  await assert.rejects(() => disguisedLoopback("https://public.example.test/rpc"), /resolves to a private/)
  assert.equal(requests, 0)

  const seen = []
  const redirectingFetch = createSecureFetch({
    baseUrl: new URL("https://mcp.example.test/rpc"),
    allowInsecureLoopback: false,
    maxResponseBytes: 1024,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url, init) => {
      seen.push({ url: url.href, authorization: new Headers(init.headers).get("authorization") })
      return new Response(null, { status: 302, headers: { location: "https://attacker.example/steal" } })
    },
  })
  await assert.rejects(() => redirectingFetch("https://mcp.example.test/rpc", {
    headers: { Authorization: "Bearer secret" },
  }), /cross-origin redirects/)
  assert.deepEqual(seen, [{ url: "https://mcp.example.test/rpc", authorization: "Bearer secret" }])
})

test("secure HTTP fetch follows bounded same-origin redirects and caps bodies", async () => {
  const seen = []
  const secureFetch = createSecureFetch({
    baseUrl: new URL("https://mcp.example.test/rpc"),
    allowInsecureLoopback: false,
    maxResponseBytes: 5,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => {
      seen.push(url.href)
      if (url.pathname === "/rpc") return new Response(null, { status: 307, headers: { location: "/v2" } })
      return new Response("123456", { headers: { "content-type": "application/json" } })
    },
  })
  const response = await secureFetch("https://mcp.example.test/rpc")
  await assert.rejects(() => response.text(), /exceeds 5 bytes/)
  assert.deepEqual(seen, ["https://mcp.example.test/rpc", "https://mcp.example.test/v2"])
  await assert.rejects(() => secureFetch("https://mcp.example.test/rpc", { body: "123456", method: "POST" }), /request body exceeds 5 bytes/)
})

test("default HTTP implementation validates the DNS used by the socket", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const address = server.address()
    assert.equal(typeof address, "object")
    let lookups = 0
    const secureFetch = createSecureFetch({
      baseUrl: new URL(`http://localhost:${address.port}/mcp`),
      allowInsecureLoopback: true,
      maxResponseBytes: 1024,
      lookup: async (hostname) => {
        lookups++
        assert.equal(hostname, "localhost")
        return [{ address: "127.0.0.1", family: 4 }]
      },
    })
    const response = await secureFetch(`http://localhost:${address.port}/mcp`)
    assert.equal(await response.text(), "{}")
    assert.equal(lookups >= 2, true)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test("bounds tool list pages, names, and retained descriptions", async () => {
  const bounded = await setup(config({ bounded_list: stdio("bounded-list") }), {
    "bounded-list": {
      listTools: async () => ({ tools: [
        { name: "n".repeat(257), inputSchema: { type: "object" } },
        { name: "kept", title: "t".repeat(2_000), description: "d".repeat(20_000), inputSchema: { type: "object" }, annotations: { destructiveHint: false } },
      ] }),
      callTool: async () => ({ content: [] }),
    },
  })
  assert.deepEqual([...bounded.tools.keys()], ["mcp__bounded_list__kept"])
  const retained = bounded.tools.get("mcp__bounded_list__kept")
  assert.equal(Buffer.byteLength(retained.description), 4_000)
  assert.equal(Buffer.byteLength(retained.label), 500)

  const oversized = await setup(config({ oversized: stdio("oversized") }), {
    oversized: {
      listTools: async () => ({ tools: [{ name: "huge", description: "x".repeat(1024 * 1024), inputSchema: { type: "object" } }] }),
      callTool: async () => ({ content: [] }),
    },
  })
  assert.equal(oversized.tools.size, 0)
  assert.equal(oversized.records.clients[0].closed, 1)
  assert.equal(oversized.logs.some((line) => line.includes("tools/list page exceeds")), true)

  const tooManyNames = await setup(config({ names: stdio("names", {
    policy: { allow: [], deny: [], approval: "never" },
  }) }), {
    names: {
      listTools: async () => ({ tools: Array.from({ length: 4_097 }, (_, index) => ({
        name: `denied_${index}`,
        inputSchema: { type: "object" },
      })) }),
      callTool: async () => ({ content: [] }),
    },
  })
  assert.equal(tooManyNames.tools.size, 0)
  assert.equal(tooManyNames.records.clients[0].closed, 1)
  assert.equal(tooManyNames.logs.some((line) => line.includes("distinct names")), true)
})

test("closes a client after an invalid tool result", async () => {
  const runtime = await setup(config({ invalid: stdio("invalid") }), {
    invalid: {
      listTools: async () => ({ tools: [{ name: "bad", inputSchema: { type: "object" }, annotations: { destructiveHint: false } }] }),
      callTool: async () => ({ content: "not-an-array" }),
    },
  })
  const result = await runtime.tools.get("mcp__invalid__bad").execute("call", {}, undefined)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /invalid result/)
  assert.equal(runtime.records.clients[0].closed, 1)
})

test("formats compatibility and binary MCP results safely", () => {
  assert.deepEqual(formatToolResult({ toolResult: { answer: 42 } }, 1024), {
    text: "{\n  \"answer\": 42\n}",
    truncated: false,
  })
  assert.equal(formatToolResult({ content: [{ type: "audio", mimeType: "audio/wav", data: "secret" }] }, 1024).text, "[audio omitted: audio/wav]")
})
