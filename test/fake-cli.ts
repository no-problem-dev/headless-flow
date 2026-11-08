// A tiny CLI speaking protocol 1, for store-flow's own tests. Run with `bun test/fake-cli.ts [flags]`.
//
// Stores:
//   counter  state {value}      ops: inc {by:number}, slowInc {by:number, ms:number}, boom {}
//   ticker   state {ticks}      ops: start {every:number, times:number}  (returns at once, ticks advance in the background)
// Flags:
//   --preamble     print build-tool-like noise on stdout before the ready line
//   --protocol N   announce protocol N
//   --no-ready     never print the ready line
//   --exit-on-boom exit(3) instead of answering op_failed for counter.boom
//   --ignore-quit  do not exit on quit

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const protocol = Number(argv[argv.indexOf('--protocol') + 1] ?? 1) || 1;

const counter = { value: 0 };
const ticker = { ticks: 0 };

type Args = Record<string, unknown>;
class OpError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const num = (args: Args, key: string): number => {
  const v = args[key];
  if (typeof v !== 'number') throw new OpError('bad_args', `${key} must be a number`);
  return v;
};

const stores: Record<string, { state: () => object; ops: Record<string, { input: object; run: (a: Args) => Promise<void> | void }> }> = {
  counter: {
    state: () => ({ ...counter }),
    ops: {
      inc: { input: { type: 'object', properties: { by: { type: 'number' } }, required: ['by'] }, run: (a) => { counter.value += num(a, 'by'); } },
      slowInc: {
        input: { type: 'object', properties: { by: { type: 'number' }, ms: { type: 'number' } }, required: ['by', 'ms'] },
        run: async (a) => { const by = num(a, 'by'); await Bun.sleep(num(a, 'ms')); counter.value += by; },
      },
      boom: {
        input: { type: 'object' },
        run: () => {
          console.error('boom: the op blew up');
          if (flag('--exit-on-boom')) process.exit(3);
          throw new OpError('op_failed', 'boom');
        },
      },
    },
  },
  ticker: {
    state: () => ({ ...ticker }),
    ops: {
      start: {
        input: { type: 'object', properties: { every: { type: 'number' }, times: { type: 'number' } } },
        run: (a) => {
          const every = num(a, 'every');
          let left = num(a, 'times');
          const t = setInterval(() => { ticker.ticks++; if (--left <= 0) clearInterval(t); }, every);
        },
      },
    },
  },
};

const out = (obj: object) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function handle(line: string) {
  let req: any;
  try { req = JSON.parse(line); } catch { return out({ id: null, ok: false, error: { code: 'bad_request', message: 'not json' } }); }
  const id = req.id;
  const fail = (code: string, message: string) => out({ id, ok: false, error: { code, message } });
  try {
    switch (req.cmd) {
      case 'ls':
        return out({ id, ok: true, result: { protocol, stores: Object.entries(stores).map(([name, s]) => ({
          name, state: s.state(), operations: Object.entries(s.ops).map(([op, o]) => ({ name: op, input: o.input })),
        })) } });
      case 'get': {
        const s = stores[req.store];
        if (!s) return fail('unknown_store', `no store ${req.store}`);
        return out({ id, ok: true, result: { name: req.store, state: s.state() } });
      }
      case 'do': {
        const s = stores[req.store];
        if (!s) return fail('unknown_store', `no store ${req.store}`);
        const op = s.ops[req.op];
        if (!op) return fail('unknown_op', `no op ${req.op} on ${req.store}`);
        await op.run(req.args ?? {});
        return out({ id, ok: true, result: { name: req.store, state: s.state() } });
      }
      case 'garble':
        // answer like a CLI that could not parse a line, then answer normally
        out({ id: null, ok: false, error: { code: 'bad_request', message: 'not json' } });
        return out({ id, ok: true, result: { name: 'counter', state: stores.counter!.state() } });
      case 'quit':
        out({ id, ok: true, result: {} });
        if (!flag('--ignore-quit')) process.exit(0);
        return;
      default:
        return fail('bad_request', `unknown cmd ${req.cmd}`);
    }
  } catch (e) {
    if (e instanceof OpError) return fail(e.code, e.message);
    return fail('op_failed', String(e));
  }
}

if (flag('--preamble')) {
  process.stdout.write('Building for debugging...\n[3/3] Linking fake-cli\n');
}
console.error('fake-cli: starting');
if (!flag('--no-ready')) out({ ready: true, protocol });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) void handle(line); // concurrent: do not await
  }
});
if (flag('--ignore-quit')) setInterval(() => {}, 1_000);
process.stdin.on('end', () => { if (!flag('--ignore-quit')) process.exit(0); });
