import { rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, Artifact, Command, Task } from '../db/store.ts';
import { claudeVersion, runtimeIdentity } from '../policy/config.ts';
import { bootIdentity, groupGone, identity, stopGroup, type Identity } from '../os/process.ts';
import { RpcFailure } from '../providers/codex/failure.ts';
import { codexVersion, discover, startCodex, supportedCodexVersion } from '../providers/codex/codex.ts';
import { claudeCatalog } from '../providers/claude/sdk.ts';
import { startClaudeWorker } from '../providers/claude/worker.ts';
import type { Worker, TurnOutcome } from '../providers/worker.ts';
import { Interactions } from '../providers/codex/interactions.ts';
import { allocate, collect } from '../workspaces/git.ts';
import { artifactView, saveArtifact } from '../workspaces/artifacts.ts';
import { hash, clip, conflict, finished, id, iso, redact, type Snapshot } from './values.ts';
import { Tasks, type TaskSpec } from './tasks.ts';
import type { Result } from './result-page.ts';

type Recovery = NonNullable<Snapshot['recovery']>;
type Live = { promise?: Promise<void>; runtime?: Worker; owner?: Identity; stopping?: Promise<boolean>;
  message?: Promise<void>; executionMs: number; sampledAt: number };
type Terminal = 'succeeded' | 'failed' | 'interrupted' | 'cancelled';
type Workspace = { managed_path: string; branch_name: string; state: string };

export class Scheduler {
  tasks: Tasks;
  interactions: Interactions;
  workers = new Map<string, Live>();
  phase: 'starting' | 'recovering' | 'ready' | 'degraded' = 'starting';
  boot = bootIdentity();
  timer?: NodeJS.Timeout;
  closing = false;
  refreshing?: Promise<void>;

  constructor(tasks: Tasks) {
    this.tasks = tasks;
    this.interactions = new Interactions(tasks, taskId => this.workers.get(taskId)?.runtime);
  }

  get store() { return this.tasks.store; }

  async begin() {
    this.phase = 'recovering';
    // A file becomes readable only after its database registration is committed.
    const artifactDir = join(this.tasks.config.state, 'artifacts');
    if (existsSync(artifactDir)) {
      for (const filename of readdirSync(artifactDir)) {
        if (/^[a-f0-9-]{36}(\.tmp)?$/.test(filename) &&
          !this.store.one('SELECT 1 FROM artifacts WHERE storage_relative_path=?', filename)) {
          rmSync(join(artifactDir, filename), { force: true });
        }
      }
    }
    const unfinished = this.store.all<Task>("SELECT * FROM tasks WHERE state NOT IN ('queued','succeeded','failed','cancelled','interrupted')");
    for (const task of unfinished) await this.reconcile(task);
    if (this.closing) return;
    await this.refresh();
    if (this.closing) return;
    this.timer = setInterval(() => this.tick(), 200);
    this.tick();
  }

  refresh() {
    return this.refreshing ??= this.refreshCatalogs().finally(() => { this.refreshing = undefined; });
  }

  private async refreshCatalogs() {
    const catalog = await discover(this.tasks.config);
    if (this.closing) return;
    this.tasks.catalogs.set('codex_app_server', {
      status: { status: catalog.status, checked_at: iso(), ...('reason' in catalog ? { reason: catalog.reason } : {}) },
      models: 'models' in catalog ? catalog.models! : new Map(),
    });
    if (this.tasks.config.claude_sdk) {
      const claude = await claudeCatalog(this.tasks.config, this.tasks.config.claude_sdk.home);
      if (this.closing) return;
      this.tasks.catalogs.set('claude_agent_sdk', {
        status: !catalog.sandboxVerified ? { status: 'unavailable', checked_at: iso(), reason: 'Claude worktree sandbox did not pass the native check.' }
          : claude.models ? { status: 'available', checked_at: iso() }
          : { status: claude.status, checked_at: iso(), reason: claude.reason },
        models: new Map(claude.models?.map(item => [item.id, item.label])),
      });
    }
    this.phase = [...this.tasks.catalogs.values()].some(entry => entry.status.status === 'available') ? 'ready' : 'degraded';
  }

