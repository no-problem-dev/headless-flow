import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  ProcessError,
  ProtocolError,
  UntilTimeoutError,
  currentPlatform,
  launch,
  platformCommand,
  type App,
} from '../src/index.ts';

const FAKE = ['bun', join(import.meta.dir, 'fake-cli.ts')];
const open: App[] = [];

async function start(...flags: string[]): Promise<App> {
  const app = await launch({ command: FAKE, args: flags, readyTimeoutMs: 10_000 });
  open.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((a) => a.close({ timeoutMs: 1_000 })));
});

describe('launch', () => {
  test('waits for the ready line and lists stores', async () => {
    const app = await start();
    const listing = await app.ls();
    expect(listing.protocol).toBe(1);
    expect(listing.stores.map((s) => s.name)).toEqual(['counter', 'ticker']);
    expect(listing.stores[0]!.operations.map((o) => o.name)).toEqual(['inc', 'slowInc', 'boom']);
  });

  test('tolerates build output on stdout before ready', async () => {
    const app = await start('--preamble');
    expect(await app.get('counter')).toEqual({ value: 0 });
  });

  test('rejects another protocol version', async () => {
    const error = await launch({ command: FAKE, args: ['--protocol', '2'], readyTimeoutMs: 10_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error.message).toContain('protocol 2');
  });

  test('times out without a ready line, carrying stderr', async () => {
    const error = await launch({ command: FAKE, args: ['--no-ready'], readyTimeoutMs: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error.message).toContain('no ready line');
    expect(error.stderr).toContain('fake-cli: starting');
  });

  test('a program that cannot start fails with ProcessError', async () => {
    const error = await launch({ command: ['/nonexistent/cli'], readyTimeoutMs: 2_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProcessError);
  });
});

describe('get / do', () => {
  test('do returns the state after the op', async () => {
    const app = await start();
    expect(await app.do('counter', 'inc', { by: 2 })).toEqual({ value: 2 });
    expect(await app.get('counter')).toEqual({ value: 2 });
  });

  test('do waits for an async op to finish', async () => {
    const app = await start();
    const t0 = Date.now();
    expect(await app.do('counter', 'slowInc', { by: 5, ms: 200 })).toEqual({ value: 5 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
  });

  test('concurrent calls are matched by id, not by order', async () => {
    const app = await start();
    const slow = app.do('counter', 'slowInc', { by: 10, ms: 300 });
    const fast = app.do('counter', 'inc', { by: 1 });
    expect(await fast).toEqual({ value: 1 });
    expect(await slow).toEqual({ value: 11 });
  });

  test.each([
    ['unknown_store', (a: App) => a.get('nope')],
    ['unknown_op', (a: App) => a.do('counter', 'nope')],
    ['bad_args', (a: App) => a.do('counter', 'inc', { by: 'x' })],
    ['op_failed', (a: App) => a.do('counter', 'boom')],
  ] as const)('%s surfaces as ProtocolError with that code', async (code, call) => {
    const app = await start();
    const error = await call(app).catch((e) => e);
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.code).toBe(code);
    // the process is still usable after an error answer
    expect(await app.get('counter')).toEqual({ value: 0 });
  });

  test('a crash rejects the in-flight call with stderr attached', async () => {
    const app = await start('--exit-on-boom');
    const error = await app.do('counter', 'boom').catch((e) => e);
    expect(error).toBeInstanceOf(ProcessError);
    expect(error.message).toContain('code 3');
    expect(error.stderr).toContain('boom: the op blew up');
    expect(await app.get('counter').catch((e) => e)).toBeInstanceOf(ProcessError);
  });
});

test('an id:null bad_request answer is not fatal', async () => {
  const app = await start();
  // garble is a fake-only command (not in the protocol) that makes the CLI emit an id:null error first
  const result = await (app as any).send({ id: 0, cmd: 'garble' });
  expect(result).toEqual({ name: 'counter', state: { value: 0 } });
  expect(app.stderr).toContain('id:null');
  expect(await app.get('counter')).toEqual({ value: 0 });
});

describe('until', () => {
  test('polls until the predicate holds', async () => {
    const app = await start();
    await app.do('ticker', 'start', { every: 30, times: 5 });
    const state = await app.until<{ ticks: number }>('ticker', (s) => s.ticks >= 5, { timeoutMs: 3_000, intervalMs: 20 });
    expect(state.ticks).toBe(5);
  });

  test('a throwing predicate (expect inside) counts as not yet', async () => {
    const app = await start();
    await app.do('ticker', 'start', { every: 30, times: 3 });
    await app.until<{ ticks: number }>('ticker', (s) => { expect(s.ticks).toBe(3); }, { timeoutMs: 3_000 });
  });

  test('times out with the last state in the message', async () => {
    const app = await start();
    await app.do('counter', 'inc', { by: 7 });
    const error = await app.until<{ value: number }>('counter', (s) => s.value > 100, { timeoutMs: 200 }).catch((e) => e);
    expect(error).toBeInstanceOf(UntilTimeoutError);
    expect(error.lastState).toEqual({ value: 7 });
    expect(error.message).toContain('"value": 7');
  });
});

describe('close', () => {
  test('quit exits cleanly and close is idempotent', async () => {
    const app = await launch({ command: FAKE, readyTimeoutMs: 10_000 });
    expect(await app.close()).toBe(0);
    expect(await app.close()).toBe(0);
  });

  test('kills a CLI that ignores quit', async () => {
    const app = await launch({ command: FAKE, args: ['--ignore-quit'], readyTimeoutMs: 10_000 });
    const t0 = Date.now();
    expect(await app.close({ timeoutMs: 300 })).toBeNull(); // killed by signal
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe('platformCommand', () => {
  const targets = {
    ios: { packagePath: 'ios/Packages/CLI', product: 'gohobi-cli' },
    android: { executable: 'android/cli/build/install/cli/bin/cli' },
  };

  test('ios is swift run on the package', () => {
    expect(platformCommand('/repo', targets, 'ios')).toEqual(['swift', 'run', '--package-path', '/repo/ios/Packages/CLI', 'gohobi-cli']);
  });

  test('android is the installDist launcher', () => {
    expect(platformCommand('/repo', targets, 'android')).toEqual(['/repo/android/cli/build/install/cli/bin/cli']);
  });

  test('FLOW_PLATFORM picks the platform and must be set', () => {
    expect(currentPlatform({ FLOW_PLATFORM: 'android' })).toBe('android');
    expect(() => currentPlatform({})).toThrow('FLOW_PLATFORM');
  });
});
