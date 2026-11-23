// Shared test-runner — invoked as `bun shared-test-runner.ts <file_path>`
// by both the OpenCode `tool.execute.after` plugin and the Claude Code
// PostToolUse hook. No shebang: always run via bun.
import { execSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { dirname, extname, join } from "path"

const TIMEOUT_SEC = 90
const SOURCE_EXTS = new Set([
  ".go", ".rs", ".ts", ".tsx", ".js", ".jsx",
  ".py", ".java", ".kt", ".swift", ".ex", ".exs",
])
const SKIP_SEGMENTS = [
  "/vendor/", "/node_modules/", "/.git/", "/dist/",
  "/build/", "/target/", "/.venv/", "/venv/",
]

// Infrastructure-related failure patterns. If every failing line in the
// test output matches one of these, the run is treated as an infra
// skip rather than a code regression. Keep this list tight — anything
// overly broad will hide real bugs. Extend it for the services your own
// test suites depend on.
const INFRA_PATTERNS: RegExp[] = [
  /connection\s+refused.*:5432\b/i,                 // postgres
  /dial\s+tcp\s+\S*:5432/i,
  /pq:\s+(could\s+not\s+connect|the\s+database\s+system\s+is)/i,
  /connection\s+refused.*:6379\b/i,                 // redis
  /redis(.|\n)*?(connection\s+(refused|reset)|i\/o\s+timeout)/i,
  /no\s+such\s+host/i,
  /network\s+is\s+unreachable/i,
  /socket:\s+connection\s+refused/i,
  /docker:\s+Cannot\s+connect\s+to\s+the\s+Docker\s+daemon/i,
  /127\.0\.0\.1:(5432|6379)/i,
]

const file = process.argv[2]
if (!file) {
  console.error("usage: shared-test-runner.ts <file_path>")
  process.exit(0)
}

function isSourceFile(p: string): boolean {
  if (SKIP_SEGMENTS.some(seg => p.includes(seg))) return false
  return SOURCE_EXTS.has(extname(p))
}

function findUp(start: string, marker: string): string | null {
  let dir = existsSync(start) ? start : dirname(start)
  while (true) {
    if (existsSync(join(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function hasCommand(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: ["pipe", "pipe", "pipe"] })
    return true
  } catch { return false }
}

type RunResult = { code: number; output: string }
function run(cmd: string, cwd: string): RunResult {
  try {
    const stdout = execSync(
      `timeout --kill-after=5 ${TIMEOUT_SEC} ${cmd}`,
      { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    )
    return { code: 0, output: stdout }
  } catch (e: any) {
    const out = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "")
    return { code: e.status ?? 1, output: out || (e.message ?? "") }
  }
}

// Splits test output into individual failure blocks (one per failing
// test) and returns true only if every block is dominated by an
// infrastructure pattern. A single non-infra failure means the run is
// a real regression.
//
// Recognised block delimiters:
//   - go test:  "--- FAIL: TestName"  ... until next "--- " / "FAIL\t"
//   - ginkgo:   "[FAIL] ..."          ... until next "•" / "Ran "
//   - jest:     "● ..."               ... until next "●" / "Tests:"
//   - rust:     "thread '...' panicked ..." ... until next "thread '"
function splitFailureBlocks(output: string): string[] {
  const lines = output.split("\n")
  const blocks: string[] = []
  let cur: string[] | null = null

  const startRe = /^(---\s+FAIL:\s+\S+|\[FAIL(ED)?\]|●\s+\S|thread\s+'.*'\s+panicked)/
  const endRe = /^(---\s+(PASS|SKIP):|FAIL\s+\S+\s+[\d\.]+s|ok\s+\S+\s+[\d\.]+s|Tests:\s+|Ran\s+\d+\s+of\s+\d+|test\s+result:)/

  for (const line of lines) {
    if (startRe.test(line)) {
      if (cur) blocks.push(cur.join("\n"))
      cur = [line]
      continue
    }
    if (endRe.test(line)) {
      if (cur) { blocks.push(cur.join("\n")); cur = null }
      continue
    }
    if (cur) cur.push(line)
  }
  if (cur) blocks.push(cur.join("\n"))
  return blocks
}

function isInfraOnly(output: string): boolean {
  if (!INFRA_PATTERNS.some(p => p.test(output))) return false
  const blocks = splitFailureBlocks(output)
  if (blocks.length === 0) {
    // No structured failure blocks (e.g. compile-time error before any
    // test ran). Treat as infra-only iff the whole output matches infra.
    return INFRA_PATTERNS.some(p => p.test(output))
  }
  return blocks.every(b => INFRA_PATTERNS.some(p => p.test(b)))
}

type Outcome = {
  language: string
  ran: boolean
  passed: boolean
  infraOnly: boolean
  output: string
}

function testGo(file: string): Outcome | null {
  const pkgDir = dirname(file)
  const modRoot = findUp(pkgDir, "go.mod")
  if (!modRoot) return null
  if (!hasCommand("go")) return null
  // Test only the package containing the changed file.
  const r = run(`go test -short -count=1 -timeout 60s .`, pkgDir)
  return {
    language: "Go",
    ran: true,
    passed: r.code === 0,
    infraOnly: r.code !== 0 && isInfraOnly(r.output),
    output: r.output,
  }
}

function testRust(file: string): Outcome | null {
  const root = findUp(dirname(file), "Cargo.toml")
  if (!root || !hasCommand("cargo")) return null
  const r = run(`cargo test --quiet --no-fail-fast`, root)
  return {
    language: "Rust",
    ran: true,
    passed: r.code === 0,
    infraOnly: r.code !== 0 && isInfraOnly(r.output),
    output: r.output,
  }
}

function testTypeScript(file: string): Outcome | null {
  const root = findUp(dirname(file), "package.json")
  if (!root) return null
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"))
  if (!pkg?.scripts?.test) return null
  const hasJest = existsSync(join(root, "node_modules/.bin/jest"))
  const cmd = hasJest
    ? `npx jest --testPathPattern='${file.replace(/'/g, "'\\''").replace(/\//g, "\\/")}' --passWithNoTests`
    : `npm test --silent`
  const r = run(cmd, root)
  return {
    language: "TypeScript",
    ran: true,
    passed: r.code === 0,
    infraOnly: r.code !== 0 && isInfraOnly(r.output),
    output: r.output,
  }
}

function main(): void {
  if (!isSourceFile(file)) process.exit(0)

  const tests = [
    () => testGo(file),
    () => testRust(file),
    () => testTypeScript(file),
  ]

  const outcomes: Outcome[] = []
  for (const t of tests) {
    const o = t()
    if (o) outcomes.push(o)
  }

  if (outcomes.length === 0) {
    console.log(`[test-runner] no test runner detected for ${file}`)
    process.exit(0)
  }

  const realFailures = outcomes.filter(o => !o.passed && !o.infraOnly)
  const infraSkips = outcomes.filter(o => !o.passed && o.infraOnly)

  if (realFailures.length === 0) {
    for (const s of infraSkips) {
      console.log(`[test-runner] ${s.language}: infra-only failure, skipped`)
    }
    for (const o of outcomes.filter(x => x.passed)) {
      console.log(`[test-runner] ${o.language}: ✓`)
    }
    process.exit(0)
  }

  // Real failure — emit a structured block on stderr so the agent sees it.
  const detail = realFailures
    .map(f => `--- ${f.language} ---\n${f.output.trim()}`)
    .join("\n\n")
    .slice(0, 8000)

  const infraNote = infraSkips.length
    ? `\n\nNote: ${infraSkips.map(s => s.language).join(", ")} reported infrastructure errors (a required service was not reachable). Those were filtered out — fix only the failures above.`
    : ""

  process.stderr.write(
    `<test_failure>\n` +
    `Tests failed after editing: ${file}\n\n` +
    `${detail}${infraNote}\n` +
    `</test_failure>\n`,
  )
  process.exit(2)
}

main()