  workspace(attempt: Attempt) {
    return this.store.one<Workspace>('SELECT managed_path,branch_name,state FROM workspaces WHERE workspace_id=?', attempt.workspace_id)!;
  }

  private async reconcile(task: Task) {
    const attempt = this.store.attempt(task.task_id)!;
    this.store.tx(() => {
      this.tasks.closePending(task, 'invalidated');
      this.tasks.rejectMessages(task);
    });
    const details = JSON.parse(attempt.supervision_json ?? '{}') as { pgid?: number; boot?: string };
    let stopped = attempt.process_stop_confirmed_at_ms !== null || attempt.process_pid === null ||
      Boolean(details.boot && details.boot !== this.boot);
    if (!stopped && attempt.process_pid && attempt.process_birth_identity && details.pgid) {
      const process = { pid: attempt.process_pid, pgid: details.pgid, birth: attempt.process_birth_identity };
      const groupStopped = groupGone(process.pgid) || await stopGroup(process);
      stopped = groupStopped && attempt.provider_start_status === 'not_sent';
    }
    if (!stopped) {
      this.recover(task, attempt, 'daemon_restarted', 'The previous worker’s execution could not be fully reconciled. Its worktree is retained.');
      return;
    }
    const state = task.desired_action === 'cancel' ? 'cancelled' : 'interrupted';
    this.finalize(task, attempt, state, 'Previous worker stopped. Recovered the worktree; the live report may be incomplete.');
  }

  confirmStopped(taskId: string, version: number) {
    const task = this.tasks.authorized('console', taskId);
    this.tasks.expectVersion(task, version);
    const attempt = this.store.attempt(taskId);
    if (task.state !== 'recovering' || !attempt || this.workers.has(taskId)) {
      throw conflict('REVIEW_NOT_ALLOWED', 'The task is not awaiting manual reconciliation.');
    }
    const details = JSON.parse(attempt.supervision_json ?? '{}') as { pgid?: number; boot?: string };
    if (details.pgid && (details.boot === this.boot || !details.boot) && !groupGone(details.pgid)) {
      throw conflict('REVIEW_NOT_ALLOWED', 'The recorded process group still exists.');
    }
    this.finalize(task, attempt, task.desired_action === 'cancel' ? 'cancelled' : 'interrupted',
      'The owner confirmed that the old worker and its related processes stopped.');
    return this.tasks.snapshot(this.store.task(taskId)!);
  }

