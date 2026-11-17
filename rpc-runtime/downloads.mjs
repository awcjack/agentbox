import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

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

// Never readFile(): stat is only an early rejection, not a bound on a growing
// file. One extra byte detects overflow, including growth after the first stat.
async function readBoundedFile(file) {
  const before = await file.stat();
  if (!before.isFile() || before.nlink !== 1) throw forbidden();
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
  if (!after.isFile() || after.nlink !== 1) throw forbidden();
  if (after.size > MAX_DOWNLOAD_BYTES) throw tooLarge();
  // Do not return a truncated/changed snapshot when a producer is still writing.
  if (before.size !== size || after.size !== size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
    throw new DownloadError(409, "download_changed", "File changed during download; retry when writing has finished");
  }
  return Buffer.concat(chunks, size);
}

export async function readWorkspaceDownload(cwd, path) {
  const { root, inside, filename } = downloadParts(cwd, path);
  // Node has no portable openat(2). Do NOT replace this with realpath + open:
  // an intermediate directory can become a symlink between those operations.
  // Other platforms (or Linux without procfs) must fail closed.
  if (process.platform !== "linux" || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw unavailable();
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let directory, file;
  try {
    directory = await open("/", directoryFlags);
    // Distinguish unavailable procfs from a missing requested file.
    try {
      const probe = await open(`/proc/self/fd/${directory.fd}/.`, directoryFlags);
      await probe.close();
    } catch { throw unavailable(); }
    const components = [...root.split(sep).filter(Boolean), ...inside.split(sep)];
    const leaf = components.pop();
    for (const component of components) {
      // Follow only our own pinned descriptor, never an untrusted component.
      const next = await open(`/proc/self/fd/${directory.fd}/${component}`, directoryFlags);
      const previous = directory;
      directory = next;
      await previous.close();
    }
    // NONBLOCK prevents a swapped-in FIFO from hanging before fstat can reject
    // it. NOFOLLOW rejects final symlinks; fstat rejects devices/directories.
    file = await open(`/proc/self/fd/${directory.fd}/${leaf}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const bytes = await readBoundedFile(file);
    return { data: bytes.toString("base64"), filename, mimeType: "application/octet-stream" };
  } catch (error) {
    if (error instanceof DownloadError) throw error;
    // Never propagate OS messages: they can include private host paths.
    if (error?.code === "ENOENT") throw new DownloadError(404, "download_not_found", "Workspace file is unavailable");
    if (["ELOOP", "ENOTDIR", "EACCES", "EPERM", "ENXIO", "ENODEV"].includes(error?.code)) throw forbidden();
    throw unavailable();
  } finally {
    await file?.close().catch(() => {});
    await directory?.close().catch(() => {});
  }
}

export const downloadInternals = { downloadParts, readBoundedFile };
