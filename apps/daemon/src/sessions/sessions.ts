import type { MainSessionDetail, MainSessionView } from '@zgent/contracts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerResponse } from 'node:http';
import type { Tasks, TurnBase } from '../core/tasks.ts';
import { clip, conflict, Failure, finished, hash, id, iso, missing, redact } from '../core/values.ts';
import { sameSecret } from '../core/tasks.ts';
import { secret, type Agent, type MainProfile } from '../policy/config.ts';
import { agyRuntime } from '../providers/agy/agy.ts';
import { claudeEnvironment } from '../providers/claude/sdk.ts';
import { claudeMain } from '../providers/claude/main.ts';
import type { MainRuntime, ModelChoice } from './runtime.ts';
import type { Task } from '../db/store.ts';

type Session = {
  session_id: string; project_id: string; client_id: Agent; previous_session_id: string | null; title: string;
  profile_json: string; native_session_id: string | null; runtime_version: string | null;
  checkout: string | null; default_worker: string | null; base_mode: 'head' | 'snapshot';
  state: 'ready' | 'running' | 'waiting_input' | 'stopping' | 'disconnected' | 'closed';
  created_at_ms: number; updated_at_ms: number;
};
type Turn = {
  turn_id: string; session_id: string; input_sha256: string; input: string; output: string;
  state: 'running' | 'completed' | 'cancelled' | 'disconnected' | 'failed';
  usage_json: string | null; error_summary: string | null; created_at_ms: number; completed_at_ms: number | null;
  base_mode: 'head' | 'snapshot'; resume_task_id: string | null;
  summary_of: string | null;
};
type Live = { token: string; client: Agent; runtime?: MainRuntime; turn?: string; output: string;
  interrupted: boolean; models: ModelChoice[]; startup?: AbortController; done?: Promise<void>; evidenceOnly?: boolean };

export class Sessions {
  tasks: Tasks;
  live = new Map<string, Live>();
  closing = false;

  constructor(tasks: Tasks) { this.tasks = tasks; }
  get store() { return this.tasks.store; }
  get config() { return this.tasks.config; }

  profiles(project: string) {
    this.tasks.grant('console', project);
    return this.config.main_profiles.filter(profile => !profile.projects.length || profile.projects.includes(project)).map(profile => ({
      ...profile,
      available: profile.runtime === 'antigravity_acp' ? Boolean(this.config.agy) : Boolean(claudeEnvironment(this.config)),
    }));
  }

  get(id: string) {
    const session = this.store.one<Session>('SELECT * FROM main_sessions WHERE session_id=?', id);
    if (!session) throw missing();
    return session;
  }

  list(project: string) {
    this.tasks.grant('console', project);
    return this.store.all<Session>('SELECT * FROM main_sessions WHERE project_id=? ORDER BY updated_at_ms DESC', project)
      .map(session => this.view(session));
  }

  view(session: Session): MainSessionView {
    const active = this.live.get(session.session_id);
    let state = session.state;
    if (state === 'running') {
      const waiting = this.store.one("SELECT 1 FROM tasks WHERE created_by_client_id=? AND conversation_tag=? AND state='waiting_input'",
        session.client_id, active?.turn ?? '');
      if (waiting) state = 'waiting_input';
    }
    const profile = JSON.parse(session.profile_json) as MainProfile;
    return {
      session_id: session.session_id, project_id: session.project_id, title: session.title, state,
      profile, previous_session_id: session.previous_session_id,
      checkout: session.checkout, default_worker: session.default_worker ?? this.defaultWorker(profile), base_mode: session.base_mode,
      updated_at: iso(session.updated_at_ms), runtime_version: session.runtime_version,
    };
  }

