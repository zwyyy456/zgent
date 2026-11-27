import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Contracts, Input } from '@zgent/contracts';
import type { Artifact, Command, Pending, Store, Task } from '../db/store.ts';
import { human, runtimeIdentity, type Client, type Config, type Profile } from '../policy/config.ts';
import { artifactView, readArtifact } from '../workspaces/artifacts.ts';
import { removeCleanWorktree, resolveBase, retainBase, snapshotCheckout, snapshotTracked } from '../workspaces/git.ts';
import { canonical, clip, conflict, Failure, finished, hash, id, invalid, iso, missing, redact } from './values.ts';
import type { PublicProfile, Snapshot, State } from './values.ts';
import { pageResult, type Result } from './result-page.ts';

type ToolGetData = NonNullable<Extract<Contracts['get_taskOutput'], {ok: true}>['data']>;
type ToolWaitData = NonNullable<Extract<Contracts['wait_tasksOutput'], {ok: true}>['data']>;
type Recovery = NonNullable<Snapshot['recovery']>;
type Operation = 'delegate_task' | 'send_to_task' | 'cancel_task' | 'resolve_pending_request' | 'review_task';
type Grant = { can_submit: number; read_scope: string; control_scope: string; can_read_artifacts: number };
export type TaskSpec = { brief: Input<'delegate_task'>['brief']; dirty: boolean; context: string[];
  checkout?: string; workspace_snapshot?: boolean; tracked_snapshot?: ReturnType<typeof snapshotTracked>; resume_task_id?: string };
export type TurnBase = { id: string; project: string; checkout: string; mode: 'head' | 'snapshot'; resume?: string };
type Submission = { include_tracked_changes?: boolean; resume_task_id?: string; turn?: TurnBase };
type Receipt<T> = { value: T; duplicate: boolean };
type TaskPage = { key: string; rows: Snapshot[]; offset: number; seq: string; expires: number };

export class Tasks {
  store: Store;
  config: Config;
  pages = new Map<string, TaskPage>();
  cursorKey = id();
  catalogs = new Map<Profile['runtime'], { status: PublicProfile['availability']; models: Map<string, string> }>();

  constructor(store: Store, config: Config) {
    this.store = store;
    this.config = config;
  }

  grant(client: Client, project: string): Grant {
    if (client === human && this.store.one('SELECT 1 FROM projects WHERE project_id=?', project)) {
      return { can_submit: 1, read_scope: 'project', control_scope: 'project', can_read_artifacts: 1 };
    }
    const grant = this.store.one<Grant>('SELECT * FROM client_project_grants WHERE client_id=? AND project_id=?', client, project);
    if (!grant) throw missing();
    return grant;
  }

  authorized(client: Client, taskId: string, scope: 'read_scope' | 'control_scope' = 'read_scope') {
    const task = this.store.task(taskId);
    if (!task) throw missing();
    const permission = this.grant(client, task.project_id)[scope];
    if (permission === 'project' || (permission === 'own' && task.created_by_client_id === client)) return task;
    const previous = scope === 'read_scope' && permission === 'own' && client.startsWith('main:') &&
      this.store.one(`SELECT 1 FROM main_sessions current JOIN main_sessions prior ON prior.session_id=current.previous_session_id
        WHERE current.client_id=? AND prior.client_id=? AND prior.project_id=?`, client, task.created_by_client_id, task.project_id);
    if (!previous) throw missing();
    return task;
  }

  pendingSummary(request: Pending): Snapshot['pending_requests'][number] {
    return { pending_request_id: request.request_id, attempt_id: request.attempt_id,
      kind: request.kind as Snapshot['pending_requests'][number]['kind'], summary: clip(JSON.parse(request.request_json).summary, 1000),
      created_at: iso(request.created_at_ms), expires_at: iso(request.expires_at_ms), console_path: '/console/requests/' + request.request_id };
  }

