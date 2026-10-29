import { opendir, realpath, stat } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

const within = (path, root) => path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
export function containsFolder(path, root) {
  return typeof path === "string" && path.startsWith("/") && path.length <= 4096
    && !/[\u0000-\u001f\u007f]/.test(path) && normalize(path) === path && within(path, normalize(root));
}

// Check both the visible path and its canonical target. A symlink under an
// approved workspace must not turn the folder browser into a host file browser.
export async function selectFolder(profiles, path, profileName) {
  const candidates = [...profiles].filter(([name, profile]) =>
    (profileName === undefined || name === profileName) && containsFolder(path, profile.cwd))
    .sort((a, b) => b[1].cwd.length - a[1].cwd.length);
  const selected = candidates[0];
  if (!selected) throw new Error("Choose a folder within a configured workspace.");
  const [name, profile] = selected;
  const [root, target] = await Promise.all([realpath(profile.cwd), realpath(path)]);
  if (!within(target, root) || !(await stat(target)).isDirectory()) throw new Error("Choose an existing folder within the workspace.");
  return { name, profile: { ...profile, cwd: path, allowSubdirectories: false }, root: profile.cwd };
}

export async function browseFolders(profiles, path) {
  if (path === null) return { roots: [...profiles].map(([profile, entry]) => ({ profile, path: entry.cwd })) };
  const selected = await selectFolder(profiles, path);
  const directories = [];
  let visited = 0, truncated = false;
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (++visited > 10000) { truncated = true; break; }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      await selectFolder(profiles, join(path, entry.name), selected.name);
      directories.push({ name: entry.name, path: join(path, entry.name) });
    } catch { /* Unreadable directories and symlinks outside the root are omitted. */ }
    if (directories.length === 1000) { truncated = true; break; }
  }
  directories.sort((a, b) => a.name.localeCompare(b.name));
  return { path, root: selected.root, parent: path === selected.root ? null : dirname(path), directories, truncated };
}
