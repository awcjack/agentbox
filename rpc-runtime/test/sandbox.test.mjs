import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildSandboxLaunch, managedGitConfigMount } from "../sandbox.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions-project");
  for (const dir of [cwd, sessionDir, join(root, "sibling"), join(root, "extra-ro"), join(root, "extra-rw")]) mkdirSync(dir);
  return { root, profile: { cwd, sessionDir }, sandbox: { enable: true, executable: "/nonexistent/bwrap", readOnlyPaths: [], readWritePaths: [] }, executable: "/bin/sh", args: ["-c", "true"] };
}
const enabledTest = process.platform === "linux" ? test : test.skip;
function mounts(args, flag) {
  return args.flatMap((arg, index) => arg === flag ? [[args[index + 1], args[index + 2]]] : []);
}

test("disabled sandbox preserves command and argv references without probing paths", () => {
  const args = ["--rpc", "$(never executed)"];
  for (const sandbox of [undefined, { enable: false, executable: "relative" }]) {
    const result = buildSandboxLaunch({ executable: "pi", args, sandbox });
    assert.equal(result.executable, "pi");
    assert.equal(result.args, args);
  }
});

test("enabled sandbox refuses unsupported platforms", { skip: process.platform === "linux" }, () => {
  assert.throws(() => buildSandboxLaunch({ sandbox: { enable: true } }), /requires Linux/);
});