  private tick() {
    if (this.closing) return;
    try {
      for (const [taskId, live] of this.workers) {
        const task = this.store.task(taskId)!;
        const now = Date.now();
        if (['starting', 'running'].includes(task.state)) live.executionMs += now - live.sampledAt;
        live.sampledAt = now;
        const attempt = this.store.attempt(taskId)!;
        const expired = this.store.one("SELECT 1 FROM pending_requests WHERE task_id=? AND state IN ('pending','decision_recorded') AND expires_at_ms<=?", taskId, now);
        if (task.desired_action === 'run' && (expired || live.executionMs >= (live.runtime?.job.profile.execution_minutes ?? 30) * 60_000 ||
          now - attempt.created_at_ms >= (live.runtime?.job.profile.total_minutes ?? 120) * 60_000)) {
          this.store.tx(() => {
            if (expired) this.tasks.closePending(task, 'expired');
            this.tasks.cancelTask(task, expired ? 'The human request expired.' : 'Execution time limit reached.');
          });
        }
        const latest = this.store.task(taskId)!;
        if (latest.desired_action === 'cancel') void this.stop(live, true);
        else if (latest.state === 'running' && live.runtime?.turn && !live.runtime.outcome && !live.message) {
          const command = this.store.one<Command>(
            "SELECT * FROM task_commands WHERE task_id=? AND operation='send_to_task' AND state='queued' ORDER BY rowid LIMIT 1", taskId);
          if (command) live.message = this.deliver(latest, attempt, live.runtime, command).finally(() => { live.message = undefined; });
        }
      }
      if (this.phase !== 'ready') return;
      const active = this.store.all<{ project_id: string; profile_id: string }>(
        "SELECT project_id,profile_id FROM tasks WHERE state IN ('starting','running','waiting_input','cancelling','recovering')");
      let available = 2 - active.length;
      const perProject = new Map<string, number>(), perProfile = new Map<string, number>();
      for (const { project_id, profile_id } of active) {
        perProject.set(project_id, (perProject.get(project_id) ?? 0) + 1);
        perProfile.set(profile_id, (perProfile.get(profile_id) ?? 0) + 1);
      }
      for (const task of this.store.all<Task>("SELECT * FROM tasks WHERE state='queued' ORDER BY created_at_ms,rowid")) {
        if (available <= 0) break;
        if ((perProject.get(task.project_id) ?? 0) >= 2 ||
          (perProfile.get(task.profile_id) ?? 0) >= this.store.acceptedProfile(task).max_active) continue;
        this.start(task);
        available--;
        perProject.set(task.project_id, (perProject.get(task.project_id) ?? 0) + 1);
        perProfile.set(task.profile_id, (perProfile.get(task.profile_id) ?? 0) + 1);
      }
    } catch (error) {
      this.phase = 'degraded';
      console.error('Scheduler stopped accepting new work. Check the local configuration and database.', (error as {code?: string}).code ?? '');
    }
  }