  detail(sessionId: string): MainSessionDetail {
    const session = this.get(sessionId);
    const active = this.live.get(sessionId);
    const turns = this.store.all<Turn>('SELECT * FROM main_turns WHERE session_id=? ORDER BY created_at_ms,rowid', sessionId);
    const related = this.store.all<Task & {conversation_tag: string}>(`SELECT * FROM tasks WHERE created_by_client_id=?
      OR created_by_client_id=(SELECT client_id FROM main_sessions WHERE session_id=?) ORDER BY created_at_ms,rowid`,
    session.client_id, session.previous_session_id);
    return {
      ...this.view(session),
      models: active?.models ?? [],
      turns: turns.map(turn => ({
        turn_id: turn.turn_id, input: turn.input, output: active?.turn === turn.turn_id ? redact(active.output) : turn.output,
        state: turn.state, error: turn.error_summary, usage: turn.usage_json ? JSON.parse(turn.usage_json) : null,
        created_at: iso(turn.created_at_ms), completed_at: turn.completed_at_ms === null ? null : iso(turn.completed_at_ms), summary_of: turn.summary_of,
      })),
      tasks: related.map(task => ({ turn_id: task.conversation_tag, snapshot: this.tasks.snapshot(task) })),
      notifications: this.store.all<{ event_id: string; task_id: string; state: string }>(`SELECT e.event_id,e.task_id,json_extract(e.payload_json,'$.to_state') state
        FROM events e JOIN tasks t ON t.task_id=e.task_id WHERE t.created_by_client_id=?
        AND e.event_type='task.state_changed' AND json_extract(e.payload_json,'$.to_state') IN ('succeeded','failed','interrupted','cancelled','recovering','waiting_input')
        ORDER BY e.event_seq DESC LIMIT 30`, session.client_id),
    };
  }

  private profile(project: string, id: string) {
    const profile = this.config.main_profiles.find(item => item.id === id && (!item.projects.length || item.projects.includes(project)));
    if (!profile) throw missing();
    return profile;
  }

  private defaultWorker(profile: MainProfile) {
    return profile.worker_profiles.includes(this.config.default_worker) ? this.config.default_worker : profile.worker_profiles[0];
  }

  private runtimeContext(sessionId: string, live: Live) {
    const cwd = join(this.config.state, 'main-sessions', sessionId);
    mkdirSync(cwd, { mode: 0o700, recursive: true });
    return { cwd, mcp: { url: this.config.origin + '/mcp', token: live.token } };
  }

  async create(project: string, profileId: string, title: string, previous?: Session, path?: string) {
    if (this.closing) throw conflict('REVIEW_NOT_ALLOWED', 'The daemon is stopping.');
    this.tasks.grant('console', project);
    const checkout = this.store.checkout(project, path ?? previous?.checkout ?? undefined);
    let profile = this.profile(project, profileId);
    const sessionId = id(), client = ('main:' + sessionId) as Agent;
    const label = clip(redact(title), 160);
    let live: Live | undefined, version: string | null = null;
    try {
      if (profile.runtime === 'antigravity_acp') {
        const startup = new AbortController();
        const preparing: Live = { token: secret(), client, output: '', interrupted: false, models: [], startup };
        const { cwd, mcp } = this.runtimeContext(sessionId, preparing);
        this.live.set(sessionId, preparing);
        live = preparing;
        preparing.done = agyRuntime(this.config, cwd, mcp, undefined, startup.signal).then(runtime => {
          preparing.runtime = runtime;
          preparing.models = runtime.models;
          const model = runtime.models.some(choice => choice.id === profile.model) ? profile.model : runtime.currentModel;
          if (!model || !runtime.models.some(choice => choice.id === model)) {
            throw new Error('The ACP session did not advertise a usable default model.');
          }
          profile = { ...profile, model };
          version = runtime.version ? clip(runtime.version, 128) : null;
        });
        try { await preparing.done; }
        catch (error) {
          const message = error instanceof Error ? error.message : '';
          throw new Failure(409, 'NOT_READY', /^(?:The ACP|Antigravity ACP|This ACP|ACP did)/.test(message)
            ? clip(redact(message), 400) : 'Antigravity ACP could not start.', 'UNAVAILABLE');
        }
        if (this.closing) throw conflict('REVIEW_NOT_ALLOWED', 'The daemon is stopping.');
      }
      const now = Date.now();
      this.store.tx(() => {
        this.store.run("INSERT INTO clients(client_id,principal_id,kind,label,host_kind,created_at_ms) VALUES (?,'owner','agent_client',?,?,?)",
          client, label, profile.runtime, now);
        this.store.run(`INSERT INTO main_sessions(session_id,project_id,client_id,previous_session_id,title,profile_json,state,created_at_ms,updated_at_ms,runtime_version,checkout,base_mode)
          VALUES (?,?,?,?,?,?,'ready',?,?,?,?,?)`, sessionId, project, client, previous?.session_id ?? null, label, JSON.stringify(profile),
          now, now, version, checkout.root, previous?.base_mode ?? (path ? 'snapshot' : 'head'));
      });
    } catch (error) {
      this.live.delete(sessionId);
      await live?.runtime?.close();
      throw error;
    }
    return this.detail(sessionId);
  }

