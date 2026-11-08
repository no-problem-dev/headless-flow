import type { ErrorCode } from './protocol.ts';

/** Base class for everything headless-flow throws. */
export class FlowError extends Error {
  override name = 'FlowError';
}

/** The CLI answered `ok:false`. `code` is the protocol error code. */
export class ProtocolError extends FlowError {
  override name = 'ProtocolError';
  constructor(
    readonly code: ErrorCode | string,
    message: string,
    readonly request: unknown,
  ) {
    super(`${code}: ${message} (request ${JSON.stringify(request)})`);
  }
}

/** The CLI failed to start, died, or wrote something that is not the protocol. `stderr` is what it logged. */
export class ProcessError extends FlowError {
  override name = 'ProcessError';
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(stderr.trim() ? `${message}\n--- stderr ---\n${tail(stderr)}` : message);
  }
}

/** `until` ran out of time. `lastState` is the last state seen. */
export class UntilTimeoutError extends FlowError {
  override name = 'UntilTimeoutError';
  constructor(
    readonly store: string,
    readonly timeoutMs: number,
    readonly lastState: unknown,
    readonly lastError?: unknown,
  ) {
    const why = lastError === undefined ? '' : `\nlast error: ${String(lastError)}`;
    super(`until(${store}) did not hold within ${timeoutMs}ms\nlast state: ${JSON.stringify(lastState, null, 2)}${why}`);
  }
}

function tail(text: string, max = 4_000): string {
  return text.length <= max ? text.trimEnd() : `…${text.slice(-max).trimEnd()}`;
}
