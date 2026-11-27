import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { validApi, standardSchema, tools, type Contracts } from '@zgent/contracts';
import { allocate, collect } from '../src/workspaces/git.ts';
import { checkSandbox, permissionArgs, workerEnv } from '../src/providers/codex/codex.ts';
import { gatedWorker, groupGone, identity, stopGroup } from '../src/os/process.ts';
import type { Config, Profile } from '../src/policy/config.ts';
import { jsonResponse, ownerRequest, ownerSocket } from '../src/os/local.ts';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture', '-C', cwd, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zgent-test-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'source.txt'), 'initial\n');
  git(repo, 'add', 'source.txt');
  git(repo, 'commit', '-m', 'Initial fixture');
  return { root, repo, base: git(repo, 'rev-parse', 'HEAD') };
}

async function until<T>(check: () => T | undefined | Promise<T | undefined>, description: string): Promise<T> {
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    const found = await check();
    if (found !== undefined) return found;
    await delay(80);
  }
  throw new Error('Expected ' + description);
}

test('stopGroup stops orphaned children only when liveOrphan is explicitly enabled', async () => {
  const { child, release } = gatedWorker('/bin/sh', ['-c', '/bin/sleep 30 >/dev/null 2>&1 & exit 0'], tmpdir(), process.env);
  const owner = identity(child.pid!)!;
  assert.equal(owner.pid, owner.pgid);
  const exited = once(child, 'close');
  release();
  await exited;
  assert.equal(groupGone(owner.pgid), false);
  // Strict mode (post-crash reconcile) must refuse to blindly signal after leader exit.
  assert.equal(await stopGroup(owner), false);
  assert.equal(groupGone(owner.pgid), false);
  // Live worker teardown mode cleanly terminates remaining members of the owned group.
  assert.equal(await stopGroup(owner, { liveOrphan: true }), true);
  assert.equal(groupGone(owner.pgid), true);
});

