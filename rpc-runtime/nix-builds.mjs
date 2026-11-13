import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";

const seed = "/etc/agentbox/nix-builds";
const storePath = /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[^/\s]+$/;

/** Project only the immutable image closure into a private writable store.
 * Never share the outer store DB, daemon socket, or writable store directory.
 * The image generates registration and store-paths from the SAME closureInfo.
 * Dependencies are injectable for offline tests, never configuration inputs.
 */
export function nixBuildStoreMounts({ readFile = readFileSync, realpath = realpathSync, lstat = lstatSync, readlink = readlinkSync } = {}) {
  const paths = readFile(`${seed}/store-paths`, "utf8").trim().split("\n");
  if (!paths.length || paths.some((path) => !storePath.test(path)) || new Set(paths).size !== paths.length) {
    throw new Error("sandbox Nix image seed has invalid store paths");
  }
  const roots = new Set(paths);
  const nixStore = readFile(`${seed}/nix-store`, "utf8").trim();
  const root = nixStore.slice(0, nixStore.indexOf("/bin/"));
  if (!roots.has(root) || nixStore !== `${root}/bin/nix-store`) {
    throw new Error("sandbox Nix executable is not in the image seed");
  }
  const args = [];
  for (const path of paths) {
    const target = realpath(path);
    if (!roots.has(target.split("/").slice(0, 4).join("/"))) {
      throw new Error(`sandbox Nix image path escapes its closure: ${path}`);
    }
    if (lstat(path).isSymbolicLink()) args.push("--symlink", readlink(path), path);
    else {
      if (target !== path) throw new Error(`sandbox Nix image path is not canonical: ${path}`);
      args.push("--ro-bind", path, path);
    }
  }
  return { args, nixStore };
}

// Nix's inner build sandbox requires namespace grants the container need not
// provide. Bubblewrap remains the filesystem boundary for ALL child processes.
// These settings affect only the private namespace, not the outer daemon.
export const privateNixEnvironment = {
  NIX_REMOTE: "local",
  NIX_STORE_DIR: "/nix/store",
  NIX_STATE_DIR: "/nix/var/nix",
  NIX_LOG_DIR: "/nix/var/log/nix",
  NIX_CONF_DIR: "/run/pi-nix-conf",
  NIX_USER_CONF_FILES: "/run/pi-nix-conf/nix.conf",
  NIX_CONFIG: "experimental-features = nix-command flakes\nsandbox = false\nsandbox-fallback = false\nbuild-users-group =\n",
};
