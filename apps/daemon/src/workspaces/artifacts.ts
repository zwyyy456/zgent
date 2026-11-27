import { constants, fstatSync, mkdirSync, openSync, readSync, closeSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact } from '../db/store.ts';
import { Failure, hash, id, iso } from '../core/values.ts';

const titles = { diff: 'Worktree diff', patch: 'Index-only patch', log: 'Worker command log',
  report: 'Worktree report', result: 'Worker result', verification: 'Observed command executions', file: 'File' };

export function artifactView(artifact: Artifact) {
  return { artifact_id: artifact.artifact_id, kind: artifact.kind, media_type: artifact.media_type,
    title: titles[artifact.kind], created_at: iso(artifact.created_at_ms), size_bytes: artifact.size_bytes,
    sha256: artifact.content_sha256 };
}

export function saveArtifact(state: string, task: string, attempt: string, kind: Artifact['kind'], data: string | Buffer) {
  const artifactId = id();
  const root = join(state, 'artifacts');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const temporary = join(root, artifactId + '.tmp');
  writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true });
  renameSync(temporary, join(root, artifactId));
  return { artifact_id: artifactId, task_id: task, attempt_id: attempt, kind,
    storage_relative_path: artifactId, content_sha256: hash(bytes), size_bytes: bytes.length,
    media_type: kind === 'diff' || kind === 'patch' ? 'text/x-diff' : 'text/plain; charset=utf-8',
    created_at_ms: Date.now() } satisfies Artifact;
}

export function readArtifact(state: string, artifact: Artifact, offset: number, limit: number) {
  if (offset > artifact.size_bytes) throw new Failure(416, 'RANGE_NOT_SATISFIABLE', 'Offset exceeds artifact size.');
  try {
    if (artifact.storage_relative_path !== artifact.artifact_id) throw new Error();
    const fd = openSync(join(state, 'artifacts', artifact.storage_relative_path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size !== artifact.size_bytes) throw new Error();
      const bytes = Buffer.alloc(Math.min(limit, artifact.size_bytes - offset));
      const count = readSync(fd, bytes, 0, bytes.length, offset);
      if (count !== bytes.length) throw new Error();
      return bytes;
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Failure(410, 'ARTIFACT_UNAVAILABLE', 'Artifact is no longer available.', 'UNAVAILABLE');
  }
}
