// Supervisor-owned pi-post storage. No history contents or process IDs are consulted.
import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS = /^s-[0-9a-f]{12}$/;
const MESSAGE = /^\d{13}-[0-9a-f]{8}$/;
const MAX_FRAME = 256 * 1024;
const address = id => `s-${createHash('sha256').update(`session\0${id}`).digest('hex').slice(0, 12)}`;
const fail = message => { throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (dir, path) => { const p = relative(dir, path); return p === '' || (!p.startsWith('..') && !isAbsolute(p)); };
const nameOf = (name, fallback) => {
  if (name === undefined) name = fallback;
  if (typeof name !== 'string' || !name.trim() || Buffer.byteLength(name) > 200 || /[\x00-\x1f\x7f]/.test(name)) fail('invalid name');
  return name.trim();
};

export function createPostBroker({ root, profiles, now = Date.now }) {
  root = resolve(root);
  const channels = new Set(), owners = new Map(), rates = new Map();
  let closed = false;
  for (const p of [root, join(root, 'registry'), join(root, 'inbox')]) directory(p);
  function directory(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!lstatSync(path).isDirectory()) fail('unsafe storage directory');
  }
  // Only regular, bounded files under broker-owned directories are opened, never histories.
  function read(path, max = MAX_FRAME) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > max) fail('invalid metadata file');
      return JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  }
  function write(path, data) {
    const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(data)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, path);
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  function configuredDir(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) return null;
    const normalized = resolve(path);
    // Canonicalize configured (trusted) roots only. Walk metadata paths without
    // following symlinks, including intermediate components, before using them.
    for (const profile of profiles.values()) {
      if (typeof profile.sessionDir !== 'string') continue;
      const configured = resolve(profile.sessionDir);
      let trusted;
      try { trusted = realpathSync(configured); } catch { continue; }
      const boundary = inside(configured, normalized) ? configured : inside(trusted, normalized) ? trusted : null;
      if (!boundary) continue;
      try {
        let current = trusted;
        if (!lstatSync(current).isDirectory()) continue;
        for (const part of relative(boundary, normalized).split('/').filter(Boolean)) {
          current = join(current, part);
          if (!lstatSync(current).isDirectory()) return null;
        }
        return current;
      } catch { return null; }
    }
    return null;
  }
  function fileInfo(file, id, expectedDir) {
    if (typeof file !== 'string' || !isAbsolute(file)) return null;
    const path = resolve(file), dir = configuredDir(dirname(path));
    if (!dir || (expectedDir && dir !== expectedDir)) return null;
    // Native filenames are timestamp_UUID.jsonl; accepting UUID.jsonl is useful for older stores.
    const stem = basename(path, '.jsonl');
    if (!path.endsWith('.jsonl') || !(stem.toLowerCase() === id.toLowerCase() || stem.toLowerCase().endsWith(`_${id.toLowerCase()}`))) return null;
    return { path: join(dir, basename(path)), dir };
  }
  function markerClear(dir, id) {
    try { lstatSync(join(dir, `.archived-${id.toLowerCase()}`)); return false; }
    catch (e) { return e.code === 'ENOENT'; }
  }
  function recordPath(a) { if (!ADDRESS.test(a)) fail('invalid address'); return join(root, 'registry', `${a}.json`); }
  function load(a) { try { return read(recordPath(a)); } catch { return null; } }
  function valid(r, checkRoot = true) {
    if (!object(r) || r.v !== 1 || !UUID.test(r.sessionId) || r.address !== address(r.sessionId)
      || typeof r.cwd !== 'string' || !isAbsolute(r.cwd) || typeof r.name !== 'string' || !r.name || Buffer.byteLength(r.name) > 200
      || !Number.isFinite(r.lastSeen)) return false;
    let dir, rootId;
    if (r.brokerVersion === 1) {
      dir = configuredDir(r.archiveDir); rootId = r.rootSessionId;
      if (!dir || !UUID.test(rootId)) return false;
      if (r.sessionFile !== null && !fileInfo(r.sessionFile, r.sessionId, dir)) return false;
      if (rootId !== r.sessionId) {
        if (!checkRoot || r.sessionFile !== null) return false;
        const parent = load(address(rootId));
        if (!valid(parent, false) || parent.rootSessionId !== rootId || parent.archiveDir !== r.archiveDir || parent.cwd !== r.cwd) return false;
      }
    } else {
      const info = fileInfo(r.sessionFile, r.sessionId);
      if (!info) return false;
      dir = info.dir; rootId = r.sessionId;
    }
    return markerClear(dir, r.sessionId) && markerClear(dir, rootId);
  }
  function inbox(a) {
    if (!ADDRESS.test(a)) fail('invalid address');
    const path = join(root, 'inbox', a);
    directory(path); return path;
  }
  function files(a) { return readdirSync(inbox(a)).filter(n => MESSAGE.test(n.slice(0, -5)) && n.endsWith('.json')).sort(); }
  function live(r) {
    const rootId = r.rootSessionId || r.sessionId;
    const owner = owners.get(rootId);
    if (!owner || owner.dead) return false;
    try {
      const current = owner.getIdentity();
      if (!current?.live || current.sessionId !== rootId || current.rootSessionId !== rootId) return false;
    } catch { return false; }
    return [...owner.peers.values()].some(p => p.record.address === r.address && p.online);
  }
  function metadata(r) { return { address: r.address, sessionId: r.sessionId, rootSessionId: r.rootSessionId || r.sessionId, name: r.name, cwd: r.cwd, live: live(r), lastSeen: r.lastSeen, queued: files(r.address).length }; }
  function records() {
    return readdirSync(join(root, 'registry')).filter(n => /^s-[0-9a-f]{12}\.json$/.test(n))
      .map(n => load(n.slice(0, -5))).filter(r => valid(r));
  }
  function persist(r) { write(recordPath(r.address), r); }
  function retire(c) {
    const peers = [...c.peers.values()];
    const owned = c.rootId && owners.get(c.rootId) === c;
    // Revoke credentials even if storage is unavailable during shutdown.
    if (owned) owners.delete(c.rootId);
    c.peers.clear(); c.rootId = null; c.main = null;
    for (const p of peers) {
      p.online = false;
      // An old channel must never overwrite its replacement's presence/name.
      if (owned) {
        const r = load(p.record.address);
        try { if (r) persist({ ...r, live: false, lastSeen: now() }); }
        catch { /* In-memory leases are still revoked; persisted live flags are never trusted. */ }
      }
    }
  }
  function identity(c) {
    const i = c.getIdentity();
    if (!object(i) || !UUID.test(i.sessionId) || i.rootSessionId !== i.sessionId || !i.live || typeof i.cwd !== 'string') fail('supervisor identity unavailable');
    const dir = configuredDir(i.sessionDir);
    if (!dir || !markerClear(dir, i.sessionId)) fail('session archived or unavailable');
    return { ...i, cwd: canonical(i.cwd), archiveDir: dir };
  }
  function targets(to, sender) {
    const inputs = Array.isArray(to) ? to : [to];
    if (!inputs.length || inputs.length > 8 || inputs.some(t => typeof t !== 'string' || !t.trim() || t.length > 4096)) fail('invalid targets (maximum 8)');
    const all = records(), found = new Map();
    for (let t of inputs) {
      t = t.trim();
      let matches;
      if (ADDRESS.test(t)) matches = all.filter(r => r.address === t);
      else if (t.includes('/') || t === '.' || t === '..') {
        // Lexical path matching only: client input never causes filesystem access.
        const path = resolve(sender.cwd, t);
        matches = all.filter(r => r.cwd === path);
      } else {
        matches = /^[0-9a-f]{8}[0-9a-f-]{0,28}$/i.test(t) ? all.filter(r => r.sessionId.toLowerCase().startsWith(t.toLowerCase())) : [];
        if (!matches.length) matches = all.filter(r => r.name === t);
        if (!matches.length) matches = all.filter(r => basename(r.cwd) === t);
      }
      if (matches.length !== 1) fail(matches.length ? 'ambiguous target' : 'unknown or archived target');
      found.set(matches[0].address, matches[0]);
    }
    return [...found.values()];
  }
  function dispatch(c, req) {
    if (!object(req) || typeof req.id !== 'string' || !req.id || req.id.length > 128 || typeof req.method !== 'string') fail('invalid request');
    const p = req.params ?? {};
    if (!object(p)) fail('invalid params');
    for (const key of ['from', 'root', 'rootSessionId', 'cwd', 'archiveDir', 'sender']) if (key in p) fail('untrusted identity field');
    let i;
    try { i = identity(c); }
    catch (e) { retire(c); throw e; }
    if (c.rootId && c.rootId !== i.sessionId) retire(c);
    if (req.method === 'register') {
      if (req.peer && req.peer !== 'main' && c.peers.get(req.peer)?.record.sessionId !== i.sessionId) fail('invalid main peer');
      const child = p.child === true;
      const id = child ? p.sessionId : i.sessionId;
      if (!UUID.test(id) || (child && id === i.sessionId) || (!child && p.sessionId !== undefined && p.sessionId !== id)) fail('invalid session identity');
      const old = load(address(id));
      if (child && (owners.has(id) || (old && (old.rootSessionId || old.sessionId) !== i.sessionId))) fail('session identity collision');
      if (child && [...c.peers.values()].some(peer => peer.online && peer.record.sessionId === id)) fail('child identity already connected');
      if (child && c.peers.size >= 128) fail('session peer limit');
      if (!child && old?.rootSessionId && old.rootSessionId !== id) fail('session identity collision');
      let sessionFile = null;
      if (!child && p.sessionFile !== undefined && p.sessionFile !== null) {
        const info = fileInfo(p.sessionFile, id, i.archiveDir);
        if (!info) fail('invalid session file');
        sessionFile = info.path;
      } else if (!child && old?.sessionFile && fileInfo(old.sessionFile, id, i.archiveDir)) sessionFile = old.sessionFile;
      if (child && (!c.rootId || owners.get(i.sessionId) !== c)) fail('register main first');
      if (!markerClear(i.archiveDir, id)) fail('session archived');
      if (!child) {
        const prior = owners.get(id);
        if (prior && prior !== c) retire(prior);
        c.rootId = id; owners.set(id, c);
      }
      const a = address(id);
      const r = { v: 1, brokerVersion: 1, address: a, sessionId: id, rootSessionId: i.sessionId, name: nameOf(p.name, (valid(old) ? old.name : undefined) || i.name || `${basename(i.cwd)}-${a.slice(2, 6)}`), cwd: i.cwd, archiveDir: i.archiveDir, sessionFile, startedAt: old?.startedAt || now(), lastSeen: now(), live: true };
      persist(r);
      // Re-registration rotates credentials for this identity.
      for (const [token, peer] of c.peers) if (peer.record.sessionId === id) c.peers.delete(token);
      const token = randomBytes(24).toString('hex');
      c.peers.set(token, { record: r, online: true });
      if (!child) c.main = token;
      return { ...metadata(r), peer: token };
    }
    const token = !req.peer || req.peer === 'main' ? c.main : req.peer;
    const peer = c.peers.get(token);
    if (!peer || !peer.online || owners.get(i.sessionId) !== c) fail('stale or invalid peer');
    let r = load(peer.record.address);
    if (!valid(r) || r.rootSessionId !== i.sessionId) fail('session archived or unavailable');
    if (now() - r.lastSeen >= 30000) {
      r = { ...r, lastSeen: now() }; persist(r); peer.record = r;
    }
    if (req.method === 'list') {
      const sessions = []; let bytes = 0, truncated = false;
      for (const item of records().filter(s => p.all === true || live(s) || now() - s.lastSeen <= 86400000 || files(s.address).length > 0)) {
        const entry = metadata(item), size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (bytes + size > MAX_FRAME - 8192) { truncated = true; break; }
        sessions.push(entry); bytes += size;
      }
      return { selfAddress: r.address, sessions, truncated };
    }
    if (req.method === 'resolve') {
      const resolved = targets(p.to, r);
      return { sameMain: resolved.every(t => (t.rootSessionId || t.sessionId) === r.rootSessionId), targets: resolved.map(metadata) };
    }
    if (req.method === 'send') {
      if (typeof p.body !== 'string' || Buffer.byteLength(p.body) > 32768) fail('body exceeds 32KiB');
      const resolved = targets(p.to, r);
      let replyTo = r.address;
      if (p.reply_to === 'none') replyTo = undefined;
      else if (p.reply_to !== undefined) {
        if (typeof p.reply_to !== 'string') fail('invalid reply target');
        replyTo = targets(p.reply_to, r)[0].address;
      }
      // Descendants share one sandbox principal; registering fresh child IDs
      // must not manufacture a fresh cross-session spam budget.
      const history = (rates.get(r.rootSessionId) || []).filter(e => now() - e.at < 60000);
      if (history.length + resolved.length > 8 || resolved.some(t => history.filter(e => e.to === t.address).length >= 4)) fail('message rate limit');
      if (resolved.some(t => files(t.address).length >= 50)) fail('mailbox backlog limit');
      const at = now();
      for (const t of resolved) {
        if (!valid(t)) fail('target archived');
        const id = `${String(at).padStart(13, '0')}-${randomBytes(4).toString('hex')}`;
        const message = { v: 1, id, from: { kind: 'session', address: r.address, name: r.name, cwd: r.cwd }, body: p.body, sentAt: at, ...(replyTo ? { replyTo } : {}) };
        write(join(inbox(t.address), `${id}.json`), message);
        history.push({ at, to: t.address });
      }
      rates.set(r.rootSessionId, history);
      return { receipts: resolved.map(t => ({ address: t.address, status: 'queued' })) };
    }
    if (req.method === 'poll' || req.method === 'inbox') {
      const messages = []; let bytes = 0;
      for (const file of files(r.address).slice(0, 50)) {
        try {
          const m = read(join(inbox(r.address), file));
          if (m.v !== 1 || m.id !== file.slice(0, -5) || !object(m.from) || typeof m.from.name !== 'string' || Buffer.byteLength(m.from.name) > 200
            || (m.from.address !== undefined && !ADDRESS.test(m.from.address)) || (m.from.cwd !== undefined && (typeof m.from.cwd !== 'string' || m.from.cwd.length > 4096))
            || (m.replyTo !== undefined && !ADDRESS.test(m.replyTo)) || !Number.isFinite(m.sentAt) || typeof m.body !== 'string' || Buffer.byteLength(m.body) > 32768) continue;
          const entry = { id: m.id, from: { address: m.from.address, name: m.from.name, cwd: m.from.cwd }, body: m.body, ...(typeof m.replyTo === 'string' ? { replyTo: m.replyTo } : {}), at: m.sentAt };
          const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
          if (bytes + size > MAX_FRAME - 8192) break;
          messages.push(entry); bytes += size;
        } catch { /* Malformed/unreadable queue entries carry no authority. */ }
      }
      return { messages };
    }
    if (req.method === 'ack') {
      if (typeof p.id !== 'string' || !MESSAGE.test(p.id)) fail('invalid message ID');
      try { unlinkSync(join(inbox(r.address), `${p.id}.json`)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return { ok: true };
    }
    if (req.method === 'rename') { r.name = nameOf(p.name); persist(r); peer.record = r; return metadata(r); }
    if (req.method === 'offline') {
      if (r.sessionId === i.sessionId) retire(c);
      else { peer.online = false; c.peers.delete(token); persist({ ...r, live: false }); }
      return { ok: true };
    }
    fail('unknown method');
  }
  function attach(stream, getIdentity) {
    if (closed) fail('broker closed');
    const c = { stream, getIdentity, peers: new Map(), dead: false, rootId: null, main: null };
    channels.add(c);
    let buffer = Buffer.alloc(0), timer;
    const cleanup = () => {
      if (c.dead) return;
      c.dead = true; clearTimeout(timer); retire(c); channels.delete(c);
    };
    c.cleanup = cleanup;
    const stop = () => { cleanup(); stream.destroy(); };
    stream.on('close', cleanup); stream.on('end', cleanup); stream.on('error', cleanup);
    stream.on('data', chunk => {
      if (c.dead || closed) return;
      clearTimeout(timer);
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      // Synchronous dispatch serializes all attached channels, including rate/backlog checks.
      let count = 0, index;
      while ((index = buffer.indexOf(10)) !== -1) {
        if (index > MAX_FRAME || ++count > 128 || stream.writableLength > 4 * 1024 * 1024) return stop();
        const line = buffer.subarray(0, index).toString('utf8'); buffer = buffer.subarray(index + 1);
        let req, response;
        try { req = JSON.parse(line); response = { id: req?.id ?? null, result: dispatch(c, req) }; }
        catch (e) { response = { id: typeof req?.id === 'string' && req.id.length <= 128 ? req.id : null, error: e instanceof SyntaxError ? 'malformed JSON' : e.message }; }
        stream.write(`${JSON.stringify(response)}\n`);
      }
      if (buffer.length > MAX_FRAME) return stop();
      if (buffer.length) { timer = setTimeout(stop, 10000); timer.unref?.(); }
    });
    return () => { cleanup(); stream.destroy(); };
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const c of [...channels]) { c.cleanup(); c.stream.destroy(); }
  }
  return { attach, close };
}
