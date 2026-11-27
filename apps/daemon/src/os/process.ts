import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Socket } from 'node:net';

export const helper = fileURLToPath(new URL('../../dist/process', import.meta.url));
export type Identity = { pid: number; pgid: number; birth: string };
const inspect = (...args: string[]) => spawnSync(helper, args, { encoding: 'utf8' });

export function bootIdentity() {
  const boot = inspect('boot');
  if (boot.status !== 0) throw new Error('Could not read the OS boot identity.');
  return boot.stdout.trim();
}

export function identity(pid: number): Identity | undefined {
  const response = inspect('identity', String(pid));
  if (response.status !== 0) return;
  const [birth, pgid] = response.stdout.trim().split(' ');
  return { pid, pgid: Number(pgid), birth };
}

export const groupGone = (pgid: number) => inspect('group', String(pgid)).status === 3;
const signalStatus = (process: Identity, name: 'TERM' | 'KILL') =>
  inspect('signal', String(process.pid), process.birth, String(process.pgid), name).status;
export const signal = (process: Identity, name: 'TERM' | 'KILL') => signalStatus(process, name) === 0;

function signalOrphanGroup(pgid: number, name: 'TERM' | 'KILL') {
  try {
    globalThis.process.kill(-pgid, name === 'TERM' ? 'SIGTERM' : 'SIGKILL');
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function waitGroupGone(pgid: number, ms: number) {
  const deadline = Date.now() + ms;
  while (!groupGone(pgid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

export async function stopGroup(process: Identity, options: { liveOrphan?: boolean } = {}) {
  for (const name of ['TERM', 'KILL'] as const) {
    if (groupGone(process.pgid)) return true;
    const status = signalStatus(process, name);
    if (status !== 0) {
      if (status === 3 && options.liveOrphan) {
        if (!signalOrphanGroup(process.pgid, name)) return false;
      } else {
        return groupGone(process.pgid);
      }
    }
    for (let polls = 0; polls < 20; polls++) {
      await delay(100);
      if (groupGone(process.pgid)) return true;
    }
  }
  return false;
}

export function gatedWorker(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(helper, ['worker', executable, ...args],
    { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  const gate = child.stdio[3] as Socket;
  gate.on('error', () => {});
  return { child, release: () => gate.end('1'), abort: () => gate.destroy() };
}
