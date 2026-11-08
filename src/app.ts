import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ProcessError, ProtocolError, UntilTimeoutError } from './errors.ts';
import {
  PROTOCOL_VERSION,
  type Json,
  type JsonObject,
  type Listing,
  type Request,
  type Response,
  type StoreSnapshot,
} from './protocol.ts';

/** What a state looks like when the caller does not name a type. */
export type State = Record<string, unknown>;

export interface LaunchOptions {
  /** The program and its fixed leading args, e.g. `['swift', 'run', '--package-path', 'ios/Packages/CLI', 'gohobi-cli']`. */
  command: string[];
  /** Appended after `command` (the per-run flags such as `--api-base`). */
  args?: string[];
  /** Merged over `process.env`. */
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** How long to wait for `{"ready":true}`. Generous by default because `swift run` / gradle may build first. */
  readyTimeoutMs?: number;
  /** Per-request timeout for ls/get/do. */
  requestTimeoutMs?: number;
  /** Called with every stderr chunk (e.g. `process.stderr.write` to watch the CLI's log live). */
  onStderr?: (chunk: string) => void;
}

export interface UntilOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_KEEP = 64_000;

interface Pending {
  request: Request;
  resolve: (result: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Spawn the CLI and resolve once it printed the ready line. */
export async function launch(options: LaunchOptions): Promise<App> {
  const [program, ...lead] = options.command;
  if (program === undefined) throw new TypeError('launch: command must not be empty');
  const child = spawn(program, [...lead, ...(options.args ?? [])], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const app = new App(child, options);
  await app.ready(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  return app;
}

/** A running CLI. Calls may be issued concurrently; answers are matched by id. */
export class App {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuffer = '';
  private stderrText = '';
  /** Lines printed before the ready line (build output from `swift run` etc). Kept for diagnostics. */
  private preamble: string[] = [];
  private isReady = false;
  private readyWaiter?: { resolve: () => void; reject: (e: Error) => void };
  private exitInfo?: { code: number | null; signal: NodeJS.Signals | null };
  private readonly exited: Promise<void>;
  private fatal?: Error;
  private readonly requestTimeoutMs: number;

  /** @internal use `launch` */
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: LaunchOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrText = (this.stderrText + chunk).slice(-STDERR_KEEP);
      options.onStderr?.(chunk);
    });
    // Writing to a dead process must surface as a ProcessError on the call, not crash the runner.
    child.stdin.on('error', () => {});
    this.exited = new Promise((resolve) => {
      child.on('error', (error) => {
        this.fail(new ProcessError(`failed to start ${options.command.join(' ')}: ${error.message}`, this.stderrText));
        resolve();
      });
      child.on('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        this.fail(new ProcessError(`CLI exited (code ${code}, signal ${signal})${this.describePreamble()}`, this.stderrText));
        resolve();
      });
    });
  }

  /** Everything the CLI wrote to stderr so far (tail). */
  get stderr(): string {
    return this.stderrText;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** @internal */
  ready(timeoutMs: number): Promise<void> {
    if (this.isReady) return Promise.resolve();
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = undefined;
        this.child.kill('SIGKILL');
        reject(new ProcessError(`no ready line within ${timeoutMs}ms${this.describePreamble()}`, this.stderrText));
      }, timeoutMs);
      this.readyWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  ls(): Promise<Listing> {
    return this.send({ id: 0, cmd: 'ls' }) as unknown as Promise<Listing>;
  }

  /** The store's current state. */
  async get<S = State>(store: string): Promise<NoInfer<S>> {
    const snap = (await this.send({ id: 0, cmd: 'get', store })) as unknown as StoreSnapshot<S>;
    return snap.state;
  }

  /** Run an operation; resolves after it finished, with the state after it. */
  async do<S = State>(store: string, op: string, args: JsonObject = {}): Promise<NoInfer<S>> {
    const snap = (await this.send({ id: 0, cmd: 'do', store, op, args })) as unknown as StoreSnapshot<S>;
    return snap.state;
  }

