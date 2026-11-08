/** Wire format of the state CLI protocol (version 1). One JSON object per line. */

export const PROTOCOL_VERSION = 1;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type ErrorCode = 'bad_request' | 'unknown_store' | 'unknown_op' | 'bad_args' | 'op_failed';

export type Request =
  | { id: number; cmd: 'ls' }
  | { id: number; cmd: 'get'; store: string }
  | { id: number; cmd: 'do'; store: string; op: string; args?: JsonObject }
  | { id: number; cmd: 'quit' };

export type Response =
  | { id: number; ok: true; result: Json }
  | { id: number; ok: false; error: { code: ErrorCode | string; message: string } };

export interface ReadyLine {
  ready: true;
  protocol: number;
}

export interface Operation {
  name: string;
  /** JSON Schema of the args object. */
  input: JsonObject;
}

export interface StoreListing<S = JsonObject> {
  name: string;
  state: S;
  operations: Operation[];
}

export interface Listing {
  protocol: number;
  stores: StoreListing[];
}

export interface StoreSnapshot<S = JsonObject> {
  name: string;
  state: S;
}
