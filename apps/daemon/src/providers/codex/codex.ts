import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, realpathSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { minCodexVersion, type Config } from '../../policy/config.ts';
import { gatedWorker, groupGone, helper, identity, stopGroup, waitGroupGone } from '../../os/process.ts';
import { ownerSocket } from '../../os/local.ts';
import type { Identity } from '../../os/process.ts';
import { canonical, clip, hash, iso, redact } from '../../core/values.ts';
import { codexFailure } from './failure.ts';
import { Rpc } from './rpc.ts';
import type {
  AskForApproval, FileChangePatchUpdatedNotification, FileUpdateChange, GetAccountResponse, ItemCompletedNotification,
  ItemStartedNotification, ModelListResponse, RequestId, ThreadStartParams, ThreadStartResponse,
  ThreadTokenUsageUpdatedNotification, TurnCompletedNotification, TurnInterruptParams, TurnStartParams, TurnStartResponse, TurnSteerParams, TurnSteerResponse,
} from './protocol.ts';
import type { ServerFrame } from './rpc.ts';
import type { Job, TurnOutcome, Evidence, RunHooks, Worker } from '../worker.ts';

const approval: AskForApproval = { granular: { sandbox_approval: true, rules: false, skill_approval: false,
  request_permissions: true, mcp_elicitations: false } };

