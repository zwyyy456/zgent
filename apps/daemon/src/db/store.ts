import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { validEvent } from '@zgent/contracts';
import { hash, id, invalid, iso, missing } from '../core/values.ts';
import type { State, Snapshot } from '../core/values.ts';
import { claudeVersion, minCodexVersion, revision, within, type Config, type Profile, type Project } from '../policy/config.ts';
import { branch, projectPaths } from '../workspaces/git.ts';

export type Task = {
  task_id: string; project_id: string; profile_id: string; profile_revision: number; created_by_client_id: string;
  title: string; state: State; state_version: number; review_state: Snapshot['review_state']; base_commit_oid: string;
  task_spec_json: string; desired_action: 'run' | 'cancel'; created_at_ms: number; updated_at_ms: number;
  finished_at_ms: number | null; error_code: string | null; result_summary_json: string | null; reviewed_at_ms: number | null;
};
export type Attempt = {
  attempt_id: string; task_id: string; workspace_id: string; owner_epoch_id: string; fencing_token: number;
  runtime_instance_id: string | null; process_pid: number | null; process_birth_identity: string | null;
  supervision_json: string | null; provider_thread_id: string | null; provider_model_id: string | null; provider_turn_id: string | null; provider_version: string | null;
  provider_start_status: 'not_sent' | 'send_intent_recorded' | 'acknowledged'; created_at_ms: number;
  process_stop_confirmed_at_ms: number | null; termination_reason: string | null; capabilities_json: string | null;
};
export type Artifact = {
  artifact_id: string; task_id: string; attempt_id: string; kind: Snapshot['artifacts'][number]['kind'];
  storage_relative_path: string; content_sha256: string; size_bytes: number; media_type: string; created_at_ms: number;
};
export type Pending = {
  request_id: string; task_id: string; attempt_id: string; runtime_instance_id: string; runtime_request_key: string;
  owner_epoch_id: string; revision: number; kind: string; state: string; delivery_state: string;
  request_json: string; request_sha256: string; allowed_decisions_json: string; expires_at_ms: number;
  decision_json: string | null; decided_at_ms: number | null; response_sent_at_ms: number | null; created_at_ms: number;
};
export type Command = {
  command_id: string; request_id: string; task_id: string; payload_json: string; state: string;
  created_by_client_id: string; created_at_ms: number; updated_at_ms: number; provider_receipt_json: string | null;
};
type Revision = { runtime_kind: Profile['runtime']; config_json: string; config_sha256: string; model_id: string; revision: number };

export class Store {
  db: DatabaseSync;
  epoch = id();