test('worktree collection includes commit, staged-only, unstaged, binary and untracked changes', () => {
  const { root, repo, base } = fixture();
  try {
    const work = join(root, 'work');
    allocate(repo, work, 'worker', base);
    writeFileSync(join(work, 'committed.txt'), 'committed\n');
    git(work, 'add', 'committed.txt');
    git(work, 'commit', '-m', 'Worker commit');
    writeFileSync(join(work, 'source.txt'), 'only staged\n');
    git(work, 'add', 'source.txt');
    writeFileSync(join(work, 'source.txt'), 'initial\n');
    writeFileSync(join(work, 'untracked.txt'), 'untracked\n');
    writeFileSync(join(work, 'binary.bin'), Buffer.from([0, 1, 2, 255]));
    const results = collect(work, base);
    assert.deepEqual(results.paths.sort(), ['binary.bin', 'committed.txt', 'source.txt', 'untracked.txt']);
    assert.match(results.cumulative.toString(), /GIT binary patch/);
    assert.match(results.staged.toString(), /only staged/);
    assert.match(git(work, 'diff', '--cached'), /only staged/);
    assert.notEqual(results.head, base);
    assert.equal(git(repo, 'status', '--porcelain'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the native Codex profile protects daemon state and the owner socket in both worker modes', async () => {
  const { root, repo, base } = fixture();
  const server = createServer(socket => socket.end());
  try {
    const daemon = join(root, 'state'), work = join(daemon, 'worktree'), codexHome = join(root, 'codex');
    mkdirSync(daemon);
    allocate(repo, work, 'native-probe', base);
    mkdirSync(join(work, '.zgent-tmp'));
    mkdirSync(codexHome);
    const hidden = join(daemon, 'protected-fixture');
    writeFileSync(hidden, 'synthetic');
    const codex = process.env.ZGENT_TEST_CODEX ?? execFileSync('/bin/sh', ['-c', 'command -v codex']).toString().trim();
    const config = { state: daemon, codexHome, codex } as Config;
    const project = { id: 'fixture', label: 'Fixture', root: repo, base_ref: 'refs/heads/main', gitDir: join(repo, '.git'), worktreeRoot: daemon };
    server.listen(ownerSocket(daemon));
    await once(server, 'listening');
    assert.equal(spawnSync(fileURLToPath(new URL('../dist/process', import.meta.url)), ['connect', ownerSocket(daemon)]).status, 0);
    for (const mode of ['workspace_write', 'read_only'] as const) {
      const profile: Profile = { id: 'fixture', label: 'Fixture', model: 'fixture', runtime: 'codex_app_server', execution_minutes: 30, request_minutes: 30, total_minutes: 120, max_active: 2, mode, network_domains: [], billing: 'unknown' };
      assert(checkSandbox(config, { cwd: work, profile, project }, hidden), 'run native Codex sandbox tests directly on the Mac');
      if (mode === 'workspace_write') {
        const check = spawnSync(codex, ['sandbox', ...permissionArgs(config, {cwd: work, profile, project}), '--', '/bin/sh', '-c',
          '/usr/bin/git status --short && ! /usr/bin/touch "$1"', 'native-git', join(repo, 'outside-worktree')],
          { cwd: work, env: workerEnv(config, work), encoding: 'utf8', timeout: 10_000 });
        assert.equal(check.status, 0, check.stderr);
        assert(!existsSync(join(repo, 'outside-worktree')));
      }
    }
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP and Apps, snapshots, main sessions, event replay and safe restart over loopback', { timeout: 50_000 }, async () => {
  const { root, repo, base } = fixture();
  const daemon = join(root, 'state'), codexHome = join(root, 'codex');
  mkdirSync(daemon, { mode: 0o700 });
  mkdirSync(codexHome, { mode: 0o700 });
  chmodSync(codexHome, 0o755);
  const agyHome = join(root, 'agy'), claudeHome = join(root, 'claude');
  mkdirSync(agyHome, { mode: 0o700 });
  mkdirSync(claudeHome, { mode: 0o700 });
  const agyExecutable = join(agyHome, 'fixture-agy');
  writeFileSync(agyExecutable, '#!' + process.execPath + '\n' + readFileSync(new URL('./fixtures/agy.mjs', import.meta.url), 'utf8'), { mode: 0o700 });
  const executable = join(codexHome, 'fixture-codex');
  const program = readFileSync(new URL('./fixtures/codex.mjs', import.meta.url), 'utf8');
  writeFileSync(executable, '#!' + process.execPath + '\n' + program, { mode: 0o700 });
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => reservation.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  assert(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = 'http://127.0.0.1:' + port;
  writeFileSync(join(daemon, 'config.private.json'), JSON.stringify({
    port, codex: executable, codex_home: codexHome,
    agy: { executable: agyExecutable, home: agyHome }, claude_sdk: { home: claudeHome, authentication: 'api_key' },
    main_profiles: [
      { id: 'google', label: 'Google', runtime: 'antigravity_acp', projects: ['fixture'], worker_profiles: ['implement','sol','astra'], billing: 'provider_plan' },
      { id: 'claude-main', label: 'Claude', runtime: 'claude_agent_sdk', model: 'not-called', projects: ['fixture'], worker_profiles: ['implement'], billing: 'api_metered' },
    ],
    projects: [{ id: 'fixture', label: 'Fixture', root: repo, base_ref: 'refs/heads/main' }],
    profiles: [{ id: 'implement', label: 'Implement', model: 'fixture-model', mode: 'workspace_write', billing: 'unknown' },
      { id: 'sol', label: 'Sol', model: 'gpt-6.2-sol', mode: 'workspace_write', billing: 'provider_plan' },
      { id: 'astra', label: 'Astra', model: 'gpt-6.2-astra', mode: 'workspace_write', billing: 'provider_plan' }],
    clients: { agy: { projects: ['fixture'], profiles: ['implement'], read: 'project', control: 'project' },
      'claude-code': { projects: ['fixture'], profiles: ['implement'], read: 'own' } },
  }), { mode: 0o600 });

  let processChild: ChildProcess | undefined, agy: Client | undefined, claude: Client | undefined;
  let cookie = '', csrf = '';
  let startOutput = '';
  async function api(path: string, data?: unknown, headers?: Record<string, string>, keepCookie = true) {
    const response = await fetch(origin + path, {
      ...(data ? { method: 'POST', body: JSON.stringify(data) } : {}),
      headers: { ...(keepCookie && cookie ? { Cookie: cookie } : {}),
        ...(data ? { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' } : {}), ...headers },
      signal: AbortSignal.timeout(6000),
    });
    return { response, body: await response.json() };
  }
  function launch() {
    const helper = fileURLToPath(new URL('../dist/process', import.meta.url));
    const entry = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    startOutput = '';
    processChild = spawn(helper, ['lock', join(daemon, 'daemon.lock'), process.execPath, entry, daemon], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: undefined } });
    processChild.stdout!.on('data', chunk => { startOutput += String(chunk); });
    processChild.stderr!.on('data', chunk => { startOutput += String(chunk); });
  }
  async function shutdown(signal: NodeJS.Signals) {
    if (!processChild || processChild.exitCode !== null || processChild.signalCode !== null) return;
    const exited = once(processChild, 'close');
    processChild.kill(signal);
    await exited;
  }
  async function pair() {
    await until(async () => api('/healthz', undefined, undefined, false).then(({response}) => response.ok ? true : undefined, () => undefined), 'loopback daemon');
    const { url } = await jsonResponse<{url: string}>(await ownerRequest(ownerSocket(daemon), '/console/link', {}));
    const code = new URLSearchParams(new URL(url).hash.slice(1)).get('pair');
    const { body, response } = await api('/console/pair', { code }, undefined, false);
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie')!.split(';')[0];
    csrf = body.csrf;
    assert.equal((await api('/console/pair', { code }, undefined, false)).response.status, 401);
    await until(async () => {
      const state = (await api('/api/v1/readiness')).body;
      if (state.phase === 'degraded') throw new Error('Fixture profile degraded: ' + (await api('/api/v1/profiles?project_id=fixture')).body.profiles[0].availability.reason + ' ' + startOutput);
      return state.ready ? true : undefined;
    }, 'fixture readiness');
  }
  const toolsByName = new Map(tools.map(tool => [tool.name, standardSchema(tool.outputSchema)]));
  async function call(client: Client, name: Parameters<typeof toolsByName.get>[0], args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const envelope = result.structuredContent;
    assert(envelope && !('issues' in toolsByName.get(name)!['~standard'].validate(envelope)),
      'MCP output conforms to v1: ' + name + ' ' + (result.isError ? JSON.stringify(result.content) : ''));
    return envelope as { ok: boolean; data: any; error: { code: string } | null };
  }
  function connect(token: string) {
    const client = new Client({ name: 'integration-sdk', version: '0.0.1' });
    return client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + token }, redirect: 'error' },
    })).then(() => client);
  }
  const brief = (goal: string, requestId: string) => ({
    request_id: requestId, project_id: 'fixture', profile_id: 'implement', brief: { goal, acceptance_criteria: ['Valid fixture'] },
  });
  const read = async (id: string) => (await api('/api/v1/tasks/' + id)).body as Contracts['TaskView'];
  const inState = (id: string, state: Contracts['TaskView']['state']) =>
    until(async () => {
      const task = await read(id);
      if (task.state === state) return task;
      if (['failed', 'interrupted', 'cancelled', 'recovering'].includes(task.state) && state !== 'recovering') {
        throw new Error('Expected ' + state + ', found ' + task.state + ': ' + task.summary + ' ' + task.recovery?.summary + ' ' + startOutput);
      }
    }, state);

  try {
    writeFileSync(join(repo, 'source.txt'), 'user working copy\n');
    launch();
    await pair();
    assert(startOutput.includes(`WARN codex_home ${JSON.stringify(codexHome)} has mode 0755.`));
    assert.equal(statSync(codexHome).mode & 0o777, 0o755);
    const concurrent = spawn(fileURLToPath(new URL('../dist/process', import.meta.url)),
      ['lock', join(daemon, 'daemon.lock'), '/usr/bin/true'], { stdio: 'ignore' });
    assert.equal((await once(concurrent, 'exit'))[0], 73);
    const tokens = JSON.parse(readFileSync(join(daemon, 'clients.private.json'), 'utf8'));
    assert.equal(statSync(join(daemon, 'clients.private.json')).mode & 0o077, 0);
    agy = await connect(tokens.agy);
    claude = await connect(tokens['claude-code']);
    const listed = await agy.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), tools.map(tool => tool.name).sort());
    const appResource = await agy.readResource({ uri: 'ui://zgent/tasks.html' });
    assert.match(appResource.contents[0].mimeType ?? '', /mcp-app/);
    const appText = (appResource.contents[0] as {text: string}).text;
    assert(appText.includes('Zgent'));
    assert(!appText.includes(tokens.agy));
    for (const tool of tools) {
      const advertised = listed.tools.find(item => item.name === tool.name)!;
      assert.deepEqual(advertised.inputSchema, tool.inputSchema);
      assert.deepEqual(advertised.outputSchema, tool.outputSchema);
    }
    assert.equal((await api('/api/v1/tasks?project_id=fixture', undefined, { Origin: 'http://elsewhere.invalid' })).response.status, 403);
    assert.equal((await api('/api/v1/tasks?project_id=fixture', undefined, { Authorization: 'Bearer wrong' }, false)).response.status, 401);
    assert((await call(agy, 'list_profiles', { project_id: 'fixture' })).ok);

    const firstRequest = brief('fixture approval', 'first-request');
    const first = await call(agy, 'delegate_task', firstRequest);
    assert(first.ok);
    assert.match(first.data.task.summary, /local changes excluded/);
    const a = first.data.task.task_id;
    const duplicate = await call(agy, 'delegate_task', firstRequest);
    assert.equal(duplicate.data.task.task_id, a);
    assert.equal(duplicate.data.deduplicated, true);
    assert.equal((await call(agy, 'delegate_task', { ...firstRequest, brief: { goal: 'other', acceptance_criteria: ['other'] } })).error?.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await call(claude, 'get_task', { task_id: a })).error?.code, 'NOT_FOUND');
    const second = await call(claude, 'delegate_task', brief('fixture hold', 'second-request'));
    assert(second.ok);
    const b = second.data.task.task_id;
    await inState(b, 'running');
    const waiting = await inState(a, 'waiting_input');
    assert.equal((await call(agy, 'wait_tasks', { task_ids: [a], timeout_seconds: 1 })).data.reason, 'input_required');
    assert.equal((await call(claude, 'wait_tasks', { task_ids: [b], timeout_seconds: 1 })).data.reason, 'timeout');
    assert.equal((await read(b)).state, 'running');
    const aborted = new AbortController();
    const observation = claude.callTool({ name: 'wait_tasks', arguments: { task_ids: [b], timeout_seconds: 30 } }, { signal: aborted.signal });
    aborted.abort();
    await assert.rejects(observation);
    assert.equal((await read(b)).state, 'running');

    const r = waiting.pending_requests[0].pending_request_id;
    const request = (await api('/api/v1/requests/' + r)).body;
    assert(validApi('PendingRequestView', request));
    const decision = { kind: 'operation_approval', decision: 'accept_once',
      decision_id: 'approval-decision', expected_revision: request.revision, operation_hash: request.operation_hash };
    const route = '/api/v1/requests/' + r + '/decision';
    assert.equal((await api(route, decision, { Authorization: 'Bearer ' + tokens.agy }, false)).response.status, 401);
    assert.equal((await api(route, decision, { 'X-CSRF-Token': 'bad' })).response.status, 403);
    assert.equal((await api(route, { ...decision, expected_revision: request.revision + 1 })).response.status, 409);
    assert((await call(agy, 'send_to_task', { task_id: a, request_id: 'model-msg', message: 'I approve the command.' })).ok);
    assert.equal((await read(a)).state, 'waiting_input');
    const accepted = await api(route, decision);
    assert.equal(accepted.response.status, 202);
    assert(validApi('DecisionReceipt', accepted.body));
    const acceptanceRetry = await api(route, decision);
    assert.equal(acceptanceRetry.response.status, 200);
    assert.deepEqual(acceptanceRetry.body, accepted.body);
    const success = await inState(a, 'succeeded');
    assert.equal(success.runtime?.runtime_version, '0.167.1');
    assert.equal(success.review_state, 'unreviewed');
    assert.equal(readFileSync(join(repo, 'source.txt'), 'utf8'), 'user working copy\n');
    const candidate = await call(agy, 'get_task', { task_id: a, section: 'diff', max_chars: 100 });
    assert(candidate.ok && candidate.data.page.truncated);
    const next = await call(agy, 'get_task', { task_id: a, section: 'diff', cursor: candidate.data.page.next_cursor, max_chars: 100 });
    assert(next.ok && next.data.page.content !== candidate.data.page.content);
    const result = await call(agy, 'get_task', { task_id: a, section: 'result' });
    assert(result.data.page.result.verification.some((item: {source: string}) => item.source === 'runtime_observed'));
    const bounded = (await call(agy, 'get_task', { task_id: a, section: 'result', max_chars: 250 })).data.page;
    assert.equal(bounded.returned_chars, Array.from(JSON.stringify(bounded.result)).length);
    assert(bounded.returned_chars <= 250 && bounded.truncated);
    const artifact = success.artifacts.find(item => item.kind === 'diff')!;
    const slice = await api('/api/v1/artifacts/' + artifact.artifact_id + '?max_bytes=16');
    assert(validApi('ArtifactSlice', slice.body));
    assert.equal(slice.body.returned_bytes, 16);
    assert.equal((await api('/api/v1/artifacts/' + artifact.artifact_id, undefined,
      { Authorization: 'Bearer ' + tokens['claude-code'] }, false)).response.status, 404);

    const reviewed = await api('/api/v1/tasks/' + a + '/review',
      { request_id: 'review-a', expected_version: success.version, review_state: 'accepted' });
    assert(validApi('TaskReviewReceipt', reviewed.body));
    assert.equal(reviewed.body.task.review_state, 'accepted');

    assert((await call(agy, 'send_to_task', { task_id: b, request_id: 'steer-b', message: 'The next input.' })).ok);
    await until(() => {
      const db = new DatabaseSync(join(daemon, 'zgent.sqlite'), { readOnly: true });
      try { return db.prepare("SELECT 1 AS delivered FROM task_commands WHERE request_id='steer-b' AND state='acknowledged'").get()?.delivered as number | undefined; }
      finally { db.close(); }
    }, 'steering receipt');
    const cancelled = await call(claude, 'cancel_task', { task_id: b, request_id: 'cancel-b' });
    assert.equal(cancelled.data.task.state, 'cancelling');
    await inState(b, 'cancelled');
    const cleanPath = (await api('/api/v1/tasks/' + b + '/workspace')).body.workspace.managed_path;
    const cleanup = '/api/v1/tasks/' + b + '/remove-workspace';
    const remove = { confirm_removal: true };
    assert.equal((await api(cleanup, remove, { Authorization: 'Bearer ' + tokens.agy }, false)).response.status, 401);
    const localFile = join(cleanPath, 'keep-local.txt');
    writeFileSync(localFile, 'preserve this file');
    assert.equal((await api(cleanup, remove)).response.status, 409);
    assert.equal(readFileSync(localFile, 'utf8'), 'preserve this file');
    rmSync(localFile);
    assert.equal((await api(cleanup, remove)).body.workspace.state, 'removed');
    assert.equal(existsSync(cleanPath), false);
    assert.equal(git(repo, 'rev-parse', 'refs/heads/zgent/' + b), base);
    assert.equal((await api(cleanup, remove)).response.status, 200);

    const question = (await call(agy, 'delegate_task', brief('fixture question', 'question'))).data.task.task_id;
    const questionTask = await inState(question, 'waiting_input');
    assert.equal((await api('/api/v1/tasks/' + question + '/workspace')).body.workspace.managed_path, cleanPath);
    assert.equal((await api('/api/v1/tasks/' + b + '/discard', remove)).response.status, 200);
    assert(existsSync(cleanPath), 'cleanup of the old task preserves the reused directory');
    const q = questionTask.pending_requests[0].pending_request_id;
    const qView = (await api('/api/v1/requests/' + q)).body;
    assert.equal((await api('/api/v1/requests/' + q + '/decision', { kind: 'question_answer', decision_id: 'answer',
      expected_revision: qView.revision, operation_hash: qView.operation_hash, answers: { style: { kind: 'single_choice', choice_id: '1' } } })).response.status, 202);
    await inState(question, 'succeeded');

    const permission = (await call(agy, 'delegate_task', brief('fixture permissions', 'permission'))).data.task.task_id;
    const p = (await inState(permission, 'waiting_input')).pending_requests[0].pending_request_id;
    const pView = (await api('/api/v1/requests/' + p)).body;
    const permissionDecision = { kind: 'permissions_approval', decision: 'accept_once', decision_id: 'permission-decision',
      expected_revision: pView.revision, operation_hash: pView.operation_hash };
    const permissionRoute = '/api/v1/requests/' + p + '/decision';
    assert.equal((await api(permissionRoute, { ...permissionDecision, approved_permissions: { fileSystem: { read: [repo] } } })).body.code,
      'INVALID_PERMISSION_SUBSET');
    assert.equal((await api(permissionRoute, { ...permissionDecision,
      approved_permissions: { fileSystem: { read: pView.requested_permissions.fileSystem.read } } })).response.status, 202);
    await inState(permission, 'succeeded');

    writeFileSync(join(repo, 'excluded.txt'), 'untracked fixture\n');
    const snap = await api('/api/v1/tasks', { request: { ...brief('snapshot run', 'snapshot'), profile_id: 'sol' }, include_tracked_changes: true });
    assert.equal(snap.response.status, 202);
    const snapId = snap.body.task.task_id;
    assert.equal(snap.body.resolved.model_id, 'gpt-6.2-sol');
    await inState(snapId, 'succeeded');
    const snapDetails = (await api('/api/v1/tasks/' + snapId + '/workspace')).body;
    assert.equal(snapDetails.tracked_snapshot.original_head, base);
    assert.deepEqual(snapDetails.tracked_snapshot.excluded_untracked, ['excluded.txt']);
    assert.notEqual(snapDetails.base_commit, base);
    assert.equal(readFileSync(join(snapDetails.workspace.managed_path, 'source.txt'), 'utf8'), 'user working copy\n');
    assert.equal(readFileSync(join(repo, 'source.txt'), 'utf8'), 'user working copy\n');
    const followup = await api('/api/v1/tasks', { request: { ...brief('continued context', 'new-context'), profile_id: 'astra' }, resume_task_id: snapId });
    assert.equal(followup.response.status, 202);
    assert.equal(followup.body.resolved.model_id, 'gpt-6.2-astra');
    const continued = await inState(followup.body.task.task_id, 'succeeded');
    assert.equal(continued.runtime?.model_id, 'gpt-6.2-astra');

    const board = (await api('/api/v1/tasks?project_id=fixture')).body;
    const sseAbort = new AbortController();
    const sse = await fetch(origin + '/api/v1/events?project_id=fixture&after=' + board.snapshot_event_cursor,
      { headers: { Cookie: cookie }, signal: sseAbort.signal });
    assert.equal(sse.status, 200);
    const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
    try {
      const changed = await api('/api/v1/tasks/' + continued.task_id + '/review',
        { request_id: 'review-followup', expected_version: continued.version, review_state: 'accepted' });
      assert.equal(changed.response.status, 200);
      let events = '';
      while (!events.includes('task.updated')) {
        const frame = await Promise.race([reader.read(), delay(3000).then(() => { throw new Error('Expected SSE update'); })]);
        if (frame.done) throw new Error('SSE ended unexpectedly');
        events += frame.value;
      }
      assert(events.includes(continued.task_id));
    } finally {
      sseAbort.abort();
      reader.releaseLock();
    }

    const created = await api('/api/v1/sessions', { project_id: 'fixture', profile_id: 'google', title: 'Fixture session' });
    assert.equal(created.response.status, 201);
    const session = created.body;
    const sessionPath = '/api/v1/sessions/' + session.session_id;
    assert.deepEqual(session.turns, []);
    assert.equal(session.profile.model, 'fixture-google');
    assert.deepEqual(session.models.map((model: {id: string}) => model.id), ['fixture-google', 'fixture-google-2']);
    assert.equal((await api(sessionPath + '/profile', { profile_id: 'google', model: 'fixture-google-2' })).response.status, 200);
    const input = { turn_id: 'fixture-turn', input: 'delegate fixture' };
    assert.equal((await api(sessionPath + '/turn', input)).response.status, 202);
    const chat = await until(async () => {
      const detail = (await api(sessionPath)).body;
      return detail.turns[0]?.state !== 'running' ? detail : undefined;
    }, 'completed ACP turn');
    assert.equal(chat.turns[0].state, 'completed', chat.turns[0].error);
    assert.match(chat.turns[0].output, /ACP response \(fixture-google-2\)/);
    assert.equal(chat.tasks[0].turn_id, input.turn_id);
    assert.equal((await api(sessionPath + '/turn', input)).body.turns.length, 1);
    assert.equal((await api(sessionPath + '/cancel-group', { turn_id: input.turn_id })).response.status, 202);
    await inState(chat.tasks[0].snapshot.task_id, 'cancelled');
    await api(sessionPath + '/profile', { profile_id: 'google', model: 'fixture-google' });
    await api(sessionPath + '/turn', { turn_id: 'fixture-turn-2', input: 'A second local turn.' });
    const switched = await until(async () => {
      const detail = (await api(sessionPath)).body;
      return detail.turns[1]?.state === 'completed' ? detail : undefined;
    }, 'same-provider model change');
    assert.match(switched.turns[1].output, /ACP response \(fixture-google\)/);
    const newMain = await api(sessionPath + '/profile', { profile_id: 'claude-main' });
    assert.equal(newMain.body.previous_session_id, session.session_id);
    assert.notEqual(newMain.body.session_id, session.session_id);
    assert.equal((await api(sessionPath + '/close', {})).body.state, 'closed');

    const owner = async (path: string, body?: unknown) => {
      const response = await ownerRequest(ownerSocket(daemon), path, body);
      return { status: response.statusCode, body: await jsonResponse<any>(response) };
    };
    const sameName = [];
    for (const parent of ['work', 'play']) {
      const path = join(root, parent, 'same-name');
      mkdirSync(path, { recursive: true });
      git(path, 'init', '-b', 'main');
      git(path, 'commit', '--allow-empty', '-m', 'Initial fixture');
      const opened = await owner('/api/v1/projects', { path });
      assert.equal(opened.status, 200);
      sameName.push(opened.body.id);
      assert((await call(agy, 'list_profiles', { project_id: opened.body.id })).ok);
      assert((await call(claude, 'list_profiles', { project_id: opened.body.id })).ok);
    }
    assert.notEqual(sameName[0], sameName[1]);
    const recent = (await owner('/api/v1/projects')).body;
    assert.deepEqual(recent.filter((item: { label: string }) => item.label === 'same-name').map((item: { id: string }) => item.id).sort(), sameName.sort());
    writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(repo, 'fresh.txt'), 'included in snapshot\n');
    writeFileSync(join(repo, 'ignored.txt'), 'excluded by project ignore\n');
    const rootProject = await owner('/api/v1/projects', { path: repo });
    mkdirSync(join(repo, 'subdir'));
    assert.equal((await owner('/api/v1/projects', { path: join(repo, 'subdir') })).body.id, rootProject.body.id);
    const linked = join(root, 'linked');
    git(repo, 'worktree', 'add', '-b', 'linked', linked, base);
    const linkedProject = await owner('/api/v1/projects', { path: linked });
    assert.equal(linkedProject.body.id, rootProject.body.id);
    assert.equal(linkedProject.body.root, linked);
    const personal = await owner('/api/v1/sessions', { project_id: rootProject.body.id, profile_id: 'google', title: 'Personal', checkout: repo });
    assert.equal(personal.status, 201);
    const personalPath = '/api/v1/sessions/' + personal.body.session_id;
    assert.equal(personal.body.base_mode, 'snapshot');
    assert.equal((await owner(personalPath + '/preferences', { worker: 'astra' })).body.default_worker, 'astra');
    assert.equal((await owner(personalPath + '/turn', { turn_id: 'snapshot-turn', input: 'snapshot fixture' })).status, 202);
    const personalReply = await until(async () => {
      const detail = (await owner(personalPath)).body;
      return detail.turns[0]?.state !== 'running' ? detail : undefined;
    }, 'personal turn with a shared snapshot');
    assert.equal(personalReply.turns[0].state, 'completed', personalReply.turns[0].error);
    assert.deepEqual(personalReply.turns[0].usage, {inputTokens: 24, cachedReadTokens: 6, outputTokens: 7});
    const candidates = personalReply.tasks.map((entry: { snapshot: { task_id: string } }) => entry.snapshot.task_id) as string[];
    assert.equal(candidates.length, 2);
    await Promise.all(candidates.map(id => inState(id, 'succeeded')));
    const views = await Promise.all(candidates.map(id => owner('/api/v1/tasks/' + id + '/workspace')));
    assert.notEqual(views[0].body.base_commit, base);
    assert.equal(views[0].body.base_commit, views[1].body.base_commit);
    assert.notEqual(views[0].body.workspace.managed_path, views[1].body.workspace.managed_path);
    for (const view of views) {
      assert(existsSync(join(view.body.workspace.managed_path, 'fresh.txt')));
      assert(!existsSync(join(view.body.workspace.managed_path, 'ignored.txt')));
    }
    assert.equal((await owner(personalPath + '/summary', { turn_id: 'snapshot-turn' })).status, 202);
    assert.equal((await owner(personalPath + '/summary', { turn_id: 'snapshot-turn' })).body.turns.length, 2);
    await until(async () => (await owner(personalPath)).body.turns[1]?.state === 'completed' ? true : undefined, 'summary turn');
    await owner(personalPath + '/close', {});

    const change = '/api/v1/tasks/' + candidates[0];
    const editedCandidate = join(views[0].body.workspace.managed_path, 'my-post-task-note.txt');
    writeFileSync(editedCandidate, 'manual edit\n');
    const refused = await owner(change + '/discard', remove);
    assert.equal(refused.status, 409);
    assert.match(refused.body.detail, /my-post-task-note.txt/);
    const mergeTarget = join(repo, 'solution.txt');
    writeFileSync(mergeTarget, 'conflicting local content');
    const preflight = await owner(change + '/apply', { checkout: repo });
    assert.equal(preflight.status, 409);
    assert.match(preflight.body.detail, /solution.txt/);
    assert(!existsSync(join(repo, 'new.bin')));
    assert.equal(readFileSync(mergeTarget, 'utf8'), 'conflicting local content');
    rmSync(mergeTarget);
    git(repo, 'add', 'source.txt');
    const stagedBefore = git(repo, 'diff', '--cached');
    const applied = await owner(change + '/apply', { checkout: repo });
    assert.equal(applied.body.state, 'applied');
    assert.match(applied.body.cleanup, /my-post-task-note.txt/);
    assert.deepEqual(readFileSync(join(repo, 'new.bin')), Buffer.from([0, 1, 4, 255]));
    assert.equal(git(repo, 'diff', '--cached'), stagedBefore);
    assert.equal((await owner(change + '/apply', { checkout: repo })).body.state, 'already_applied');
    const cleanApplication = await owner('/api/v1/tasks/' + candidates[1] + '/apply', { checkout: linked });
    assert.deepEqual(cleanApplication.body, {state: 'applied', cleanup: null});
    assert(!existsSync(views[1].body.workspace.managed_path));

    const held = (await call(agy, 'delegate_task', brief('fixture hold fixture crash', 'unknown'))).data.task.task_id;
    await inState(held, 'running');
    const db = new DatabaseSync(join(daemon, 'zgent.sqlite'), { readOnly: true });
    try {
      const dirs = db.prepare('SELECT managed_path FROM workspaces WHERE task_id IN (?,?) ORDER BY managed_path').all(a, b);
      assert.equal(dirs.length, 2);
      assert.notEqual(dirs[0].managed_path, dirs[1].managed_path);
    } finally { db.close(); }
    await agy.close(); agy = undefined;
    await claude.close(); claude = undefined;
    await shutdown('SIGKILL');
    const interrupted = new DatabaseSync(join(daemon, 'zgent.sqlite'));
    try { interrupted.prepare("UPDATE task_applications SET state='applying',applied_at_ms=NULL WHERE task_id=?").run(candidates[0]); }
    finally { interrupted.close(); }
    launch();
    const previousCookie = cookie;
    await until(async () => api('/healthz', undefined, undefined, false).then(({response}) => response.ok ? true : undefined, () => undefined), 'restarted daemon');
    assert.equal((await api('/console/session', undefined, { Cookie: previousCookie }, false)).response.status, 401);
    await pair();
    assert.equal((await owner(change + '/workspace')).body.application.state, 'needs_confirmation');
    assert.equal((await owner(change + '/apply', { checkout: repo })).status, 409);
    assert(existsSync(editedCandidate));
    await inState(held, 'recovering');
    assert.equal((await read(a)).review_state, 'accepted');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    const restarted = new DatabaseSync(join(daemon, 'zgent.sqlite'), { readOnly: true });
    try { assert.equal(restarted.prepare('SELECT count(*) n FROM run_attempts WHERE task_id=?').get(held)?.n, 1); }
    finally { restarted.close(); }
    const unknown = await read(held);
    const reconciled = await until(async () => {
      const result = await api('/api/v1/tasks/' + held + '/confirm-stopped', {
        expected_version: unknown.version, confirm_stopped: true,
      });
      return result.response.ok ? result.body : undefined;
    }, 'owner recovery confirmation');
    assert.equal(reconciled.state, 'interrupted');
  } finally {
    await agy?.close();
    await claude?.close();
    await shutdown('SIGTERM');
    rmSync(root, { recursive: true, force: true });
  }
});
