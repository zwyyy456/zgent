import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { validApi, type Contracts } from '@zgent/contracts';
import type { Attempt, Pending, Task } from '../../db/store.ts';
import { human, within } from '../../policy/config.ts';
import type { Tasks } from '../../core/tasks.ts';
import { canonical, clip, conflict, hash, id, iso, missing, redact } from '../../core/values.ts';
import type { Worker } from '../worker.ts';
import type { ServerFrame } from './rpc.ts';
import type { CommandExecutionRequestApprovalParams, FileChangeRequestApprovalParams, FileUpdateChange,
  PermissionsRequestApprovalParams, PermissionsRequestApprovalResponse, ToolRequestUserInputParams,
  ToolRequestUserInputResponse, RequestId } from './protocol.ts';

type Decision = Contracts['DecisionRequest'];
type View = Contracts['PendingRequestView'];
type Details = Pick<Extract<View, { kind: 'command_approval' | 'file_approval' }>, 'kind' | 'operation_preview' | 'artifact_ids' | 'allowed_choices'> |
  Pick<Extract<View, { kind: 'permission_grant' }>, 'kind' | 'requested_permissions' | 'allowed_choices'> |
  Pick<Extract<View, { kind: 'user_question' }>, 'kind' | 'questions' | 'allowed_choices'>;
type Question = Extract<View, {kind: 'user_question'}>['questions'][number];
type NativeResult = { decision: 'accept' | 'decline' } | PermissionsRequestApprovalResponse | ToolRequestUserInputResponse;

function operation(kind: 'command_approval' | 'file_approval', body: unknown, canApprove: boolean): Details {
  const original = JSON.stringify(body, null, 2);
  const safe = redact(original);
  const preview = clip(safe, 32_000);
  return { kind, operation_preview: preview, artifact_ids: [],
    allowed_choices: canApprove && preview === original ? ['accept_once', 'deny', 'cancel_task'] : ['deny', 'cancel_task'] };
}

function describe(frame: ServerFrame, patches?: FileUpdateChange[]): { details: Details; summary: string; binding: unknown } | undefined {
  if (frame.method === 'claude/commandApproval') {
    const params = frame.params as { command: string; cwd: string };
    return { details: operation('command_approval', params, true), summary: clip(redact(params.command), 1000), binding: params };
  }
  if (frame.method === 'item/commandExecution/requestApproval') {
    const params = frame.params as CommandExecutionRequestApprovalParams;
    const summary = params.command ? clip(redact(params.command), 1000) : 'Codex command approval';
    return { details: operation('command_approval', params, Boolean(params.command && params.cwd && params.kind === 'command' &&
      (!params.availableDecisions || params.availableDecisions.includes('accept')))),
      summary: summary || 'Codex command approval', binding: params };
  }
  if (frame.method === 'item/fileChange/requestApproval') {
    const params = frame.params as FileChangeRequestApprovalParams;
    const binding = { ...params, patches: patches ?? [] };
    return { details: operation('file_approval', binding, Boolean(patches?.length && !params.grantRoot)), summary: 'Codex file change approval', binding };
  }
  if (frame.method === 'item/permissions/requestApproval') {
    const params = frame.params as PermissionsRequestApprovalParams;
    const original = JSON.stringify(params.permissions);
    const safe = redact(original);
    const details: Details = { kind: 'permission_grant',
      requested_permissions: (safe === original ? params.permissions : { withheld: true }) as Extract<Details, {kind: 'permission_grant'}>['requested_permissions'],
      allowed_choices: safe === original ? ['accept_once', 'deny', 'cancel_task'] : ['deny', 'cancel_task'] };
    return { details, summary: 'Codex requests permissions for this turn.', binding: params };
  }
  if (frame.method === 'item/tool/requestUserInput') {
    const params = frame.params as ToolRequestUserInputParams;
    if (!params.isBlocking || params.questions.some(question => question.isSecret)) return;
    const questions = params.questions.map((question): Question => {
      const choices = question.isOther ? [] : (question.options ?? []).map((option, index) => ({
        choice_id: String(index + 1), label: redact(option.label), description: redact(option.description) || null,
      }));
      return { question_id: question.id, title: redact(question.header || 'Codex question'), prompt: redact(question.question),
        answer_kind: choices.length ? 'single_choice' : 'text', required: true, choices };
    });
    if (canonical(params.questions) !== redact(canonical(params.questions))) return;
    const [first, ...rest] = questions;
    if (!first) return;
    return { details: { kind: 'user_question', questions: [first, ...rest], allowed_choices: ['answer', 'cancel_task'] },
      summary: clip(questions[0]?.prompt || 'Codex question', 1000), binding: params };
  }
}