  constructor(config: Config, birth: string) {
    this.db = new DatabaseSync(join(config.state, 'zgent.sqlite'));
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.one<{ version: string }>('SELECT sqlite_version() AS version')!.version;
    const [major, minor, patch] = version.split('.').map(Number);
    if (major < 3 || (major === 3 && (minor < 51 || (minor === 51 && patch < 3)))) {
      throw new Error('Embedded SQLite 3.51.3 or later is required.');
    }
    if (!this.one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")) {
      this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
      this.run('UPDATE schema_migrations SET applied_at_ms=? WHERE version=1', Date.now());
    }
    if (!this.one('SELECT 1 FROM schema_migrations WHERE version=2')) {
      this.tx(() => {
        this.db.exec(readFileSync(new URL('./sessions.sql', import.meta.url), 'utf8'));
        this.run("INSERT INTO schema_migrations VALUES (2,'Persistent main sessions and turns',?)", Date.now());
      });
    }
    if (!this.one('SELECT 1 FROM schema_migrations WHERE version=3')) {
      this.db.exec('PRAGMA foreign_keys=OFF');
      try {
        this.tx(() => {
          this.db.exec(readFileSync(new URL('./personal.sql', import.meta.url), 'utf8'));
          if (this.one('PRAGMA foreign_key_check')) throw new Error('Personal edition migration left invalid references.');
          this.run("INSERT INTO schema_migrations VALUES (3,'Personal projects, turn baselines and workspace results',?)", Date.now());
        });
      } finally { this.db.exec('PRAGMA foreign_keys=ON'); }
    }
    this.tx(() => {
      const now = Date.now();
      this.run("UPDATE main_turns SET state='disconnected',completed_at_ms=? WHERE state='running'", now);
      this.run("UPDATE main_sessions SET state='disconnected',updated_at_ms=? WHERE state IN ('running','waiting_input','stopping')", now);
      this.run("INSERT OR IGNORE INTO principals VALUES ('owner', 'local_owner', 'Local owner', ?)", now);
      const enroll = (client: string, kind: string, credential: string | null) => {
        this.run(`INSERT INTO clients(client_id,principal_id,kind,label,host_kind,credential_fingerprint,created_at_ms)
          VALUES (?,'owner',?,?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET credential_fingerprint=excluded.credential_fingerprint`,
        client, kind, client, client, credential, now);
      };
      enroll('console', 'human_ui', null);
      enroll('system', 'system', null);
      for (const slot of ['agy', 'claude-code'] as const) enroll(slot, 'agent_client', hash(config.credentials[slot]));
      this.run("UPDATE projects SET status='disabled',updated_at_ms=? WHERE personal=0", now);
      this.run("UPDATE task_applications SET state='needs_confirmation' WHERE state='applying'");
      this.run('UPDATE profiles SET enabled=0,updated_at_ms=?', now);
      for (const project of config.projects) {
        const saved = this.one<{ canonical_root: string; git_common_dir: string }>('SELECT canonical_root,git_common_dir FROM projects WHERE project_id=?', project.id);
        if (saved && (saved.canonical_root !== project.root || saved.git_common_dir !== project.gitDir)) {
          throw new Error('Use a new project ID when changing a registered Git repository.');
        }
        this.run(`INSERT INTO projects(project_id,principal_id,label,canonical_root,git_common_dir,approved_base_ref,managed_worktree_root,created_at_ms,updated_at_ms)
          VALUES (?,'owner',?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET label=excluded.label,
          approved_base_ref=excluded.approved_base_ref,status='enabled',updated_at_ms=excluded.updated_at_ms`,
        project.id, project.label, project.root, project.gitDir, project.base_ref, project.worktreeRoot, now, now);
      }
      for (const profile of config.profiles) {
        this.run(`INSERT INTO profiles(profile_id,label,created_at_ms,updated_at_ms) VALUES (?,?,?,?)
          ON CONFLICT(profile_id) DO UPDATE SET label=excluded.label,enabled=1,updated_at_ms=excluded.updated_at_ms`,
        profile.id, profile.label, now, now);
        const latest = this.profile(profile.id);
        const current = revision(profile, config);
        if (latest?.config_sha256 !== current.sha) {
          this.run('INSERT INTO profile_revisions VALUES (?,?,?,?,?,?,?,?,?)',
            profile.id, (latest?.revision ?? 0) + 1, profile.runtime, profile.model,
            profile.runtime === 'codex_app_server' ? 'native_cli_login' : 'claude-sdk', profile.mode, current.value, current.sha, now);
        }
      }
      this.run('DELETE FROM client_project_grants');
      this.run('DELETE FROM client_profile_grants');
      for (const slot of ['agy', 'claude-code'] as const) {
        const grant = config.clients[slot];
        for (const project of new Set(grant.projects)) this.run('INSERT INTO client_project_grants VALUES (?,?,1,?,?,1,?)', slot, project, grant.read, grant.control, now);
        this.run("INSERT OR IGNORE INTO client_project_grants SELECT ?,project_id,1,'project','own',1,? FROM projects WHERE personal=1", slot, now);
        for (const profile of new Set(grant.profiles)) this.run('INSERT INTO client_profile_grants VALUES (?,?,?)', slot, profile, now);
      }
      this.run(`INSERT INTO daemon_epochs(epoch_id,owner_pid,process_birth_identity,started_at_ms,last_heartbeat_at_ms)
        VALUES (?,?,?,?,?)`, this.epoch, process.pid, birth, now, now);
      this.run('UPDATE daemon_control SET current_epoch_id=?,updated_at_ms=? WHERE singleton=1', this.epoch, now);
    });
  }

  one<T>(sql: string, ...parameters: SQLInputValue[]) { return this.db.prepare(sql).get(...parameters) as T | undefined; }
  all<T>(sql: string, ...parameters: SQLInputValue[]) { return this.db.prepare(sql).all(...parameters) as T[]; }
  run(sql: string, ...parameters: SQLInputValue[]) { return this.db.prepare(sql).run(...parameters); }

  tx<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  task(taskId: string) { return this.one<Task>('SELECT * FROM tasks WHERE task_id=?', taskId); }
  project(projectId: string) {
    return this.one<Project & { personal: number }>(`SELECT project_id id,label,canonical_root root,git_common_dir gitDir,
      approved_base_ref base_ref,managed_worktree_root worktreeRoot,personal FROM projects WHERE project_id=? AND status='enabled'`, projectId);
  }

  recentProjects() {
    return this.all<{ id: string; label: string; root: string }>(`SELECT project_id id,label,COALESCE(recent_checkout,canonical_root) root FROM projects
      WHERE status='enabled' ORDER BY updated_at_ms DESC,label`);
  }

