import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gatedWorker, groupGone, stopGroup, waitGroupGone, type Identity } from '../../os/process.ts';
import type { Config } from '../../policy/config.ts';
import { clip, redact, type Snapshot } from '../../core/values.ts';
import { permissionArgs, workerEnv } from '../codex/codex.ts';
import { Rpc } from '../codex/rpc.ts';
import type { Job, Evidence, RunHooks, TurnOutcome, Worker } from '../worker.ts';
import type { RequestId } from '../codex/protocol.ts';
import { claudeEnvironment } from './sdk.ts';

export function startClaudeWorker(config: Config, job: Job) {
  const env = claudeEnvironment(config);
  if (!env) throw new Error('Claude SDK credentials are unavailable.');
  mkdirSync(join(job.cwd, '.zgent-tmp'), { mode: 0o700 });
  const child = gatedWorker(process.execPath, [fileURLToPath(new URL('./entry.ts', import.meta.url))], job.cwd, env);
  const rpc = new Rpc(child.child as ConstructorParameters<typeof Rpc>[0]);
  const runtime = new ClaudeWorker(job, rpc, {
    model: job.profile.model, mode: job.profile.mode, effort: job.profile.effort,
    codex: config.codex, sandboxArgs: permissionArgs(config, job), sandboxEnv: workerEnv(config, job.cwd),
  });
  return { ...child, runtime };
}

class ClaudeWorker implements Worker {
  job: Job;
  rpc: Rpc;
  setup: unknown;
  turn?: string;
  stopping = false;
  outcome?: TurnOutcome;
  evidence: Evidence[] = [];
  finalText = '';
  activeCommands = new Set<string>();
  artifactsTruncated = false;
  failure?: string;

  constructor(job: Job, rpc: Rpc, setup: unknown) {
    this.job = job;
    this.rpc = rpc;
    this.setup = setup;
  }

  async perform(prompt: string, hooks: RunHooks) {
    this.rpc.invalidFrame = hooks.badFrame;
    this.rpc.request = frame => this.stopping ? void this.error(frame.id) : hooks.request(frame);
    let resolveTurn: (outcome: TurnOutcome) => void = () => {};
    const completed = new Promise<TurnOutcome>(resolve => { resolveTurn = resolve; });
    this.rpc.notification = (method, value) => {
      const params = value as { id: string; text: string; status: TurnOutcome; model?: string };
      switch (method) {
        case 'work/thread': hooks.thread(params.id, params.model); break;
        case 'work/text': this.finalText = clip(redact(params.text), 64_000); break;
        case 'work/failure': this.failure = (value as { code: string }).code; break;
        case 'work/usage': hooks.usage(value as NonNullable<Snapshot['actual_usage']>); break;
        case 'work/evidence':
          if (this.evidence.length < 500) this.evidence.push(value as Evidence);
          else this.artifactsTruncated = true;
          break;
        case 'work/commandStarted': this.activeCommands.add(params.id); break;
        case 'work/commandFinished': this.activeCommands.delete(params.id); break;
        case 'work/resolved': hooks.resolved(params.id); break;
        case 'work/complete':
          if (params.id === this.turn) {
            this.outcome = params.status;
            hooks.outcome(params.status);
            resolveTurn(params.status);
          }
          break;
      }
    };
    await this.rpc.call('work/initialize', this.setup, 10_000);
    if (this.stopping || !hooks.beforeTurn()) return 'interrupted';
    this.turn = (await this.rpc.call<{ id: string }>('work/start', { prompt }, 30_000)).id;
    hooks.turn(this.turn);
    return Promise.race([completed, this.rpc.closed.then(() => 'disconnected' as const)]);
  }

  async steer(message: string) {
    if (!this.turn || this.stopping || this.outcome) return false;
    return (await this.rpc.call<{ queued: boolean }>('work/steer', { message }, 5000)).queued;
  }

  async error(id: RequestId) {
    await this.rpc.write({ id, error: { code: -32601, message: 'This interaction is unavailable.' } }).catch(() => {});
  }

  fileRequestCurrent() { return undefined; }

  async stop(owner: Identity, cancel: boolean) {
    this.stopping = true;
    if (cancel && !this.outcome && !this.rpc.exited) {
      await this.rpc.call('work/interrupt', {}, 2500).catch(() => {});
      const until = Date.now() + 7500;
      while (!this.outcome && !this.rpc.exited && Date.now() < until) await delay(100);
    }
    this.rpc.child.stdin.end();
    await Promise.race([this.rpc.closed, delay(750)]);
    if (this.rpc.exited) await waitGroupGone(owner.pgid, 750);
    const stopped = groupGone(owner.pgid) || await stopGroup(owner, { liveOrphan: this.rpc.exited });
    await Promise.race([this.rpc.closed, delay(1000)]);
    return stopped && this.rpc.exited;
  }
}
