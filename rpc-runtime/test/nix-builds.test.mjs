import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nixBuildStoreMounts, privateNixEnvironment } from "../nix-builds.mjs";
import { buildSandboxLaunch } from "../sandbox.mjs";

const root = `/nix/store/${"0".repeat(32)}-nix`;
const other = `/nix/store/${"1".repeat(32)}-runtime`;
function seed(overrides = {}) {
  return {
    readFile(path) {
      if (path.endsWith("/store-paths")) return `${root}\n${other}\n`;
      if (path.endsWith("/nix-store")) return `${root}/bin/nix-store\n`;
      throw new Error(`unexpected seed read: ${path}`);
    },
    realpath: (path) => path,
    lstat: () => ({ isSymbolicLink: () => false }),
    ...overrides,
  };
}

test("private Nix projects immutable image roots only, never the outer store or DB", () => {
  const projection = nixBuildStoreMounts(seed());
  assert.deepEqual(projection, {
    nixStore: `${root}/bin/nix-store`,
    args: ["--ro-bind", root, root, "--ro-bind", other, other],
  });
  assert.equal(privateNixEnvironment.NIX_REMOTE, "local");
  assert.match(privateNixEnvironment.NIX_CONFIG, /sandbox = false\n/);
  assert.match(privateNixEnvironment.NIX_CONFIG, /build-users-group =\n/);
});

test("missing, malformed or escaping image seeds fail closed", () => {
  for (const paths of ["", "/nix/store\n", `${root}\n${root}\n`, `${root}/../etc\n`, "/nix/var/nix\n"]) {
    const valid = seed();
    assert.throws(() => nixBuildStoreMounts(seed({ readFile: (path) => path.endsWith("/store-paths") ? paths : valid.readFile(path) })), /invalid store paths/);
  }
  assert.throws(() => nixBuildStoreMounts(seed({ readFile: () => { throw new Error("missing image seed"); } })), /missing image seed/);
  const valid = seed();
  assert.throws(() => nixBuildStoreMounts(seed({ readFile: (path) => path.endsWith("/nix-store") ? "/bin/nix-store" : valid.readFile(path) })), /not in the image seed/);
  assert.throws(() => nixBuildStoreMounts(seed({ realpath: () => "/outside" })), /escapes its closure/);
});

test("top-level store symlinks are recreated, not dereferenced into writable copies", () => {
  const projection = nixBuildStoreMounts(seed({
    realpath: (path) => path === other ? `${root}/lib` : path,
    lstat: (path) => ({ isSymbolicLink: () => path === other }),
    readlink: () => `${root}/lib`,
  }));
  assert.deepEqual(projection.args.slice(-3), ["--symlink", `${root}/lib`, other]);
});

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-private-nix-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project"), sessionDir = join(dir, "sessions");
  mkdirSync(cwd); mkdirSync(sessionDir);
  return { executable: "/bin/sh", args: ["-c", "true"], profile: { cwd, sessionDir }, sandbox: { enable: true, nixBuilds: true, executable: "/bin/bwrap" } };
}