  async changeProfile(sessionId: string, profileId: string, model?: string) {
    const session = this.get(sessionId);
    if ((session.state !== 'ready' && session.state !== 'disconnected') || this.live.get(sessionId)?.turn) {
      throw conflict('REVIEW_NOT_ALLOWED', 'Finish or stop the current turn before switching models.');
    }
    const next = this.profile(session.project_id, profileId);
    const previous = JSON.parse(session.profile_json) as MainProfile;
    if (previous.runtime !== next.runtime) return this.create(session.project_id, profileId, session.title, session);
    const choices = this.live.get(sessionId)?.models ?? [];
    if (model && !choices.some(choice => choice.id === model)) throw conflict('REVIEW_NOT_ALLOWED', 'Select a model advertised by this runtime.');
    const profile = { ...next, model: model ?? (profileId === previous.id ? previous.model : next.model || previous.model) };
    this.store.run('UPDATE main_sessions SET profile_json=?,updated_at_ms=? WHERE session_id=?', JSON.stringify(profile), Date.now(), sessionId);
    return this.detail(sessionId);
  }

  async models(sessionId: string) {
    const session = this.get(sessionId);
    const profile = JSON.parse(session.profile_json) as MainProfile;
    const existing = this.live.get(sessionId);
    if (this.closing || session.state === 'closed' || profile.runtime !== 'antigravity_acp' || existing?.runtime || existing?.turn) {
      return this.detail(sessionId);
    }
    const live = existing ?? { token: secret(), client: session.client_id, output: '', interrupted: false, models: [] };
    if (!live.startup || !live.done) {
      live.startup = new AbortController();
      const { cwd, mcp } = this.runtimeContext(sessionId, live);
      this.live.set(sessionId, live);
      live.done = agyRuntime(this.config, cwd, mcp, session.native_session_id ?? undefined, live.startup.signal).then(runtime => {
        live.runtime = runtime;
        live.models = runtime.models;
      });
    }
    try { await live.done; }
    catch { throw new Failure(409, 'NOT_READY', 'Antigravity ACP could not load the models for this session.', 'UNAVAILABLE'); }
    finally { live.startup = undefined; live.done = undefined; }
    return this.detail(sessionId);
  }

  authenticate(token: string) {
    for (const current of this.live.values()) {
      if (sameSecret(token, current.token)) return current.client;
    }
  }

  activeTurn(client: Agent) {
    for (const current of this.live.values()) if (current.client === client && !current.interrupted && !current.evidenceOnly) return current.turn;
  }

  delegation(client: Agent): TurnBase | undefined {
    const active = this.activeTurn(client);
    if (!active) return;
    const row = this.store.one<{ project_id: string; checkout: string | null; base_mode: TurnBase['mode']; resume_task_id: string | null }>(
      `SELECT s.project_id,s.checkout,t.base_mode,t.resume_task_id FROM main_turns t JOIN main_sessions s USING(session_id)
        WHERE t.turn_id=? AND s.client_id=?`, active, client);
    if (!row) return;
    return { id: active, project: row.project_id, checkout: this.store.checkout(row.project_id, row.checkout ?? undefined).root,
      mode: row.base_mode, resume: row.resume_task_id ?? undefined };
  }

