import { ClientApp, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type SessionConfigOption,
  type SessionModeState, type NewSessionResponse, type NewSessionRequest, type LoadSessionResponse, type LoadSessionRequest } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../../policy/config.ts';
import { gatedWorker, groupGone, identity, stopGroup } from '../../os/process.ts';
import { coordinatorSettings } from './settings.ts';
import type { MainMcp, MainRuntime, ModelChoice, TurnHooks } from '../../sessions/runtime.ts';

const allowedMcpTools = new Set([
  'mcp_zgent_list_profiles',
  'mcp_zgent_delegate_task',
  'mcp_zgent_get_task',
  'mcp_zgent_wait_tasks',
  'mcp_zgent_send_to_task',
  'mcp_zgent_cancel_task',
  'mcp_zgent_list_tasks',
  'mcp_zgent_inspect_project',
]);

export async function agyRuntime(config: Config, cwd: string, mcp: MainMcp, existing?: string, startupSignal?: AbortSignal) {
  const service = config.agy;
  if (!service) throw new Error('Configure an Antigravity ACP executable and provider home.');
  coordinatorSettings(service.home);
  const env = { HOME: process.env.HOME ?? service.home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
  const worker = gatedWorker(service.executable, ['acp', '--process-per-session', '--sandbox', '--disable-telemetry',
    '--include-default-customizations=false', '--gemini-dir', join(service.home, '.gemini')], cwd, env);
  const child = worker.child;
  const owner = child.pid ? identity(child.pid) : undefined;
  let childExited = false;
  const exited = new Promise<void>(resolve => child.once('close', () => { childExited = true; resolve(); }));
  child.once('error', () => {});
  if (!owner || owner.pid !== owner.pgid) {
    worker.abort();
    await exited;
    throw new Error('Could not verify the ACP process.');
  }
  child.stderr?.resume();
  const app = new ClientApp();
  let sessionId = existing;
  let version: string | undefined;
  let options: SessionConfigOption[] = [];
  let modes: SessionModeState | null | undefined;
  let hooks: TurnHooks | undefined;
  let text = '';
  let connection: ClientConnection | undefined;
  let closed = false;
  app.onRequest('session/request_permission', ({ params }) => {
    const name = params.toolCall?.name;
    if (params.sessionId === sessionId && typeof name === 'string' && allowedMcpTools.has(name)) {
      const allow = params.options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always');
      if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    const reject = params.options.find(option => option.kind === 'reject_once' || option.kind === 'reject_always');
    return reject ? { outcome: { outcome: 'selected', optionId: reject.optionId } } : { outcome: { outcome: 'cancelled' } };
  });
  app.onNotification('session/update', ({ params: notice }) => {
    if (notice.sessionId !== sessionId) return;
    if (hooks && notice.update.sessionUpdate === 'agent_message_chunk' && notice.update.content.type === 'text') {
      const delta = notice.update.content.text;
      text += delta;
      hooks.text(delta);
    }
    if (notice.update.sessionUpdate === 'config_option_update') {
      options = notice.update.configOptions;
      hooks?.models(models());
    }
  });
  connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
  const agent = connection.agent;
  worker.release();

  async function close() {
    if (closed) return;
    closed = true;
    connection?.close();
    child.stdin?.end();
    await Promise.race([exited, delay(600)]);
    if (!groupGone(owner!.pgid)) await stopGroup(owner!, { liveOrphan: childExited });
  }

  const deadline = () => ({ cancellationSignal: startupSignal ? AbortSignal.any([startupSignal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000), stopWaitingOnCancel: true });
  const selector = (category: string) => options.find(option => option.type === 'select' &&
    (option.category === category || option.id === category));
  function choices(option?: SessionConfigOption): ModelChoice[] {
    if (option?.type !== 'select') return [];
    return option.options.flatMap(item => 'options' in item ? item.options : [item])
      .map(item => ({ id: item.value, label: item.name }));
  }
  const models = () => choices(selector('model'));
  async function choose(category: 'mode' | 'model', value: string) {
    const option = selector(category);
    if (option?.type === 'select') {
      if (option.currentValue === value) return;
      if (!choices(option).some(item => item.id === value)) throw new Error('The configured ACP ' + category + ' is unavailable.');
      const changed = await agent.request('session/set_config_option', { sessionId: sessionId!, configId: option.id, value }, deadline());
      options = changed.configOptions;
      if (selector(category)?.currentValue !== value) throw new Error('ACP did not apply the selected ' + category + '.');
      return;
    }
    if (category === 'mode') {
      if (!modes?.availableModes.some(item => item.id === value)) throw new Error('This ACP runtime did not advertise ' + value + ' mode.');
      if (modes.currentModeId !== value) await agent.request('session/set_mode', { sessionId: sessionId!, modeId: value }, deadline());
      return;
    }
    throw new Error('The ACP session did not advertise a model selector.');
  }

  try {
    const init = await agent.request('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      clientInfo: { name: 'zgent', version: '1.1.0' } }, deadline());
    version = init.agentInfo?.version;
    if (!init.agentCapabilities?.mcpCapabilities?.http) throw new Error('The ACP runtime does not support HTTP MCP.');
    const input = { cwd, mcpServers: [{ type: 'http' as const, name: 'zgent', url: mcp.url,
      headers: [{ name: 'Authorization', value: 'Bearer ' + mcp.token }] }] };
    if (sessionId) {
      if (!init.agentCapabilities?.loadSession) throw new Error('This ACP runtime does not support loading an existing session.');
      const loaded = await agent.request<LoadSessionResponse | void, LoadSessionRequest>('session/load', { ...input, sessionId }, deadline());
      options = loaded?.configOptions ?? [];
      modes = loaded?.modes;
    } else {
      const opened = await agent.request<NewSessionResponse, NewSessionRequest>('session/new', input, deadline());
      sessionId = opened.sessionId;
      options = opened.configOptions ?? [];
      modes = opened.modes;
    }
    await choose('mode', 'default');
    if (!models().length) throw new Error('The ACP session did not advertise any models.');
  } catch (error) {
    await close();
    if (error instanceof Error && /^The ACP|^This ACP|^ACP did/.test(error.message)) throw error;
    throw new Error('Antigravity ACP initialization or authentication failed.');
  }

  const currentModel = selector('model');
  return {
    version,
    models: models(),
    currentModel: currentModel?.type === 'select' ? currentModel.currentValue : undefined,
    async prompt(input, model, observer) {
      if (closed) throw new Error('The ACP session has closed.');
      observer.models(models());
      await choose('model', model);
      observer.session(sessionId!);
      if (version) observer.runtime(version);
      hooks = observer;
      text = '';
      try {
        const result = await agent.request('session/prompt', { sessionId: sessionId!, prompt: [{ type: 'text', text: input }] });
        const raw = (result as typeof result & { usage?: unknown }).usage ?? result._meta?.usage;
        const usage = raw && typeof raw === 'object' ? Object.fromEntries(['inputTokens','cachedReadTokens','outputTokens']
          .map(key => [key, (raw as Record<string, unknown>)[key]]).filter(([, value]) =>
            typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) : undefined;
        return { nativeId: sessionId, text, cancelled: result.stopReason === 'cancelled', usage };
      } finally { hooks = undefined; }
    },
    async interrupt() { if (!closed) await agent.notify('session/cancel', { sessionId: sessionId! }); },
    close,
  } satisfies MainRuntime & { version?: string; models: ModelChoice[]; currentModel?: string };
}
