import test from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostBroker } from '../post-broker.mjs';

class Channel extends Duplex {
  output = '';
  _read() {}
  _write(chunk, encoding, callback) { this.output += chunk.toString(); callback(); }
  request(method, params = {}, peer) {
    this.output = '';
    this.push(`${JSON.stringify({ id: 'request', method, params, ...(peer ? { peer } : {}) })}\n`);
    // Readable events can be deferred until the next tick.
    return new Promise(resolve => setImmediate(() => resolve(JSON.parse(this.output))));
  }
  async call(...args) {
    const response = await this.request(...args);
    if (response.error) throw new Error(response.error);
    return response.result;
  }
}
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'post-broker-test-'));
  const root = join(base, 'post'), dir = join(base, 'sessions'); mkdirSync(dir);
  let time = 1700000000000;
  const profiles = new Map([['test', { cwd: base, sessionDir: dir }]]);
  let broker = createPostBroker({ root, profiles, now: () => time });
  t.after(() => { broker.close(); rmSync(base, { recursive: true, force: true }); });
  return {
    base, root, dir, profiles, get broker() { return broker; }, advance(ms) { time += ms; },
    restart() { broker.close(); broker = createPostBroker({ root, profiles, now: () => time }); },
    channel(overrides = {}) {
      const id = randomUUID();
      const identity = { sessionId: id, rootSessionId: id, cwd: base, sessionDir: dir, live: true, pid: 123, ...overrides };
      const channel = new Channel(); broker.attach(channel, () => identity);
      return { channel, identity };
    },
  };
}
const addr = id => `s-${createHash('sha256').update(`session\0${id}`).digest('hex').slice(0, 12)}`;
async function registered(f, name) {
  const { channel, identity } = f.channel();
  const self = await channel.call('register', { name });
  return { channel, identity, self };
}

test('distinct supervisor roots sharing a fake PID remain live; durable offline queue and reconnect', async t => {
  const f = fixture(t);
  const a = await registered(f, 'alpha'), b = await registered(f, 'beta');
  assert.equal(a.self.address, addr(a.identity.sessionId));
  let list = await a.channel.call('list');
  assert.equal(list.sessions.filter(s => s.live).length, 2);
  b.channel.destroy(); await new Promise(resolve => setImmediate(resolve));
  list = await a.channel.call('list');
  assert.equal(list.sessions.find(s => s.address === b.self.address).live, false);
  assert.deepEqual((await a.channel.call('send', { to: 'beta', body: 'durable hello' })).receipts, [{ address: b.self.address, status: 'queued' }]);
  assert.equal((await a.channel.call('poll')).messages.length, 0);
  f.restart();
  const resumed = f.channel({ ...b.identity });
  await resumed.channel.call('register');
  let messages = (await resumed.channel.call('inbox')).messages;
  assert.equal(messages[0].body, 'durable hello');
  assert.deepEqual(messages[0].from, { address: a.self.address, name: 'alpha', cwd: f.base });
  assert.equal(messages[0].replyTo, a.self.address);
  assert.equal((await resumed.channel.call('poll')).messages.length, 1);
  await resumed.channel.call('ack', { id: messages[0].id });
  assert.equal((await resumed.channel.call('poll')).messages.length, 0);
});

test('children authenticate independently, share sameMain, and root archive blocks poll and ack', async t => {
  const f = fixture(t), a = await registered(f, 'parent'), b = await registered(f, 'other');
  const id = randomUUID();
  const child = await a.channel.call('register', { child: true, sessionId: id, name: 'child' });
  assert.equal(child.rootSessionId, a.identity.sessionId);
  assert.equal((await a.channel.call('resolve', { to: 'child' })).sameMain, true);
  assert.equal((await a.channel.call('resolve', { to: ['child', 'other'] })).sameMain, false);
  await b.channel.call('send', { to: 'child', body: 'for child' });
  assert.equal((await a.channel.call('poll')).messages.length, 0);
  const message = (await a.channel.call('poll', {}, child.peer)).messages[0];
  writeFileSync(join(f.dir, `.archived-${a.identity.sessionId}`), '');
  assert.match((await a.channel.request('ack', { id: message.id }, child.peer)).error, /archived/);
  assert.match((await a.channel.request('poll', {}, child.peer)).error, /archived/);
  assert.equal((await b.channel.call('list', { all: true })).sessions.length, 1);
  assert.match((await b.channel.request('send', { to: child.address, body: 'blocked' })).error, /archived/);
  assert.equal(readdirSync(join(f.root, 'inbox', child.address)).length, 1);
});

test('archive marker introduced between poll and ack preserves message; symlink markers exclude', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  await a.channel.call('send', { to: 'b', body: 'pending' });
  const m = (await b.channel.call('poll')).messages[0];
  symlinkSync(join(f.base, 'missing'), join(f.dir, `.archived-${b.identity.sessionId}`));
  assert.match((await b.channel.request('ack', { id: m.id })).error, /archived/);
  assert.equal((await a.channel.call('list', { all: true })).sessions.length, 1);
});