  /**
   * Poll `get(store)` until `predicate(state)` is truthy, and return that state.
   * A predicate that throws counts as "not yet" (so `expect` can be used inside); the last throw is reported on timeout.
   */
  async until<S = State>(
    store: string,
    predicate: (state: S) => boolean | void | Promise<boolean | void>,
    { timeoutMs = 5_000, intervalMs = 50 }: UntilOptions = {},
  ): Promise<S> {
    const deadline = Date.now() + timeoutMs;
    let last: S | undefined;
    let lastError: unknown;
    for (;;) {
      last = await this.get<S>(store);
      try {
        const verdict = await predicate(last);
        if (verdict !== false) return last;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) throw new UntilTimeoutError(store, timeoutMs, last, lastError);
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  }

  /** Send `quit`, wait for the process to exit, kill it after `timeoutMs`. Safe to call twice. Resolves with the exit code. */
  async close({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<number | null> {
    if (!this.exitInfo && !this.fatal) {
      const quit = this.send({ id: 0, cmd: 'quit' }, timeoutMs).catch(() => undefined);
      await Promise.race([quit, sleep(timeoutMs)]);
      this.child.stdin.end();
    }
    if (!this.exitInfo) {
      const killer = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
      await this.exited;
      clearTimeout(killer);
    }
    return this.exitInfo?.code ?? null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private send(request: Request, timeoutMs = this.requestTimeoutMs): Promise<Json> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    const withId = { ...request, id } as Request;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProcessError(`no answer to ${JSON.stringify(withId)} within ${timeoutMs}ms`, this.stderrText));
      }, timeoutMs);
      this.pending.set(id, { request: withId, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(withId)}\n`);
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      message = undefined;
    }

    if (!this.isReady) {
      // Before ready, tolerate build tools chatting on stdout.
      if (isObject(message) && message.ready === true) {
        if (message.protocol !== PROTOCOL_VERSION) {
          this.fail(new ProcessError(`CLI speaks protocol ${String(message.protocol)}, headless-flow speaks ${PROTOCOL_VERSION}`, this.stderrText));
          this.child.kill('SIGKILL');
          return;
        }
        this.isReady = true;
        this.readyWaiter?.resolve();
        this.readyWaiter = undefined;
      } else {
        this.preamble = [...this.preamble, line].slice(-20);
      }
      return;
    }

    // The CLI could not read a line at all (bad_request with id null). headless-flow never sends such lines,
    // so there is no call to fail; keep it visible in stderr diagnostics instead of killing the session.
    if (isObject(message) && message.id === null && message.ok === false) {
      this.stderrText = `${this.stderrText}[headless-flow] CLI answered id:null: ${line}\n`.slice(-STDERR_KEEP);
      return;
    }

    if (!isResponse(message)) {
      this.fail(new ProcessError(`CLI wrote a non-protocol line on stdout: ${line}`, this.stderrText));
      this.child.kill('SIGKILL');
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return; // answer to a request that already timed out
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new ProtocolError(message.error.code, message.error.message, pending.request));
  }

  private fail(error: Error): void {
    // quit makes the process exit; that is not a failure of the quit request
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.request.cmd === 'quit') pending.resolve(null);
      else pending.reject(error);
      this.pending.delete(id);
    }
    this.fatal ??= error;
    this.readyWaiter?.reject(error);
    this.readyWaiter = undefined;
  }

  private describePreamble(): string {
    return this.preamble.length ? `\n--- stdout before ready ---\n${this.preamble.join('\n')}` : '';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponse(value: unknown): value is Response {
  if (!isObject(value) || typeof value.id !== 'number') return false;
  if (value.ok === true) return 'result' in value;
  return value.ok === false && isObject(value.error) && typeof value.error.code === 'string';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
