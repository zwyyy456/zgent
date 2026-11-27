import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Rpc, type Pipes } from '../src/providers/codex/rpc.ts';
import { permissionArgs, workerEnv } from '../src/providers/codex/codex.ts';
import type { Job } from '../src/providers/worker.ts';
import type { Config } from '../src/policy/config.ts';

test('the bundled Claude SDK streams a loopback fixture and executes an approved scoped workspace command', { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'zgent-sdk-fixture-')));
  const cwd = join(root, 'work'), state = join(root, 'state'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  for (const folder of [cwd, state, codexHome, claudeHome, join(cwd, '.zgent-tmp')]) mkdirSync(folder, { mode: 0o700 });

  const tool = 'mcp__workspace__ask_before_command';
  const command = 'printf "fixture" > isolated.txt';
  const model = 'claude-opus-4-8';
  let proposals = 0;
  const server = createServer(async (req, res) => {
    if (!req.url?.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Fixture route' } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: { name?: string }[] };
    const useTool = payload.tools?.some(candidate => candidate.name === tool) && proposals++ === 0;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const event = (type: string, value: object) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
    event('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: useTool
      ? { type: 'tool_use', id: 'toolu_fixture', name: tool, input: {} }
      : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: useTool
      ? { type: 'input_json_delta', partial_json: JSON.stringify({ command }) }
      : { type: 'text_delta', text: 'Fixture completed.' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: useTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } });
    event('message_stop', {});
    res.end();
  });
  let child: Pipes | undefined;
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const codex = process.env.ZGENT_TEST_CODEX ?? execFileSync('/bin/sh', ['-c', 'command -v codex']).toString().trim();
    const config = { state, codexHome, codex, claude_sdk: { home: claudeHome } } as Config;
    const job: Job = { cwd,
      project: { root: cwd, gitDir: join(cwd, 'git-fixture'), base_ref: 'refs/heads/main', worktreeRoot: root, id: 'fixture', label: 'Fixture' },
      profile: { id: 'claude-test', label: 'Claude test', model, runtime: 'claude_agent_sdk', mode: 'workspace_write',
        network_domains: [], billing: 'unknown', execution_minutes: 30, request_minutes: 30, total_minutes: 120, max_active: 2 } };
    const shell = workerEnv(config, cwd);
    child = spawn(process.execPath, [fileURLToPath(new URL('../src/providers/claude/entry.ts', import.meta.url))], {
      cwd, stdio: ['pipe','pipe','pipe'],
      env: { HOME: claudeHome, CLAUDE_CONFIG_DIR: claudeHome, PATH: shell.PATH,
        ANTHROPIC_API_KEY: 'fixture-local-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + address.port,
        DISABLE_NONESSENTIAL_MODEL_CALLS: '1', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' },
    });
    const rpc = new Rpc(child);
    let evidence = false, approved = false, final = '';
    rpc.request = frame => {
      if (frame.method === 'claude/commandApproval' && (frame.params as { command: string }).command === command) {
        approved = true;
        void rpc.write({ id: frame.id, result: { decision: 'accept' } });
      } else void rpc.write({ id: frame.id, error: { code: -32601 } });
    };
    const done = new Promise<string>(resolve => { rpc.notification = (method, payload) => {
      const value = payload as { text: string; status: string; exitCode: number | null };
      if (method === 'work/evidence') evidence = value.exitCode === 0;
      if (method === 'work/text') final = value.text;
      if (method === 'work/complete') resolve(value.status);
    }; });
    await rpc.call('work/initialize', { model, mode: 'workspace_write', codex, sandboxArgs: permissionArgs(config, job), sandboxEnv: shell }, 5000);
    await rpc.call('work/start', { prompt: 'Use the approved fixture command.' }, 5000);
    assert.equal(await Promise.race([done, delay(18_000, 'timed_out', { ref: false })]), 'completed');
    assert(approved && evidence);
    assert.match(final, /Fixture completed/);
    assert.equal(readFileSync(join(cwd, 'isolated.txt'), 'utf8'), 'fixture');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close');
      child.stdin.end();
      await Promise.race([exited, delay(2500, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
