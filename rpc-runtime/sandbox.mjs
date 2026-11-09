import { realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

// This is filesystem/process isolation, not a network or credential boundary:
// networking is inherited, private auth/config copies remain readable by the agent,
// and explicitly configured extra mounts are trusted administrator grants.
// Do not expose the agent directory (sessions, extensions, caches, etc.). Skills
// are deliberately opt-in via readOnlyPaths: they can contain arbitrary code and
// symlinks into unrelated private directories.
const optionalReadOnly = [
  "/nix/store", "/bin", "/usr", "/lib", "/lib64", "/sbin",
  "/etc/ssl/certs", "/etc/ssl/cert.pem", "/etc/pki/tls/certs",
  "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf",
  "/etc/passwd", "/etc/group", "/etc/localtime",
  "/etc/pi", "/etc/agentbox",
];
const agentHome = "/home/agent/.pi/agent";
const seedDir = "/run/pi-seed";
const configNames = ["auth.json", "settings.json", "models.json"];
// Executed only AFTER entering bwrap. Tools are absolute trusted package paths,
// never resolved via a profile-controlled PATH. Each invocation gets fresh copies;
// OAuth refresh/settings changes and lock files are writable but LOST on exit;
// providers rotating refresh tokens may require re-authentication afterwards.
const bootstrap = `seed=$1; agent=$2; tools=$3; shift 3
export PI_CODING_AGENT_DIR="$agent"
umask 077
"$tools/mkdir" -p -- "$agent"
for name in auth.json settings.json models.json; do
  if [ -f "$seed/$name" ]; then
    "$tools/cp" -- "$seed/$name" "$agent/$name"
    "$tools/chmod" 600 -- "$agent/$name"
  fi
done
exec "$@"`;

function trustedBootstrapPath(path, label, fallbacks) {
  absolute(path, label);
  if (!fallbacks.includes(path) && !path.startsWith("/nix/store/")) {
    throw new Error(`sandbox ${label} must be an immutable store path or standard system fallback`);
  }
  return path;
}
const broadPaths = new Set([
  "/", "/root", "/etc", "/nix", "/usr", "/bin", "/sbin", "/lib", "/lib64",
  "/workspace", "/home", "/home/agent", "/home/agent/.pi",
  "/home/agent/.pi/agent", "/home/agent/.pi/agent/sessions", "/sessions",
  "/tmp", "/run", "/var", "/var/lib", "/mnt", "/media", "/opt", "/srv",
]);
const contains = (parent, child) => parent === child || child.startsWith(`${parent}/`);
const overlaps = (a, b) => contains(a, b) || contains(b, a);

function absolute(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
    throw new Error(`sandbox ${label} must be an absolute normalized path`);
  }
  return path;
}

function canonical(path, label) {
  absolute(path, label);
  const resolved = realpathSync(path); // Missing required paths fail closed; never create host paths here.
  if (resolved !== path) throw new Error(`sandbox ${label} must be canonical (resolved path: ${resolved})`);
  return path;
}

function restricted(path, label) {
  if (broadPaths.has(path) || overlaps(path, seedDir) || configNames.some((name) => overlaps(path, `${agentHome}/${name}`) || path.startsWith(`${agentHome}/${name}.`)) || ["/proc", "/dev", "/sys", "/etc", "/nix/store", "/usr", "/bin", "/sbin", "/lib", "/lib64"].some((root) => contains(root, path))) {
    throw new Error(`sandbox ${label} is too broad or reserved: ${path}`);
  }
}

/** Build argv only. Failure to validate or to start bwrap must never launch Pi directly.
 * cwd/sessionDir and explicit mounts must already exist and be canonical. Rejecting
 * symlinked project paths avoids granting a different tree than the runtime's cwd.
 * As with all pathname-based mounts, trusted host administrators must not rename
 * or replace these directories between validation and exec (TOCTOU).
 */