  preferences(sessionId: string, input: { worker?: string; base?: 'head' | 'snapshot' }) {
    const session = this.get(sessionId);
    if (session.state === 'closed') throw conflict('REVIEW_NOT_ALLOWED', 'The session is closed.');
    const profile = this.profile(session.project_id, (JSON.parse(session.profile_json) as MainProfile).id);
    if (input.worker && !profile.worker_profiles.includes(input.worker)) throw missing();
    this.store.run('UPDATE main_sessions SET default_worker=?,base_mode=?,updated_at_ms=? WHERE session_id=?',
      input.worker ?? session.default_worker, input.base ?? session.base_mode, Date.now(), sessionId);
    return this.detail(sessionId);
  }

  summarize(sessionId: string, sourceId: string) {
    const session = this.get(sessionId);
    if (this.store.one('SELECT 1 FROM main_turns WHERE session_id=? AND summary_of=?', sessionId, sourceId)) return this.detail(sessionId);
    const turn = this.store.one<Turn>('SELECT * FROM main_turns WHERE turn_id=? AND session_id=?', sourceId, sessionId);
    const tasks = this.store.all<Task>('SELECT * FROM tasks WHERE created_by_client_id=? AND conversation_tag=?', session.client_id, sourceId);
    if (!turn || turn.state === 'running' || !tasks.length || tasks.some(task => !finished(task.state))) {
      throw conflict('REVIEW_NOT_ALLOWED', 'The task group has not finished.');
    }
    const evidence = tasks.map(task => {
      const result = task.result_summary_json ? JSON.parse(task.result_summary_json) : undefined;
      return { task_id: task.task_id, state: task.state, result };
    });
    return this.send(sessionId, id(), '请用中文汇报以下已结束任务。用 get_task 查看真实 Diff，区分运行时观察到的验证和模型自述。' +
      ' 说明改动、未验证项和可以用 /diff、/apply 或 /discard 查看与处理结果。\n' + clip(JSON.stringify(evidence), 12000), undefined, sourceId);
  }

  send(sessionId: string, turnId: string, input: string, resume?: string, summaryOf?: string) {
    if (this.closing) throw conflict('REVIEW_NOT_ALLOWED', 'The daemon is stopping.');
    const session = this.get(sessionId);
    const existing = this.store.one<Turn>('SELECT * FROM main_turns WHERE turn_id=?', turnId);
    if (existing) {
      if (existing.session_id !== sessionId || existing.input_sha256 !== hash(input) || existing.resume_task_id !== (resume ?? null)) {
        throw conflict('IDEMPOTENCY_CONFLICT', 'This turn ID already has a different request.');
      }
      return this.detail(sessionId);
    }
    const live = this.live.get(sessionId);
    if (input.trim().length === 0 || session.state === 'closed' || live?.turn || (live?.startup && live.done && !live.runtime)) {
      throw conflict('REVIEW_NOT_ALLOWED', 'The session cannot accept a new turn.');
    }
    const accepted = JSON.parse(session.profile_json) as MainProfile;
    const authorization = this.profile(session.project_id, accepted.id);
    if (authorization.runtime !== accepted.runtime) throw missing();
    if (resume && this.tasks.authorized('console', resume).project_id !== session.project_id) throw missing();
    const current: Live = live ?? { token: secret(), client: session.client_id, output: '', interrupted: false, models: [] };
    const now = Date.now();
    const text = redact(input);
    this.store.tx(() => {
      this.store.run("INSERT INTO main_turns(turn_id,session_id,input_sha256,input,state,created_at_ms,base_mode,resume_task_id,summary_of) VALUES (?,?,?,?,'running',?,?,?,?)",
        turnId, sessionId, hash(input), text, now, session.base_mode, resume ?? null, summaryOf ?? null);
      this.store.run("UPDATE main_sessions SET state='running',updated_at_ms=? WHERE session_id=?", now, sessionId);
      this.store.run("INSERT OR REPLACE INTO client_project_grants VALUES (?,?,1,'own','own',1,?)", session.client_id, session.project_id, now);
      this.store.run('DELETE FROM client_profile_grants WHERE client_id=?', session.client_id);
      for (const profile of new Set(authorization.worker_profiles)) this.store.run('INSERT INTO client_profile_grants VALUES (?,?,?)',
        session.client_id, profile, now);
    });
    current.turn = turnId;
    current.output = '';
    current.interrupted = false;
    current.evidenceOnly = Boolean(summaryOf);
    current.startup = new AbortController();
    this.live.set(sessionId, current);
    current.done = this.perform(session, turnId, text, current);
    return this.detail(sessionId);
  }