  snapshot(task: Task): Snapshot {
    const attempt = this.store.attempt(task.task_id);
    const pending = this.store.all<Pending>(`SELECT * FROM pending_requests WHERE task_id=? AND state IN ('pending','decision_recorded')
      ORDER BY created_at_ms, request_id LIMIT 9`, task.task_id);
    const artifacts = this.store.all<Artifact>('SELECT * FROM artifacts WHERE task_id=? ORDER BY created_at_ms, rowid LIMIT 17', task.task_id);
    const result = task.result_summary_json ? JSON.parse(task.result_summary_json) as Result : null;
    const spec = JSON.parse(task.task_spec_json) as TaskSpec;
    const dirtyNotice = spec.workspace_snapshot ? ' (workspace snapshot)' : spec.tracked_snapshot
      ? ' (tracked snapshot; ' + spec.tracked_snapshot.excluded_untracked.length + ' untracked files excluded)'
      : spec.dirty ? ' (uses committed base; local changes excluded)' : '';
    return {
      task_id: task.task_id, project_id: task.project_id, profile_id: task.profile_id, state: task.state,
      version: task.state_version, review_state: task.review_state, created_at: iso(task.created_at_ms), updated_at: iso(task.updated_at_ms),
      summary: clip(result?.outcome_summary || task.title + dirtyNotice, 2000),
      ...(attempt ? { latest_attempt_id: attempt.attempt_id, started_at: iso(attempt.created_at_ms), runtime: this.store.runtime(task) } : {}),
      ...(attempt?.supervision_json && JSON.parse(attempt.supervision_json).usage
        ? { actual_usage: JSON.parse(attempt.supervision_json).usage } : {}),
      ...(task.finished_at_ms !== null ? { completed_at: iso(task.finished_at_ms) } : {}),
      ...(task.state === 'recovering' ? { recovery: JSON.parse(attempt?.supervision_json ?? '{}').recovery as Recovery } : {}),
      pending_requests: pending.slice(0, 8).map(request => this.pendingSummary(request)),
      pending_requests_truncated: pending.length > 8,
      artifacts: artifacts.slice(0, 16).map(artifactView), artifacts_truncated: artifacts.length > 16,
    };
  }

  update(task: Task, next: State, fields: Record<string, string | number | null> = {}, changedFields: string[] = ['summary']) {
    const now = Math.max(Date.now(), task.updated_at_ms);
    if (task.state !== next && ['running', 'waiting_input', 'cancelling'].includes(next)) {
      this.store.run('UPDATE run_attempts SET state=?,updated_at_ms=? WHERE task_id=? AND finished_at_ms IS NULL',
        next, now, task.task_id);
    }
    const extras = Object.entries(fields);
    this.store.run(`UPDATE tasks SET state=?, state_version=state_version+1, updated_at_ms=?,
      finished_at_ms=? ${extras.map(([name]) => ', ' + name + '=?').join('')} WHERE task_id=?`,
      next, now, task.finished_at_ms ?? (finished(next) ? now : null), ...extras.map(([, value]) => value), task.task_id);
    const updated = this.store.task(task.task_id)!;
    const snapshot = this.snapshot(updated);
    if (task.state === next) this.store.event(updated, 'task.updated', { snapshot, changed_fields: changedFields });
    else this.store.event(updated, 'task.state_changed', { from_state: task.state, to_state: next, snapshot });
    return updated;
  }

  remember<T>(client: Client, operation: Operation, request: string, payload: unknown,
    action: () => { task: string; value: T }): Receipt<T> {
    return this.store.tx(() => {
      const digest = hash(canonical(payload));
      const previous = this.store.one<{canonical_payload_sha256: string; response_json: string}>(
        'SELECT canonical_payload_sha256,response_json FROM idempotency_keys WHERE client_id=? AND operation=? AND request_id=?',
        client, operation, request);
      if (previous) {
        if (digest !== previous.canonical_payload_sha256) throw new Failure(409, 'IDEMPOTENCY_CONFLICT', 'Request ID already has a different payload.');
        return { value: JSON.parse(previous.response_json) as T, duplicate: true };
      }
      const now = Date.now();
      this.store.run("INSERT INTO idempotency_keys VALUES (?,?,?,?,'in_progress',NULL,NULL,?,?)", client, operation, request, digest, now, now);
      const { task, value } = action();
      this.store.run(`UPDATE idempotency_keys SET state='completed',task_id=?,response_json=?,updated_at_ms=?
        WHERE client_id=? AND operation=? AND request_id=?`, task, JSON.stringify(value), Date.now(), client, operation, request);
      return { value, duplicate: false };
    });
  }

