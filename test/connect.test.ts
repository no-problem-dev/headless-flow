import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { ProcessError, ProtocolError, connect, type App } from '../src/index.ts';
import { startFakeServer, type FakeServer } from './fake-socket-server.ts';

const servers: FakeServer[] = [];
const apps: App[] = [];

async function serve(options?: Parameters<typeof startFakeServer>[0]): Promise<FakeServer> {
  const server = await startFakeServer(options);
  servers.push(server);
  return server;
}

async function open(port: number): Promise<App> {
  const app = await connect({ port, readyTimeoutMs: 2_000 });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close({ timeoutMs: 1_000 })));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A port nothing listens on. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as { port: number };
  await new Promise((r) => probe.close(r));
  return port;
}

describe('connect', () => {
  test('waits for the ready line, then speaks the same App API', async () => {
    const server = await serve();
    const app = await open(server.port);
    expect(app.pid).toBeUndefined();
    expect((await app.ls()).stores.map((s) => s.name)).toEqual(['counter']);
    expect(await app.do('counter', 'inc', { by: 2 })).toEqual({ value: 2 });
    expect(await app.get('counter')).toEqual({ value: 2 });
    expect(await app.until<{ value: number }>('counter', (s) => s.value === 2)).toEqual({ value: 2 });
  });

  test('concurrent calls are matched by id', async () => {
    const server = await serve();
    const app = await open(server.port);
    const [slow, fast] = await Promise.all([app.do('counter', 'slowInc', { by: 10, ms: 100 }), app.do('counter', 'inc', { by: 1 })]);
    expect(slow).toEqual({ value: 10 });
    expect(fast).toEqual({ value: 11 });
  });

  test('ok:false becomes ProtocolError', async () => {
    const server = await serve();
    const app = await open(server.port);
    const error = await app.get('nope').catch((e) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.code).toBe('unknown_store');
  });

  test('close disconnects without quit; the app keeps serving', async () => {
    const server = await serve();
    const first = await connect({ port: server.port });
    await first.do('counter', 'inc', { by: 3 });
    expect(await first.close()).toBeNull();
    expect(server.received.some((r: any) => r.cmd === 'quit')).toBe(false);
    expect(await first.close()).toBeNull(); // twice is fine

    const second = await open(server.port);
    expect(await second.get('counter')).toEqual({ value: 3 });
  });

  test('nothing listening fails with ProcessError', async () => {
    const error = await connect({ port: await freePort(), readyTimeoutMs: 2_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error.message).toContain('ECONNREFUSED');
  });

  test('no ready line within the timeout fails with ProcessError', async () => {
    const server = await serve({ greeting: null });
    const error = await connect({ port: server.port, readyTimeoutMs: 300 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error.message).toContain('no ready line');
  });

  test('another protocol version is refused', async () => {
    const server = await serve({ greeting: '{"ready":true,"protocol":2}' });
    const error = await connect({ port: server.port, readyTimeoutMs: 2_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error.message).toContain('protocol 2');
  });

  test('the app dropping the connection fails pending and later calls', async () => {
    const server = await serve();
    const app = await open(server.port);
    const pending = app.do('counter', 'slowInc', { by: 1, ms: 500 });
    await Bun.sleep(50);
    server.dropAll();
    expect(await pending.catch((e) => e)).toBeInstanceOf(ProcessError);
    expect(await app.get('counter').catch((e) => e)).toBeInstanceOf(ProcessError);
  });
});
