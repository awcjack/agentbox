import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Duplex } from 'node:stream';
import { createPostBroker } from '../post-broker.mjs';
import { PostClient, createPostRelay, connectBroker, MAX_FRAME } from '../post-client.mjs';
import { main } from '../post-cli.mjs';

export async function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'post-client-test-'));
  const dir = join(base, 'sessions'); mkdirSync(dir);
  const broker = createPostBroker({ root: join(base, 'trusted'), profiles: new Map([['test', { sessionDir: dir }]]) });
  const identities = [];
  const server = net.createServer(socket => {
    const id = randomUUID(); const identity = { sessionId: id, rootSessionId: id, cwd: base, sessionDir: dir, live: true };
    identities.push(identity); broker.attach(socket, () => identity);
  });
  const socket = join(base, 'upstream.sock');
  await new Promise(resolve => server.listen(socket, resolve));
  return { base, dir, identities, broker, socket, async close() { broker.close(); await new Promise(resolve => server.close(resolve)); rmSync(base, { recursive: true, force: true }); } };
}
test('real broker: scoped relay, CLI, child and descendant identities, archive and outage', async () => {
  const f = await fixture(); const parent = connectBroker({ PI_POST_BROKER_SOCKET: f.socket });
  let relay, childRelay, child, other;
  try {
    const self = await parent.request('register', { name: 'parent' });
    relay = await createPostRelay((...args) => parent.request(...args));
    assert.equal(statSync(relay.path).mode & 0o777, 0o600);
    const env = { PI_POST_BROKER_SOCKET: relay.path, PI_POST_DIR: join(f.base, 'must-not-exist') };
    assert.equal(await main(['whoami'], env), self.address);
    assert.match(await main(['list'], env), /parent/);
    await assert.rejects(main(['send', '--from', 'spoof'], env), /--from/);
    await assert.rejects(main(['list'], {}), /unavailable/);
    other = connectBroker({ PI_POST_BROKER_SOCKET: f.socket });
    await other.request('register', { name: 'unrelated-main' });
    await assert.rejects(main(['send', '--to', 'unrelated-main', '--body', 'must require tool approval'], env), /approval/);
    assert.equal((await other.request('poll')).messages.length, 0);
    child = connectBroker(env);
    const c = await child.request('register', { sessionId: randomUUID(), name: 'child', rootSessionId: 'spoof' });
    assert.equal(c.rootSessionId, self.sessionId);
    const impersonator = connectBroker(env);
    await assert.rejects(impersonator.request('register', { sessionId: c.sessionId, name: 'spoof' }));
    impersonator.close();
    await assert.rejects(child.request('send', { to: 'unrelated-main', body: 'cannot bypass approval as child' }), /approval/);
    assert.equal((await child.request('resolve', { to: 'parent' })).sameMain, true);
    await assert.rejects(child.request('poll', {}, self.peer));
    childRelay = await createPostRelay((...args) => child.request(...args), { childConnect: () => connectBroker(env) });
    const childEnv = { PI_POST_BROKER_SOCKET: childRelay.path };
    assert.equal(await main(['whoami'], childEnv), c.address);
    await main(['send', '--to', 'parent', '--body', 'child report'], childEnv);
    const inbox = await parent.request('poll');
    assert.equal(inbox.messages[0].from.address, c.address);
    await parent.request('ack', { id: inbox.messages[0].id });
    const descendant = connectBroker(childEnv);
    const d = await descendant.request('register', { sessionId: randomUUID(), name: 'descendant' });
    assert.equal(d.rootSessionId, self.sessionId);
    descendant.close();
    await main(['send', '--to', 'child', '--body', 'queued'], env);
    writeFileSync(join(f.dir, `.archived-${c.sessionId}`), '');
    await assert.rejects(child.request('poll'));
    await assert.rejects(main(['send', '--to', 'child', '--body', 'must not wake'], env));
    assert.equal(existsSync(env.PI_POST_DIR), false);
    f.broker.close();
    await assert.rejects(main(['list'], env));
  } finally { other?.close(); child?.close(); if (childRelay) await childRelay.close(); if (relay) await relay.close(); parent.close(); await f.close(); }
});

test('transport split frames, pending cap, timeout, oversize and close', async () => {
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } });
  const client = new PostClient(stream, { timeout: 30, maxPending: 1 });
  const first = client.request('list');
  await assert.rejects(client.request('list'), /busy/);
  stream.push('{"id":"1","res'); stream.push('ult":{"ok":true}}\n');
  assert.deepEqual(await first, { ok: true });
  await assert.rejects(client.request('list'), /timeout/);
  await assert.rejects(client.request('send', { body: 'x'.repeat(MAX_FRAME) }), /large/);
  const pending = client.request('list'); stream.destroy();
  await assert.rejects(pending, /disconnected/);
});