  private start(task: Task) {
    const spec = JSON.parse(task.task_spec_json) as TaskSpec;
    const project = this.store.project(task.project_id);
    const profile = this.store.acceptedProfile(task);
    const version = profile.runtime === 'codex_app_server' ? codexVersion(this.tasks.config) : claudeVersion;
    if (!project || this.tasks.availability(profile).status !== 'available' ||
      !version || (profile.runtime === 'codex_app_server' && !supportedCodexVersion(version)) ||
      ![runtimeIdentity(this.tasks.config, profile.runtime), runtimeIdentity(this.tasks.config, profile.runtime, true)].includes(profile.runtimeIdentity)) {
      this.store.tx(() => {
        this.tasks.rejectMessages(task);
        this.tasks.update(task, 'failed', { error_code: 'PROFILE_UNAVAILABLE',
          result_summary_json: JSON.stringify(this.emptyResult('The accepted project or worker profile is unavailable.')) });
      });
      return;
    }
    const workspace = id(), attemptId = id(), runtimeId = id(), now = Date.now();
    let slot = 1;
    const occupied = new Set(this.store.all<{ managed_path: string }>("SELECT managed_path FROM workspaces WHERE project_id=? AND state<>'removed'", project.id)
      .map(row => row.managed_path));
    let path = join(project.worktreeRoot, project.id + '-' + slot);
    while (occupied.has(path) || existsSync(path)) path = join(project.worktreeRoot, project.id + '-' + ++slot);
    const branch = 'zgent/' + task.task_id;
    this.store.tx(() => {
      this.store.run(`INSERT INTO workspaces(workspace_id,task_id,project_id,managed_path,branch_name,base_commit_oid,
        access_mode,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
      workspace, task.task_id, task.project_id, path, branch, task.base_commit_oid, profile.mode, now, now);
      this.store.run(`INSERT INTO run_attempts(attempt_id,task_id,attempt_no,workspace_id,state,owner_epoch_id,fencing_token,runtime_kind,
        runtime_instance_id,provider_version,provider_model_id,created_at_ms,updated_at_ms)
        VALUES (?,?,1,?,'starting',?,1,?,?,?,?,?,?)`,
      attemptId, task.task_id, workspace, this.store.epoch, profile.runtime, runtimeId,
      version, profile.model, now, now);
      this.tasks.update(task, 'starting');
    });
    const attempt = this.store.attempt(task.task_id)!;
    const live: Live = { executionMs: 0, sampledAt: now };
    this.workers.set(task.task_id, live);
    live.promise = Promise.resolve().then(async () => {
      const latest = () => this.store.task(task.task_id)!;
      let outcome: TurnOutcome | undefined;
      let explanation = '';
      try {
        if (latest().desired_action === 'cancel' || this.closing) throw new Error('cancelled before startup');
        const checkout = this.store.checkout(task.project_id, spec.checkout);
        allocate(checkout.root, path, branch, task.base_commit_oid);
        this.store.run("UPDATE workspaces SET state='ready',updated_at_ms=? WHERE workspace_id=?", Date.now(), workspace);
        if (latest().desired_action === 'cancel' || this.closing) throw new Error('cancelled before startup');
        const resumeThread = spec.resume_task_id ? this.store.attempt(spec.resume_task_id)?.provider_thread_id ?? undefined : undefined;
        if (spec.resume_task_id && !resumeThread) throw new Error('The previous Codex context is unavailable.');
        const start = profile.runtime === 'claude_agent_sdk' ? startClaudeWorker : startCodex;
        const { runtime, release, abort } = start(this.tasks.config, { cwd: path, project: checkout, profile, resumeThread });
        live.runtime = runtime;
        const pid = runtime.rpc.child.pid;
        live.owner = pid === undefined ? undefined : identity(pid);
        if (!live.owner || live.owner.pid !== live.owner.pgid) {
          abort();
          await runtime.rpc.closed;
          throw new Error('process identity');
        }
        try {
          this.store.tx(() => {
            this.store.run(`UPDATE run_attempts SET process_pid=?,process_birth_identity=?,supervision_json=?,updated_at_ms=?
              WHERE attempt_id=?`, pid!, live.owner!.birth, JSON.stringify({ pgid: live.owner!.pgid, boot: this.boot }), Date.now(), attemptId);
            this.store.run("UPDATE workspaces SET state='in_use',updated_at_ms=? WHERE workspace_id=?", Date.now(), workspace);
          });
        } catch (error) {
          abort();
          await runtime.rpc.closed;
          throw error;
        }
        release();
        outcome = await runtime.perform(this.prompt(task), {
          thread: (threadId, model) => this.store.run('UPDATE run_attempts SET provider_thread_id=?,provider_model_id=COALESCE(?,provider_model_id),updated_at_ms=? WHERE attempt_id=?',
            threadId, model ? clip(model, 256) : null, Date.now(), attemptId),
          beforeTurn: () => {
            if (latest().desired_action !== 'run' || this.closing) return false;
            this.store.run("UPDATE run_attempts SET provider_start_status='send_intent_recorded',updated_at_ms=? WHERE attempt_id=?", Date.now(), attemptId);
            return true;
          },
          turn: turnId => this.store.tx(() => {
            const current = latest();
            this.store.run(`UPDATE run_attempts SET provider_turn_id=?,provider_start_status='acknowledged',updated_at_ms=?
              WHERE attempt_id=?`, turnId, Date.now(), attemptId);
            const updated = current.state === 'starting' ? this.tasks.update(current, 'running') : current;
            this.store.event(updated, 'attempt.started', { attempt_id: attemptId, runtime: this.store.runtime(updated),
              base_commit: task.base_commit_oid, profile_revision: this.store.profile(task.profile_id, task.profile_revision)!.config_sha256 });
          }),
          outcome: value => this.store.run('UPDATE run_attempts SET termination_reason=?,updated_at_ms=? WHERE attempt_id=?', value, Date.now(), attemptId),
          request: (frame, patches) => this.interactions.open(task.task_id, attempt, runtime, frame, patches),
          resolved: requestId => this.interactions.resolved(task.task_id, attempt, requestId),
          badFrame: () => { void this.stop(live, false); },
          usage: value => this.store.tx(() => {
            this.store.run("UPDATE run_attempts SET supervision_json=json_set(supervision_json,'$.usage',json(?)) WHERE attempt_id=?",
              JSON.stringify(value), attemptId);
            const current = latest();
            if (!finished(current.state)) this.tasks.update(current, current.state, {}, ['actual_usage']);
          }),
        });
      } catch (error) {
        if (error instanceof RpcFailure && live.runtime) live.runtime.failure = error.category;
        explanation = 'The worktree or worker startup could not complete.';
      }
      const stopped = await this.stop(live, latest().desired_action === 'cancel');
      const recorded = this.store.attempt(task.task_id)!;
      const status = outcome ?? live.runtime?.outcome;
      const activeUnresolved = Boolean(live.runtime?.activeCommands.size) && !(latest().desired_action === 'cancel' && status === 'interrupted');
      if (!stopped || (recorded.provider_start_status !== 'not_sent' &&
        (!status || status === 'disconnected' || activeUnresolved))) {
        const reason = latest().desired_action === 'cancel' ? 'cancellation_unconfirmed' : 'runtime_disconnected';
        this.recover(latest(), recorded, reason, 'The worker or a command could not be confirmed stopped. Its worktree is retained.');
        return;
      }
      this.store.run('UPDATE run_attempts SET process_stop_confirmed_at_ms=?,updated_at_ms=? WHERE attempt_id=?', Date.now(), Date.now(), attemptId);
      const state = latest().desired_action === 'cancel' ? 'cancelled' :
        status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'interrupted' : 'failed';
      this.finalize(latest(), recorded, state, explanation || (status === 'completed' ? 'Codex completed the turn.' :
        state === 'cancelled' ? 'The worker stopped after cancellation.' : 'The worker turn did not complete.'), live.runtime, status);
    }).catch(() => {
      const latest = this.store.task(task.task_id)!;
      if (!finished(latest.state)) {
        try { this.recover(latest, this.store.attempt(task.task_id)!, 'manual_reconciliation', 'The worker stopped reporting reliable state. Inspect its retained worktree.'); }
        catch { this.phase = 'degraded'; }
      }
      console.error('Worker finalization could not complete for task ' + task.task_id);
    }).finally(() => { this.workers.delete(task.task_id); });
  }

  private stop(live: Live, cancelled: boolean) {
    if (!live.runtime || !live.owner) return Promise.resolve(true);
    return live.stopping ??= live.runtime.stop(live.owner, cancelled);
  }

  private async deliver(task: Task, attempt: Attempt, runtime: Worker, command: Command) {
    this.store.run(`UPDATE task_commands SET state='send_intent_recorded',attempt_id=?,expected_fencing_token=?,updated_at_ms=? WHERE command_id=?`,
      attempt.attempt_id, attempt.fencing_token, Date.now(), command.command_id);
    const { message } = JSON.parse(command.payload_json) as { message: string };
    const outcome = await runtime.steer(message).then(value => value ? 'acknowledged' as const : 'rejected' as const,
      () => 'delivery_unknown' as const);
    const current = this.store.one<Command>('SELECT * FROM task_commands WHERE command_id=?', command.command_id);
    if (current?.state === 'send_intent_recorded') this.store.tx(() =>
      this.tasks.commandStatus(this.store.task(task.task_id)!, command, outcome));
  }

  private recover(task: Task, attempt: Attempt, reason: Recovery['reason'], summary: string) {
    this.store.tx(() => {
      this.tasks.closePending(task, 'invalidated');
      this.tasks.rejectMessages(task);
      const recovery: Recovery = { reason, summary, requires_human: true };
      const now = Date.now();
      this.store.run(`UPDATE run_attempts SET state='recovering',supervision_json=?,updated_at_ms=? WHERE attempt_id=?`,
        JSON.stringify({ ...JSON.parse(attempt.supervision_json ?? '{}'), recovery }), now, attempt.attempt_id);
      this.store.run("UPDATE workspaces SET state='quarantined',quarantine_reason=?,updated_at_ms=? WHERE workspace_id=?",
        reason, now, attempt.workspace_id);
      const latest = this.tasks.update(task, 'recovering', {}, ['pending_requests']);
      this.store.event(latest, 'task.recovery_required', { snapshot: this.tasks.snapshot(latest), recovery });
    });
  }

  private emptyResult(summary: string): Result {
    return { outcome_summary: summary, changes: [], verification: [], open_issues: [], artifact_refs: [], truncated: false };
  }

  private finalize(task: Task, attempt: Attempt, state: Terminal, explanation: string, runtime?: Worker, outcome?: TurnOutcome) {
    const path = this.workspace(attempt).managed_path;
    const artifacts: Artifact[] = [];
    const save = (kind: Artifact['kind'], data: string | Buffer) => {
      const artifact = saveArtifact(this.tasks.config.state, task.task_id, attempt.attempt_id, kind, data);
      artifacts.push(artifact);
      return artifact.artifact_id;
    };
    const fullText = runtime?.finalText || explanation;
    const result = this.emptyResult(clip(fullText, 8000));
    result.truncated = Boolean(runtime?.artifactsTruncated);
    let head: string | null = null, dirty = false;
    if (existsSync(path)) {
      try {
        const changes = collect(path, task.base_commit_oid);
        head = changes.head;
        dirty = changes.status.length > 0 || changes.head !== task.base_commit_oid || changes.ignored.length > 0;
        const patchIds: string[] = [];
        for (const [kind, data] of [['diff', changes.cumulative], ['patch', changes.staged]] as const) {
          const text = data.toString('utf8');
          if (redact(text) === text && !changes.sensitive.length) patchIds.push(save(kind, data));
          else result.open_issues.push('A candidate patch contains a sensitive path or credential and was left in the local worktree.');
        }
        if (changes.ignored.length) result.open_issues.push('Git-ignored files are listed in the worktree report and excluded from the patch.');
        const safePaths = changes.paths.map(redact).map(path => clip(path, 1024));
        const summary = save('report', JSON.stringify({
          base_commit: task.base_commit_oid, final_head: head, final_tree: changes.tree, staged_tree: changes.stagedTree,
          changed_paths: changes.paths.length, turn_outcome: outcome ?? null,
          tracked_snapshot: (() => {
            const snapshot = (JSON.parse(task.task_spec_json) as TaskSpec).tracked_snapshot;
            return snapshot ? { original_head: snapshot.original_head, oid: snapshot.oid, excluded_count: snapshot.excluded_untracked.length } : null;
          })(),
          status: changes.status.map(redact), ignored: changes.ignored.map(redact), sensitive_paths_omitted: changes.sensitive.length,
        }, null, 2));
        result.changes.push({ summary: changes.paths.length ? 'Changes collected from Git.' : 'Git found no changes in the candidate patch.',
          paths: [...new Set(safePaths)].slice(0, 50), evidence_artifact_ids: [summary, ...patchIds] });
        result.truncated ||= changes.paths.length > 50;
      } catch {
        result.open_issues.push('Could not collect the complete Git result. Inspect the retained worktree.');
        if (state === 'succeeded') state = 'failed';
      }
    }
    const resultArtifact = save('result', fullText);
    if (runtime?.evidence.length) {
      const log = runtime.evidence.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      const logId = save('log', log);
      result.verification = runtime.evidence.slice(0, 49).map(entry => ({
        check: entry.command || 'Codex command',
        status: entry.exitCode === null ? 'unknown' : entry.exitCode === 0 ? 'passed' : 'failed',
        source: 'runtime_observed', evidence_artifact_ids: [logId],
      }));
      result.truncated ||= runtime.evidence.length > 49;
    }
    if (runtime?.finalText) result.verification.push({ check: 'See the worker report for its claims about verification.',
      status: 'unknown', source: 'model_reported', evidence_artifact_ids: [resultArtifact] });
    result.artifact_refs = artifacts.map(artifact => artifact.artifact_id);

    this.store.tx(() => {
      this.tasks.closePending(task, 'invalidated');
      this.tasks.rejectMessages(task);
      const now = Date.now();
      this.store.run(`UPDATE run_attempts SET state=?,process_stop_confirmed_at_ms=COALESCE(process_stop_confirmed_at_ms,?),
        finished_at_ms=?,updated_at_ms=?,termination_reason=COALESCE(termination_reason,?) WHERE attempt_id=?`,
      state, now, now, now, outcome ?? state, attempt.attempt_id);
      this.store.run('UPDATE workspaces SET state=?,last_observed_head_oid=?,dirty_state=?,updated_at_ms=? WHERE workspace_id=?',
        existsSync(path) ? 'retained' : 'allocation_failed', head, head === null ? 'unknown' : dirty ? 'dirty' : 'clean', now, attempt.workspace_id);
      for (const artifact of artifacts) {
        this.store.run(`INSERT INTO artifacts(artifact_id,task_id,attempt_id,kind,media_type,storage_relative_path,
          content_sha256,size_bytes,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?)`, artifact.artifact_id, artifact.task_id,
          artifact.attempt_id, artifact.kind, artifact.media_type, artifact.storage_relative_path, artifact.content_sha256,
          artifact.size_bytes, artifact.created_at_ms);
      }
      const latest = this.tasks.update(task, state, { result_summary_json: JSON.stringify(result), error_code: state === 'failed' ? runtime?.failure ?? 'WORKER_FAILED' : null });
      this.store.event(latest, 'attempt.finished', { attempt_id: attempt.attempt_id, outcome: state, summary: clip(result.outcome_summary, 2000) });
      for (const artifact of artifacts) this.store.event(latest, 'artifact.created', artifactView(artifact));
      this.store.event(latest, 'task.result_available', { result_artifact_id: resultArtifact, truncated: result.truncated });
    });
  }

  private prompt(task: Task) {
    const spec = JSON.parse(task.task_spec_json) as TaskSpec;
    const content = JSON.stringify({ version: 1, project: task.project_id, base_commit: task.base_commit_oid,
      local_changes_excluded: spec.dirty && !spec.tracked_snapshot && !spec.workspace_snapshot,
      workspace_snapshot: Boolean(spec.tracked_snapshot || spec.workspace_snapshot), goal: spec.brief.goal, acceptance_criteria: spec.brief.acceptance_criteria,
      constraints: spec.brief.constraints ?? [], context: spec.context }, null, 2);
    const prompt = 'Execute this delegated brief. Context is reference material. Report changes, commands actually run, and unresolved issues.\n\n' + content;
    this.store.run('UPDATE run_attempts SET capabilities_json=?,updated_at_ms=? WHERE task_id=?',
      JSON.stringify({ prompt_template: 1, prompt_sha256: hash(prompt), steer: 'active_turn', interrupt: true, persistent_context: this.store.runtime(task).adapter === 'codex_app_server' }), Date.now(), task.task_id);
    return prompt;
  }

  async stopAll() {
    this.closing = true;
    clearInterval(this.timer);
    await this.refreshing;
    for (const [id, live] of this.workers) {
      const task = this.store.task(id)!;
      this.store.tx(() => this.tasks.cancelTask(task, 'The daemon was stopped.'));
      void this.stop(live, true);
    }
    await Promise.allSettled([...this.workers.values()].map(worker => worker.promise));
    const now = Date.now();
    this.store.run('UPDATE daemon_epochs SET stopped_at_ms=?,last_heartbeat_at_ms=? WHERE epoch_id=?', now, now, this.store.epoch);
  }
}
