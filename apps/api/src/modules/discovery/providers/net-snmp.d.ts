/** Minimal typings for net-snmp (no @types package). Only what the discovery provider uses. */
declare module 'net-snmp' {
  export interface Varbind { oid: string; type: number; value: unknown }
  export interface SessionOptions { version?: number; port?: number; retries?: number; timeout?: number; transport?: string; backoff?: number; idBitsSize?: number; context?: string }
  export interface V3User { name: string; level: number; authProtocol?: number; authKey?: string; privProtocol?: number; privKey?: string }
  export interface Session {
    get(oids: string[], cb: (err: Error | null, varbinds: Varbind[]) => void): Session;
    subtree(oid: string, maxRepetitions: number, feedCb: (varbinds: Varbind[]) => boolean | void, doneCb: (err: Error | null) => void): Session;
    close(): void;
    cancelRequests(err?: Error): void;
    on(event: 'error', cb: (err: Error) => void): this;
  }
  export function createSession(target: string, community: string, options?: SessionOptions): Session;
  export function createV3Session(target: string, user: V3User, options?: SessionOptions): Session;
  export function isVarbindError(vb: Varbind): boolean;
  export function varbindError(vb: Varbind): string;
  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;
  export const ObjectType: Record<string, number>;
  export const SecurityLevel: { noAuthNoPriv: number; authNoPriv: number; authPriv: number };
  export const AuthProtocols: { none: number; md5: number; sha: number; sha224: number; sha256: number; sha384: number; sha512: number };
  export const PrivProtocols: { none: number; des: number; aes: number; aes256b: number; aes256r: number };
}