test('forged identities, child collisions, cross-channel peer and stale tokens rejected', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  assert.match((await a.channel.request('register', { sessionId: b.identity.sessionId })).error, /identity/);
  assert.match((await a.channel.request('register', { child: true, sessionId: b.identity.sessionId })).error, /collision/);
  assert.match((await a.channel.request('send', { to: 'b', body: 'x', from: b.self })).error, /identity/);
  assert.match((await a.channel.request('send', { to: 'b', body: 'x', rootSessionId: b.identity.sessionId })).error, /identity/);
  assert.match((await a.channel.request('poll', {}, b.self.peer)).error, /peer/);
  const child = await a.channel.call('register', { child: true, sessionId: randomUUID() });
  const replacement = f.channel({ ...a.identity });
  await replacement.channel.call('register');
  assert.match((await a.channel.request('poll', {}, child.peer)).error, /peer/);
  const nextId = randomUUID();
  replacement.identity.sessionId = nextId; replacement.identity.rootSessionId = nextId;
  const next = await replacement.channel.call('register');
  assert.notEqual(next.peer, a.self.peer);
  assert.match((await replacement.channel.request('poll', {}, a.self.peer)).error, /peer/);
});

test('main offline/stream close retires children, independent of PID; stale peer cannot revive', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  const child = await a.channel.call('register', { child: true, sessionId: randomUUID() });
  await a.channel.call('offline');
  assert.match((await a.channel.request('poll', {}, child.peer)).error, /peer/);
  const list = await b.channel.call('list');
  assert.equal(list.sessions.filter(s => !s.live).length, 2);
  const persisted = JSON.parse(readFileSync(join(f.root, 'registry', `${child.address}.json`)));
  assert.equal(persisted.live, false); assert.equal(persisted.pid, undefined);
});

test('resolves all before deposit, deduplicates, refuses ambiguity and hides old offline records', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  assert.match((await a.channel.request('send', { to: ['b', 'unknown'], body: 'no partial' })).error, /unknown/);
  assert.equal((await b.channel.call('poll')).messages.length, 0);
  assert.equal((await a.channel.call('send', { to: ['b', b.self.address, b.identity.sessionId.slice(0, 8)], body: 'once', reply_to: 'none' })).receipts.length, 1);
  assert.equal((await b.channel.call('poll')).messages[0].replyTo, undefined);
  assert.match((await a.channel.request('resolve', { to: f.base })).error, /ambiguous/);
  assert.match((await a.channel.request('resolve', { to: Array(9).fill('b') })).error, /maximum 8/);
  await b.channel.call('offline'); f.advance(86400001);
  assert.equal((await a.channel.call('list')).sessions.length, 2, 'queued offline mail stays discoverable');
  await b.channel.call('register', { name: 'b' });
  await b.channel.call('ack', { id: (await b.channel.call('poll')).messages[0].id });
  await b.channel.call('offline'); f.advance(86400001);
  assert.equal((await a.channel.call('list')).sessions.length, 1);
  assert.equal((await a.channel.call('list', { all: true })).sessions.length, 2);
  assert.equal((await a.channel.call('resolve', { to: 'b' })).targets.length, 1);
});

test('children cannot take over active siblings or reset the root message budget', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  const id = randomUUID(), child = await a.channel.call('register', { child: true, sessionId: id, name: 'child' });
  await assert.rejects(a.channel.call('register', { child: true, sessionId: id }), /already connected/);
  for (let i = 0; i < 4; i++) await a.channel.call('send', { to: 'b', body: 'shared quota' });
  await assert.rejects(a.channel.call('send', { to: 'b', body: 'fresh identity is not fresh authority' }, child.peer), /rate/);
  assert.equal((await a.channel.call('list', {}, child.peer)).selfAddress, child.address);
});

test('poll responses stay bounded even with a backlog of maximally escaped bodies', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  for (let i = 0; i < 4; i++) await a.channel.call('send', { to: 'b', body: String.fromCharCode(0).repeat(32768) });
  const first = await b.channel.call('poll');
  assert.equal(first.messages.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 256 * 1024);
  await b.channel.call('ack', { id: first.messages[0].id });
  assert.equal((await b.channel.call('poll')).messages.length, 1);
});

test('byte limit, per-target and total rate limit, atomic backlog preflight', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b'), c = await registered(f, 'c');
  assert.match((await a.channel.request('send', { to: 'b', body: 'é'.repeat(16385) })).error, /32KiB/);
  await a.channel.call('send', { to: 'b', body: 'é'.repeat(16384) });
  for (let i = 0; i < 3; i++) await a.channel.call('send', { to: 'b', body: 'x' });
  assert.match((await a.channel.request('send', { to: 'b', body: 'x' })).error, /rate/);
  for (let i = 0; i < 4; i++) await a.channel.call('send', { to: 'c', body: 'x' });
  assert.match((await a.channel.request('send', { to: 'a', body: 'x' })).error, /rate/);
  f.advance(60001);
  for (let i = 4; i < 50; i++) {
    await a.channel.call('send', { to: 'b', body: 'fill' });
    f.advance(60001);
  }
  assert.equal((await b.channel.call('poll')).messages.length, 50);
  assert.match((await a.channel.request('send', { to: ['c', 'b'], body: 'full' })).error, /backlog/);
  assert.equal((await c.channel.call('poll')).messages.length, 4);
});