  checkout(projectId: string, path?: string) {
    const project = this.project(projectId);
    if (!project) throw missing();
    if (!path) return project;
    let paths;
    try { paths = projectPaths(path); }
    catch { throw invalid('The selected Git checkout could not be opened.'); }
    if (paths.gitDir !== project.gitDir || within(project.worktreeRoot, paths.root)) throw invalid('Select an original checkout of this project.');
    return { ...project, root: paths.root };
  }

  openProject(config: Config, path: string) {
    let paths, currentBranch;
    try { paths = projectPaths(path); currentBranch = branch(paths.root); }
    catch { throw invalid('Choose a Git checkout with an initial commit.'); }
    const protectedPaths = [config.state, config.codexHome, config.agy?.home, config.claude_sdk?.home];
    if ([paths.root, paths.gitDir].some(path => protectedPaths.some(root => root && (within(root, path) || within(path, root))))) {
      throw invalid('Choose a repository separate from Zgent state and provider homes.');
    }
    return this.tx(() => {
      const known = this.one<{ id: string; label: string }>('SELECT project_id id,label FROM projects WHERE git_common_dir=?', paths.gitDir);
      const project = known ?? { id: id(), label: basename(paths.root) };
      const now = Date.now();
      this.run(`INSERT INTO projects(project_id,principal_id,label,canonical_root,git_common_dir,approved_base_ref,managed_worktree_root,personal,recent_checkout,created_at_ms,updated_at_ms)
        VALUES (?,'owner',?,?,?,?,?,1,?,?,?) ON CONFLICT(project_id) DO UPDATE SET personal=1,status='enabled',
        recent_checkout=excluded.recent_checkout,updated_at_ms=excluded.updated_at_ms`,
        project.id, project.label, paths.root, paths.gitDir, 'HEAD', config.worktreeRoot, paths.root, now, now);
      for (const client of ['agy', 'claude-code']) {
        this.run("INSERT OR IGNORE INTO client_project_grants VALUES (?,?,1,'project','own',1,?)", client, project.id, now);
      }
      return { ...project, root: paths.root, branch: currentBranch };
    });
  }
  attempt(taskId: string) { return this.one<Attempt>('SELECT * FROM run_attempts WHERE task_id=?', taskId); }
  profile(profileId: string, revision?: number) {
    return revision === undefined
      ? this.one<Revision>('SELECT * FROM profile_revisions WHERE profile_id=? ORDER BY revision DESC LIMIT 1', profileId)
      : this.one<Revision>('SELECT * FROM profile_revisions WHERE profile_id=? AND revision=?', profileId, revision);
  }
  acceptedProfile(task: Task) {
    const recorded = JSON.parse(this.profile(task.profile_id, task.profile_revision)!.config_json) as
      Omit<Profile, 'runtime' | 'execution_minutes' | 'request_minutes' | 'total_minutes' | 'max_active'> &
      Partial<Pick<Profile, 'runtime' | 'execution_minutes' | 'request_minutes' | 'total_minutes' | 'max_active'>> & { runtimeIdentity: string };
    return { runtime: 'codex_app_server' as const, execution_minutes: 30, request_minutes: 30, total_minutes: 120, max_active: 2, ...recorded };
  }
  pending(requestId: string) { return this.one<Pending>('SELECT * FROM pending_requests WHERE request_id=?', requestId); }
  runtime(task: Task) {
    const revision = this.profile(task.profile_id, task.profile_revision)!;
    const isCodex = revision.runtime_kind === 'codex_app_server';
    const attempt = this.attempt(task.task_id);
    return { provider: isCodex ? 'openai' as const : 'anthropic' as const, adapter: revision.runtime_kind,
      model_id: attempt?.provider_model_id ?? revision.model_id, runtime_version: attempt?.provider_version ?? (isCodex ? minCodexVersion : claudeVersion), adapter_version: '0.1.0' };
  }

  event(task: Task, eventType: string, payload: unknown, attempt = this.attempt(task.task_id)) {
    const eventId = id();
    const time = Date.now();
    const inserted = this.run(`INSERT INTO events(event_id,project_id,task_id,attempt_id,task_state_version,event_type,producer_epoch_id,fencing_token,payload_json,created_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, eventId, task.project_id, task.task_id, attempt?.attempt_id ?? null, task.state_version,
    eventType, this.epoch, attempt?.fencing_token ?? null, JSON.stringify(payload), time);
    const cursor = this.one<{ seq: string }>('SELECT CAST(event_seq AS TEXT) AS seq FROM events WHERE event_id=?', eventId)!.seq;
    if (!validEvent({ schema_version: '1', event_id: eventId, cursor, occurred_at: iso(time), event_type: eventType,
      project_id: task.project_id, task_id: task.task_id, task_version: task.state_version, data: payload })) {
      throw new Error('Invalid persisted domain event: ' + eventType);
    }
    return inserted;
  }
}
