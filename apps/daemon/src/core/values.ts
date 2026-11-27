import { createHash, randomUUID } from 'node:crypto';
import type { Contracts } from '@zgent/contracts';

type DelegateData = Extract<Contracts['delegate_taskOutput'], { ok: true }>['data'];
export type Snapshot = DelegateData['task'];
export type State = Snapshot['state'];
export type PublicArtifact = Snapshot['artifacts'][number];
export type PublicProfile = Extract<Contracts['list_profilesOutput'], { ok: true }>['data']['profiles'][number];
export type ProblemCode = Contracts['Problem']['code'];

export const id = randomUUID;
export const iso = (ms = Date.now()) => new Date(ms).toISOString();
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const clip = (value: string, limit: number) => Array.from(value).slice(0, limit).join('');
export const finished = (state: State) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  }
  return JSON.stringify(value);
}

export class Failure extends Error {
  http: ProblemCode;
  mcp: string;
  status: number;

  constructor(status: number, http: ProblemCode, message: string, mcp = http as string) {
    super(message);
    this.http = http;
    this.mcp = mcp;
    this.status = status;
  }
}

export const missing = () => new Failure(404, 'NOT_FOUND', 'Resource not found.');
export const invalid = (message: string) => new Failure(400, 'INVALID_REQUEST', message, 'INVALID_ARGUMENT');
export const conflict = (code: ProblemCode, message: string) => new Failure(409, code, message, 'CONFLICT');

export function redact(text: string) {
  return text.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[redacted credential]')
    .replace(/(\b(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|client[-_ ]?secret|token)\b["']?\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]');
}