export function buildSandboxLaunch({ executable, args, profile, sandbox, browserRpcFd }) {
  // Never accept arbitrary descriptor ranges: fd 3 is the sole private bridge.
  if (browserRpcFd !== undefined && browserRpcFd !== 3) throw new Error("sandbox browserRpcFd must be 3");
  if (!sandbox?.enable) return { executable, args };
  if (process.platform !== "linux") throw new Error("Pi RPC sandbox requires Linux bubblewrap");
  absolute(sandbox.executable, "executable");
  const shell = trustedBootstrapPath(process.env.PI_RPC_SANDBOX_SHELL ?? "/bin/sh", "bootstrap shell", ["/bin/sh"]);
  const tools = trustedBootstrapPath(process.env.PI_RPC_SANDBOX_COREUTILS ?? "/bin", "bootstrap coreutils", ["/bin", "/usr/bin"]);
  const cwd = canonical(profile?.cwd, "profile.cwd");
  const sessionDir = canonical(profile?.sessionDir, "profile.sessionDir");
  for (const [label, path] of [["profile.cwd", cwd], ["profile.sessionDir", sessionDir]]) {
    restricted(path, label);
    if (!statSync(path).isDirectory()) throw new Error(`sandbox ${label} must be a directory`);
  }
  if (overlaps(cwd, sessionDir)) throw new Error("sandbox cwd and sessionDir must not overlap");

  const readOnly = sandbox.readOnlyPaths ?? [];
  const readWrite = sandbox.readWritePaths ?? [];
  if (!Array.isArray(readOnly) || !Array.isArray(readWrite)) throw new Error("sandbox extra paths must be arrays");
  const extras = [...readOnly.map((path) => ["--ro-bind", path]), ...readWrite.map((path) => ["--bind", path])];
  for (const [flag, path] of extras) {
    canonical(path, "extra path");
    restricted(path, "extra path");
    if (contains(agentHome, path) && !(flag === "--ro-bind" && contains(`${agentHome}/skills`, path))) {
      throw new Error("sandbox extra agent-home mounts are restricted to read-only skills");
    }
    if (overlaps(path, cwd) || overlaps(path, sessionDir)) {
      throw new Error("sandbox extra paths must not overlap cwd or sessionDir");
    }
  }
  for (let i = 0; i < extras.length; i++) {
    for (let j = i + 1; j < extras.length; j++) {
      if (overlaps(extras[i][1], extras[j][1])) throw new Error("sandbox extra paths must not overlap each other");
    }
  }

  // bwrap starts with an empty mount namespace. --dev creates a private minimal
  // device tree, NOT a bind of host /dev. No --unshare-net: networking is out of scope.
  const launchArgs = [
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/home/agent",
    "--proc", "/proc", "--dev", "/dev",
  ];
  if (browserRpcFd === 3) launchArgs.push("--preserve-fds", "1");
  const bound = new Set();
  const aliases = [];
  for (const path of optionalReadOnly) {
    let target;
    try { target = realpathSync(path); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
    // Never bind a symlink's target at the alias path: bwrap may otherwise create
    // the destination beneath a read-only mount or leave absolute links dangling.
    // Bind canonical targets, then recreate the public aliases in the empty tree.
    if ((broadPaths.has(target) && target !== path) || target === "/" || ["/proc", "/dev", "/sys"].some((root) => contains(root, target)) ||
        (statSync(target).isDirectory() && target !== path && !["/nix/store", "/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc"].some((root) => contains(root, target)))) {
      throw new Error(`sandbox unsafe runtime mount target: ${path}`);
    }
    if (overlaps(target, cwd) || overlaps(target, sessionDir) || extras.some(([, extra]) => overlaps(target, extra))) {
      throw new Error(`sandbox runtime mount overlaps writable/extra path: ${path}`);
    }
    if (![...bound].some((root) => contains(root, target))) {
      launchArgs.push("--ro-bind", target, target);
      bound.add(target);
    }
    if (path !== target) aliases.push([target, path]);
  }
  for (const [target, path] of aliases) {
    // An enclosing canonical bind already contains its original symlink.
    if (![...bound].some((root) => contains(root, path))) launchArgs.push("--symlink", target, path);
  }
  // Seed mounts are files at private /run paths, never binds at Pi's final paths.
  // Do not mount their canonical host locations: that could expose other host
  // credentials via aliases or collide with the writable private agent directory.
  for (const name of configNames) {
    let target;
    try { target = realpathSync(`${agentHome}/${name}`); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
    if (!statSync(target).isFile() || ["/proc", "/dev", "/sys"].some((root) => contains(root, target))) {
      throw new Error(`sandbox config seed must be a regular non-device file: ${name}`);
    }
    launchArgs.push("--ro-bind", target, `${seedDir}/${name}`);
  }
  launchArgs.push("--bind", cwd, cwd, "--bind", sessionDir, sessionDir);
  for (const [flag, path] of extras) launchArgs.push(flag, path, path);
  // -p prevents BASH_ENV/ENV and imported shell functions from running before
  // this trusted bootstrap, even if configured child environment contains them.
  launchArgs.push("--chdir", cwd, "--", shell, "-peu", "-c", bootstrap, "pi-rpc-sandbox-bootstrap", seedDir, agentHome, tools, executable, ...args);
  return { executable: sandbox.executable, args: launchArgs };
}
