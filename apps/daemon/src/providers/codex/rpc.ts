import { RpcFailure } from './failure.ts';
import { createInterface } from 'node:readline';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { InitializeParams, RequestId } from './protocol.ts';

type Frame = { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: unknown };
export type ServerFrame = { id: RequestId; method: string; params: unknown };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type Pipes = ChildProcessByStdio<Writable, Readable, Readable>;

export class Rpc {
  child: Pipes;
  pending = new Map<number, Pending>();
  serial = 0;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  exited = false;
  notification?: (method: string, params: unknown) => void;
  request?: (frame: ServerFrame) => void;
  invalidFrame?: () => void;

  constructor(child: Pipes) {
    this.child = child;
    this.closed = new Promise(resolve => child.once('close', (code, signal) => {
      this.exited = true;
      this.disconnect();
      resolve({ code, signal });
    }));
    child.once('error', () => this.disconnect());
    child.stdin.on('error', () => this.disconnect());
    child.stdout.on('error', () => this.disconnect());
    child.stderr.resume();
    const input = createInterface({ input: child.stdout, crlfDelay: Infinity });
    input.on('line', line => {
      try {
        if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw new Error();
        const frame = JSON.parse(line) as Frame;
        if (frame.method && frame.id !== undefined) this.request?.({ id: frame.id, method: frame.method, params: frame.params });
        else if (frame.method) this.notification?.(frame.method, frame.params);
        else if (typeof frame.id === 'number') {
          const request = this.pending.get(frame.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(frame.id);
          if (frame.error) request.reject(new RpcFailure(frame.error));
          else request.resolve(frame.result);
        }
      } catch {
        this.invalidFrame?.();
      }
    });
  }

  disconnect() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Codex transport closed.'));
    }
    this.pending.clear();
  }

  write(frame: Frame) {
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(frame) + '\n', error =>
        error ? reject(new Error('Codex transport write failed.')) : resolve());
    });
  }

  call<T>(method: string, params: unknown, timeout = 60_000): Promise<T> {
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('Codex protocol reply timed out.')), timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      void this.write({ id, method, params }).catch(fail);
    });
  }

  async initialize() {
    const params: InitializeParams = {
      clientInfo: { name: 'zgent', title: 'Zgent', version: '0.1.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: null, requestAttestation: false },
    };
    await this.call('initialize', params, 10_000);
    await this.write({ method: 'initialized' });
  }
}