test('legacy records require safe session metadata; history contents are never read', async t => {
  const f = fixture(t), a = await registered(f, 'a');
  const id = randomUUID(), good = addr(id);
  const file = join(f.dir, `2026-01-01T00-00-00_${id}.jsonl`);
  // Even an unreadable/nonexistent history is irrelevant; only metadata and archive markers matter.
  const legacy = { v: 1, address: good, sessionId: id, name: 'legacy', cwd: f.base, startedAt: 1, lastSeen: 1700000000000, pid: process.pid, sessionFile: file };
  writeFileSync(join(f.root, 'registry', `${good}.json`), JSON.stringify(legacy));
  let list = (await a.channel.call('list')).sessions;
  assert.equal(list.find(s => s.address === good).live, false);
  await a.channel.call('send', { to: 'legacy', body: 'offline legacy' });
  for (const unsafe of [undefined, join(f.base, `${id}.jsonl`), join(f.dir, `${randomUUID()}.jsonl`)]) {
    writeFileSync(join(f.root, 'registry', `${good}.json`), JSON.stringify({ ...legacy, sessionFile: unsafe }));
    assert.equal((await a.channel.call('list', { all: true })).sessions.length, 1);
  }
  assert.match((await a.channel.request('register', { sessionFile: join(f.base, `${a.identity.sessionId}.jsonl`) })).error, /session file/);
  const outside = join(f.base, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(f.dir, 'escape'));
  writeFileSync(join(f.root, 'registry', `${good}.json`), JSON.stringify({ ...legacy, sessionFile: join(f.dir, 'escape', `${id}.jsonl`) }));
  assert.equal((await a.channel.call('list', { all: true })).sessions.length, 1);
});

test('malformed frames fail safely and oversized/too many frames close the channel', async t => {
  const f = fixture(t), a = await registered(f, 'a');
  a.channel.output = ''; a.channel.push('{bad json}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(a.channel.output).error, 'malformed JSON');
  assert.match((await a.channel.request('not-a-method')).error, /unknown method/);
  a.channel.push('x'.repeat(256 * 1024 + 1));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.channel.destroyed, true);
  const b = f.channel(); b.channel.push(('{}\n').repeat(129));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.channel.destroyed, true);
});

test('ack is caller-local; names bounded; broker close persists offline leases and keeps queues', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  await a.channel.call('send', { to: 'b', body: 'keep' });
  const m = (await b.channel.call('poll')).messages[0];
  await a.channel.call('ack', { id: m.id });
  assert.equal((await b.channel.call('poll')).messages.length, 1);
  assert.match((await b.channel.request('ack', { id: '../../secret' })).error, /message ID/);
  assert.match((await b.channel.request('rename', { name: 'x'.repeat(201) })).error, /name/);
  assert.equal((await b.channel.call('rename', { name: 'renamed' })).name, 'renamed');
  f.broker.close();
  assert.equal(JSON.parse(readFileSync(join(f.root, 'registry', `${b.self.address}.json`))).live, false);
  assert.equal(readdirSync(join(f.root, 'inbox', b.self.address)).length, 1);
  assert.throws(() => f.broker.attach(new Channel(), () => b.identity), /closed/);
});

test('partial frames time out and revoke all stream leases', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  const child = await a.channel.call('register', { child: true, sessionId: randomUUID(), name: 'child' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  a.channel.push('{');
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(10001);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.channel.destroyed, true);
  const list = await b.channel.call('list');
  assert.equal(list.sessions.find(s => s.address === child.address).live, false);
});

test('unknown/unreadable registry metadata fails closed, and callback shutdown revokes tokens', async t => {
  const f = fixture(t), a = await registered(f, 'a'), b = await registered(f, 'b');
  const path = join(f.root, 'registry', `${b.self.address}.json`);
  const good = JSON.parse(readFileSync(path));
  for (const bad of [{ ...good, archiveDir: null }, { ...good, rootSessionId: randomUUID() }, { ...good, sessionFile: '/outside/secret' }]) {
    writeFileSync(path, JSON.stringify(bad));
    assert.equal((await a.channel.call('list', { all: true })).sessions.length, 1);
    assert.match((await b.channel.request('poll')).error, /unavailable/);
  }
  writeFileSync(path, '{broken');
  assert.equal((await a.channel.call('list', { all: true })).sessions.length, 1);
  writeFileSync(path, JSON.stringify(good));
  b.identity.live = false;
  assert.equal((await a.channel.call('list')).sessions.find(s => s.address === b.self.address).live, false);
  assert.match((await b.channel.request('poll')).error, /unavailable/);
  b.identity.live = true;
  assert.match((await b.channel.request('poll', {}, b.self.peer)).error, /peer/);
});