const linuxTest = process.platform === "linux" ? test : test.skip;
linuxTest("opt-in uses private /nix, seeds DB inside bwrap and overrides daemon environment", (t) => {
  const input = fixture(t);
  const launch = buildSandboxLaunch(input, { nixStoreMounts: () => nixBuildStoreMounts(seed()) });
  assert.deepEqual(launch.args.slice(0, 3), ["--args", "4", "--"]);
  assert.ok(Buffer.isBuffer(launch.argumentData));
  const args = launch.argumentData.toString().split("\0").slice(0, -1);
  assert.ok(args.some((value, index) => value === "--tmpfs" && args[index + 1] === "/nix"));
  assert.ok(!args.some((value, index) => ["--bind", "--ro-bind"].includes(value) && ["/nix", "/nix/store", "/nix/var/nix"].includes(args[index + 1])));
  for (const [name, value] of Object.entries(privateNixEnvironment)) {
    const index = args.indexOf(name);
    assert.equal(args[index - 1], "--setenv");
    assert.equal(args[index + 1], value);
  }
  assert.ok(!args.includes("--"), "only Bubblewrap options belong in the argument pipe");
  const command = launch.args.slice(3);
  assert.match(command[3], /"\$nix_store" --load-db < \/etc\/agentbox\/nix-builds\/registration/);
  assert.match(command[3], /gcroots\/image/);
  assert.equal(command[9], `${root}/bin/nix-store`);
  assert.deepEqual(args.filter((value) => value.startsWith("--unshare-")), ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]);
  assert.throws(() => buildSandboxLaunch({ ...input, sandbox: { ...input.sandbox, enable: false } }), /requires filesystem sandboxing/);
  assert.throws(() => buildSandboxLaunch({ ...input, sandbox: { ...input.sandbox, nixBuilds: "true" } }), /must be a boolean/);
  assert.throws(() => buildSandboxLaunch({ ...input, args: ["injected\0--bind"] }, { nixStoreMounts: () => nixBuildStoreMounts(seed()) }), /NUL-free/);
  const manyMounts = Array.from({ length: 1000 }, () => ["--ro-bind", "x".repeat(2048), "x".repeat(2048)]).flat();
  const large = buildSandboxLaunch(input, { nixStoreMounts: () => ({ nixStore: `${root}/bin/nix-store`, args: manyMounts }) });
  assert.deepEqual(large.args.slice(0, 3), ["--args", "4", "--"]);
  assert.ok(large.argumentData.length > 3 * 1024 * 1024);
  assert.throws(() => buildSandboxLaunch(input, { nixStoreMounts: () => ({ nixStore: `${root}/bin/nix-store`, args: Array(9000).fill("arg") }) }), /9000-argument limit/);
});

// Run this test INSIDE a newly built Agentbox image with Bubblewrap available.
// No downloads or outer daemon are used. Package-build environments lack the
// image seed, so they exercise the deterministic planner tests above instead.
linuxTest("image integration: build and read a private stdenv.sh, without an outer daemon", (t) => {
  if (!existsSync("/etc/agentbox/nix-builds/store-paths")) return t.skip("requires the built Agentbox image seed");
  const imageBwrap = readFileSync("/etc/agentbox/nix-builds/store-paths", "utf8").trim().split("\n")
    .filter((path) => /-bubblewrap-/.test(path)).map((path) => join(path, "bin/bwrap")).find(existsSync);
  const bwrap = process.env.TEST_BWRAP ?? process.env.PI_RPC_SANDBOX_EXECUTABLE ?? imageBwrap
    ?? (process.env.PATH ?? "").split(":").map((dir) => join(dir, "bwrap")).find(existsSync);
  assert.ok(bwrap, "built image must contain Bubblewrap");
  const input = fixture(t);
  input.sandbox.executable = bwrap;
  writeFileSync(join(input.profile.cwd, "probe.nix"), `let
  setup = builtins.toFile "stdenv.sh" "value=private-store-ok\\n";
in builtins.derivation {
  name = "agentbox-private-store-probe";
  system = builtins.currentSystem;
  builder = "/bin/sh";
  args = [ "-eu" "-c" ". \${setup}; echo $value > $out" ];
}\n`);
  const marker = join(input.profile.cwd, "verified");
  input.args = ["-eu", "-c", `test ! -S /nix/var/nix/daemon-socket/socket
nix build --file "$1/probe.nix" --out-link "$1/result" --offline
value=$(cat "$1/result")
test "$value" = private-store-ok
printf '%s' "$value" > "$1/verified"
`, "private-nix-test", input.profile.cwd];
  const launch = buildSandboxLaunch(input);
  // spawnSync can feed stdin, not an arbitrary extra input pipe. Runtime
  // launches use fd 4 instead, preserving normal RPC stdin and browser fd 3.
  const result = spawnSync(launch.executable, ["--args", "0", ...launch.args.slice(2)], { input: launch.argumentData, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.equal(readFileSync(marker, "utf8"), "private-store-ok");
});