  delegate(client: Client, input: Input<'delegate_task'>, controls?: Submission) {
    const turn = controls?.turn;
    if (!this.grant(client, input.project_id).can_submit || (controls && client !== human && turn?.project !== input.project_id)) throw missing();
    const payload = controls ? { input, ...controls } : input;
    const { value, duplicate } = this.remember(client, 'delegate_task', input.request_id, payload, () => {
      const project = this.store.checkout(input.project_id, turn?.checkout);
      const profile = this.config.profiles.find(item => item.id === input.profile_id);
      if (!project || !profile || (client !== human && !this.store.one('SELECT 1 FROM client_profile_grants WHERE client_id=? AND profile_id=?', client, profile.id))) throw missing();
      const availability = this.availability(profile);
      if (availability.status !== 'available') {
        throw new Failure(409, 'NOT_READY', availability.reason ?? 'Configured model is unavailable.',
          availability.status === 'model_unavailable' ? 'MODEL_UNAVAILABLE' : 'PROFILE_UNAVAILABLE');
      }
      let base: string, dirty: boolean;
      try {
        ({ base, dirty } = resolveBase(project.root, turn || project.personal ? 'HEAD' : project.base_ref,
          turn ? undefined : input.base_commit?.toLowerCase()));
      }
      catch { throw invalid('Base commit must be reachable from the registered base branch.'); }
      const context = (input.brief.context_artifact_ids ?? []).map(artifactId => {
        const { artifact, task } = this.artifact(client, artifactId);
        if (task.project_id !== input.project_id) throw missing();
        return artifactId + '\n' + clip(readArtifact(this.config.state, artifact, 0, 8000).toString('utf8'), 2000);
      });
      const spec: TaskSpec = { brief: { ...input.brief, goal: redact(input.brief.goal),
        acceptance_criteria: input.brief.acceptance_criteria.map(redact) as [string, ...string[]],
        constraints: input.brief.constraints?.map(redact) }, dirty, context, checkout: project.root };
      const resume = turn?.resume ?? controls?.resume_task_id;
      if (resume) {
        const previous = this.authorized(human, resume);
        const attempt = this.store.attempt(previous.task_id);
        const prior = this.store.acceptedProfile(previous);
        if (previous.project_id !== project.id || !finished(previous.state) ||
            !attempt?.process_stop_confirmed_at_ms || !attempt.provider_thread_id || !attempt.provider_turn_id ||
            !JSON.parse(attempt.capabilities_json ?? '{}').persistent_context || profile.runtime !== 'codex_app_server' ||
            prior.runtime !== 'codex_app_server' || ![runtimeIdentity(this.config), runtimeIdentity(this.config, prior.runtime, true)].includes(prior.runtimeIdentity)) {
          throw conflict('REVIEW_NOT_ALLOWED', 'The previous task does not have an eligible stopped Codex context for this project.');
        }
        spec.resume_task_id = previous.task_id;
      }
      if (turn) {
        const fixed = this.store.one<{ base_oid: string | null }>('SELECT base_oid FROM main_turns WHERE turn_id=?', turn.id);
        if (!fixed) throw missing();
        if (fixed.base_oid) base = fixed.base_oid;
        else {
          if (turn.mode === 'snapshot') {
            try { base = snapshotCheckout(project.root, base); }
            catch { throw invalid('The current checkout could not be snapshotted.'); }
          }
          this.store.run('UPDATE main_turns SET base_oid=? WHERE turn_id=?', base, turn.id);
        }
        spec.workspace_snapshot = turn.mode === 'snapshot';
      }
      if (controls?.include_tracked_changes) {
        try { spec.tracked_snapshot = snapshotTracked(project.root, base); }
        catch { throw invalid('A tracked snapshot requires the registered checkout HEAD to match the selected base.'); }
        base = spec.tracked_snapshot.oid;
      }
      const snapshot = this.store.profile(profile.id)!;
      const taskId = id();
      retainBase(project.root, taskId, base);
      const now = Date.now();
      this.store.run(`INSERT INTO tasks(task_id,project_id,created_by_client_id,conversation_tag,profile_id,profile_revision,title,
        task_spec_json,task_spec_sha256,base_commit_oid,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        taskId, project.id, client, input.conversation_tag ? redact(input.conversation_tag) : null, profile.id, snapshot.revision,
        clip(spec.brief.goal.trim() || 'Untitled task', 200), JSON.stringify(spec), hash(canonical(spec)), base, now, now);
      const task = this.store.task(taskId)!;
      const taskView = this.snapshot(task);
      this.store.event(task, 'task.created', { snapshot: taskView });
      return { task: taskId, value: { task: taskView, resolved: { profile_revision: snapshot.config_sha256,
        base_commit: base, model_id: profile.model, adapter: profile.runtime } } };
    });
    return { ...value, deduplicated: duplicate };
  }

  workspaceInfo(task: Task) {
    const workspace = this.store.one<{ managed_path: string; state: string; dirty_state: string }>(
      'SELECT managed_path,state,dirty_state FROM workspaces WHERE task_id=?', task.task_id);
    const spec = JSON.parse(task.task_spec_json) as TaskSpec;
    const attempt = this.store.attempt(task.task_id);
    const canResume = finished(task.state) && Boolean(attempt?.provider_thread_id && attempt.provider_turn_id && attempt.process_stop_confirmed_at_ms &&
      JSON.parse(attempt.capabilities_json ?? '{}').persistent_context);
    return { task_id: task.task_id, base_commit: task.base_commit_oid, tracked_snapshot: spec.tracked_snapshot ?? null,
      workspace: workspace ?? null, can_resume_context: canResume, error_code: task.error_code };
  }

  retainedWorkspaces(project: string) {
    this.grant(human, project);
    return this.store.all<{ task_id: string; title: string; managed_path: string; state: string; dirty_state: string }>(
      `SELECT w.task_id,t.title,w.managed_path,w.state,w.dirty_state FROM workspaces w JOIN tasks t ON t.task_id=w.task_id
       WHERE w.project_id=? AND w.state IN ('retained','quarantined','allocation_failed') ORDER BY w.updated_at_ms DESC`, project);
  }

  removeWorkspace(taskId: string) {
    const task = this.authorized(human, taskId);
    const workspace = this.store.one<{ managed_path: string; branch_name: string; state: string }>(
      'SELECT managed_path,branch_name,state FROM workspaces WHERE task_id=?', taskId);
    if (!workspace) throw missing();
    if (workspace.state === 'removed') return this.workspaceInfo(task);
    const attempt = this.store.attempt(taskId);
    const project = this.store.project(task.project_id);
    const artifacts = this.store.all<Artifact>('SELECT * FROM artifacts WHERE task_id=?', taskId);
    if (!project || !finished(task.state) || !attempt?.process_stop_confirmed_at_ms || workspace.state !== 'retained' ||
        !artifacts.some(artifact => artifact.kind === 'report')) {
      throw conflict('REVIEW_NOT_ALLOWED', 'Cleanup requires a retained worktree, recorded artifacts and a confirmed worker stop.');
    }
    for (const artifact of artifacts) readArtifact(this.config.state, artifact, 0, 0);
    try { removeCleanWorktree(project.root, workspace.managed_path, workspace.branch_name); }
    catch { throw conflict('REVIEW_NOT_ALLOWED', 'Git could not remove this worktree. Check for local files, changes or a Git lock.'); }
    const now = Date.now();
    this.store.run("UPDATE workspaces SET state='removed', dirty_state='clean', updated_at_ms=?, removed_at_ms=? WHERE workspace_id=?",
      now, now, attempt.workspace_id);
    return this.workspaceInfo(task);
  }

  availability(profile: Profile): PublicProfile['availability'] {
    const catalog = this.catalogs.get(profile.runtime);
    if (!catalog) return { status: 'unavailable', reason: 'Runtime startup checks are pending.', checked_at: iso() };
    if (catalog.status.status !== 'available') return catalog.status;
    return catalog.models.has(profile.model) ? catalog.status :
      { ...catalog.status, status: 'model_unavailable', reason: 'The configured model is absent from the runtime model list.' };
  }

  catalog() {
    return [...this.catalogs].map(([runtime, catalog]) => ({
      runtime, availability: catalog.status, models: [...catalog.models].map(([id, label]) => ({ id, label })),
    }));
  }

  profiles(client: Client, project: string) {
    this.grant(client, project);
    const profiles = this.config.profiles.filter(profile => client === human ||
      this.store.one('SELECT 1 FROM client_profile_grants WHERE client_id=? AND profile_id=?', client, profile.id))
      .map((profile): PublicProfile => {
        const model = this.catalogs.get(profile.runtime)?.models.get(profile.model);
        const codex = profile.runtime === 'codex_app_server';
        return ({
        profile_id: profile.id, revision: this.store.profile(profile.id)!.config_sha256, display_name: profile.label,
        description: (profile.mode === 'workspace_write' ? 'Writable isolated worktree.' : 'Read-only worktree.') +
          (profile.network_domains.length ? ' Tool network limited to owner-configured domains.' : ' Tool network disabled.') +
          ` Execution ${profile.execution_minutes} min, request ${profile.request_minutes} min, total ${profile.total_minutes} min; up to ${profile.max_active} active.`,
        roles: [profile.mode === 'read_only' ? 'reviewer' : 'worker'], provider: codex ? 'openai' : 'anthropic', adapter: profile.runtime,
        model: { id: profile.model, display_name: model ?? profile.model,
          catalog_source: model ? 'runtime_reported' : 'operator_configured' },
        availability: this.availability(profile), permission_policy_id: profile.id,
        billing: { authentication: codex ? 'native_cli_login' : this.config.claude_sdk?.authentication === 'api_key' ? 'api_key' : 'cloud_identity', billing_channel: profile.billing,
          extra_charges: profile.billing === 'api_metered' ? 'possible' : 'not_reported', source: 'operator_configured',
          note: 'Operator-configured billing channel.' },
      }); });
    return { project_id: project, profiles };
  }

  list(client: Client, project: string, statuses: State[], limit: number, cursor?: string) {
    const grant = this.grant(client, project);
    const key = canonical({ client, project, statuses: [...statuses].sort(), limit });
    const now = Date.now();
    for (const [id, page] of this.pages) if (page.expires <= now) this.pages.delete(id);
    let page: TaskPage;
    if (cursor) {
      const known = this.pages.get(cursor);
      if (!known || known.key !== key) throw new Failure(410, 'LIST_CURSOR_EXPIRED', 'Reload the task list to begin a new snapshot.', 'CURSOR_EXPIRED');
      page = known;
    } else {
      const rows = this.store.all<Task>(`SELECT * FROM tasks WHERE project_id=? AND (?='project' OR created_by_client_id=?)
        ${statuses.length ? 'AND state IN (' + statuses.map(() => '?').join(',') + ')' : ''}
        ORDER BY created_at_ms DESC, rowid DESC`, project, grant.read_scope, client, ...statuses);
      const seq = this.store.one<{seq: string}>('SELECT CAST(COALESCE(MAX(event_seq),0) AS TEXT) AS seq FROM events')!.seq;
      page = { key, rows: rows.map(row => this.snapshot(row)), offset: 0, seq, expires: now + 120_000 };
    }
    const offset = page.offset + limit;
    const next = offset < page.rows.length ? id() : null;
    if (next) {
      if (this.pages.size >= 64) this.pages.delete(this.pages.keys().next().value!);
      this.pages.set(next, { ...page, offset });
    }
    return { project_id: project, tasks: page.rows.slice(page.offset, offset), next_cursor: next, snapshot_event_cursor: page.seq };
  }

  artifact(client: Client, artifactId: string) {
    const artifact = this.store.one<Artifact>('SELECT * FROM artifacts WHERE artifact_id=?', artifactId);
    if (!artifact) throw missing();
    const task = this.authorized(client, artifact.task_id);
    if (!this.grant(client, task.project_id).can_read_artifacts) throw missing();
    return { artifact, task };
  }

  readSlice(client: Client, artifactId: string, offset: number, limit: number): Contracts['ArtifactSlice'] {
    const { artifact, task } = this.artifact(client, artifactId);
    const data = readArtifact(this.config.state, artifact, offset, limit);
    const next = offset + data.length;
    const eof = next >= artifact.size_bytes;
    return { artifact: { ...artifactView(artifact), task_id: task.task_id, project_id: task.project_id,
      attempt_id: artifact.attempt_id }, offset_bytes: offset, returned_bytes: data.length,
      content_encoding: 'base64', data_base64: data.toString('base64'), next_offset_bytes: eof ? null : next, eof };
  }

  get(client: Client, input: Input<'get_task'>): ToolGetData {
    const task = this.authorized(client, input.task_id);
    const snapshot = this.snapshot(task);
    const section = input.section ?? 'summary';
    const response = { task: snapshot, section };
    if (section === 'summary') return response;
    if (!this.grant(client, task.project_id).can_read_artifacts) throw missing();
    const kind = section === 'logs' ? 'log' : section;
    const artifact = this.store.one<Artifact>('SELECT * FROM artifacts WHERE task_id=? AND kind=? ORDER BY rowid DESC LIMIT 1', task.task_id, kind);
    const key = hash(this.cursorKey + canonical({ client, task: task.task_id, section, artifact: artifact?.artifact_id }));
    let offset = 0;
    if (input.cursor) {
      const [sig, bytes, ...rest] = input.cursor.split('.');
      if (!artifact || sig !== hash(key + '.' + bytes) || !/^\d+$/.test(bytes) || rest.length || !Number.isSafeInteger(Number(bytes))) {
        throw new Failure(410, 'LIST_CURSOR_EXPIRED', 'Reload the first content page.', 'CURSOR_EXPIRED');
      }
      offset = Number(bytes);
    }
    if (!artifact) return response;
    const max = input.max_chars ?? 8000;
    const cursor = (next: number) => hash(key + '.' + next) + '.' + next;
    if (section === 'result') {
      const result = JSON.parse(task.result_summary_json!) as Result;
      const text = readArtifact(this.config.state, artifact, 0, artifact.size_bytes).toString('utf8');
      const { next, ...page } = pageResult(result, text, offset, max);
      return { ...response, page: { kind: 'result', ...page, next_cursor: next === null ? null : cursor(next) } };
    }
    const bytes = readArtifact(this.config.state, artifact, offset, max * 4);
    const chars = Array.from(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes, { stream: offset + bytes.length < artifact.size_bytes })).slice(0, max);
    const content = chars.join('');
    const next = offset + Buffer.byteLength(content);
    const more = next < artifact.size_bytes;
    return { ...response, page: { kind: section, content, returned_chars: chars.length, truncated: more,
      next_cursor: more ? cursor(next) : null } };
  }

  async wait(client: Client, input: Input<'wait_tasks'>, signal: AbortSignal): Promise<ToolWaitData> {
    const start = performance.now();
    const budget = (input.timeout_seconds ?? 20) * 1000;
    const read = () => input.task_ids.map(id => this.snapshot(this.authorized(client, id))) as ToolWaitData['tasks'];
    const first = read();
    let tasks = first;
    while (true) {
      const reason = tasks.every(task => finished(task.state)) ? 'all_terminal' :
        tasks.some(task => task.state === 'waiting_input' || task.state === 'recovering') ? 'input_required' :
        tasks.some((task, i) => task.version !== first[i].version) ? 'state_changed' :
        performance.now() - start >= budget ? 'timeout' : null;
      if (reason) return { reason, tasks, waited_ms: Math.round(performance.now() - start) };
      await delay(Math.min(200, Math.max(1, budget - (performance.now() - start))), undefined, { signal });
      tasks = read();
    }
  }

  send(client: Client, input: Input<'send_to_task'>) {
    const task = this.authorized(client, input.task_id, 'control_scope');
    const { value, duplicate } = this.remember(client, 'send_to_task', input.request_id, input, () => {
      if (!['queued', 'starting', 'running', 'waiting_input'].includes(task.state)) {
        throw new Failure(409, 'REQUEST_RESOLVED', 'Task is not accepting messages.', 'TASK_NOT_ACTIVE');
      }
      const now = Date.now(), command = id();
      this.store.run(`INSERT INTO task_commands(command_id,task_id,created_by_client_id,operation,request_id,payload_json,created_at_ms,updated_at_ms)
        VALUES (?,?,?,'send_to_task',?,?,?,?)`, command, task.task_id, client, input.request_id,
        JSON.stringify({ message: redact(input.message) }), now, now);
      const receipt = { message_id: command, request_id: input.request_id, status: 'queued' as const, received_at: iso(now), effective_mode: this.store.runtime(task).adapter === 'claude_agent_sdk' ? 'after_current_tools' as const : 'active_turn' as const };
      this.store.event(task, 'message.status_changed', receipt);
      return { task: task.task_id, value: { task: this.snapshot(task), receipt } };
    });
    return { ...value, deduplicated: duplicate };
  }

  cancel(client: Client, taskId: string, request: string, reason?: string, version?: number) {
    const task = this.authorized(client, taskId, 'control_scope');
    return this.remember(client, 'cancel_task', request, { taskId, reason, version }, () => {
      this.expectVersion(task, version);
      const now = Date.now();
      const terminal = finished(task.state);
      const updated = this.cancelTask(task, reason);
      this.store.run(`INSERT INTO task_commands(command_id,task_id,created_by_client_id,operation,request_id,payload_json,state,created_at_ms,updated_at_ms)
        VALUES (?,?,?,'cancel_task',?,?,'acknowledged',?,?)`, id(), taskId, client, request, JSON.stringify({ reason: reason ? redact(reason) : null }), now, now);
      return { task: taskId, value: { disposition: terminal ? 'already_terminal' as const : 'accepted' as const,
        task: this.snapshot(updated), requestedAt: iso(now) } };
    });
  }

  cancelTask(task: Task, reason?: string) {
    if (finished(task.state) || task.desired_action === 'cancel') return task;
    this.closePending(task, 'cancelled');
    if (task.state === 'queued') this.rejectMessages(task);
    return this.update(task, task.state === 'queued' ? 'cancelled' : task.state === 'recovering' ? 'recovering' : 'cancelling',
      { desired_action: 'cancel', cancel_requested_at_ms: Date.now(), cancel_reason: reason ? redact(reason) : null });
  }

  closePending(task: Task, reason: 'cancelled' | 'expired' | 'invalidated') {
    const rows = this.store.all<Pending>("SELECT * FROM pending_requests WHERE task_id=? AND state IN ('pending','decision_recorded')", task.task_id);
    const now = Date.now();
    for (const entry of rows) {
      const state = reason === 'expired' && entry.expires_at_ms <= now ? 'expired' : 'invalidated';
      this.store.run(`UPDATE pending_requests SET state=?,revision=revision+1,updated_at_ms=?,
        delivery_state=CASE WHEN state='decision_recorded' AND delivery_state='not_sent' THEN 'delivery_unknown' ELSE delivery_state END
        WHERE request_id=?`, state, now, entry.request_id);
      this.store.event(task, 'interaction.closed', { pending_request_id: entry.request_id, attempt_id: entry.attempt_id,
        reason: state === 'expired' ? 'expired' : reason === 'cancelled' ? 'cancelled' : 'invalidated',
        decision_source: entry.decision_json ? 'human_ui' : 'none', resolved_at: iso(now) });
    }
  }

  commandStatus(task: Task, command: Command, state: 'acknowledged' | 'rejected' | 'delivery_unknown') {
    const now = Date.now();
    this.store.run('UPDATE task_commands SET state=?,updated_at_ms=? WHERE command_id=?', state, now, command.command_id);
    this.store.event(task, 'message.status_changed', { message_id: command.command_id, request_id: command.request_id,
      received_at: iso(command.created_at_ms),
      ...(state === 'acknowledged' ? { status: 'delivered', effective_mode: this.store.runtime(task).adapter === 'claude_agent_sdk' ? 'after_current_tools' : 'active_turn', delivered_at: iso(now) } :
        { status: 'rejected', reason: state === 'delivery_unknown' ? 'Delivery could not be confirmed; the message will not be replayed.' : 'The active turn has ended.' }) });
  }

  rejectMessages(task: Task) {
    const messages = this.store.all<Command>(`SELECT * FROM task_commands WHERE task_id=? AND operation='send_to_task'
      AND state IN ('queued','send_intent_recorded')`, task.task_id);
    for (const message of messages) this.commandStatus(task, message, message.state === 'queued' ? 'rejected' : 'delivery_unknown');
  }

  review(taskId: string, input: Contracts['TaskReviewCommand']) {
    const task = this.authorized(human, taskId);
    return this.remember(human, 'review_task', input.request_id, { taskId, ...input }, () => {
      this.expectVersion(task, input.expected_version);
      if (!finished(task.state)) throw conflict('REVIEW_NOT_ALLOWED', 'Only finished tasks can be reviewed.');
      const now = Date.now();
      const updated = this.update(task, task.state, { review_state: input.review_state, reviewed_by_client_id: human,
        reviewed_at_ms: now }, ['review_state']);
      return { task: taskId, value: { request_id: input.request_id, status: 'recorded' as const, task: this.snapshot(updated), recorded_at: iso(now) } };
    }).value;
  }

  expectVersion(task: Task, expected?: number) {
    if (expected !== undefined && task.state_version !== expected) throw conflict('REVISION_MISMATCH', 'Task changed. Reload before taking action.');
  }
}

export function sameSecret(left: unknown, right: string) {
  return typeof left === 'string' && timingSafeEqual(Buffer.from(hash(left)), Buffer.from(hash(right)));
}
