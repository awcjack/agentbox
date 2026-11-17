import test from "node:test";
import assert from "node:assert/strict";
import { localDownloadPath, downloadFilename, downloadBlob, saveDownload, fetchDownload, MAX_DOWNLOAD_BYTES } from "./downloads.mjs";

test("inline file classification preserves paths and spaces without collecting a button list", () => {
  for (const path of ["reports/final draft.csv", "README.md", "/workspace/output.pdf", "./out/file.zip"]) {
    assert.equal(localDownloadPath(path), path);
  }
  assert.equal(localDownloadPath('"report two.pdf"'), "report two.pdf");
  for (const text of [null, "", "npm install", "plainword", "dir/"]) assert.equal(localDownloadPath(text), null);
  assert.equal(localDownloadPath("LICENSE", { explicit: true }), "LICENSE");
});

test("local link targets decode once and discard URL fragments, not encoded filename characters", () => {
  const options = { encoded: true, explicit: true };
  assert.equal(localDownloadPath("reports/final%20draft.csv#L42", options), "reports/final draft.csv");
  assert.equal(localDownloadPath("report.md?view=1#part", options), "report.md");
  assert.equal(localDownloadPath("out/report(1).zip", options), "out/report(1).zip");
  assert.equal(localDownloadPath("out/a%23b%3Fc.txt", options), "out/a#b?c.txt");
  assert.equal(localDownloadPath("out/100%25.txt", options), "out/100%.txt");
});

test("download classification never captures external, unsafe, anchor or ambiguous URL targets", () => {
  for (const value of ["https://host/file.zip", "mailto:x@y.com", "//host/file.zip", "#part", "file:///etc/passwd", "javascript:evil", "%00bad.zip", "%2F%2Fevil/a.zip", "%5Cevil/file.zip", "%6Aavascript:evil", "bad%XX.txt", "~/file.zip"]) {
    assert.equal(localDownloadPath(value, { encoded: true, explicit: true }), null, value);
  }
});

test("download filenames cannot introduce directories or control characters", () => {
  assert.equal(downloadFilename('../../report final.csv'), 'report final.csv');
  assert.equal(downloadFilename('C:\\tmp\\report\n.txt'), 'report_.txt');
  for (const name of [null, '', '..', '/']) assert.equal(downloadFilename(name), 'download');
});

test("base64 becomes exact binary octet-stream, including empty files", async () => {
  const blob = downloadBlob({ data: 'AP+AQQ==', mimeType: 'application/octet-stream' });
  assert.equal(blob.type, 'application/octet-stream');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 255, 128, 65]);
  assert.equal(downloadBlob({ data: '', mimeType: 'application/octet-stream' }).size, 0);
  for (const data of ['!', 'AAA', 'A===', '====']) assert.throws(() => downloadBlob({ data, mimeType: 'application/octet-stream' }));
  assert.throws(() => downloadBlob({ data: '', mimeType: 'text/html' }));
});

test("16 MiB succeeds without regex stack overflow and oversized responses fail", () => {
  const data = Buffer.alloc(MAX_DOWNLOAD_BYTES).toString('base64');
  assert.equal(downloadBlob({ data, mimeType: 'application/octet-stream' }).size, MAX_DOWNLOAD_BYTES);
  assert.throws(() => downloadBlob({ data: Buffer.alloc(MAX_DOWNLOAD_BYTES + 1).toString('base64'), mimeType: 'application/octet-stream' }));
});

const response = { data: 'YQ==', filename: 'a.txt', mimeType: 'application/octet-stream', nativeSessionId: 'native' };
function options(overrides = {}) {
  return { sessionId: 'runtime/id', nativeSessionId: 'native', path: 'out/a file.txt', valid: () => true,
    request: async () => response, save: () => {}, ...overrides };
}
test("authenticated transport receives the session binding and JSON path only on invocation", async () => {
  let calls = 0, saved;
  const signal = new AbortController().signal;
  const result = await fetchDownload(options({ signal, request: async (url, opts) => {
    calls++;
    assert.equal(url, '/v1/sessions/runtime%2Fid/downloads');
    assert.deepEqual(opts, { body: { path: 'out/a file.txt' }, nativeSessionId: 'native', signal });
    return response;
  }, save: (blob, name) => { saved = [blob.size, name]; } }));
  assert.equal(result, true); assert.equal(calls, 1); assert.deepEqual(saved, [1, 'a.txt']);
});

test("switches before request or before save discard downloads", async () => {
  let valid = false, calls = 0, saves = 0;
  const opts = options({ valid: () => valid, request: async () => { calls++; valid = false; return response; }, save: () => saves++ });
  assert.equal(await fetchDownload(opts), false); assert.equal(calls, 0);
  valid = true;
  assert.equal(await fetchDownload(opts), false); assert.equal(calls, 1); assert.equal(saves, 0);
});

test("native conversation mismatches and API errors never save or retry", async () => {
  let saves = 0, calls = 0;
  await assert.rejects(fetchDownload(options({ request: async () => ({ ...response, nativeSessionId: 'other' }), save: () => saves++ })), /conversation changed/);
  await assert.rejects(fetchDownload(options({ request: async () => { calls++; throw new Error('outside workspace'); }, save: () => saves++ })), /outside workspace/);
  assert.equal(saves, 0); assert.equal(calls, 1);
});

test("Blob URL is clicked, removed, and revoked, including failed clicks", () => {
  for (const fail of [false, true]) {
    const events = [], link = { click() { events.push('click'); if (fail) throw new Error('blocked'); }, remove() { events.push('remove'); } };
    const env = { document: { createElement: () => link, body: { append: () => events.push('append') } },
      URL: { createObjectURL: () => 'blob:local', revokeObjectURL: (url) => events.push(url) }, defer: (fn) => fn() };
    const run = () => saveDownload(new Blob(['a']), '../a.txt', env);
    if (fail) assert.throws(run, /blocked/); else run();
    assert.equal(link.href, 'blob:local'); assert.equal(link.download, 'a.txt');
    assert.deepEqual(events, ['append', 'click', 'remove', 'blob:local']);
  }
});