function permissionSubset(runtime: Worker, requested: unknown, submitted: unknown): PermissionsRequestApprovalResponse['permissions'] {
  const request = requested as { network: {enabled: boolean | null} | null; fileSystem: Record<string, unknown> | null };
  const grant = submitted as Record<string, unknown>;
  const reject = () => { throw conflict('INVALID_PERMISSION_SUBSET', 'Grant only concrete requested permissions allowed by this worker profile.'); };
  const allowedPath = (path: unknown, access: 'read' | 'write') => {
    if (typeof path !== 'string' || !isAbsolute(path) || (access === 'write' && runtime.job.profile.mode !== 'workspace_write')) return false;
    try { return within(runtime.job.cwd, realpathSync(path)); }
    catch { return false; }
  };
  let selected = 0;
  for (const [key, value] of Object.entries(grant)) {
    if (key === 'network' && canonical(value) === '{"enabled":true}' && request.network?.enabled && runtime.job.profile.network_domains.length) {
      selected++;
    } else if (key === 'fileSystem' && value && typeof value === 'object' && !Array.isArray(value) && request.fileSystem) {
      for (const [kind, items] of Object.entries(value)) {
        if (kind === 'read' || kind === 'write') {
          if (items === null) continue;
          const originals = request.fileSystem[kind];
          if (!Array.isArray(items) || !Array.isArray(originals) ||
            !items.every(path => originals.includes(path) && allowedPath(path, kind))) reject();
          selected += (items as unknown[]).length;
        } else if (kind === 'entries') {
          const originals = request.fileSystem.entries;
          if (!Array.isArray(items) || !Array.isArray(originals)) reject();
          for (const entry of items as {path?: {type?: string; path?: string}; access?: string}[]) {
            if (!entry || !['read', 'write'].includes(entry.access ?? '') || entry.path?.type !== 'path' ||
              !allowedPath(entry.path.path, entry.access as 'read' | 'write') ||
              !(originals as unknown[]).some(original => canonical(original) === canonical(entry))) reject();
            selected++;
          }
        } else reject();
      }
    } else reject();
  }
  if (selected === 0) reject();
  return grant as PermissionsRequestApprovalResponse['permissions'];
}

export class Interactions {
  tasks: Tasks;
  live: (taskId: string) => Worker | undefined;

  constructor(tasks: Tasks, live: (taskId: string) => Worker | undefined) {
    this.tasks = tasks;
    this.live = live;
  }

  get store() { return this.tasks.store; }

