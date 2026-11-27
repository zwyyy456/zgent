import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { claudeVersion, type Config } from '../../policy/config.ts';
import type { MainMcp, MainRuntime } from '../../sessions/runtime.ts';
import { claudeEnvironment, claudeUsage, sdkQuery, userMessage } from './sdk.ts';

export function claudeMain(config: Config, cwd: string, mcp: MainMcp, existing?: string): MainRuntime {
  const env = claudeEnvironment(config);
  if (!env) throw new Error('Configure separate Claude SDK credentials.');
  let active: Query | undefined, controller: AbortController | undefined;
  let native = existing;
  let stopped = false;
  return {
    async prompt(text, model, hooks) {
      stopped = false;
      controller = new AbortController();
      const toolNames = ['delegate_task', 'get_task', 'wait_tasks', 'send_to_task', 'cancel_task', 'list_profiles', 'list_tasks'];
      const allowed = toolNames.map(name => 'mcp__zgent__' + name);
      const options: Options = { cwd, model, ...(native ? { resume: native } : {}),
        abortController: controller, persistSession: true,
        mcpServers: { zgent: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer ' + mcp.token } } },
        allowedTools: allowed,
        canUseTool: async (name, content) => allowed.includes(name) ? { behavior: 'allow', updatedInput: content }
          : { behavior: 'deny', message: 'Tool not available to this coordinator.' },
        hooks: { PreToolUse: [{ hooks: [async event => event.hook_event_name === 'PreToolUse' && !allowed.includes(event.tool_name)
          ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Coordinator tools only.' } }
          : {}] }] },
        systemPrompt: 'You are the task coordinator. Use list_profiles before delegation. Submit a clear brief and acceptance criteria. Wait in bounded intervals, send protected interactions to the console and report real result evidence. Only use the registered project provided in the user turn.' };
      const source = (async function* () { yield userMessage(text); })();
      const query = sdkQuery(source, options, env);
      active = query;
      let streamed = '';
      try {
        for await (const message of query) {
          if (message.type === 'system' && message.subtype === 'init') {
            native = message.session_id;
            hooks.session(native);
            hooks.runtime(claudeVersion);
            void query.supportedModels().then(models => hooks.models(models.map(item => ({ id: item.value, label: item.displayName }))), () => {});
          }
          if (message.type === 'stream_event' && !message.parent_tool_use_id && message.event.type === 'content_block_delta' &&
            message.event.delta.type === 'text_delta') {
            streamed += message.event.delta.text;
            hooks.text(message.event.delta.text);
          }
          if (message.type === 'result') {
            if (stopped) return { nativeId: native, text: streamed, cancelled: true };
            if (message.subtype !== 'success' || message.is_error) throw new Error('Claude SDK could not complete the turn.');
            return { nativeId: native, text: message.result || streamed, usage: claudeUsage(message) };
          }
        }
        if (stopped) return { nativeId: native, text: streamed, cancelled: true };
        throw new Error('Claude SDK disconnected before returning a result.');
      } catch (error) {
        if (stopped) return { nativeId: native, text: streamed, cancelled: true };
        throw error;
      } finally {
        query.close();
        active = undefined;
      }
    },
    async interrupt() {
      stopped = true;
      if (active) {
        const query = active;
        await Promise.race([query.interrupt().catch(() => {}), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
      }
      controller?.abort();
    },
    async close() { stopped = true; controller?.abort(); active?.close(); },
  };
}
