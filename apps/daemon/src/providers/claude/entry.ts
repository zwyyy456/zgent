import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createSdkMcpServer, tool, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { sdkQuery, userMessage, claudeUsage, claudeFailure } from './sdk.ts';
import { clip, id, redact } from '../../core/values.ts';
import { within } from '../../policy/config.ts';
import type { Job } from '../worker.ts';

type Setup = { model: string; mode: Job['profile']['mode']; effort?: Job['profile']['effort'];
  codex: string; sandboxArgs: string[]; sandboxEnv: Record<string, string | undefined> };
type Frame = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
const send = (frame: Frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const notification = (method: string, params?: unknown) => send({ method, params });
const reply = (frame: Frame, result: unknown) => send({ id: frame.id, result });
const fail = (frame: Frame) => send({ id: frame.id, error: { code: -32603, message: 'Claude runtime command failed.' } });

const cwd = process.cwd();
const decisions = new Map<string, (value: unknown) => void>();
let active: Query | undefined, input: PassThrough | undefined, controller: AbortController | undefined;
let setup: Setup | undefined;
let cancelled = false;

function interaction(method: string, params: unknown) {
  const nativeId = id();
  return new Promise<unknown>(resolve => {
    decisions.set(nativeId, resolve);
    send({ id: nativeId, method, params });
  });
}

function toolPath(filename: string) {
  const path = resolve(cwd, filename);
  if (!within(cwd, path)) throw new Error('Choose a path inside the task worktree.');
  return path;
}

async function sandboxed(command: string, args: string[], stdin?: string) {
  const config = setup!;
  const runId = id();
  notification('work/commandStarted', { id: runId });
  const result = await new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn(config.codex, ['sandbox', ...config.sandboxArgs, '--', command, ...args],
      { cwd, env: config.sandboxEnv, signal: controller?.signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk: Buffer) => { if (output.length < 65_536) output += chunk.toString('utf8').slice(0, 65_536 - output.length); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.stdin.on('error', () => {});
    child.on('error', () => {});
    child.once('close', code => resolve({ code, output: redact(output) }));
    child.stdin.end(stdin);
  });
  notification('work/commandFinished', { id: runId, code: result.code });
  return result;
}

const textResult = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], isError });

function workspaceTools(config: Setup) {
  const pathSchema = z.string().min(1).max(1024);
  const command = z.string().min(1).max(8000);
  const entries = [
    tool('list_files', 'List entries in a worktree directory.', { path: pathSchema }, async ({ path }) => {
      const result = await sandboxed('/bin/ls', ['-a', '--', toolPath(path)]);
      return textResult(result.output, result.code !== 0);
    }),
    tool('read_file', 'Read a text file inside the worktree.', { path: pathSchema }, async ({ path }) => {
      const result = await sandboxed('/bin/cat', [toolPath(path)]);
      return textResult(result.output, result.code !== 0);
    }),
    tool('write_file', 'Write UTF-8 text to a file in the worktree.', { path: pathSchema, text: z.string().max(160_000) },
      async ({ path, text }) => {
        if (config.mode !== 'workspace_write') return textResult('This profile is read-only.', true);
        const result = await sandboxed(process.execPath, ['--input-type=module', '-e',
          "import{writeFileSync,readFileSync}from'node:fs';writeFileSync(process.argv[1],readFileSync(0));", toolPath(path)], text);
        return textResult(result.code === 0 ? 'Written.' : result.output, result.code !== 0);
      }),
    tool('run_command', 'Run a shell command under the worktree policy.', { command }, async args => run(args.command)),
    tool('ask_before_command', 'Ask the owner to approve the exact command, then run it under the same worktree policy.',
      { command }, async args => {
        const decision = await interaction('claude/commandApproval', { command: args.command, cwd }) as { decision?: string } | undefined;
        return decision?.decision === 'accept' ? run(args.command) : textResult('Command was declined.', true);
      }),
    tool('ask_user', 'Ask the owner a question before continuing.', { question: z.string().min(1).max(4000) }, async ({ question }) => {
      const answer = await interaction('item/tool/requestUserInput', { isBlocking: true,
        questions: [{ id: 'answer', header: 'Claude', question, isSecret: false, isOther: true, options: null }] }) as
        { answers?: { answer?: { answers: string[] } } } | undefined;
      const value = answer?.answers?.answer?.answers[0];
      return value === undefined ? textResult('No answer was available.', true) : textResult(value);
    }),
  ];
  return { server: createSdkMcpServer({ name: 'workspace', version: '1.1.0', tools: entries }),
    names: entries.map(entry => 'mcp__workspace__' + entry.name) };
}