  open(taskId: string, attempt: Attempt, runtime: Worker, frame: ServerFrame, patches?: FileUpdateChange[]) {
    const task = this.store.task(taskId)!;
    if (!['starting', 'running', 'waiting_input'].includes(task.state) || task.desired_action !== 'run') {
      void runtime.error(frame.id);
      return;
    }
    const info = describe(frame, patches);
    if (!info) {
      void runtime.error(frame.id);
      return;
    }
    const now = Date.now(), requestId = id(), key = JSON.stringify(frame.id);
    if (this.store.one('SELECT 1 FROM pending_requests WHERE attempt_id=? AND runtime_request_key=?', attempt.attempt_id, key)) return;
    this.store.tx(() => {
      const encoded = { ...info.details, summary: info.summary };
      const digest = hash(canonical({ attempt: attempt.attempt_id, instance: attempt.runtime_instance_id,
        method: frame.method, request: frame.id, operation: info.binding, choices: info.details.allowed_choices }));
      this.store.run(`INSERT INTO pending_requests(request_id,task_id,attempt_id,runtime_instance_id,runtime_request_key,
        owner_epoch_id,fencing_token,kind,request_json,request_sha256,allowed_decisions_json,expires_at_ms,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, requestId, taskId, attempt.attempt_id, attempt.runtime_instance_id, key,
        attempt.owner_epoch_id, attempt.fencing_token, info.details.kind, JSON.stringify(encoded), digest,
        JSON.stringify(info.details.allowed_choices), now + runtime.job.profile.request_minutes * 60_000, now, now);
      const request = this.store.pending(requestId)!;
      if (!validApi('PendingRequestView', this.view(task, request))) throw new Error('Provider interaction does not fit the control contract.');
      const updated = this.tasks.update(task, 'waiting_input', {}, ['pending_requests']);
      this.store.event(updated, 'interaction.opened', this.tasks.pendingSummary(request));
    });
  }

  view(task: Task, request: Pending): View {
    return { ...JSON.parse(request.request_json), task_id: task.task_id, project_id: task.project_id,
      attempt_id: request.attempt_id, revision: request.revision, operation_hash: 'sha256:' + request.request_sha256,
      state: request.state, created_at: iso(request.created_at_ms), expires_at: iso(request.expires_at_ms),
      runtime: this.store.runtime(task).adapter, provider_request_id: String(JSON.parse(request.runtime_request_key)),
      pending_request_id: request.request_id, delivery_state: request.delivery_state,
      decision: request.decision_json ? this.receipt(task, request) : null } as View;
  }

  get(client: Parameters<Tasks['authorized']>[0], requestId: string) {
    const request = this.store.pending(requestId);
    if (!request) throw missing();
    const task = this.tasks.authorized(client, request.task_id);
    // Only the human control surface receives raw operation details. MCP exposes a bounded summary.
    return this.view(task, request);
  }

  receipt(task: Task, request: Pending): Contracts['DecisionReceipt'] {
    const recorded = JSON.parse(request.decision_json!) as { id: string; kind: Decision['kind'] };
    const delivery = request.delivery_state as Contracts['DecisionReceipt']['delivery_state'];
    return { decision_id: recorded.id, task_id: task.task_id, attempt_id: request.attempt_id,
      request_revision: request.revision, decision_kind: recorded.kind, delivery_state: delivery,
      delivery_status: delivery === 'not_sent' ? 'recorded' : delivery,
      recorded_at: iso(request.decided_at_ms!), sent_at: request.response_sent_at_ms ? iso(request.response_sent_at_ms) : null,
      pending_request_id: request.request_id, request_state: request.state as Contracts['DecisionReceipt']['request_state'],
      task_state: task.state } as Contracts['DecisionReceipt'];
  }

  decide(requestId: string, input: Decision) {
    const request = this.store.pending(requestId);
    if (!request) throw missing();
    const task = this.tasks.authorized(human, request.task_id);
    let send: { runtime: Worker; native: NativeResult } | undefined;
    const receipt = this.tasks.remember(human, 'resolve_pending_request', input.decision_id, { requestId, ...input }, () => {
      if (request.owner_epoch_id !== this.store.epoch) throw conflict('STALE_ATTEMPT', 'The original worker is no longer active.');
      if (request.state !== 'pending') throw conflict('REQUEST_RESOLVED', 'The request is no longer pending.');
      if (request.expires_at_ms <= Date.now()) throw conflict('REQUEST_EXPIRED', 'The request expired.');
      if (request.revision !== input.expected_revision) throw conflict('REVISION_MISMATCH', 'Reload the request before making a decision.');
      if ('sha256:' + request.request_sha256 !== input.operation_hash) throw conflict('OPERATION_CHANGED', 'The operation changed.');
      const runtime = this.live(task.task_id);
      const attempt = this.store.attempt(task.task_id);
      if (!runtime || runtime.stopping || runtime.outcome || !attempt || attempt.runtime_instance_id !== request.runtime_instance_id ||
        task.desired_action !== 'run') throw conflict('STALE_ATTEMPT', 'The original worker is no longer active.');
      const view = this.view(task, request);
      const choice = input.kind === 'question_answer' ? 'answer' : input.decision;
      if (!(view.allowed_choices as string[]).includes(choice)) throw conflict('INVALID_DECISION_KIND', 'That choice is unavailable for this request.');
      if (input.kind === 'operation_approval' && view.kind === 'file_approval' &&
        runtime.job.profile.runtime === 'codex_app_server' && !runtime.fileRequestCurrent(JSON.parse(request.runtime_request_key) as RequestId)) {
        throw conflict('OPERATION_CHANGED', 'The file patch changed after the approval was displayed.');
      }
      if (input.kind !== 'task_cancellation') send = { runtime, native: this.nativeResponse(view, input, runtime) };
      if (input.kind !== 'task_cancellation' && input.kind !== 'approval_denial' &&
        request.kind === 'billing_confirmation') throw conflict('INVALID_DECISION_KIND', 'Billing decisions are configured locally.');
      const now = Date.now();
      this.store.run(`UPDATE pending_requests SET state='decision_recorded',decision_json=?,decided_by_client_id='console',
        decided_at_ms=?,revision=revision+1,updated_at_ms=? WHERE request_id=?`,
      JSON.stringify({ id: input.decision_id, kind: input.kind, response: send?.native }), now, now, requestId);
      const updated = input.kind === 'task_cancellation' ? this.tasks.cancelTask(task, input.reason) :
        this.tasks.update(task, task.state, {}, ['pending_requests']);
      return { task: task.task_id, value: this.receipt(updated, this.store.pending(requestId)!) };
    });
    if (!receipt.duplicate && send) {
      void this.deliver(task.task_id, requestId, send.runtime, JSON.parse(request.runtime_request_key) as RequestId, send.native);
    }
    return receipt;
  }

  private nativeResponse(view: View, input: Decision, runtime: Worker): NativeResult {
    if (input.kind === 'operation_approval' && (view.kind === 'command_approval' || view.kind === 'file_approval')) return { decision: 'accept' };
    if (input.kind === 'approval_denial') {
      if (view.kind === 'command_approval' || view.kind === 'file_approval') return { decision: 'decline' };
      if (view.kind === 'permission_grant') return { permissions: {}, scope: 'turn' };
    }
    if (input.kind === 'permissions_approval' && view.kind === 'permission_grant') {
      return { permissions: permissionSubset(runtime, view.requested_permissions, input.approved_permissions), scope: 'turn' };
    }
    if (input.kind === 'question_answer' && view.kind === 'user_question') {
      const answerEntries = Object.entries(input.answers);
      if (answerEntries.length !== view.questions.length) throw conflict('INVALID_ANSWERS', 'Answer each question once.');
      const answers = answerEntries.map(([id, answer]) => {
        const question = view.questions.find(question => question.question_id === id);
        if (question?.answer_kind === 'text' && answer?.kind === 'text' && redact(answer.value) === answer.value) return [id, { answers: [answer.value] }];
        if (question?.answer_kind === 'single_choice' && answer?.kind === 'single_choice') {
          const choice = question.choices.find(choice => choice.choice_id === answer.choice_id);
          if (choice) return [id, { answers: [choice.label] }];
        }
        throw conflict('INVALID_ANSWERS', 'Answer using the displayed text or choices, without credentials.');
      });
      return { answers: Object.fromEntries(answers) };
    }
    throw conflict('INVALID_DECISION_KIND', 'Decision kind does not match the worker request.');
  }

  private async deliver(taskId: string, requestId: string, runtime: Worker, native: RequestId, result: NativeResult) {
    const state = await runtime.rpc.write({ id: native, result }).then(() => 'sent', () => 'delivery_unknown');
    const request = this.store.pending(requestId);
    if (!request || !['decision_recorded', 'provider_resolved'].includes(request.state)) return;
    const now = Date.now();
    this.store.tx(() => {
      this.store.run('UPDATE pending_requests SET delivery_state=?,response_sent_at_ms=?,revision=revision+1,updated_at_ms=? WHERE request_id=?',
        state, state === 'sent' ? now : null, now, requestId);
      const task = this.store.task(taskId)!;
      if (!['cancelling', 'recovering', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state)) {
        this.tasks.update(task, task.state, {}, ['pending_requests']);
      }
    });
  }

  resolved(taskId: string, attempt: Attempt, nativeId: RequestId) {
    const request = this.store.one<Pending>('SELECT * FROM pending_requests WHERE attempt_id=? AND runtime_request_key=?',
      attempt.attempt_id, JSON.stringify(nativeId));
    if (!request || !['pending', 'decision_recorded'].includes(request.state)) return;
    const now = Date.now();
    this.store.tx(() => {
      const task = this.store.task(taskId)!;
      this.store.run('UPDATE pending_requests SET state=?,revision=revision+1,updated_at_ms=? WHERE request_id=?',
        request.decision_json ? 'provider_resolved' : 'invalidated', now, request.request_id);
      const waiting = this.store.one("SELECT 1 FROM pending_requests WHERE task_id=? AND state IN ('pending','decision_recorded')", taskId);
      const updated = this.tasks.update(task, task.state === 'waiting_input' && !waiting ? 'running' : task.state, {}, ['pending_requests']);
      this.store.event(updated, 'interaction.closed', { pending_request_id: request.request_id, attempt_id: request.attempt_id,
        reason: 'provider_resolved', decision_source: request.decision_json ? 'human_ui' : 'runtime', resolved_at: iso(now) });
    });
  }
}