  private async perform(session: Session, turnId: string, text: string, live: Live) {
    const profile = JSON.parse(session.profile_json) as MainProfile;
    let status: Turn['state'] = 'failed';
    let problem: string | null = null;
    let usage: unknown;
    try {
      const { cwd, mcp } = this.runtimeContext(session.session_id, live);
      live.runtime ??= profile.runtime === 'antigravity_acp'
        ? await agyRuntime(this.config, cwd, mcp, session.native_session_id ?? undefined, live.startup?.signal)
        : claudeMain(this.config, cwd, mcp, session.native_session_id ?? undefined);
      if (live.interrupted) { status = 'cancelled'; await live.runtime.close(); live.runtime = undefined; return; }
      const previous = session.previous_session_id && !session.native_session_id
        ? this.store.all<Turn>('SELECT * FROM main_turns WHERE session_id=? ORDER BY created_at_ms DESC,rowid DESC LIMIT 3', session.previous_session_id)
        : [];
      const prior = previous.length ? '\nContext from the previous provider (reference only):\n' +
        previous.reverse().map(item => clip(item.input, 1200) + '\n' + clip(item.output, 2200)).join('\n') : '';
      const priorId = session.previous_session_id ? this.get(session.previous_session_id).client_id : undefined;
      const references = priorId ? this.store.all<{task_id: string}>('SELECT task_id FROM tasks WHERE created_by_client_id=? ORDER BY created_at_ms DESC LIMIT 20', priorId)
        .map(item => item.task_id).join(', ') : '';
      const prompt = 'Coordinate with the zgent MCP tools. Use inspect_project to read code before planning when available. Only delegate implementation when the owner explicitly requests execution. Use the default worker unless the owner names another one. Use actual task diff and verification evidence for the Chinese summary. Human approvals belong to the owner.\n' +
        prior + (references ? '\nPrevious conversation task IDs (for the human to reference): ' + references : '') +
        '\nRegistered project: ' + session.project_id + '\nDefault worker profile: ' + (session.default_worker ?? this.defaultWorker(profile)) +
        '\nWorker base mode: ' + session.base_mode + '\n\nUser message:\n' + text;
      const result = await live.runtime.prompt(prompt, profile.model, {
        runtime: version => this.store.run('UPDATE main_sessions SET runtime_version=? WHERE session_id=?', clip(version, 128), session.session_id),
        session: native => this.store.run('UPDATE main_sessions SET native_session_id=? WHERE session_id=?', native, session.session_id),
        text: delta => { live.output = (live.output + delta).slice(0, 64_000); },
        models: models => { live.models = models; },
      });
      if (result.text) live.output = clip(redact(result.text), 64_000);
      usage = result.usage;
      status = live.interrupted || result.cancelled ? 'cancelled' : 'completed';
    } catch (error) {
      if (live.interrupted) status = 'cancelled';
      else {
        const message = error instanceof Error ? error.message : '';
        problem = /^(?:The ACP|Antigravity ACP|This ACP|Configure separate Claude|Claude SDK could|Claude SDK disconnected|ACP did)/.test(message)
          ? clip(redact(message), 400) : 'Runtime did not complete the turn.';
      }
      await live.runtime?.close();
      live.runtime = undefined;
    } finally {
      if (live.turn === turnId) {
        const currentSession = this.get(session.session_id);
        const now = Date.now();
        this.store.tx(() => {
          this.store.run('UPDATE main_turns SET state=?,output=?,usage_json=?,error_summary=?,completed_at_ms=? WHERE turn_id=?',
            status, redact(live.output), usage ? JSON.stringify(usage) : null, problem, now, turnId);
          if (currentSession.state !== 'closed') this.store.run('UPDATE main_sessions SET state=?,updated_at_ms=? WHERE session_id=?',
            status === 'failed' ? 'disconnected' : 'ready', now, session.session_id);
        });
        live.turn = undefined;
        live.startup = undefined;
        live.done = undefined;
      }
    }
  }

