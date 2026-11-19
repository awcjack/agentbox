import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { EXECUTION_TARGET_ENTRY, isExecutionTargetReport, registerExecutionTargetTool } from "../extensions/execution-target.ts"

// The removed variable must not be needed, or change the reported coordinates.
const legacyVariable = "PI_EXECUTION_TARGET_PRODUCT_PATH"
const originalProductPath = process.env[legacyVariable]
delete process.env[legacyVariable]
const originalGitDir = process.env.GIT_DIR
const temporary = await realpath(await mkdtemp(join(tmpdir(), "pi-execution-target-")))
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8",
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    HOME: temporary, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
}).trim()
function harness() {
  const tools: any[] = [], entries: any[] = []
  registerExecutionTargetTool({
    registerTool: (tool: any) => tools.push(tool),
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
  } as any)
  return { tool: tools[0], entries }
}

try {
  const project = join(temporary, "workspace/aogb")
  const repo = join(project, "aogb-erp")
  const worktree = join(project, "aogb-erp-new-feat")
  const product = "modules/café"
  await mkdir(repo, { recursive: true })
  git(repo, "init", "-q")
  await mkdir(join(repo, product, "services/api"), { recursive: true })
  await writeFile(join(repo, product, "services/api/tracked.txt"), "original\n")
  git(repo, "add", ".")
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture")
  git(repo, "worktree", "add", "-q", "-b", "implementation", worktree)
  const workingDirectory = join(worktree, product, "services/api")
  await mkdir(workingDirectory, { recursive: true })
  await writeFile(join(workingDirectory, "uncommitted.txt"), "implementation remains uncommitted\n")
  await writeFile(join(workingDirectory, "tracked.txt"), "modified implementation\n")
  await mkdir(join(repo, product), { recursive: true })
  const before = git(worktree, "status", "--porcelain")
  const worktreesBefore = git(repo, "worktree", "list", "--porcelain")
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => "implementation-session" } }
  const configured = harness()
  assert.equal(configured.tool.name, "report_execution_target")
  assert.equal(configured.tool.executionMode, "sequential")
  assert.equal(configured.tool.parameters.additionalProperties, false)
  assert.ok(configured.tool.promptGuidelines.every((line: string) => line.includes("report_execution_target")))
  // Stale legacy configuration and inherited Git overrides must be ignored.
  process.env[legacyVariable] = "not-a-product-directory"
  process.env.GIT_DIR = join(repo, ".git")
  const result = await configured.tool.execute("report-1", { workingDirectory }, undefined, undefined, ctx)
  if (originalGitDir === undefined) delete process.env.GIT_DIR
  else process.env.GIT_DIR = originalGitDir
  const expected = {
    version: 1, worktreeRoot: worktree, productPath: ".", productRelativeCwd: `${product}/services/api`,
    workingDirectory, sessionId: "implementation-session", toolCallId: "report-1",
  }
  assert.deepEqual(result.details, expected)
  assert.deepEqual(result.structuredContent, expected)
  assert.equal(result.terminate, undefined, "report does not claim task completion or suppress final response")
  assert.deepEqual(configured.entries, [{ customType: EXECUTION_TARGET_ENTRY, data: expected }])
  assert.equal(isExecutionTargetReport(expected), true)
  assert.equal(ctx.cwd, repo, "reporting does not redirect the Pi session")
  assert.equal(await readFile(join(workingDirectory, "uncommitted.txt"), "utf8"), "implementation remains uncommitted\n")
  assert.equal(git(worktree, "status", "--porcelain"), before)
  assert.equal(git(repo, "worktree", "list", "--porcelain"), worktreesBefore)

  // Canonical aliases for the explicit directory are resolved, never added as grants.
  await symlink(workingDirectory, join(temporary, "cwd-alias"))
  const alias = await configured.tool.execute("report-alias", { workingDirectory: join(temporary, "cwd-alias") }, undefined, undefined, ctx)
  assert.equal(alias.details.workingDirectory, workingDirectory)
  const productRoot = await configured.tool.execute("report-product", { workingDirectory: join(worktree, product) }, undefined, undefined, ctx)
  assert.equal(productRoot.details.productRelativeCwd, product)
  const selectedWorktree = await configured.tool.execute("report-worktree", { workingDirectory: worktree }, undefined, undefined, ctx)
  assert.equal(selectedWorktree.details.worktreeRoot, join(temporary, "workspace/aogb/aogb-erp-new-feat"))
  assert.equal(selectedWorktree.details.workingDirectory, worktree)
  assert.equal(selectedWorktree.details.productRelativeCwd, ".")
  delete process.env[legacyVariable]
  const root = harness()
  const rootResult = await root.tool.execute("report-root", { workingDirectory: repo }, undefined, undefined, ctx)
  assert.equal(rootResult.details.worktreeRoot, repo)
  assert.equal(rootResult.details.productRelativeCwd, ".")
  assert.equal(rootResult.details.productPath, ".")

  const persisted = configured.entries.length
  for (const invalid of [".", "relative/path", `@${workingDirectory}`, `${worktree}/../original`, `${worktree}/`, "~/project", `${workingDirectory}\n`, `${workingDirectory}\\x`, "x".repeat(4097)]) {
    await assert.rejects(configured.tool.execute("bad-cwd", { workingDirectory: invalid }, undefined, undefined, ctx), /invalid|sensitive directory/)
  }
  for (const invalid of [null, {}, { workingDirectory, productPath: "." }, { workingDirectory: 12 }]) {
    await assert.rejects(configured.tool.execute("bad-args", invalid, undefined, undefined, ctx), /workingDirectory/)
  }
  await assert.rejects(configured.tool.execute("missing", { workingDirectory: join(worktree, "missing") }, undefined, undefined, ctx), /ENOENT/)
  await assert.rejects(configured.tool.execute("file", { workingDirectory: join(workingDirectory, "uncommitted.txt") }, undefined, undefined, ctx), /directory/)
  await assert.rejects(root.tool.execute("no-repo", { workingDirectory: temporary }, undefined, undefined, ctx), /Git metadata/)
  await mkdir(join(worktree, "secrets"))
  await assert.rejects(root.tool.execute("sensitive", { workingDirectory: join(worktree, "secrets") }, undefined, undefined, ctx), /sensitive/)
  await symlink(join(worktree, "secrets"), join(temporary, "sensitive-alias"))
  await assert.rejects(root.tool.execute("sensitive-alias", { workingDirectory: join(temporary, "sensitive-alias") }, undefined, undefined, ctx), /sensitive/)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(configured.tool.execute("cancelled", { workingDirectory }, controller.signal, undefined, ctx), /abort/i)
  assert.equal(configured.entries.length, persisted, "failures and cancellation must not persist success metadata")

  // A linked worktree whose common metadata is unavailable cannot be reported.
  const inaccessible = join(temporary, "inaccessible-worktree")
  await mkdir(inaccessible)
  await writeFile(join(inaccessible, ".git"), `gitdir: ${join(temporary, "missing-metadata")}\n`)
  await assert.rejects(root.tool.execute("inaccessible", { workingDirectory: inaccessible }, undefined, undefined, ctx), /Git metadata/)

  for (const invalid of [
    null, [], {}, { ...expected, extra: true }, { ...expected, version: 2 },
    { ...expected, worktreeRoot: "relative" }, { ...expected, worktreeRoot: `${worktree}/` },
    { ...expected, productPath: "../escape" }, { ...expected, productPath: "some-product" }, { ...expected, productRelativeCwd: "/escape" },
    { ...expected, productRelativeCwd: "a/../services/api" }, { ...expected, productRelativeCwd: "src\\nested" },
    { ...expected, workingDirectory: `${workingDirectory}/other` }, { ...expected, sessionId: "" },
    { ...expected, toolCallId: "bad\ncall" }, { ...expected, productPath: "x".repeat(4097) },
  ]) assert.equal(isExecutionTargetReport(invalid), false, JSON.stringify(invalid))

  // Register and validate the actual shipped core extension under installed Pi.
  // No session_start or model calls: do not read live runtime configuration.
  if (process.argv[2]) {
    const piRoot = process.argv[2]
    const { loadExtensions } = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href)
    const { validateToolArguments } = await import(pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-ai/dist/utils/validation.js")).href)
    const source = join(dirname(fileURLToPath(import.meta.url)), "../extensions/pi-agentbox.ts")
    const loaded = await loadExtensions([source], temporary)
    assert.deepEqual(loaded.errors, [])
    const tool = loaded.extensions[0].tools.get("report_execution_target").definition
    assert.deepEqual(validateToolArguments(tool, { id: "wire", name: tool.name, arguments: { workingDirectory } }), { workingDirectory })
    for (const args of [{}, { workingDirectory, productPath: "." }, { workingDirectory: "x".repeat(4097) }]) {
      assert.throws(() => validateToolArguments(tool, { id: "wire", name: tool.name, arguments: args }), /Validation failed/)
    }
    assert.deepEqual(tool.outputSchema, configured.tool.outputSchema)
    loaded.runtime.invalidate()
  }
  console.log("pi execution target tests passed")
} finally {
  if (originalProductPath === undefined) delete process.env[legacyVariable]
  else process.env[legacyVariable] = originalProductPath
  if (originalGitDir === undefined) delete process.env.GIT_DIR
  else process.env.GIT_DIR = originalGitDir
  await rm(temporary, { recursive: true, force: true })
}
