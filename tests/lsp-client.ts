import { strict as assert } from "node:assert"
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn as nodeSpawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import {
  createLspClient,
  DEFAULT_LANGUAGE_SERVERS,
  type LanguageServerDefinition,
  type LspNavigationAction,
  type LspSpawn,
} from "../extensions/lsp-client.ts"

function rpcFrame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

function runFakeServer() {
  const mode = process.argv.at(-2)!
  const logPath = process.argv.at(-1)!
  let input = Buffer.alloc(0)
  let applyEditDenied = false
  let outgoing = Promise.resolve()
  const documents = new Map<string, { text: string; version: number }>()
  const pendingHovers: Array<{ id: number | string; uri: string }> = []

  const log = (line: string) => appendFileSync(logPath, `${mode}:${line}\n`)
  const send = (message: unknown) => {
    const framed = rpcFrame(message)
    outgoing = outgoing.then(async () => {
      process.stdout.write(framed.subarray(0, 7))
      await new Promise((resolve) => setTimeout(resolve, 2))
      process.stdout.write(framed.subarray(7, 23))
      await new Promise((resolve) => setTimeout(resolve, 2))
      process.stdout.write(framed.subarray(23))
    })
  }
  const locationResult = (method: string, uri: string) => [
    { uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, method },
    {
      uri: pathToFileURL(join(fileURLToPath(uri), "..", "blocked", "secret.fake")).href,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    },
  ]
  const sendHover = (id: number | string, uri: string) => {
    const document = documents.get(uri)
    const value = document?.text === "large"
      ? "x".repeat(5_000)
      : `hover: ${applyEditDenied ? "applyEdit denied" : "applyEdit not denied"}; ${locationResult("hover", uri)[1].uri}`
    send({ jsonrpc: "2.0", id, result: { contents: { kind: "markdown", value } } })
  }

  const onMessage = (message: any) => {
    if (message.id === "apply-edit" && !message.method) {
      applyEditDenied = message.result?.applied === false
        && /read-only/.test(message.result?.failureReason ?? "")
      for (const hover of pendingHovers.splice(0)) sendHover(hover.id, hover.uri)
      return
    }
    if (message.method === "initialize") {
      log("initialize")
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { capabilities: mode === "pull" ? { diagnosticProvider: {} } : {} },
      })
      return
    }
    if (message.method === "initialized") {
      send({
        jsonrpc: "2.0",
        id: "apply-edit",
        method: "workspace/applyEdit",
        params: { edit: { changes: {} } },
      })
      return
    }
    if (message.method === "textDocument/didOpen") {
      const document = message.params.textDocument
      documents.set(document.uri, { text: document.text, version: document.version })
      log(`open:${document.version}`)
      if (mode === "push" && document.text !== "quiet") {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri: document.uri,
            version: document.version,
            diagnostics: [{ severity: 2, message: `push:${document.text}:${document.version}` }],
          },
        })
      }
      return
    }
    if (message.method === "textDocument/didChange") {
      const uri = message.params.textDocument.uri
      const version = message.params.textDocument.version
      const text = message.params.contentChanges[0].text
      documents.set(uri, { text, version })
      log(`change:${version}`)
      if (mode === "push" && text !== "quiet") {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri,
            version: text === "stale" ? version - 1 : version,
            diagnostics: text === "clear" ? [] : [{ severity: 1, message: `push:${text}:${version}` }],
          },
        })
      }
      return
    }
    if (message.method === "textDocument/diagnostic") {
      const uri = message.params.textDocument.uri
      const document = documents.get(uri)!
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          kind: "full",
          items: [{
            severity: 1,
            message: `pull:${document.text}:${document.version}`,
            relatedInformation: [
              { location: locationResult("diagnostic", uri)[0], message: "allowed" },
              { location: locationResult("diagnostic", uri)[1], message: "blocked" },
            ],
          }],
        },
      })
      return
    }
    if (message.method === "textDocument/implementation"
      && documents.get(message.params.textDocument.uri)?.text === "cancel") {
      log(`pending:${message.id}`)
      return
    }
    if (message.method === "$/cancelRequest") {
      log(`cancel:${message.params.id}`)
      return
    }
    if (message.method === "textDocument/hover") {
      const uri = message.params.textDocument.uri
      if (applyEditDenied) sendHover(message.id, uri)
      else pendingHovers.push({ id: message.id, uri })
      return
    }
    if (message.method === "textDocument/documentSymbol") {
      const uri = message.params.textDocument.uri
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: [
          { name: "allowedSymbol", kind: 12, range: locationResult("symbol", uri)[0].range, selectionRange: locationResult("symbol", uri)[0].range },
          { name: "blockedSymbol", kind: 12, location: locationResult("symbol", uri)[1] },
        ],
      })
      return
    }
    if (typeof message.method === "string" && message.method.startsWith("textDocument/")) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: locationResult(message.method, message.params.textDocument.uri),
      })
      return
    }
    if (message.method === "shutdown") {
      log("shutdown")
      send({ jsonrpc: "2.0", id: message.id, result: null })
      return
    }
    if (message.method === "exit") {
      log("exit")
      process.exit(0)
    }
  }

  process.stdin.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk])
    while (true) {
      const headerEnd = input.indexOf("\r\n\r\n")
      if (headerEnd < 0) return
      const match = /Content-Length:\s*(\d+)/i.exec(input.subarray(0, headerEnd).toString("ascii"))
      if (!match) process.exit(2)
      const length = Number(match![1])
      const bodyStart = headerEnd + 4
      if (input.length < bodyStart + length) return
      const body = input.subarray(bodyStart, bodyStart + length)
      input = input.subarray(bodyStart + length)
      onMessage(JSON.parse(body.toString("utf8")))
    }
  })
}

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function runTests() {
  const root = mkdtempSync(join(tmpdir(), "pi-lsp-client-test-"))
  const secondRoot = join(root, "second")
  mkdirSync(secondRoot)
  const source = join(root, "main.fake")
  const secondSource = join(secondRoot, "other.fake")
  const pushSource = join(root, "main.push")
  const quietSource = join(root, "quiet.push")
  const thirdPushSource = join(root, "third.push")
  const logPath = join(root, "server.log")
  writeFileSync(source, "initial")
  writeFileSync(secondSource, "second")
  writeFileSync(pushSource, "published")
  writeFileSync(quietSource, "quiet")
  writeFileSync(thirdPushSource, "third")
  writeFileSync(logPath, "")

  const script = fileURLToPath(import.meta.url)
  const server = (id: string, extension: string, mode: string): LanguageServerDefinition => ({
    id,
    command: process.execPath,
    args: ["--experimental-strip-types", script, "--fake-lsp", mode, logPath],
    extensionToLanguage: { [extension]: id },
  })
  let spawnCount = 0
  let activeProcesses = 0
  const spawn: LspSpawn = (command, args, options) => {
    spawnCount += 1
    activeProcesses += 1
    const child = nodeSpawn(command, [...args], options) as ChildProcessWithoutNullStreams
    child.once("exit", () => { activeProcesses -= 1 })
    return child
  }
  const client = createLspClient({
    pathGuard: (path) => !path.includes("/blocked/"),
    servers: [server("fake-pull", ".fake", "pull"), server("fake-push", ".push", "push")],
    spawn,
    maxOutputBytes: 1_024,
    maxDocumentBytes: 128,
    maxDocuments: 2,
    maxRetainedDocumentBytes: 128,
    requestTimeoutMs: 1_000,
    diagnosticsTimeoutMs: 80,
    shutdownTimeoutMs: 500,
  })

  assert.deepEqual(
    DEFAULT_LANGUAGE_SERVERS.map(({ id, command }) => [id, command]),
    [
      ["gopls", "gopls"],
      ["nil", "nil"],
      ["typescript", "typescript-language-server"],
      ["yaml", "yaml-language-server"],
      ["json", "vscode-json-language-server"],
      ["html", "vscode-html-language-server"],
      ["css", "vscode-css-language-server"],
    ],
  )
  assert.equal(
    DEFAULT_LANGUAGE_SERVERS.find((definition) => ".tsx" in definition.extensionToLanguage)?.id,
    "typescript",
  )
  assert.equal(
    DEFAULT_LANGUAGE_SERVERS.find((definition) => ".yml" in definition.extensionToLanguage)?.id,
    "yaml",
  )
  assert.equal(client.serverForPath("source.fake")?.id, "fake-pull")
  assert.equal(client.serverForPath("unknown.py"), undefined)

  const firstDiagnostics = await client.diagnostics({ path: source, root, text: "initial" })
  assert.match(firstDiagnostics.output, /pull:initial:1/)
  assert.match(firstDiagnostics.output, /allowed/)
  assert.doesNotMatch(firstDiagnostics.output, /blocked/)
  assert.equal(spawnCount, 1, "the partially framed initialize response should be accepted")

  const changedDiagnostics = await client.diagnostics({ path: source, root, text: "changed" })
  assert.match(changedDiagnostics.output, /pull:changed:2/)
  assert.equal(spawnCount, 1, "requests for the same server and root should reuse one process")

  await client.diagnostics({ path: secondSource, root: secondRoot })
  assert.equal(spawnCount, 2, "a different root should receive a separate persistent process")

  const pushed = await client.diagnostics({ path: pushSource, root })
  assert.match(pushed.output, /push:published:1/)
  const cacheStarted = Date.now()
  const cachedPushDiagnostics = await client.diagnostics({ path: pushSource, root })
  assert.match(cachedPushDiagnostics.output, /push:published:1/)
  assert.ok(Date.now() - cacheStarted < 60, "version-matched diagnostics should be returned from cache")
  const clearedPushDiagnostics = await client.diagnostics({ path: pushSource, root, text: "clear" })
  assert.equal(clearedPushDiagnostics.output, "[]", "an explicit current-version publish may report clean")
  await assert.rejects(
    client.diagnostics({ path: pushSource, root, text: "quiet" }),
    /publishDiagnostics timed out.*version 3/,
  )
  const timeoutStarted = Date.now()
  await assert.rejects(client.diagnostics({ path: quietSource, root }), /publishDiagnostics timed out/)
  assert.ok(Date.now() - timeoutStarted >= 60, "publishDiagnostics fallback should wait for its timeout")
  await assert.rejects(
    client.diagnostics({ path: quietSource, root, text: "stale" }),
    /publishDiagnostics timed out.*version 2/,
    "a stale published version must not satisfy the current request",
  )
  await assert.rejects(
    client.diagnostics({ path: thirdPushSource, root, text: "third" }),
    /already has 2 open documents/,
  )
  await assert.rejects(
    client.diagnostics({ path: source, root, text: "x".repeat(129) }),
    /document exceeds 128 bytes/,
  )
  writeFileSync(source, "x".repeat(129))
  await assert.rejects(
    client.diagnostics({ path: source, root }),
    /document exceeds 128 bytes/,
    "default file reads should stop at the document byte limit",
  )
  await client.diagnostics({ path: pushSource, root, text: "r".repeat(100) })
  await assert.rejects(
    client.diagnostics({ path: quietSource, root, text: "q".repeat(40) }),
    /retained document text exceeds 128 bytes/,
  )

  const actions: LspNavigationAction[] = [
    "definition",
    "declaration",
    "typeDefinition",
    "implementation",
    "references",
    "hover",
    "documentSymbol",
  ]
  for (const action of actions) {
    const result = await client.navigate({
      action,
      path: source,
      root,
      text: "navigation",
      ...(action === "documentSymbol" ? {} : { position: { line: 0, character: 1 } }),
    })
    assert.doesNotMatch(result.output, /blocked/, `${action} should filter guarded file URIs`)
    if (action === "hover") assert.match(result.output, /applyEdit denied/)
    else if (action === "documentSymbol") assert.match(result.output, /allowedSymbol/)
    else assert.match(result.output, new RegExp(`textDocument/${action}`))
  }

  const largeHover = await client.navigate({
    action: "hover",
    path: source,
    root,
    text: "large",
    position: { line: 0, character: 0 },
  })
  assert.equal(largeHover.truncated, true)
  assert.ok(Buffer.byteLength(largeHover.output) <= 1_024)
  assert.match(largeHover.output, /\[output truncated\]$/)

  const controller = new AbortController()
  const cancelled = client.navigate({
    action: "implementation",
    path: source,
    root,
    text: "cancel",
    position: { line: 0, character: 0 },
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(cancelled, (error: any) => error?.name === "AbortError")
  await waitFor(() => /pull:cancel:\d+/.test(readFileSync(logPath, "utf8")), "server did not receive cancellation")

  await assert.rejects(
    client.navigate({
      action: "definition",
      path: join(root, "blocked", "secret.fake"),
      root,
      text: "secret",
      position: { line: 0, character: 0 },
    }),
    /not allowed/,
  )

  await client.shutdown()
  await client.shutdown()
  await waitFor(() => activeProcesses === 0, "language servers were not cleaned up")
  const log = readFileSync(logPath, "utf8")
  assert.equal((log.match(/pull:initialize/g) ?? []).length, 2)
  assert.equal((log.match(/push:initialize/g) ?? []).length, 1)
  assert.equal((log.match(/:shutdown/g) ?? []).length, 3)
  assert.equal((log.match(/:exit/g) ?? []).length, 3)
  await assert.rejects(client.diagnostics({ path: source, root }), /session is closed/)

  console.log("lsp client tests passed")
}

if (process.argv.includes("--fake-lsp")) runFakeServer()
else await runTests()
