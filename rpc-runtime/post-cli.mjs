import { connectBroker } from './post-client.mjs';

export async function main(args = process.argv.slice(2), env = process.env) {
  // Never accept a supervisor fd in a shell CLI. Only its private relay is a
  // CLI authentication endpoint, and --from cannot override that identity.
  if (!env.PI_POST_BROKER_SOCKET) throw new Error('Messaging broker relay unavailable');
  const [command, ...rest] = args;
  const options = { to: [] }; const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--from' || arg.startsWith('--from=')) throw new Error('--from is not allowed in broker mode');
    if (arg === '--all') options.all = true;
    else if (['--to', '--body', '--reply-to'].includes(arg)) {
      if (rest[i + 1] === undefined) throw new Error('Missing option value');
      const value = rest[++i];
      if (arg === '--to') options.to.push(value);
      else options[arg === '--body' ? 'body' : 'reply_to'] = value;
    } else if (arg.startsWith('--')) throw new Error('Unknown broker CLI option');
    else positional.push(arg);
  }
  const client = connectBroker({ PI_POST_BROKER_SOCKET: env.PI_POST_BROKER_SOCKET });
  try {
    let data;
    if (command === 'send') {
      if (!options.to.length) throw new Error('send requires --to');
      if (options.body === undefined) {
        const chunks = []; let size = 0;
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 32768) throw new Error('Body too large'); chunks.push(chunk); }
        options.body = Buffer.concat(chunks).toString('utf8');
      }
      data = await client.request('send', { to: options.to, body: options.body, reply_to: options.reply_to });
      return data.receipts.map(r => `${r.status} ${r.address}`).join('\n');
    }
    if (command === 'list') return JSON.stringify(await client.request('list', { all: options.all }), null, 2);
    if (command === 'resolve') return JSON.stringify(await client.request('resolve', { to: positional }), null, 2);
    if (command === 'peek') {
      if (positional.length) throw new Error('Broker peek is limited to the authenticated session');
      return JSON.stringify(await client.request('inbox'), null, 2);
    }
    if (command === 'whoami') return (await client.request('list')).selfAddress;
    throw new Error('Expected list, resolve, send, peek, or whoami');
  } finally { client.close(); }
}
