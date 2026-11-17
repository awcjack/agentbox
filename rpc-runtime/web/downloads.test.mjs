import test from "node:test";
import assert from "node:assert/strict";
import { extractDownloadPaths, downloadFilename, downloadBlob, saveDownload, fetchDownload, MAX_DOWNLOAD_BYTES } from "./downloads.mjs";

test("suggestions preserve filenames and spaces, deduplicate, and cap actions", () => {
  assert.deepEqual(extractDownloadPaths('Saved `reports/final draft.csv`, `"report two.pdf"`, `README.md` and `reports/final draft.csv`.'),
    ["reports/final draft.csv", "report two.pdf", "README.md"]);
  assert.equal(extractDownloadPaths(Array.from({ length: 20 }, (_, i) => `\`file${i}.zip\``).join(" ")).length, 6);
  assert.deepEqual(extractDownloadPaths("`a.zip`", 0), []);
});

test("local markdown links support encoded/angle spaces, balanced parentheses, titles and escapes", () => {
  assert.deepEqual(extractDownloadPaths('[CSV](reports/final%20draft.csv) [PDF](<reports/annual report.pdf> "title") [zip](out/report(1).zip) [escaped](out/my\\ file.txt) [quote](out/a.zip \'title\')'),
    ["reports/final draft.csv", "reports/annual report.pdf", "out/report(1).zip", "out/my file.txt", "out/a.zip"]);
});

test("ignore remote links, images, schemes, controls, prose and fenced code", () => {
  const text = '[remote](https://host/file.zip) ![image](/images/a.png) [anchor](#part) [bad](file:///etc/passwd) [bad](%00bad.zip) [bad](%2F%2Fevil/a.zip) `https://host/x.zip` `npm install`\n```sh\ncat /workspace/example.txt\n```';
  assert.deepEqual(extractDownloadPaths(text), []);
});

test("bare absolute paths trim prose punctuation but do not split code paths", () => {
  assert.deepEqual(extractDownloadPaths('See /workspace/result.csv, (/workspace/archive.zip). Also `/workspace/spaced name.txt`.'),
    ["/workspace/spaced name.txt", "/workspace/result.csv", "/workspace/archive.zip"]);
  assert.deepEqual(extractDownloadPaths('[unicode 📦](<out/my file.zip>) /workspace/other.txt'), ["out/my file.zip", "/workspace/other.txt"]);
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