  async interrupt(sessionId: string) {
    const session = this.get(sessionId), live = this.live.get(sessionId);
    if (!live?.turn) return this.detail(sessionId);
    live.interrupted = true;
    live.startup?.abort();
    this.store.run("UPDATE main_sessions SET state='stopping',updated_at_ms=? WHERE session_id=?", Date.now(), session.session_id);
    await live.runtime?.interrupt();
    void Promise.race([live.done, delay(10_000, undefined, { ref: false })]).then(async () => {
      if (live.turn && live.interrupted) {
        await live.runtime?.close();
        live.runtime = undefined;
      }
    }).catch(() => {});
    return this.detail(sessionId);
  }

  cancelGroup(sessionId: string, turn: string) {
    const session = this.get(sessionId);
    if (!this.store.one('SELECT 1 FROM main_turns WHERE turn_id=? AND session_id=?', turn, sessionId)) throw missing();
    return this.store.tx(() => {
      const tasks = this.store.all<Task>('SELECT * FROM tasks WHERE created_by_client_id=? AND conversation_tag=?', session.client_id, turn);
      const cancelled = tasks.filter(task => !finished(task.state)).map(task => this.tasks.snapshot(this.tasks.cancelTask(task, 'Owner cancelled the task group.')));
      return { tasks: cancelled };
    });
  }

  async closeSession(sessionId: string) {
    const session = this.get(sessionId);
    const live = this.live.get(sessionId);
    if (live) {
      live.interrupted = true;
      live.startup?.abort();
      await live.runtime?.close();
      await live.done;
    }
    this.store.run("UPDATE main_sessions SET state='closed',updated_at_ms=? WHERE session_id=?", Date.now(), session.session_id);
    this.live.delete(sessionId);
    return this.view(this.get(sessionId));
  }

  stream(sessionId: string, res: ServerResponse) {
    this.get(sessionId);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    res.write(': connected\n\n');
    let previous = '', lastWrite = Date.now();
    const send = () => {
      if (res.destroyed) return;
      const content = JSON.stringify(this.detail(sessionId));
      if (content === previous) {
        if (Date.now() - lastWrite >= 15_000) { lastWrite = Date.now(); if (!res.write(': heartbeat\n\n')) res.end(); }
        return;
      }
      previous = content;
      lastWrite = Date.now();
      if (!res.write('data: ' + content + '\n\n') && res.writableLength > Buffer.byteLength(content) + 64_000) res.end();
    };
    const timer = setInterval(send, 250);
    timer.unref();
    res.once('close', () => clearInterval(timer));
    send();
  }

  async close() {
    this.closing = true;
    for (const live of this.live.values()) { live.interrupted = true; live.startup?.abort(); }
    await Promise.allSettled([...this.live.values()].map(live => live.runtime?.close()));
    await Promise.race([Promise.allSettled([...this.live.values()].map(live => live.done)), delay(15_000, undefined, { ref: false })]);
  }
}
