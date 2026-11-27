import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { type Contracts, type Input, standardSchema, tools, validApi } from '@zgent/contracts';
import { Sessions } from './sessions/sessions.ts';
import { projectEvents } from './events.ts';
import { createMcp, mcpBodyLimit } from './mcp/server.ts';
import { sameSecret, type Tasks } from './core/tasks.ts';
import type { Scheduler } from './core/scheduler.ts';
import { Failure, invalid, missing, id, iso, type State } from './core/values.ts';
import { z } from 'zod/v4';
import { human, secret, type Agent, type Client } from './policy/config.ts';
import { applyCandidate, discardCandidate, resolveApplication, resultStats } from './workspaces/results.ts';

const cookie = 'zgent_owner';
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const submission = z.strictObject({ request: z.unknown(), include_tracked_changes: z.boolean().default(false),
  resume_task_id: z.string().max(128).optional() });
const delegateSchema = standardSchema(tools.find(tool => tool.name === 'delegate_task')!.inputSchema);
const checkoutPath = z.string().min(1).max(4096);
const newSession = z.strictObject({ project_id: z.string(), profile_id: z.string(), title: z.string().trim().min(1).max(160), checkout: checkoutPath.optional() });
const newTurn = z.strictObject({ turn_id: z.string(), input: z.string().min(1).max(12000), resume_task_id: z.string().optional() });
const newProfile = z.strictObject({ profile_id: z.string(), model: z.string().min(1).max(256).optional() });
const group = z.strictObject({ turn_id: z.string() });
const recovery = z.strictObject({ expected_version: z.number().int().nonnegative(), confirm_stopped: z.literal(true) });
const workspaceRemoval = z.strictObject({ confirm_removal: z.literal(true) });
const preferences = z.strictObject({ worker: z.string().optional(), base: z.enum(['head','snapshot']).optional() });

function json(res: ServerResponse, status: number, body: unknown, problem = false) {
  res.writeHead(status, { 'content-type': problem ? 'application/problem+json' : 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function bodyOf<K extends keyof Contracts>(name: K, body: unknown): Contracts[K] {
  if (!validApi(name, body)) throw invalid('The request body does not match the v1 contract.');
  return body;
}

function param(url: URL, name: string, max = 128) {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (!value || Array.from(value).length > max) throw invalid('Invalid query parameter: ' + name);
  return value;
}

function target(value: string | undefined) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw invalid('An object or project ID is missing or invalid.');
  return value;
}

function integer(url: URL, name: string, fallback: number, low: number, high: number) {
  const value = param(url, name, 16);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < low || number > high) throw invalid('Invalid query parameter: ' + name);
  return number;
}

async function readJson(req: IncomingMessage) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw invalid('Use an application/json request body.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  const limit = 256 * 1024;
  for await (const chunk of req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > limit) {
      req.resume();
      throw new Failure(413, 'INVALID_REQUEST', 'The body is too large.');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw invalid('Invalid JSON body.'); }
}

function credential(req: IncomingMessage, tasks: Tasks, sessions: Sessions): Agent | undefined {
  const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i)?.[1];
  if (!token) return;
  for (const slot of ['agy', 'claude-code'] as const) {
    if (sameSecret(token, tasks.config.credentials[slot])) return slot;
  }
  return sessions.authenticate(token);
}

