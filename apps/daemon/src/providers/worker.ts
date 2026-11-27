import type { Identity } from '../os/process.ts';
import type { Profile, Project } from '../policy/config.ts';
import type { FileUpdateChange, RequestId } from './codex/protocol.ts';
import type { Rpc, ServerFrame } from './codex/rpc.ts';
import type { Snapshot } from '../core/values.ts';

export type Job = { cwd: string; project: Project; profile: Profile; resumeThread?: string };
export type TurnOutcome = 'completed' | 'failed' | 'interrupted' | 'disconnected';
export type Evidence = { command: string; status: string; exitCode: number | null; output: string };
export type RunHooks = {
  thread: (id: string, model?: string) => void;
  beforeTurn: () => boolean;
  turn: (id: string) => void;
  outcome: (value: TurnOutcome) => void;
  request: (frame: ServerFrame, patches?: FileUpdateChange[]) => void;
  resolved: (id: RequestId) => void;
  badFrame: () => void;
  usage: (value: NonNullable<Snapshot['actual_usage']>) => void;
};

export interface Worker {
  job: Job;
  rpc: Rpc;
  turn?: string;
  stopping: boolean;
  outcome?: TurnOutcome;
  evidence: Evidence[];
  finalText: string;
  activeCommands: Set<string>;
  artifactsTruncated: boolean;
  failure?: string;
  perform(prompt: string, hooks: RunHooks): Promise<TurnOutcome>;
  steer(message: string): Promise<boolean>;
  stop(process: Identity, cancel: boolean): Promise<boolean>;
  error(id: RequestId): Promise<void>;
  fileRequestCurrent(id: RequestId): boolean | undefined;
}