async function run(command: string) {
  const result = await sandboxed('/bin/sh', ['-c', command]);
  notification('work/evidence', { command: clip(redact(command), 2000), status: result.code === 0 ? 'completed' : 'failed',
    exitCode: result.code, output: clip(result.output, 16_000) });
  return textResult(result.output + '\nExit code: ' + (result.code ?? 'unknown'), result.code !== 0);
}

async function perform(prompt: string, turnId: string) {
  let outcome = 'failed';
  const current = new AbortController();
  controller = current;
  input = new PassThrough({ objectMode: true });
  const roles = workspaceTools(setup!);
  const permit = (name: string) => roles.names.includes(name);
  const options: Options = {
    cwd, model: setup!.model, ...(setup!.effort && setup!.effort !== 'minimal' ? { effort: setup!.effort } : {}),
    abortController: current, persistSession: false, mcpServers: { workspace: roles.server },
    allowedTools: roles.names, canUseTool: async (name, content) =>
      permit(name) ? { behavior: 'allow', updatedInput: content } : { behavior: 'deny', message: 'Tool outside the workspace policy.' },
    hooks: { PreToolUse: [{ hooks: [async event => event.hook_event_name === 'PreToolUse' && !permit(event.tool_name)
      ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Tool outside the workspace policy.' } }
      : {}] }] },
    systemPrompt: 'Use only the workspace tools. Keep changes in this worktree. Never start persistent services or delegate. Report changes, observations from verification commands, and unresolved issues.',
  };
  try {
    active = sdkQuery(input as AsyncIterable<SDKUserMessage>, options, process.env);
    input.write(userMessage(prompt));
    for await (const message of active) {
      if (message.type === 'system' && message.subtype === 'init') notification('work/thread', { id: message.session_id, model: message.model });
      if (message.type === 'assistant' && !message.parent_tool_use_id && message.error) {
        const code = claudeFailure(message.error);
        if (code) notification('work/failure', { code });
      }
      if (message.type === 'result') {
        if (cancelled) outcome = 'interrupted';
        else if (message.subtype === 'success' && !message.is_error) {
          outcome = 'completed';
          notification('work/text', { text: clip(redact(message.result), 64_000) });
        }
        notification('work/usage', claudeUsage(message));
        break;
      }
    }
  } catch {
    if (cancelled) outcome = 'interrupted';
  } finally {
    input.end();
    active?.close();
    active = undefined;
    notification('work/complete', { id: turnId, status: outcome });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  try {
    const frame = JSON.parse(line) as Frame;
    if (frame.method === 'work/initialize') {
      setup = frame.params as Setup;
      reply(frame, {});
    } else if (frame.method === 'work/start' && setup && !active) {
      const { prompt } = frame.params as { prompt: string };
      const turn = id();
      reply(frame, { id: turn });
      void perform(prompt, turn);
    } else if (frame.method === 'work/steer' && input && !cancelled && active) {
      input.write({ ...userMessage((frame.params as { message: string }).message), priority: 'next' });
      reply(frame, { queued: true });
    } else if (frame.method === 'work/interrupt') {
      cancelled = true;
      for (const resolve of decisions.values()) resolve(undefined);
      decisions.clear();
      void active?.interrupt().catch(() => {});
      controller?.abort();
      reply(frame, {});
    } else if (!frame.method && typeof frame.id === 'string' && decisions.has(frame.id)) {
      decisions.get(frame.id)!(frame.result);
      decisions.delete(frame.id);
      notification('work/resolved', { id: frame.id });
    } else fail(frame);
  } catch {
    process.exitCode = 1;
    controller?.abort();
    lines.close();
  }
});
lines.on('close', () => {
  controller?.abort();
  active?.close();
  for (const resolve of decisions.values()) resolve(undefined);
  decisions.clear();
});
