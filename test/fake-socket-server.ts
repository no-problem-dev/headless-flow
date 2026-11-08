// A tiny socket server speaking protocol 1, standing in for a DEBUG app that was launched with `-HeadlessPort`.
// One `counter` store shared by every connection. Each connection gets the ready line first.
import { createServer, type Server, type Socket } from 'node:net';

export interface FakeServer {
  port: number;
  /** Every request line received, across connections. */
  received: unknown[];
  /** Connections currently open. */
  open(): number;
  /** Drop every connection without answering. */
  dropAll(): void;
  close(): Promise<void>;
}

export interface FakeServerOptions {
  /** What to send on connect instead of the ready line (null: send nothing). */
  greeting?: string | null;
}

export async function startFakeServer({ greeting = '{"ready":true,"protocol":1}' }: FakeServerOptions = {}): Promise<FakeServer> {
  const counter = { value: 0 };
  const received: unknown[] = [];
  const sockets = new Set<Socket>();

  const answer = async (request: any): Promise<object> => {
    const { id } = request;
    const state = { name: 'counter', state: { ...counter } };
    switch (request.cmd) {
      case 'ls':
        return { id, ok: true, result: { protocol: 1, stores: [{ ...state, operations: [{ name: 'inc', input: { type: 'object' } }, { name: 'slowInc', input: { type: 'object' } }] }] } };
      case 'get':
        if (request.store !== 'counter') return { id, ok: false, error: { code: 'unknown_store', message: `no store ${request.store}` } };
        return { id, ok: true, result: state };
      case 'do': {
        if (request.store !== 'counter') return { id, ok: false, error: { code: 'unknown_store', message: `no store ${request.store}` } };
        const by = typeof request.args?.by === 'number' ? request.args.by : 1;
        if (request.op === 'slowInc') await Bun.sleep(request.args?.ms ?? 100);
        else if (request.op !== 'inc') return { id, ok: false, error: { code: 'unknown_op', message: `no op ${request.op}` } };
        counter.value += by;
        return { id, ok: true, result: { name: 'counter', state: { ...counter } } };
      }
      case 'quit':
        return { id, ok: true, result: {} };
      default:
        return { id, ok: false, error: { code: 'bad_request', message: `unknown cmd ${request.cmd}` } };
    }
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    if (greeting !== null) socket.write(`${greeting}\n`);
    let buffer = '';
    // one request at a time per connection, like the Swift server
    let queue = Promise.resolve();
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        received.push(request);
        queue = queue.then(async () => {
          const reply = await answer(request);
          if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
          if (request.cmd === 'quit') socket.end();
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  return {
    port: address.port,
    received,
    open: () => sockets.size,
    dropAll: () => { for (const s of sockets) s.destroy(); },
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
