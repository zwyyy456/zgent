import { existsSync } from 'node:fs';
import type { Tasks, TaskSpec } from '../core/tasks.ts';
import { clip, conflict, Failure, finished, missing, redact } from '../core/values.ts';
import type { Artifact, Task } from '../db/store.ts';
import { readArtifact } from './artifacts.ts';
import { applyPatch, changedTreePaths, collect, removeWorktree, worktreeChangedCount } from './git.ts';

const blocked = (message: string) => conflict('REVIEW_NOT_ALLOWED', message);
type Completion = { final_head?: string; final_tree?: string; staged_tree?: string; changed_paths?: number };
type Application = { checkout: string; state: 'applying' | 'applied' | 'needs_confirmation'; applied_at_ms: number | null };

function artifact(tasks: Tasks, taskId: string, kind: Artifact['kind']) {
  const row = tasks.store.one<Artifact>('SELECT * FROM artifacts WHERE task_id=? AND kind=?', taskId, kind);
  if (!row) throw blocked('The complete Git result is unavailable. The worktree is retained.');
  return readArtifact(tasks.config.state, row, 0, row.size_bytes);
}

export function application(tasks: Tasks, taskId: string) {
  return tasks.store.one<Application>('SELECT checkout,state,applied_at_ms FROM task_applications WHERE task_id=?', taskId) ?? null;
}

export function resultStats(tasks: Tasks, task: Task) {
  const row = tasks.store.one<Artifact>("SELECT * FROM artifacts WHERE task_id=? AND kind='report'", task.task_id);
  let count: number | undefined;
  try {
    if (row) count = (JSON.parse(readArtifact(tasks.config.state, row, 0, row.size_bytes).toString()) as Completion).changed_paths;
    else if (!finished(task.state)) {
      const workspace = tasks.store.one<{ managed_path: string }>("SELECT managed_path FROM workspaces WHERE task_id=? AND state='in_use'", task.task_id);
      if (workspace) count = worktreeChangedCount(workspace.managed_path, task.base_commit_oid);
    }
  } catch { /* Result artifacts and running worktrees may be unavailable. */ }
  return { changed_paths: count ?? null, application: application(tasks, task.task_id) };
}

export function discardCandidate(tasks: Tasks, task: Task) {
  const taskId = task.task_id;
  const attempt = tasks.store.attempt(taskId);
  const workspace = attempt && tasks.store.one<{ managed_path: string; branch_name: string; state: string }>(
    'SELECT managed_path,branch_name,state FROM workspaces WHERE workspace_id=?', attempt.workspace_id);
  if (!workspace) throw missing();
  if (workspace.state === 'removed') return;
  if (!finished(task.state) || workspace.state !== 'retained' || attempt?.process_stop_confirmed_at_ms == null) {
    throw blocked('Cleanup requires a retained candidate and a confirmed worker stop.');
  }
  if (application(tasks, taskId)?.state === 'needs_confirmation') throw blocked('Resolve the interrupted application before cleanup.');
  const project = tasks.store.project(task.project_id);
  if (!project) throw missing();
  const archived = JSON.parse(artifact(tasks, taskId, 'report').toString()) as Completion;
  const patch = artifact(tasks, taskId, 'diff');
  const staged = artifact(tasks, taskId, 'patch');
  const path = workspace.managed_path;
  if (existsSync(path)) {
    const changes = collect(path, task.base_commit_oid);
    const changed = [...changes.ignored];
    if (!patch.equals(changes.cumulative)) changed.push(...(archived.final_tree
      ? changedTreePaths(path, archived.final_tree, changes.tree) : changes.paths));
    if (!staged.equals(changes.staged)) changed.push(...(archived.staged_tree
      ? changedTreePaths(path, archived.staged_tree, changes.stagedTree) : changes.paths));
    if (changed.length || !patch.equals(changes.cumulative) || !staged.equals(changes.staged) || changes.head !== archived.final_head) {
      throw blocked('The candidate has unarchived changes. ' + (changed.length ? clip(redact([...new Set(changed)].join(', ')), 1200) : 'Check the candidate HEAD and index.'));
    }
  }
  removeWorktree(project.root, path, workspace.branch_name, true);
  const now = Date.now();
  tasks.store.run("UPDATE workspaces SET state='removed',updated_at_ms=?,removed_at_ms=? WHERE workspace_id=?", now, now, attempt.workspace_id);
}

export function applyCandidate(tasks: Tasks, task: Task, checkout?: string) {
  const taskId = task.task_id;
  const existing = application(tasks, taskId);
  if (existing?.state === 'applied') return { state: 'already_applied', cleanup: null };
  if (existing) throw blocked('The previous application needs confirmation. Review the checkout before retrying.');
  if (!finished(task.state) || tasks.store.attempt(taskId)?.process_stop_confirmed_at_ms == null) throw blocked('Wait for the worker to finish.');
  const original = (JSON.parse(task.task_spec_json) as TaskSpec).checkout;
  const target = tasks.store.checkout(task.project_id, checkout ?? original).root;
  const patch = artifact(tasks, taskId, 'diff');
  const errorMessage = (error: unknown) => {
    const stderr = (error as { stderr?: Buffer }).stderr;
    return clip(redact(stderr?.toString().trim() || 'Git could not apply the complete patch.'), 2000);
  };
  try { applyPatch(target, patch, true); }
  catch (error) { throw blocked(errorMessage(error)); }
  tasks.store.run("INSERT INTO task_applications VALUES (?,?,'applying',NULL)", taskId, target);
  try { applyPatch(target, patch, false); }
  catch (error) {
    tasks.store.run("UPDATE task_applications SET state='needs_confirmation' WHERE task_id=?", taskId);
    throw blocked(errorMessage(error));
  }
  tasks.store.run("UPDATE task_applications SET state='applied',applied_at_ms=? WHERE task_id=?", Date.now(), taskId);
  let cleanup: string | null = null;
  try { discardCandidate(tasks, task); }
  catch (error) { cleanup = error instanceof Failure ? error.message : 'The candidate worktree was retained.'; }
  return { state: 'applied', cleanup };
}

export function resolveApplication(tasks: Tasks, taskId: string, applied: boolean) {
  if (application(tasks, taskId)?.state !== 'needs_confirmation') throw blocked('The application does not need confirmation.');
  if (applied) tasks.store.run("UPDATE task_applications SET state='applied',applied_at_ms=? WHERE task_id=?", Date.now(), taskId);
  else tasks.store.run('DELETE FROM task_applications WHERE task_id=?', taskId);
  return application(tasks, taskId);
}