export function workerEnv(config: Config, workspace: string) {
  return { HOME: homedir(), CODEX_HOME: config.codexHome, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: join(workspace, '.zgent-tmp'), LANG: 'en_US.UTF-8', USER: process.env.USER, LOGNAME: process.env.LOGNAME,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' };
}

const permissionsName = 'zgent-worker';

export function permissionArgs(config: Config, job: Job) {
  const { cwd, profile, project } = job;
  const rules: Record<string, string> = {
    ':root': 'deny', ':minimal': 'read',
    '/opt/homebrew': 'read', '/usr/local': 'read',
    [project.root]: 'deny',
    [cwd]: profile.mode === 'workspace_write' ? 'write' : 'read',
    [join(cwd, '.zgent-tmp')]: 'write',
    [join(cwd, '.git')]: 'read',
    [project.gitDir]: 'read',
    [config.codexHome]: 'deny',
    ...(config.claude_sdk ? { [config.claude_sdk.home]: 'deny' } : {}),
    ...(config.agy ? { [config.agy.home]: 'deny' } : {}),
  };
  for (const name of ['config.private.json', 'clients.private.json', 'agy-mcp.private.json', 'claude-code-mcp.private.json',
    'owner.sock', 'daemon.lock', 'daemon.log', 'main-sessions', 'zgent.sqlite', 'zgent.sqlite-wal', 'zgent.sqlite-shm', 'artifacts']) {
    rules[join(config.state, name)] = 'deny';
  }
  // Keep an explicit root read denial. The pinned Codex keeps the restricted
  // policy when an operation is approved and a retained denial covers the root.
  const filesystem = Object.entries(rules).map(([key, value]) => JSON.stringify(key) + '=' + JSON.stringify(value)).join(',');
  const args = ['-c', 'default_permissions=' + JSON.stringify(permissionsName),
    '-c', 'permissions.' + permissionsName + '.filesystem={' + filesystem + '}',
    '-c', 'permissions.' + permissionsName + '.network.enabled=' + Boolean(profile.network_domains.length)];
  if (profile.network_domains.length) {
    args.push('-c', 'features.network_proxy=true', '-c', 'permissions.' + permissionsName + '.network.domains={' +
      profile.network_domains.map(domain => JSON.stringify(domain) + '="allow"').join(',') + '}');
  }
  return args;
}

function launchArgs(config: Config, job: Job) {
  const env = workerEnv(config, job.cwd);
  const shellEnv = { PATH: env.PATH, TMPDIR: env.TMPDIR, LANG: env.LANG, GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: env.GIT_CONFIG_NOSYSTEM, GIT_OPTIONAL_LOCKS: env.GIT_OPTIONAL_LOCKS };
  return [...permissionArgs(config, job), '-c', 'mcp_servers={}', '-c', 'notify=[]', '-c', 'web_search="disabled"',
    '-c', 'features.shell_snapshot=false', '-c', 'features.multi_agent=false', '-c', 'features.hooks=false',
    '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false', '-c', 'features.apps=false', '-c', 'features.code_mode=false',
    '-c', 'shell_environment_policy.inherit="none"',
    '-c', 'shell_environment_policy.set={' + Object.entries(shellEnv).map(([key, value]) => key + '=' + JSON.stringify(value)).join(',') + '}'];
}

export function checkSandbox(config: Config, job: Job, hidden: string) {
  const { cwd, profile } = job;
  const readable = join(cwd, 'canary-input');
  const inside = join(cwd, 'canary-output');
  const outside = hidden + '.denied-output';
  const socket = ownerSocket(config.state);
  const probe = join(cwd, 'canary-socket');
  const checkSocket = existsSync(socket);
  if (checkSocket) copyFileSync(helper, probe);
  writeFileSync(readable, 'zgent workspace capability check', { mode: 0o600 });
  const check = spawnSync(config.codex, ['sandbox', ...permissionArgs(config, job), '--', '/bin/sh', '-c',
    '/bin/cat "$4" >/dev/null 2>&1 && ! /bin/cat "$1" >/dev/null 2>&1 && ! /usr/bin/touch "$2" >/dev/null 2>&1 && ' +
    (checkSocket ? '( "$5" connect "$6"; test "$?" -eq 3 ) && ' : '') +
    (profile.mode === 'workspace_write' ? '/usr/bin/touch "$3"' : '! /usr/bin/touch "$3"'),
    'zgent-profile-check', hidden, outside, inside, readable, probe, socket],
    { cwd, env: workerEnv(config, cwd), timeout: 10_000, stdio: 'ignore' });
  const applied = check.status === 0 && !existsSync(outside) &&
    existsSync(inside) === (profile.mode === 'workspace_write');
  rmSync(outside, { force: true });
  rmSync(inside, { force: true });
  rmSync(readable, { force: true });
  rmSync(probe, { force: true });
  return applied;
}

export function startCodex(config: Config, job: Job) {
  mkdirSync(join(job.cwd, '.zgent-tmp'), { mode: 0o700 });
  const worker = gatedWorker(config.codex, ['app-server', '--listen', 'stdio://', ...launchArgs(config, job)],
    job.cwd, workerEnv(config, job.cwd));
  const runtime = new Codex(worker.child as ConstructorParameters<typeof Rpc>[0], job);
  return { runtime, release: worker.release, abort: worker.abort };
}

export function codexVersion(config: Config) {
  try {
    return /^codex-cli (\S+)$/.exec(execFileSync(config.codex, ['--version'], {
      env: { HOME: homedir(), PATH: process.env.PATH, CODEX_HOME: config.codexHome }, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim())?.[1];
  } catch { return undefined; }
}

export function supportedCodexVersion(version: string) {
  const values = /^(\d+)\.(\d+)\.(\d+)(-[^+]+)?(?:\+.+)?$/.exec(version);
  if (!values) return false;
  const found = values.slice(1, 4).map(Number);
  const minimum = minCodexVersion.split('.').map(Number);
  const difference = found.findIndex((value, index) => value !== minimum[index]);
  return difference >= 0 ? found[difference] > minimum[difference] : !values[4];
}

export async function discover(config: Config) {
  const root = mkdtempSync(join(config.state, 'runtime-check-'));
  const cwd = join(root, 'workspace');
  const project = { id: 'probe', label: 'Runtime check', root: cwd, gitDir: join(cwd, '.git'), base_ref: 'HEAD', worktreeRoot: root };
  const job = { cwd, profile: config.profiles[0], project };
  mkdirSync(join(cwd, '.zgent-tmp'), { mode: 0o700, recursive: true });
  const env = workerEnv(config, cwd);
  const version = codexVersion(config);
  if (!version || !supportedCodexVersion(version)) {
    rmSync(root, { recursive: true, force: true });
    return { status: 'unavailable' as const, sandboxVerified: false, reason: version ?
      'Codex CLI ' + minCodexVersion + ' or later is required.' : 'The configured Codex CLI could not be started.' };
  }
  const hidden = join(root, 'sandbox-check');
  writeFileSync(hidden, 'zgent sandbox capability check', { mode: 0o600 });
  for (const profile of config.profiles) {
    if (!checkSandbox(config, { cwd, profile, project }, hidden)) {
      rmSync(root, { recursive: true, force: true });
      return { status: 'unavailable' as const, sandboxVerified: false, reason: 'Codex native sandbox did not enforce the configured worker profile.' };
    }
  }
  const worker = gatedWorker(config.codex, ['app-server', '--listen', 'stdio://', ...launchArgs(config, job)], cwd, env);
  const rpc = new Rpc(worker.child as ConstructorParameters<typeof Rpc>[0]);
  const owner = worker.child.pid ? identity(worker.child.pid) : undefined;
  if (!owner || owner.pid !== owner.pgid) {
    worker.abort();
    await rpc.closed;
    rmSync(root, { recursive: true, force: true });
    return { status: 'unavailable' as const, sandboxVerified: true, reason: 'Could not verify the Codex startup process group.' };
  }
  worker.release();
  try {
    await rpc.initialize();
    const account = await rpc.call<GetAccountResponse>('account/read', { refreshToken: false }, 10_000);
    if (!account.account) return { status: 'requires_login' as const, sandboxVerified: true, reason: 'Sign into the dedicated Codex home.' };
    const listModels = async () => {
      const models = new Map<string, string>();
      let cursor: string | null = null;
      do {
        const result: ModelListResponse = await rpc.call('model/list', { cursor, limit: 100, includeHidden: false }, 10_000);
        for (const model of result.data) models.set(model.model, model.displayName);
        cursor = result.nextCursor;
      } while (cursor);
      return models;
    };
    let models = await listModels();
    if (models.size === 0) {
      await rpc.call<GetAccountResponse>('account/read', { refreshToken: true }, 10_000).catch(() => {});
      await delay(1000);
      models = await listModels();
    }
    if (models.size === 0) return { status: 'unavailable' as const, sandboxVerified: true, reason: 'Codex returned an empty model catalog.' };
    return { status: 'available' as const, sandboxVerified: true, models };
  } catch {
    return { status: 'unavailable' as const, sandboxVerified: true, reason: 'Codex initialization or model discovery did not complete.' };
  } finally {
    rpc.child.stdin.end();
    await Promise.race([rpc.closed, delay(500)]);
    if (!groupGone(owner.pgid)) await stopGroup(owner, { liveOrphan: rpc.exited });
    rmSync(root, { recursive: true, force: true });
  }
}

export class Codex implements Worker {
  rpc: Rpc;
  job: Job;
  thread: string | undefined;
  turn: string | undefined;
  stopping = false;
  evidence: Evidence[] = [];
  finalText = '';
  activeCommands = new Set<string>();
  patches = new Map<string, FileUpdateChange[]>();
  fileRequests = new Map<RequestId, { itemId: string; digest: string }>();
  outcome: TurnOutcome | undefined;
  artifactsTruncated = false;
  failure?: string;

  constructor(child: ConstructorParameters<typeof Rpc>[0], job: Job) {
    this.rpc = new Rpc(child);
    this.job = job;
  }

  async perform(prompt: string, hooks: RunHooks) {
    let submitted = false;
    let earlyTurn: string | undefined;
    const itemMatches = (params: { threadId: string; turnId: string }) =>
      submitted && params.threadId === this.thread && params.turnId === (this.turn ?? (earlyTurn ??= params.turnId));
    this.rpc.invalidFrame = hooks.badFrame;
    this.rpc.request = frame => {
      const params = frame.params as { threadId?: string; turnId?: string; itemId?: string };
      if (!this.stopping && typeof params?.threadId === 'string' && typeof params.turnId === 'string' &&
        itemMatches({ threadId: params.threadId, turnId: params.turnId })) {
        const patches = params.itemId === undefined ? undefined : this.patches.get(params.itemId);
        if (frame.method === 'item/fileChange/requestApproval' && params.itemId && patches) {
          this.fileRequests.set(frame.id, { itemId: params.itemId, digest: hash(canonical(patches)) });
        }
        hooks.request(frame, patches);
      } else void this.error(frame.id);
    };
    let resolveTurn: (outcome: TurnOutcome) => void = () => {};
    const completed = new Promise<TurnOutcome>(resolve => { resolveTurn = resolve; });
    this.rpc.notification = (method, raw) => {
      if (method === 'turn/completed') {
        const { threadId, turn } = raw as TurnCompletedNotification;
        if (!itemMatches({ threadId, turnId: turn.id }) || this.outcome) return;
        if (turn.status === 'inProgress') return;
        this.outcome = turn.status;
        this.failure = codexFailure(turn.error?.codexErrorInfo);
        for (const item of turn.items) {
          if (item.type === 'agentMessage') this.recordText(item.text);
        }
        hooks.outcome(turn.status);
        resolveTurn(turn.status);
      } else if (method === 'thread/tokenUsage/updated') {
        const value = raw as ThreadTokenUsageUpdatedNotification;
        if (!itemMatches(value)) return;
        const usage = this.job.resumeThread ? value.tokenUsage.last : value.tokenUsage.total;
        hooks.usage({ status: this.job.resumeThread ? 'incomplete' : 'reported', source: 'runtime', as_of: iso(),
          scope: 'attempt', input_tokens: usage.inputTokens, cached_input_tokens: usage.cachedInputTokens,
          output_tokens: usage.outputTokens, reasoning_tokens: usage.reasoningOutputTokens, total_tokens: usage.totalTokens });
      } else if (method === 'item/started') {
        const value = raw as ItemStartedNotification;
        if (!itemMatches(value)) return;
        if (value.item.type === 'fileChange') this.patches.set(value.item.id, value.item.changes);
        if (value.item.type === 'commandExecution') this.activeCommands.add(value.item.id);
      } else if (method === 'item/fileChange/patchUpdated') {
        const value = raw as FileChangePatchUpdatedNotification;
        if (itemMatches(value)) this.patches.set(value.itemId, value.changes);
      } else if (method === 'item/completed') {
        const value = raw as ItemCompletedNotification;
        if (!itemMatches(value)) return;
        const item = value.item;
        if (item.type === 'agentMessage') this.recordText(item.text);
        if (item.type === 'commandExecution') {
          if (item.exitCode !== null || item.status !== 'inProgress') this.activeCommands.delete(item.id);
          if (this.evidence.length < 500) this.evidence.push({ command: clip(redact(item.command), 2000),
            status: item.status, exitCode: item.exitCode, output: clip(redact(item.aggregatedOutput ?? ''), 16_000) });
          else this.artifactsTruncated = true;
        }
      } else if (method === 'serverRequest/resolved') {
        const params = raw as { threadId: string; requestId: RequestId };
        if (params.threadId === this.thread) {
          this.fileRequests.delete(params.requestId);
          hooks.resolved(params.requestId);
        }
      }
    };

    await this.rpc.initialize();
    if (this.stopping) return 'interrupted';
    const { cwd, profile } = this.job;
    const params: ThreadStartParams = { cwd, model: profile.model, permissions: permissionsName, runtimeWorkspaceRoots: [cwd],
      approvalPolicy: approval, approvalsReviewer: 'user',
      developerInstructions: 'Work only on the delegated task in this worktree. Earlier conversation is reference context. Do not reuse old approvals, merge, push, launch persistent background services, or delegate tasks. Report changes, verification and unresolved issues.' };
    const opened = this.job.resumeThread
      // Both responses expose the same fields used to verify the new execution boundary.
      ? await this.rpc.call<ThreadStartResponse>('thread/resume', { ...params, threadId: this.job.resumeThread, excludeTurns: true })
      : await this.rpc.call<ThreadStartResponse>('thread/start', { ...params, ephemeral: false });
    if (opened.cwd !== realpathSync(cwd) || opened.model !== profile.model ||
        !['readOnly', 'workspaceWrite'].includes(opened.sandbox?.type) ||
        opened.activePermissionProfile?.id !== permissionsName ||
        canonical(opened.runtimeWorkspaceRoots) !== canonical([cwd]) || opened.approvalsReviewer !== 'user' ||
        canonical(opened.approvalPolicy) !== canonical(approval)) {
      throw new Error('Codex did not apply the configured worker restrictions.');
    }
    this.thread = opened.thread.id;
    hooks.thread(opened.thread.id, opened.model);
    if (this.stopping || !hooks.beforeTurn()) return 'interrupted';
    const input: TurnStartParams = { threadId: this.thread, input: [{ type: 'text', text: prompt, text_elements: [] }],
      effort: this.job.profile.effort ?? null };
    submitted = true;
    const response = await this.rpc.call<TurnStartResponse>('turn/start', input);
    if (earlyTurn && response.turn.id !== earlyTurn) throw new Error('Codex replied with a different turn identity.');
    this.turn = response.turn.id;
    hooks.turn(this.turn);
    if (this.stopping) void this.interrupt(this.turn);
    return await Promise.race([completed, this.rpc.closed.then(() => 'disconnected' as const)]);
  }

  async error(id: RequestId) {
    await this.rpc.write({ id, error: { code: -32601, message: 'This worker interaction is unavailable.' } }).catch(() => {});
  }

  fileRequestCurrent(id: RequestId) {
    const request = this.fileRequests.get(id);
    const patches = request && this.patches.get(request.itemId);
    return request && patches && hash(canonical(patches)) === request.digest;
  }

  private recordText(text: string) {
    const safe = redact(text);
    this.finalText = clip(safe, 64_000);
    if (this.finalText !== safe) this.artifactsTruncated = true;
  }

  async steer(message: string) {
    if (!this.thread || !this.turn || this.stopping || this.outcome) return false;
    const input: TurnSteerParams = { threadId: this.thread, expectedTurnId: this.turn,
      input: [{ type: 'text', text: message, text_elements: [] }] };
    const result = await this.rpc.call<TurnSteerResponse>('turn/steer', input, 10_000);
    return result.turnId === this.turn;
  }

  private async interrupt(turnId: string) {
    if (!this.thread) return;
    const params: TurnInterruptParams = { threadId: this.thread, turnId };
    await this.rpc.call('turn/interrupt', params, 2500).catch(() => {});
  }

  async stop(process: Identity, cancel: boolean) {
    this.stopping = true;
    if (cancel && !this.outcome && !this.rpc.exited && this.turn) {
      const deadline = Date.now() + 10_000;
      await this.interrupt(this.turn);
      while (!this.outcome && !this.rpc.exited && Date.now() < deadline) await delay(100);
    }
    this.rpc.child.stdin.end();
    await Promise.race([this.rpc.closed, delay(750)]);
    if (this.rpc.exited) await waitGroupGone(process.pgid, 750);
    const groupStopped = groupGone(process.pgid) || await stopGroup(process, { liveOrphan: this.rpc.exited });
    await Promise.race([this.rpc.closed, delay(1000)]);
    return groupStopped && this.rpc.exited;
  }
}