enabledTest("uses isolated namespaces, private runtime trees, and only two default RW mounts", (t) => {
  const input = fixture(t);
  const result = buildSandboxLaunch(input);
  assert.equal(result.executable, input.sandbox.executable);
  for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--die-with-parent", "--new-session"]) assert.ok(result.args.includes(flag));
  // Keep the exact clone signature in security/seccomp/browser-rpc.nix valid.
  assert.deepEqual(result.args.filter((arg) => arg.startsWith("--unshare-")),
    ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts"]);
  assert.deepEqual(mounts(result.args, "--bind"), [[input.profile.cwd, input.profile.cwd], [input.profile.sessionDir, input.profile.sessionDir]]);
  assert.deepEqual(mounts(result.args, "--tmpfs").map(([path]) => path), ["/tmp", "/run", "/home/agent"]);
  assert.ok(result.args.includes("--proc"));
  assert.ok(result.args.includes("--dev"));
  const ro = mounts(result.args, "--ro-bind");
  for (const [source, destination] of ro) {
    assert.equal(source, realpathSync(source));
    if (destination.startsWith("/run/pi-seed/")) {
      assert.ok(["auth.json", "settings.json", "models.json"].includes(destination.split("/").at(-1)));
    } else if (destination !== "/home/agent/.gitconfig") assert.equal(source, destination);
    assert.ok(!["/", "/workspace", "/home", "/home/agent", "/home/agent/.pi/agent", "/home/agent/.pi/agent/sessions"].includes(source));
  }
  const command = result.args.slice(result.args.indexOf("--") + 1);
  assert.equal(command[0], process.env.PI_RPC_SANDBOX_SHELL ?? "/bin/sh");
  assert.deepEqual(command.slice(-3), ["/bin/sh", "-c", "true"]);
  assert.deepEqual(command.slice(5, 9), ["/run/pi-seed", "/home/agent/.pi/agent", process.env.PI_RPC_SANDBOX_COREUTILS ?? "/bin", "0"]);
});

test("managed Git identity exposes only its regular config file read-only", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-git-config-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "managed-gitconfig");
  writeFileSync(config, '[user]\n  name = Sandbox Test\n  email = sandbox@example.invalid\n');
  const mount = managedGitConfigMount({ realpath(path) {
    assert.equal(path, "/home/agent/.gitconfig");
    return config; // Also covers a managed file backed by a symlink.
  } });
  assert.deepEqual(mount, ["--ro-bind", config, "/home/agent/.gitconfig"]);
  const identity = spawnSync(process.env.TEST_GIT ?? "git", ["var", "GIT_AUTHOR_IDENT"], {
    cwd: root, encoding: "utf8", env: {
      PATH: process.env.PATH, HOME: root,
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: mount[1],
    },
  });
  assert.equal(identity.status, 0, identity.stderr || identity.error?.message);
  assert.match(identity.stdout, /^Sandbox Test <sandbox@example\.invalid> /);
  for (const code of ["ENOENT", "ENOTDIR"]) {
    assert.deepEqual(managedGitConfigMount({ realpath() { throw Object.assign(new Error(code), { code }); } }), []);
  }
  assert.throws(() => managedGitConfigMount({ realpath() { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), /denied/);
  assert.throws(() => managedGitConfigMount({ realpath: () => root }), /regular non-device file/);
  assert.throws(() => managedGitConfigMount({ realpath: () => "/proc/fake", stat: () => ({ isFile: () => true }) }), /regular non-device file/);
});

enabledTest("shell metacharacters remain argv, never shell interpolation", (t) => {
  const input = fixture(t);
  input.executable = "pi; touch /tmp/escaped";
  input.args = ["$(cat /etc/shadow)", "--bind", "/", "--", "a\nb"];
  const result = buildSandboxLaunch(input);
  assert.deepEqual(result.args.slice(-(input.args.length + 1)), [input.executable, ...input.args]);
});

enabledTest("bootstrap uses private writable config copies and never persists refreshes between launches", (t) => {
  const input = fixture(t);
  input.executable = process.env.TEST_BASH ?? "/bin/sh";
  const seed = join(input.root, "seeds");
  mkdirSync(seed);
  for (const name of ["auth.json", "settings.json", "models.json"]) {
    writeFileSync(join(seed, name), JSON.stringify({ fixture: name }));
    chmodSync(join(seed, name), 0o400);
  }
  const injected = join(input.root, "injected-startup");
  const unexpected = join(input.root, "unexpected-startup-effect");
  writeFileSync(injected, `printf injected > '${unexpected}'\n`);
  for (let iteration = 0; iteration < 2; iteration++) {
    const home = join(input.root, `private-agent-${iteration}`);
    input.args = ["-peu", "-c", `test "$PI_CODING_AGENT_DIR" = "$1"; test ! -e "$1/auth.json.lock"; IFS= read -r initial < "$1/auth.json" || :; test "$initial" = '{"fixture":"auth.json"}'; printf refreshed > "$1/auth.json"; : > "$1/auth.json.lock"; printf changed > "$1/settings.json"; printf changed > "$1/models.json"`, "fixture-bootstrap", home];
    const launch = buildSandboxLaunch(input);
    const command = launch.args.slice(launch.args.indexOf("--") + 1);
    command[5] = seed;
    command[6] = home;
    // Execute ONLY the extracted trusted bootstrap against fixture directories.
    // No real credential source or real /home/agent is accessed by this test.
    const result = spawnSync(command[0], command.slice(1), { encoding: "utf8", env: { PATH: "/nonexistent", BASH_ENV: injected, ENV: injected, PI_CODING_AGENT_DIR: "/should-not-be-used" } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(!existsSync(unexpected), "bootstrap must not source injected shell startup files");
    assert.equal(readFileSync(join(home, "auth.json"), "utf8"), "refreshed");
    assert.equal(statSync(join(home, "auth.json")).mode & 0o777, 0o600);
    for (const name of ["auth.json", "settings.json", "models.json"]) assert.deepEqual(JSON.parse(readFileSync(join(seed, name), "utf8")), { fixture: name });
  }
});

enabledTest("bootstrap rejects untrusted shell or tool lookup paths", (t) => {
  const input = fixture(t);
  for (const key of ["PI_RPC_SANDBOX_SHELL", "PI_RPC_SANDBOX_COREUTILS"]) {
    const saved = process.env[key];
    try {
      process.env[key] = join(input.root, "project", "malicious-tool");
      assert.throws(() => buildSandboxLaunch(input), /immutable store path/);
    } finally {
      if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
    }
  }
});

enabledTest("requires an existing, distinct, canonical cwd and session directory", (t) => {
  const input = fixture(t);
  for (const key of ["cwd", "sessionDir"]) {
    for (const path of [undefined, "relative", `${input.profile[key]}/../${key}`, `${input.root}/missing`]) {
      assert.throws(() => buildSandboxLaunch({ ...input, profile: { ...input.profile, [key]: path } }));
    }
    const alias = join(input.root, `${key}-alias`);
    symlinkSync(input.profile[key], alias);
    assert.throws(() => buildSandboxLaunch({ ...input, profile: { ...input.profile, [key]: alias } }), /canonical/);
  }
  assert.throws(() => buildSandboxLaunch({ ...input, profile: { ...input.profile, sessionDir: input.profile.cwd } }), /overlap/);
  const nested = join(input.profile.cwd, "nested");
  mkdirSync(nested);
  assert.throws(() => buildSandboxLaunch({ ...input, profile: { ...input.profile, sessionDir: nested } }), /overlap/);
  const file = join(input.root, "file");
  writeFileSync(file, "fixture");
  assert.throws(() => buildSandboxLaunch({ ...input, profile: { ...input.profile, cwd: file } }), /directory/);
});

enabledTest("rejects broad/reserved mounts, alias escapes, overlaps and missing extra paths", (t) => {
  const input = fixture(t);
  for (const key of ["readOnlyPaths", "readWritePaths"]) {
    for (const path of ["/", "/tmp", "/usr", "/proc", "/dev", "/home/agent/.gitconfig", "/home/agent/.gitconfig.lock", input.root, input.profile.cwd, input.profile.sessionDir, join(input.root, "missing")]) {
      assert.throws(() => buildSandboxLaunch({ ...input, sandbox: { ...input.sandbox, [key]: [path] } }));
    }
    assert.throws(() => buildSandboxLaunch({ ...input, sandbox: { ...input.sandbox, [key]: "not-an-array" } }), /arrays/);
    const alias = join(input.root, `${key}-alias`);
    symlinkSync(input.root, alias);
    assert.throws(() => buildSandboxLaunch({ ...input, sandbox: { ...input.sandbox, [key]: [alias] } }), /canonical/);
  }
  for (const cwd of ["/", "/tmp", "/usr"]) assert.throws(() => buildSandboxLaunch({ ...input, profile: { ...input.profile, cwd } }));
  assert.throws(() => buildSandboxLaunch({ ...input, sandbox: { ...input.sandbox, executable: "bwrap" } }), /absolute/);
});

enabledTest("explicit trusted extra mounts are same-path and do not shadow profile mounts", (t) => {
  const input = fixture(t);
  const ro = join(input.root, "extra-ro");
  const rw = join(input.root, "extra-rw");
  input.sandbox.readOnlyPaths = [ro];
  input.sandbox.readWritePaths = [rw];
  const { args } = buildSandboxLaunch(input);
  assert.ok(mounts(args, "--ro-bind").some(([path, destination]) => path === ro && destination === ro));
  assert.ok(mounts(args, "--bind").some(([path, destination]) => path === rw && destination === rw));
  input.sandbox.readWritePaths = [ro];
  assert.throws(() => buildSandboxLaunch(input), /overlap/);
});

enabledTest("bubblewrap integration: sibling files/symlink escape hidden, project and session writable", (t) => {
  const bwrap = process.env.TEST_BWRAP ?? (process.env.PATH ?? "").split(":")
    .filter((path) => path.startsWith("/"))
    .map((path) => join(path, "bwrap")).find((path) => existsSync(path));
  if (!bwrap) return t.skip("bubblewrap is unavailable (PATH/TEST_BWRAP)");
  const input = fixture(t);
  input.sandbox.executable = bwrap;
  input.executable = process.env.TEST_BASH ?? "/bin/sh";
  const secret = join(input.root, "sibling", "fixture-secret");
  writeFileSync(secret, "test fixture, not a host secret");
  const readonly = join(input.root, "extra-ro");
  writeFileSync(join(readonly, "marker"), "unchanged");
  input.sandbox.readOnlyPaths = [readonly];
  symlinkSync(join(input.root, "sibling"), join(input.profile.cwd, "escape"));
  // Probe the same launch, not an unrestricted host-root bind. Sandboxed Nix
  // builders often prohibit nested user namespaces even when bwrap is installed.
  const probe = spawnSync(...launchTuple(input), { encoding: "utf8" });
  if (probe.error?.code === "ENOENT") return t.skip("configured bubblewrap is unavailable");
  if (probe.status !== 0 && /(?:operation not permitted|permission denied|no permissions to create|creating new namespace failed)/i.test(probe.stderr ?? "")) {
    return t.skip("kernel/container disallows bubblewrap user namespaces");
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  input.args = ["-peu", "-c", `test ! -e "$1"; test ! -e escape/fixture-secret; test ! -e /dev/sda; printf project > written; printf session > "$2/written"; ! printf changed > "$3/marker"; test ! -e /home/agent/.ssh
agent=/home/agent/.pi/agent
test ! -e "$agent/auth.json.lock"
IFS= read -r initial < "$agent/auth.json" || :
test "$initial" = '{"fixture":"auth.json"}'
for name in auth.json settings.json models.json; do printf changed > "$agent/$name"; done
: > "$agent/auth.json.lock"
! printf changed > /home/agent/.gitconfig
unset GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM GIT_CONFIG_COUNT GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
export HOME=/home/agent GIT_CONFIG_NOSYSTEM=1
identity=$("$4" var GIT_AUTHOR_IDENT)
case "$identity" in 'Sandbox Test <sandbox@example.invalid> '*) ;; *) exit 1 ;; esac`, "sandbox-test", secret, input.profile.sessionDir, readonly, process.env.TEST_GIT ?? "/usr/bin/git"];
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = spawnSync(...launchTuple(input), { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  input.browserRpcFd = 3;
  // Bubblewrap inherits descriptors; the trusted bootstrap keeps only fd 3.
  input.args = ["-peu", "-c", "printf private-bridge >&3; test ! -e /proc/self/fd/4"];
  const inherited = spawnSync(...launchTuple(input), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
  assert.equal(inherited.status, 0, inherited.stderr || inherited.error?.message);
  assert.equal(inherited.output[3], "private-bridge");
  assert.equal(inherited.output[4], "");
  assert.equal(readFileSync(join(input.profile.cwd, "written"), "utf8"), "project");
  assert.equal(readFileSync(join(input.profile.sessionDir, "written"), "utf8"), "session");
  assert.equal(readFileSync(join(readonly, "marker"), "utf8"), "unchanged");
  assert.match(readFileSync(join(input.root, "fixture-gitconfig"), "utf8"), /name = Sandbox Test/);
});

function launchTuple(input) {
  const launch = buildSandboxLaunch(input);
  // Never copy real host credentials in tests: replace ALL seed mounts with
  // deterministic fixture sources, even if the host happens to have auth.json.
  const args = [];
  const split = launch.args.indexOf("--");
  for (let i = 0; i < split; i++) {
    if (launch.args[i] === "--ro-bind" && (launch.args[i + 2].startsWith("/run/pi-seed/") || launch.args[i + 2] === "/home/agent/.gitconfig")) { i += 2; continue; }
    args.push(launch.args[i]);
  }
  const seeds = join(input.root, "fixture-seeds");
  mkdirSync(seeds, { recursive: true });
  for (const name of ["auth.json", "settings.json", "models.json"]) {
    writeFileSync(join(seeds, name), JSON.stringify({ fixture: name }));
    args.push("--ro-bind", join(seeds, name), `/run/pi-seed/${name}`);
  }
  const gitConfig = join(input.root, "fixture-gitconfig");
  writeFileSync(gitConfig, '[user]\n  name = Sandbox Test\n  email = sandbox@example.invalid\n');
  args.push("--ro-bind", gitConfig, "/home/agent/.gitconfig");
  return [launch.executable, [...args, ...launch.args.slice(split)]];
}

enabledTest("keeps only fd3 for the private browser bridge", (t) => {
  const input = fixture(t);
  const without = buildSandboxLaunch(input).args;
  assert.equal(without.includes("--preserve-fds"), false);
  assert.equal(without[without.indexOf("pi-rpc-sandbox-bootstrap") + 4], "0");
  const { args } = buildSandboxLaunch({ ...input, browserRpcFd: 3 });
  assert.equal(args.includes("--preserve-fds"), false);
  assert.equal(args[args.indexOf("pi-rpc-sandbox-bootstrap") + 4], "1");
  for (const fd of [0, 1, 2, 4, "3", [3], null]) assert.throws(() => buildSandboxLaunch({ ...input, browserRpcFd: fd }), /must be 3/);
});
