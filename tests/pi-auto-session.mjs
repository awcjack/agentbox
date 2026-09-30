import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPiPolicyExtension } from '../extensions/pi-policy.ts'

function harness({ manager, available = true, env = {}, readFile } = {}) {
  const entries = [], notices = [], handlers = new Map(), commands = new Map(), events = new Map()
  let fail = false, writes = 0
  manager ??= { getSessionId: () => 'native-id', getEntries: () => entries,
    getSessionFile: () => undefined, getHeader: () => ({}) }
  const ctx = { sessionManager: manager, cwd: '/workspace', hasUI: true, mode: 'tui',
    ui: { notify: text => notices.push(text), setStatus() {}, select: async () => 'Deny' } }
  createPiPolicyExtension({ env, argv: [], signal() {}, realpath: async p => p,
    readFile: readFile ?? (async () => JSON.stringify({ version: 1, defaultDecision: 'ask',
      rules: [{ tools: ['write'], patterns: ['*'], decision: 'deny' }], auto: { enable: available } })),
    defaultsStore: async () => ({ read: () => ({ agentboxAutoDefault: true }), setAuto: async () => { writes++ } }),
  })({ events: { on: (n, fn) => events.set(n, fn) }, on: (n, fn) => handlers.set(n, fn),
    registerCommand: (n, cmd) => commands.set(n, cmd),
    appendEntry(type, data) {
      if (fail) throw Error('disk full')
      if (manager.appendCustomEntry) manager.appendCustomEntry(type, data)
      else entries.push({ type: 'custom', customType: type, data })
    } })
  return { ctx, entries, notices, fail: () => { fail = true }, writes: () => writes,
    auto: value => commands.get('auto').handler(value, ctx),
    start: reason => handlers.get('session_start')({ reason }, ctx),
    tree: () => handlers.get('session_tree')({}, ctx),
    shutdown: () => handlers.get('session_shutdown')({}, ctx),
    tool: toolName => handlers.get('tool_call')({ toolName, input: { path: 'README.md' } }, ctx),
    enabled: () => { let value; events.get('agentbox:auto-query')({ reply: v => { value = v } }); return value },
  }
}
for (const mode of ['on', 'off', 'review']) {
  const h = harness()
  await h.auto(mode)
  assert.deepEqual(h.entries.at(-1).data, { version: 1, sessionId: 'native-id', mode })
  for (const reason of ['startup', 'resume', 'reload']) {
    await h.start(reason)
    await h.auto('status')
    assert.match(h.notices.at(-1), new RegExp(`Auto: ${mode}`))
    await h.tree()
    assert.equal(h.enabled(), mode === 'on')
  }
  assert.equal((await h.tool('write')).block, true)
  assert.equal(h.writes(), 0)
  h.ctx.sessionManager.getSessionId = () => 'fork-id'
  await h.start('fork')
  assert.equal(h.enabled(), false)
}
for (const data of [null, {}, { version: 2, sessionId: 'native-id', mode: 'on' },
  { version: 1, sessionId: 'native-id', mode: 'bogus' }, { version: 1, sessionId: 'other', mode: 'on' }]) {
  const h = harness()
  await h.auto('on')
  h.entries.push({ type: 'custom', customType: 'agentbox-auto-mode', data })
  await h.start('new')
  assert.equal(h.enabled(), false)
}
for (const options of [{ available: false }, { env: { PI_WORKFLOW_CHILD: '1' } },
  { env: { PI_WORKFLOW_APPROVAL_VERSION: '1' } }]) {
  const h = harness(options)
  h.entries.push({ type: 'custom', customType: 'agentbox-auto-mode', data: { version: 1, sessionId: 'native-id', mode: 'on' } })
  await h.start('resume')
  assert.equal(h.enabled(), false)
}
const freshFailure = harness()
freshFailure.fail()
await freshFailure.auto('on')
await freshFailure.start('new')
assert.equal(freshFailure.enabled(), false)

const defaults = harness()
await defaults.start('new')
assert.equal(defaults.enabled(), true)
assert.equal(defaults.entries.length, 0) // inherited defaults aren't explicit choices
await defaults.start('resume')
assert.equal(defaults.enabled(), false)

const failure = harness()
await failure.auto('on')
failure.fail()
await failure.auto('off')
assert.equal(failure.enabled(), false)
assert.match(failure.notices.at(-1), /Could not save/)
await failure.start('resume')
assert.equal(failure.enabled(), false)
await failure.auto('review')
assert.equal(failure.enabled(), false)