export function http(tasks: Tasks, scheduler: Scheduler, shutdown: () => void) {
  const { origin } = tasks.config;
  const host = new URL(origin).host;
  const sessions = new Sessions(tasks);
  const mcp = createMcp(tasks, sessions);
  let pairing: { code: string; expires: number } | undefined;
  let owner: { session: string; csrf: string } | undefined;
  const assets: Record<string, [string, Buffer]> = {
    '/console': ['text/html; charset=utf-8', readFileSync(new URL('../../console/index.html', import.meta.url))],
    '/console/style.css': ['text/css; charset=utf-8', readFileSync(new URL('../../console/style.css', import.meta.url))],
    '/console/console.js': ['text/javascript; charset=utf-8', readFileSync(new URL('../../console/dist/console.js', import.meta.url))],
  };
  const hostHeaders = ['host', 'origin', 'authorization', 'cookie', 'x-csrf-token'];
  const authFailure = () => new Failure(401, 'UNAUTHENTICATED', 'Authenticate with an enrolled client or a paired owner session.');
  const ownerFrom = (req: IncomingMessage) => owner && sameSecret(
    req.headers.cookie?.split(/;\s*/).find(part => part.startsWith(cookie + '='))?.slice(cookie.length + 1), owner.session,
  ) ? owner : undefined;
  const mustOrigin = (req: IncomingMessage) => {
    if (req.headers.origin !== origin) throw new Failure(403, 'INVALID_ORIGIN', 'Use the registered local console origin.');
  };
  const sessionData = (session?: NonNullable<typeof owner>) => ({
    csrf: session?.csrf,
    projects: tasks.store.recentProjects(),
  });

  async function dispatch(req: IncomingMessage, res: ServerResponse, local: boolean) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    const duplicates = hostHeaders.some(name => (req.headersDistinct[name]?.length ?? 0) > 1);
    if (duplicates || (!local && req.headers.host !== host) || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
      throw new Failure(403, 'INVALID_ORIGIN', 'Invalid local Host or Origin.');
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw missing();
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'ok' });
    if (local && req.method === 'POST' && path === '/console/link') {
      pairing = { code: secret(), expires: Date.now() + 60_000 };
      return json(res, 200, { url: origin + '/console#pair=' + pairing.code });
    }
    if (local && req.method === 'POST' && path === '/daemon/stop') {
      res.once('finish', shutdown);
      return json(res, 202, { status: 'stopping' });
    }
    if (path === '/mcp') {
      const principal = credential(req, tasks, sessions);
      if (!principal) {
        res.setHeader('www-authenticate', 'Bearer realm="zgent"');
        throw authFailure();
      }
      if (url.search || req.headers.cookie) throw invalid('The MCP endpoint only accepts its assigned bearer credentials.');
      if (Number(req.headers['content-length']) > mcpBodyLimit) throw new Failure(413, 'INVALID_REQUEST', 'The MCP body is too large.');
      const verified = req as IncomingMessage & { auth: { token: string; clientId: string; scopes: string[] } };
      verified.auth = { token: req.headers.authorization!.slice(7), clientId: principal, scopes: ['tasks'] };
      await mcp.node(verified, res);
      return;
    }
    if (req.method === 'GET' && (Object.hasOwn(assets, path) || /^\/console\/requests\/[A-Za-z0-9._:-]+$/.test(path))) {
      const [mime, asset] = assets[Object.hasOwn(assets, path) ? path : '/console'];
      res.writeHead(200, { 'content-type': mime, 'content-security-policy': CSP, 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' });
      res.end(asset);
      return;
    }
    if (path === '/console/pair' && req.method === 'POST') {
      mustOrigin(req);
      if (req.headers.authorization) throw authFailure();
      const body = await readJson(req) as { code?: string } | null;
      if (!pairing || pairing.expires <= Date.now() || !sameSecret(body?.code, pairing.code)) throw authFailure();
      const current = { session: secret(), csrf: secret() };
      pairing = undefined;
      owner = current;
      res.setHeader('set-cookie', cookie + '=' + current.session + '; Path=/; HttpOnly; SameSite=Strict');
      return json(res, 200, sessionData(current));
    }
    if (path === '/console/session' && req.method === 'GET') {
      const session = ownerFrom(req);
      if ((!local && !session) || req.headers.authorization) throw authFailure();
      return json(res, 200, sessionData(session));
    }
    if (!path.startsWith('/api/v1/')) throw missing();
    const session = ownerFrom(req);
    if (req.headers.authorization && req.headers.cookie) throw authFailure();
    let principal: Client | undefined;
    if (local && (req.method === 'GET' || req.method === 'POST')) {
      principal = human;
    } else if (req.method === 'POST') {
      mustOrigin(req);
      if (!session || req.headers.authorization) throw authFailure();
      if (!sameSecret(req.headers['x-csrf-token'], session.csrf)) throw new Failure(403, 'INVALID_CSRF', 'Reload the active owner session.');
      principal = human;
    } else if (req.method === 'GET') {
      principal = session ? human : credential(req, tasks, sessions);
    } else throw missing();
    if (!principal) throw authFailure();

    const [, , , area, objectId, action, extra] = path.split('/');
    if (extra !== undefined) throw missing();
    if (area === 'projects' && objectId === undefined) {
      if (principal !== human) throw missing();
      if (req.method === 'GET') return json(res, 200, tasks.store.recentProjects());
      const input = z.strictObject({ path: checkoutPath }).safeParse(await readJson(req));
      if (!input.success) throw invalid('Provide a local Git directory.');
      return json(res, 200, tasks.store.openProject(tasks.config, input.data.path));
    }
    if (area === 'session-profiles' || area === 'sessions') {
      if (principal !== human) throw missing();
      if (req.method === 'GET') {
        if (objectId === undefined) {
          const project = target(param(url, 'project_id'));
          return json(res, 200, area === 'session-profiles' ? sessions.profiles(project) : sessions.list(project));
        }
        if (area !== 'sessions') throw missing();
        if (action === 'stream') { sessions.stream(target(objectId), res); return; }
        if (action === 'models') return json(res, 200, await sessions.models(target(objectId)));
        if (action === undefined) return json(res, 200, sessions.detail(target(objectId)));
        throw missing();
      }
      if (area !== 'sessions') throw missing();
      if (objectId === undefined) {
        const input = newSession.safeParse(await readJson(req));
        if (!input.success) throw invalid('Invalid main session.');
        return json(res, 201, await sessions.create(target(input.data.project_id), target(input.data.profile_id), input.data.title, undefined, input.data.checkout));
      }
      const sessionId = target(objectId);
      if (action === 'turn') {
        const input = newTurn.safeParse(await readJson(req));
        if (!input.success) throw invalid('Invalid main session turn.');
        return json(res, 202, sessions.send(sessionId, target(input.data.turn_id), input.data.input,
          input.data.resume_task_id ? target(input.data.resume_task_id) : undefined));
      }
      if (action === 'profile') {
        const input = newProfile.safeParse(await readJson(req));
        if (!input.success) throw invalid('Invalid main profile.');
        return json(res, 200, await sessions.changeProfile(sessionId, target(input.data.profile_id), input.data.model));
      }
      if (action === 'preferences') {
        const input = preferences.safeParse(await readJson(req));
        if (!input.success) throw invalid('Invalid session preferences.');
        return json(res, 200, sessions.preferences(sessionId, input.data));
      }
      if (action === 'cancel-group') {
        const input = group.safeParse(await readJson(req));
        if (!input.success) throw invalid('Invalid task group.');
        return json(res, 202, sessions.cancelGroup(sessionId, target(input.data.turn_id)));
      }
      if (action === 'summary') {
        const input = group.safeParse(await readJson(req));
        if (!input.success) throw invalid('Invalid task group.');
        return json(res, 202, sessions.summarize(sessionId, target(input.data.turn_id)));
      }
      if (action === 'interrupt') return json(res, 202, await sessions.interrupt(sessionId));
      if (action === 'close') return json(res, 200, await sessions.closeSession(sessionId));
      throw missing();
    }
    if (req.method === 'GET') {
      if (area === 'events' && objectId === undefined) {
        projectEvents(tasks, principal, target(param(url, 'project_id')), param(url, 'after', 19) ?? '0', res);
        return;
      }
      if (area === 'model-catalog' && objectId === undefined && principal === human) return json(res, 200, tasks.catalog());
      if (area === 'workspaces' && objectId === undefined && principal === human) {
        return json(res, 200, tasks.retainedWorkspaces(target(param(url, 'project_id'))));
      }
      if (area === 'tasks' && action === 'workspace' && principal === human) {
        const task = tasks.authorized(human, target(objectId));
        return json(res, 200, { ...tasks.workspaceInfo(task), ...resultStats(tasks, task) });
      }
      if (area === 'readiness' && objectId === undefined && principal === human) {
        return json(res, 200, { ready: scheduler.phase === 'ready', phase: scheduler.phase, checked_at: iso() });
      }
      if (area === 'tasks' && objectId === undefined) {
        const state = param(url, 'state');
        const states = ['queued', 'starting', 'running', 'waiting_input', 'cancelling', 'recovering', 'succeeded', 'failed', 'cancelled', 'interrupted'];
        if (state && !states.includes(state)) throw invalid('Invalid task state.');
        return json(res, 200, tasks.list(principal, target(param(url, 'project_id')), state ? [state as State] : [],
          integer(url, 'limit', 50, 1, 100), param(url, 'cursor', 1024)));
      }
      if (area === 'profiles' && objectId === undefined) return json(res, 200, tasks.profiles(principal, target(param(url, 'project_id'))));
      if (action !== undefined) throw missing();
      if (area === 'tasks') return json(res, 200, tasks.snapshot(tasks.authorized(principal, target(objectId))));
      if (area === 'requests') return json(res, 200, scheduler.interactions.get(principal, target(objectId)));
      if (area === 'artifacts') return json(res, 200, tasks.readSlice(principal, target(objectId),
        integer(url, 'offset_bytes', 0, 0, Number.MAX_SAFE_INTEGER), integer(url, 'max_bytes', 65536, 1, 262144)));
      throw missing();
    }
    if (area === 'model-catalog' && objectId === undefined) {
      await scheduler.refresh();
      return json(res, 200, tasks.catalog());
    }
    if (area === 'tasks' && objectId === undefined) {
      const input = submission.safeParse(await readJson(req));
      if (!input.success || 'issues' in delegateSchema['~standard'].validate(input.data.request)) throw invalid('Invalid task submission.');
      return json(res, 202, tasks.delegate(human, input.data.request as Input<'delegate_task'>, {
        include_tracked_changes: input.data.include_tracked_changes,
        resume_task_id: input.data.resume_task_id === undefined ? undefined : target(input.data.resume_task_id),
      }));
    }
    if (area === 'tasks' && action === 'confirm-stopped') {
      const input = recovery.safeParse(await readJson(req));
      if (!input.success) throw invalid('Confirm that the old worker and its related processes have stopped.');
      return json(res, 200, scheduler.confirmStopped(target(objectId), input.data.expected_version));
    }
    if (area === 'tasks' && action === 'remove-workspace') {
      const input = workspaceRemoval.safeParse(await readJson(req));
      if (!input.success) throw invalid('Confirm removal of this worktree.');
      return json(res, 200, tasks.removeWorkspace(target(objectId)));
    }
    if (area === 'tasks' && action === 'apply') {
      const input = z.strictObject({ checkout: checkoutPath.optional() }).safeParse(await readJson(req));
      if (!input.success) throw invalid('Invalid application target.');
      return json(res, 200, applyCandidate(tasks, tasks.authorized(human, target(objectId)), input.data.checkout));
    }
    if (area === 'tasks' && action === 'discard') {
      const input = workspaceRemoval.safeParse(await readJson(req));
      if (!input.success) throw invalid('Confirm removal of this worktree.');
      discardCandidate(tasks, tasks.authorized(human, target(objectId)));
      return json(res, 200, { state: 'removed' });
    }
    if (area === 'tasks' && action === 'resolve-application') {
      const input = z.strictObject({ applied: z.boolean() }).safeParse(await readJson(req));
      if (!input.success) throw invalid('Confirm whether the patch was applied.');
      return json(res, 200, resolveApplication(tasks, tasks.authorized(human, target(objectId)).task_id, input.data.applied));
    }
    if (area === 'tasks' && action === 'cancel') {
      const input = bodyOf('CancelTaskCommand', await readJson(req));
      const { value, duplicate } = tasks.cancel(human, target(objectId), input.command_id, input.reason, input.expected_version);
      return json(res, duplicate || value.disposition === 'already_terminal' ? 200 : 202, {
        command_id: input.command_id, task_id: value.task.task_id,
        acceptance: value.disposition === 'accepted' ? 'requested' : 'already_terminal', requested_at: value.requestedAt,
        task_state: value.task.state, task_version: value.task.version,
      } satisfies Contracts['CancellationReceipt']);
    }
    if (area === 'tasks' && action === 'review') return json(res, 200,
      tasks.review(target(objectId), bodyOf('TaskReviewCommand', await readJson(req))));
    if (area === 'requests' && action === 'decision') {
      const receipt = scheduler.interactions.decide(target(objectId), bodyOf('DecisionRequest', await readJson(req)));
      return json(res, receipt.duplicate ? 200 : 202, receipt.value);
    }
    throw missing();
  }

  const listen = (local: boolean) => createServer({ maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 5000 }, (req, res) => {
    void dispatch(req, res, local).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      const fault = error instanceof Failure ? error : new Failure(500, 'INTERNAL_ERROR', 'The local operation could not complete.');
      if (!(error instanceof Failure)) console.error('Control request failed.', (error as {code?: string}).code ?? '');
      return json(res, fault.status, { type: 'about:blank', title: fault.http, code: fault.http, status: fault.status,
        detail: fault.message, correlation_id: id(), retryable: false } satisfies Contracts['Problem'], true);
    });
  });
  return { server: listen(false), ownerServer: listen(true), close: async () => {
    await sessions.close();
    await mcp.close();
  } };
}
