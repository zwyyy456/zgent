import type { Contracts } from './types.ts';

export type MainProfileView = {
  id: string; label: string; model: string; runtime: 'antigravity_acp' | 'claude_agent_sdk';
  projects: string[]; worker_profiles: string[]; billing: 'provider_plan' | 'api_metered' | 'cloud_account' | 'unknown'; available?: boolean;
};
export type MainSessionView = {
  session_id: string; project_id: string; title: string;
  state: 'ready' | 'running' | 'waiting_input' | 'stopping' | 'disconnected' | 'closed';
  profile: MainProfileView; previous_session_id: string | null; updated_at: string; runtime_version: string | null;
  checkout: string | null; default_worker: string; base_mode: 'head' | 'snapshot';
};
export type MainSessionDetail = MainSessionView & {
  models: { id: string; label: string }[];
  turns: { turn_id: string; input: string; output: string; state: 'running' | 'completed' | 'cancelled' | 'disconnected' | 'failed';
    error: string | null; usage: { total_tokens?: number; reported_cost?: { amount: string; currency: string };
      inputTokens?: number; cachedReadTokens?: number; outputTokens?: number } | null;
    created_at: string; completed_at: string | null; summary_of: string | null }[];
  tasks: { turn_id: string; snapshot: Contracts['TaskView'] }[];
  notifications: { event_id: string; task_id: string; state: string }[];
};
