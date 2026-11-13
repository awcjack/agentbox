// Trusted broker transport. No registry or mailbox filesystem access.
import net from 'node:net';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MAX_FRAME = 256 * 1024;
const CROSS_MAIN_RELAY = 'Cross-main messages must use the main session send_message tool and its approval';
export class PostClient {
  constructor(socket, { timeout = 5000, maxPending = 64 } = {}) {
    this.socket = socket; this.timeout = timeout; this.maxPending = maxPending;
    this.pending = new Map(); this.next = 0; this.buffer = ''; this.closed = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      this.buffer += chunk;
      for (;;) {
        const i = this.buffer.indexOf('\n');
        if (i < 0) break;
        const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) return this.close();
        let value;
        try { value = JSON.parse(line); } catch { return this.close(); }
        if (!value || typeof value.id !== 'string' || value.id.length > 128 ||
            !('result' in value || typeof value.error === 'string')) return this.close();
        const item = this.pending.get(value.id);
        if (!item) continue; // A timed-out reply is harmless.
        this.pending.delete(value.id); clearTimeout(item.timer);
        if (typeof value.error === 'string') item.reject(new Error(value.error.slice(0, 2048)));
        else item.resolve(value.result);
      }
      if (Buffer.byteLength(this.buffer) > MAX_FRAME) this.close();
    });
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    socket.on('end', () => this.close());
  }
  request(method, params, peer) {
    if (this.closed) return Promise.reject(new Error('Messaging broker disconnected'));
    if (this.pending.size >= this.maxPending) return Promise.reject(new Error('Messaging broker busy'));
    if (this.next >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error('Messaging request IDs exhausted'));
    const id = String(++this.next);
    const frame = JSON.stringify({ id, method, ...(params === undefined ? {} : { params }), ...(peer === undefined ? {} : { peer }) }) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME) return Promise.reject(new Error('Messaging frame too large'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Messaging broker timeout')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(frame, error => { if (error) this.close(); });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.socket.destroy();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Messaging broker disconnected')); }
    this.pending.clear();
  }
}
export function connectBroker(env = process.env) {
  // A child must use its scoped relay, not a supervisor descriptor.
  if (env.PI_POST_BROKER_SOCKET) return new PostClient(net.createConnection(env.PI_POST_BROKER_SOCKET));
  if (env.PI_POST_BROKER_FD !== undefined) {
    const fd = Number(env.PI_POST_BROKER_FD);
    if (fd !== 5) throw new Error('Invalid messaging broker descriptor');
    return new PostClient(new net.Socket({ fd, readable: true, writable: true }));
  }
  throw new Error('Messaging broker unavailable');
}

// Each relay belongs to exactly one authenticated session. The only identity
// accepted from clients is a child registration; its capability comes from the
// upstream server, never from a client-supplied peer/from/root field.
export async function createPostRelay(request, { childConnect } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-post-'));
  await chmod(directory, 0o700);
  const path = join(directory, 'broker.sock');
  const clients = new Set();
  const allowed = new Set(['list', 'resolve', 'send', 'poll', 'inbox', 'ack', 'rename', 'offline', 'whoami']);
  const server = net.createServer(socket => {
    clients.add(socket); socket.setEncoding('utf8');
    let buffer = '', peer, registered = false, ended = false, count = 0, childClient;
    const scopedRequest = (method, params, token) => childClient ? childClient.request(method, params) : request(method, params, token);
    let chain = Promise.resolve();
    const offline = () => {
      clients.delete(socket); ended = true;
      if (peer) { const token = peer; peer = undefined; void scopedRequest('offline', {}, token).catch(() => {}).finally(() => childClient?.close()); }
      else childClient?.close();
    };
    socket.on('error', () => socket.destroy()); socket.on('close', offline);
    socket.on('data', chunk => {
      buffer += chunk;
      for (;;) {
        const i = buffer.indexOf('\n'); if (i < 0) break;
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (Buffer.byteLength(line) > MAX_FRAME || ++count > 64) { socket.destroy(); return; }
        chain = chain.then(async () => {
          let id;
          try {
            const frame = JSON.parse(line); id = frame.id;
            if (typeof id !== 'string' || !id || id.length > 128 || typeof frame.method !== 'string' || frame.peer !== undefined) throw new Error('Invalid relay request');
            const p = frame.params ?? {};
            let result;
            if (frame.method === 'register') {
              if (registered) throw new Error('Already registered');
              if (childConnect) childClient = childConnect();
              result = await scopedRequest('register', { child: true, sessionId: p.sessionId, name: p.name, sessionFile: p.sessionFile });
              if (typeof result?.peer !== 'string' || !result.peer) throw new Error('Invalid child registration');
              registered = true; peer = result.peer;
              if (ended) { await scopedRequest('offline', {}, peer); childClient?.close(); peer = undefined; return; }
            } else {
              if (!allowed.has(frame.method)) throw new Error('Unsupported relay method');
              // Do not forward identity metadata, including nested peer claims.
              const params = frame.method === 'send' ? { to: p.to, body: p.body, reply_to: p.reply_to }
                : frame.method === 'resolve' ? { to: p.to }
                : frame.method === 'ack' ? { id: p.id }
                : frame.method === 'rename' ? { name: p.name }
                : frame.method === 'list' ? { all: p.all } : {};
              if (!registered && ['offline', 'rename', 'ack', 'poll'].includes(frame.method)) throw new Error('CLI method not permitted');
              if (frame.method === 'send') {
                const scope = await scopedRequest('resolve', { to: params.to }, peer);
                if (scope.sameMain !== true) throw new Error(CROSS_MAIN_RELAY);
              }
              result = await scopedRequest(frame.method, params, peer);
            }
            const response = JSON.stringify({ id, result }) + '\n';
            if (Buffer.byteLength(response) > MAX_FRAME) throw new Error('Messaging response too large');
            if (!ended) socket.write(response);
          } catch (error) { if (!ended) socket.write(JSON.stringify({ id, error: error?.message === CROSS_MAIN_RELAY ? CROSS_MAIN_RELAY : 'Messaging relay request failed' }) + '\n'); }
          finally { count--; }
        });
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy();
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return { path, async close() { for (const socket of clients) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); } };
}
