import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
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

export interface ConnectOptions {
  /** The port the running app listens on (e.g. the one passed as `-HeadlessPort`). */
  port: number;
  host?: string;
  /** How long to wait for the connection and its ready line. */
  readyTimeoutMs?: number;
  /** Per-request timeout for ls/get/do. */
  requestTimeoutMs?: number;
}

export interface UntilOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 300_000;
const DEFAULT_CONNECT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_KEEP = 64_000;

interface Pending {
  request: Request;
  resolve: (result: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The byte stream an `App` talks over: a CLI's stdin/stdout, or a socket to a running app.
 * @internal
 */
export interface Channel {
  write(text: string): void;
  /** Ask the other side to finish (close stdin / half-close the socket). */
  end(): void;
  /** Stop it now (SIGKILL / destroy the socket). */
  kill(): void;
  /** Send `quit` before closing (a CLI exits on quit). A socket just disconnects. */
  readonly quitOnClose: boolean;
  readonly pid?: number;
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
  const app = new App(
    {
      write: (text) => { child.stdin.write(text); },
      end: () => { child.stdin.end(); },
      kill: () => { child.kill('SIGKILL'); },
      quitOnClose: true,
      pid: child.pid,
    },
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => app.receive(chunk));
  child.stderr.on('data', (chunk: string) => {
    app.receiveLog(chunk);
    options.onStderr?.(chunk);
  });
  // Writing to a dead process must surface as a ProcessError on the call, not crash the runner.
  child.stdin.on('error', () => {});
  child.on('error', (error) => app.closed(`failed to start ${options.command.join(' ')}: ${error.message}`, null));
  child.on('exit', (code, signal) => app.closed(`CLI exited (code ${code}, signal ${signal})`, code));
  await app.ready(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  return app;
}

/**
 * Connect to an app that already serves the protocol on a TCP port (e.g. a DEBUG build launched with
 * `-HeadlessPort <port>`) and resolve once it sent the ready line. Returns the same `App` as `launch`;
 * `close()` only disconnects, the app keeps running.
 */
export async function connect({
  port,
  host = '127.0.0.1',
  readyTimeoutMs = DEFAULT_CONNECT_READY_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: ConnectOptions): Promise<App> {
  const socket = createConnection({ port, host });
  const app = new App(
    {
      write: (text) => { socket.write(text); },
      end: () => { socket.end(); },
      kill: () => { socket.destroy(); },
      quitOnClose: false,
    },
    requestTimeoutMs,
  );
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => app.receive(chunk));
  let failure: string | undefined;
  socket.on('error', (error) => { failure = `cannot talk to ${host}:${port}: ${error.message}`; });
  socket.on('close', () => app.closed(failure ?? `${host}:${port} closed the connection`, null));
  try {
    await app.ready(readyTimeoutMs);
  } catch (error) {
    socket.destroy();
    throw error;
  }
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
  private exitInfo?: { code: number | null };
  private readonly exited: Promise<void>;
  private markExited!: () => void;
  private fatal?: Error;

  /** @internal use `launch` or `connect` */
  constructor(
    private readonly channel: Channel,
    private readonly requestTimeoutMs: number,
  ) {
    this.exited = new Promise((resolve) => { this.markExited = resolve; });
  }

  /** @internal stdout / socket bytes */
  receive(chunk: string): void {
    this.onStdout(chunk);
  }

  /** @internal stderr of a CLI */
  receiveLog(chunk: string): void {
    this.stderrText = (this.stderrText + chunk).slice(-STDERR_KEEP);
  }

  /** @internal the process exited or the socket closed */
  closed(message: string, code: number | null): void {
    if (this.exitInfo) return;
    this.exitInfo = { code };
    this.fail(new ProcessError(`${message}${this.describePreamble()}`, this.stderrText));
    this.markExited();
  }

  /** Everything the CLI wrote to stderr so far (tail). */
  get stderr(): string {
    return this.stderrText;
  }

  /** The CLI's process id (undefined for `connect`). */
  get pid(): number | undefined {
    return this.channel.pid;
  }

  /** @internal */
  ready(timeoutMs: number): Promise<void> {
    if (this.isReady) return Promise.resolve();
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = undefined;
        this.channel.kill();
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

  /**
   * A CLI: send `quit`, wait for the process to exit, kill it after `timeoutMs`. Resolves with the exit code.
   * A connection (`connect`): disconnect without `quit`, so the app keeps running. Resolves with null.
   * Safe to call twice.
   */
  async close({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<number | null> {
    if (!this.exitInfo && !this.fatal && this.channel.quitOnClose) {
      const quit = this.send({ id: 0, cmd: 'quit' }, timeoutMs).catch(() => undefined);
      await Promise.race([quit, sleep(timeoutMs)]);
    }
    if (!this.exitInfo) this.channel.end();
    if (!this.exitInfo) {
      const killer = setTimeout(() => this.channel.kill(), timeoutMs);
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
      this.channel.write(`${JSON.stringify(withId)}\n`);
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
          this.channel.kill();
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
      this.channel.kill();
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