let delay = false, release
const race = harness({ readFile: async () => {
  if (delay) await new Promise(resolve => { release = resolve })
  return JSON.stringify({ version: 1, defaultDecision: 'ask', rules: [], auto: { enable: true } })
} })
await race.auto('on')
delay = true
const restoring = race.start('resume')
delay = false
await race.auto('off')
release()
await restoring
assert.equal(race.enabled(), false)
await race.auto('on')
delay = true
const disabling = race.auto('off')
assert.equal(race.enabled(), false) // revocation precedes policy I/O
release()
await disabling
const enabling = race.auto('on')
race.shutdown()
release()
await enabling
assert.equal(race.enabled(), false)

// Real RPC processes exercise the same status protocol consumed by Pi web.
async function rpcAuto(piRoot, directory, file, command) {
  const child = spawn(process.execPath, [`${piRoot}/dist/cli.js`, '--mode', 'rpc', '--offline',
    '--no-extensions', '-e', new URL('../extensions/pi-policy.ts', import.meta.url).pathname,
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools',
    '--session', file], {
    cwd: directory, env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: join(directory, 'agent'),
      PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_POLICY_CONFIG: join(directory, 'policy.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', stderr = '', state, timer
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error(`RPC timeout: ${stderr}`)), 15_000)
      child.on('error', reject)
      child.on('exit', code => reject(Error(`RPC exited ${code}: ${stderr}`)))
      child.stdout.on('data', chunk => {
        output += chunk
        const lines = output.split('\n'); output = lines.pop()
        for (const line of lines) {
          let record
          try { record = JSON.parse(line) } catch { continue }
          if (record.type === 'extension_error') return reject(Error(JSON.stringify(record)))
          if (record.type === 'extension_ui_request' && record.statusKey === 'agentbox-auto') {
            state = JSON.parse(record.statusText)
          }
          if (record.id === 'probe') {
            if (!record.success) return reject(Error(JSON.stringify(record)))
            if (command) {
              child.stdin.write(JSON.stringify({ id: 'choice', type: 'prompt', message: `/auto ${command}` }) + '\n')
            } else resolve(state)
          }
          if (record.id === 'choice') {
            if (!record.success) return reject(Error(JSON.stringify(record)))
            resolve(state)
          }
        }
      })
      child.stdin.write(JSON.stringify({ id: 'probe', type: 'get_state' }) + '\n')
    })
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.stdin.end()
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000)
      try { await exited } finally { clearTimeout(kill) }
    }
  }
}

// Supply the installed Pi package root to exercise actual disk persistence.
if (process.argv[2]) {
  const { SessionManager } = await import(pathToFileURL(join(process.argv[2], 'dist/core/session-manager.js')).href)
  const root = mkdtempSync(join(tmpdir(), 'pi-auto-session-'))
  try {
    let manager = SessionManager.create(root, root)
    // Pi defers fresh session writes until the first assistant message.
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'saved conversation' }],
      api: 'openai-completions', provider: 'test', model: 'test', stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
    const file = manager.getSessionFile()
    for (const mode of ['on', 'off', 'review']) {
      await harness({ manager }).auto(mode)
      // No close API: synchronous appends are complete; discard and reopen.
      manager = SessionManager.open(file)
      const reader = harness({ manager })
      await reader.start('startup')
      await reader.auto('status')
      assert.match(reader.notices.at(-1), new RegExp(`Auto: ${mode}`))
      manager.branch(manager.getEntries()[0].id)
      await reader.tree()
      await reader.auto('status')
      assert.match(reader.notices.at(-1), new RegExp(`Auto: ${mode}`))
      assert.equal(reader.writes(), 0)
    }
    writeFileSync(join(root, 'policy.json'), JSON.stringify({ version: 1, defaultDecision: 'ask', rules: [], auto: { enable: true } }))
    assert.deepEqual(await rpcAuto(process.argv[2], root, file, 'on'), { available: true, enabled: true })
    assert.deepEqual(await rpcAuto(process.argv[2], root, file), { available: true, enabled: true },
      `new RPC process restores Auto for Pi web: ${JSON.stringify(SessionManager.open(file).getEntries().filter(entry => entry.type === 'custom'))}`)
    assert.deepEqual(await rpcAuto(process.argv[2], root, file, 'off'), { available: true, enabled: false })
    assert.deepEqual(await rpcAuto(process.argv[2], root, file), { available: true, enabled: false }, 'explicit off also survives web resume')
  } finally { rmSync(root, { recursive: true, force: true }) }
}
console.log('pi auto session tests passed')
