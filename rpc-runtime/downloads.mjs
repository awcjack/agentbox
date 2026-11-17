import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_CHECKOUT_SCAN_ENTRIES = 256;

export class DownloadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const unavailable = () => new DownloadError(503, "download_unavailable", "Secure workspace downloads are unavailable");
const forbidden = () => new DownloadError(403, "download_forbidden", "Only regular, single-link workspace files without symlinks can be downloaded");
const tooLarge = () => new DownloadError(413, "download_too_large", "File exceeds the 16 MiB download limit");
const notFound = () => new DownloadError(404, "download_not_found", "Workspace file is unavailable; include its checkout directory or use an absolute workspace path");
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const descriptorPath = (directory, child) => `/proc/self/fd/${directory.fd}/${child}`;

function downloadParts(cwd, path) {
  if (typeof path !== "string" || !path.trim() || path.length > 4096 || path.includes("\0")) {
    throw new DownloadError(400, "invalid_download", "Download requires a nonempty file path");
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) throw unavailable();
  const root = resolve(cwd);
  const target = resolve(root, path);
  const inside = relative(root, target);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw forbidden();
  return { root, inside, filename: basename(target) };
}

function regularFile(info) {
  if (!info.isFile() || info.nlink !== 1) throw forbidden();
}

// Never readFile(): stat is only an early rejection, not a bound on a growing
// file. One extra byte detects overflow, including growth after the first stat.
async function readBoundedFile(file) {
  const before = await file.stat();
  regularFile(before);
  if (before.size > MAX_DOWNLOAD_BYTES) throw tooLarge();
  const chunks = [];
  let size = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_DOWNLOAD_BYTES + 1 - size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, size);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > MAX_DOWNLOAD_BYTES) throw tooLarge();
    chunks.push(buffer.subarray(0, bytesRead));
  }
  const after = await file.stat();
  regularFile(after);
  if (after.size > MAX_DOWNLOAD_BYTES) throw tooLarge();
  // Do not return a truncated/changed snapshot when a producer is still writing.
  if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new DownloadError(409, "download_changed", "File changed during download; retry when writing has finished");
  }
  return Buffer.concat(chunks, size);
}

async function openWorkspaceRoot(root) {
  let directory = await open("/", directoryFlags);
  try {
    // Distinguish unavailable procfs from a missing requested file.
    try {
      const probe = await open(descriptorPath(directory, "."), directoryFlags);
      await probe.close();
    } catch { throw unavailable(); }
    for (const component of root.split(sep).filter(Boolean)) {
      const next = await open(descriptorPath(directory, component), directoryFlags);
      const previous = directory;
      directory = next;
      await previous.close();
    }
    return directory;
  } catch (error) {
    await directory.close().catch(() => {});
    throw error;
  }
}

// `inside` is already normalized and confined by downloadParts. Keep the caller's
// root pinned throughout both the exact lookup and any checkout fallback.
async function openFileAt(root, inside) {
  let directory = root, file;
  try {
    const parts = inside.split(sep);
    const leaf = parts.pop();
    for (const component of parts) {
      const next = await open(descriptorPath(directory, component), directoryFlags);
      if (directory !== root) await directory.close();
      directory = next;
    }
    // NONBLOCK prevents a swapped-in FIFO from hanging before fstat can reject
    // it. NOFOLLOW rejects final symlinks; fstat rejects devices/directories.
    file = await open(descriptorPath(directory, leaf), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    regularFile(await file.stat());
    return file;
  } catch (error) {
    await file?.close().catch(() => {});
    throw error;
  } finally {
    if (directory !== root) await directory.close().catch(() => {});
  }
}

// Pi can mention checkout-relative files even when cwd is the checkout's parent
// (e.g. /workspace/brian/use-brian/apps/... vs apps/...). Only inspect immediate,
// non-hidden real directories with a .git directory or worktree marker file.
// Never recursively search by basename, run Git, read .git contents, or follow a
// gitdir pointer. Inaccessible/incomplete scans cannot establish uniqueness.
async function openCheckoutFile(root, inside) {
  let match;
  try {
    const entries = await opendir(descriptorPath(root, "."));
    let visited = 0;
    for await (const entry of entries) {
      if (++visited > MAX_CHECKOUT_SCAN_ENTRIES) {
        throw new DownloadError(409, "download_search_limit", "Checkout search limit exceeded; include the checkout directory or use an absolute workspace path");
      }
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
      let checkout, candidate;
      try {
        checkout = await open(descriptorPath(root, entry.name), directoryFlags);
        const marker = await lstat(descriptorPath(checkout, ".git"));
        if (!marker.isDirectory() && !marker.isFile()) continue;
        candidate = await openFileAt(checkout, inside);
        if (match) {
          throw new DownloadError(409, "download_ambiguous", "File path matches multiple checkouts; include the checkout directory or use an absolute workspace path");
        }
        match = candidate;
        candidate = undefined;
      } catch (error) {
        // A vanished entry, symlink, or non-directory is not a checkout match.
        // Permission errors and invalid existing files fail closed instead.
        if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) throw error;
      } finally {
        await candidate?.close().catch(() => {});
        await checkout?.close().catch(() => {});
      }
    }
    if (!match) throw notFound();
    return match;
  } catch (error) {
    await match?.close().catch(() => {});
    throw error;
  }
}

export async function readWorkspaceDownload(cwd, path) {
  const { root, inside, filename } = downloadParts(cwd, path);
  // Node has no portable openat(2). Do NOT replace this with realpath + open:
  // an intermediate directory can become a symlink between those operations.
  // Other platforms (or Linux without procfs) must fail closed.
  if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw unavailable();
  let directory, file;
  try {
    directory = await openWorkspaceRoot(root);
    try { file = await openFileAt(directory, inside); }
    catch (error) {
      // Explicit absolute paths are exact. Only a missing relative path permits
      // fallback; never retry forbidden, oversized, or otherwise invalid files.
      if (error?.code !== "ENOENT" || isAbsolute(path)) throw error;
      file = await openCheckoutFile(directory, inside);
    }
    const bytes = await readBoundedFile(file);
    return { data: bytes.toString("base64"), filename, mimeType: "application/octet-stream" };
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    // Never propagate OS messages: they can include private host paths.
    if (error?.code === "ENOENT") throw notFound();
    if (["ELOOP", "ENOTDIR", "EACCES", "EPERM", "ENXIO", "ENODEV"].includes(error?.code)) throw forbidden();
    throw unavailable();
  } finally {
    await file?.close().catch(() => {});
    await directory?.close().catch(() => {});
  }
}

export const downloadInternals = { downloadParts, readBoundedFile };
