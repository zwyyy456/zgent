import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { standardSchema, tools, type Input, type ToolName } from '@zgent/contracts';
import { isAgent, type Agent } from '../policy/config.ts';
import type { Sessions } from '../sessions/sessions.ts';
import type { Tasks } from '../core/tasks.ts';
import { appUri, registerTaskApp } from './apps.ts';
import { Failure, iso } from '../core/values.ts';
import { readProject } from '../workspaces/read-project.ts';
import { z } from 'zod/v4';

export const mcpBodyLimit = 256 * 1024;

function run(tasks: Tasks, sessions: Sessions, tool: ToolName, client: Agent, args: unknown, signal: AbortSignal) {
  const main = client.startsWith('main:');
  const modifying = tool === 'delegate_task' || tool === 'send_to_task' || tool === 'cancel_task';
  const active = main && modifying ? sessions.activeTurn(client) : undefined;
  if (main && modifying && !active) throw new Failure(409, 'NOT_READY', 'The coordinator is not in an active turn.', 'UNAVAILABLE');
  switch (tool) {
    case 'delegate_task': {
      const input = args as Input<'delegate_task'>;
      const turn = active ? sessions.delegation(client) : undefined;
      return tasks.delegate(client, turn ? { ...input, conversation_tag: turn.id } : input, turn ? { turn } : undefined);
    }
    case 'get_task': return tasks.get(client, args as Input<'get_task'>);
    case 'wait_tasks': return tasks.wait(client, args as Input<'wait_tasks'>, signal);
    case 'send_to_task': return tasks.send(client, args as Input<'send_to_task'>);
    case 'cancel_task': {
      const input = args as Input<'cancel_task'>;
      const { value, duplicate } = tasks.cancel(client, input.task_id, input.request_id, input.reason);
      return { task: value.task, disposition: value.disposition, deduplicated: duplicate };
    }
    case 'list_profiles': return tasks.profiles(client, (args as Input<'list_profiles'>).project_id);
    case 'list_tasks': {
      const input = args as Input<'list_tasks'>;
      const { project_id, tasks: rows, next_cursor } = tasks.list(client, input.project_id, input.statuses ?? [], input.limit ?? 20, input.cursor);
      return { project_id, tasks: rows, next_cursor, has_more: next_cursor !== null };
    }
  }
}

export function createMcp(tasks: Tasks, sessions: Sessions) {
  const registrations = tools.map(tool => ({
    ...tool, input: standardSchema(tool.inputSchema), output: standardSchema(tool.outputSchema),
  }));
  const handler = createMcpHandler(({ authInfo }) => {
    const client = authInfo?.clientId;
    if (!client || !isAgent(client)) throw new Error('MCP requires an enrolled client.');
    const server = new McpServer({ name: 'zgent', version: '1.1.0' });
    registerTaskApp(server, tasks.config.origin);
    if (client.startsWith('main:')) {
      server.registerTool('inspect_project', {
        description: 'Read the active Git checkout. Use list or read with a project-relative path, search for literal text, or inspect status, diff and log. Tracked files and unignored new files are visible.',
        annotations: { readOnlyHint: true },
        inputSchema: z.object({ action: z.enum(['list','read','search','status','diff','log']),
          path: z.string().max(1024).optional(), query: z.string().max(512).optional() }),
      }, async input => {
        try {
          const turn = sessions.delegation(client);
          if (!turn) throw new Error();
          return { content: [{ type: 'text', text: readProject(turn.checkout, input) }] };
        } catch {
          return { isError: true, content: [{ type: 'text', text: 'Could not read the requested project content.' }] };
        }
      });
    }
    for (const tool of registrations) {
      server.registerTool(tool.name, {
        description: tool.description, annotations: tool.annotations,
        inputSchema: tool.input, outputSchema: tool.output,
        ...(['list_tasks', 'get_task'].includes(tool.name) ? { _meta: { ui: { resourceUri: appUri } } } : {}),
      }, async (args, context) => {
        const signal = AbortSignal.any([context.mcpReq.signal, ...(context.http?.req ? [context.http.req.signal] : [])]);
        const base = { schema_version: '1', server_time: iso() };
        let envelope: Record<string, unknown>;
        let isError = false;
        try {
          const data = await run(tasks, sessions, tool.name, client, args, signal);
          envelope = { ...base, server_time: iso(), ok: true, data, error: null };
          if ('issues' in tool.output['~standard'].validate(envelope)) throw new Error('Output schema mismatch: ' + tool.name);
        } catch (error) {
          if (signal.aborted) throw error;
          const fault = error instanceof Failure ? error : new Failure(500, 'INTERNAL_ERROR', 'Task operation could not complete.', 'INTERNAL');
          if (!(error instanceof Failure)) console.error('MCP operation failed: ' + tool.name, (error as {code?: string}).code ?? '');
          isError = true;
          envelope = { ...base, server_time: iso(), ok: false, data: null, error: { code: fault.mcp, message: fault.message, retryable: false } };
        }
        return { content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError };
      });
    }
    return server;
  }, { legacy: 'stateless', maxRequestBodySize: mcpBodyLimit });
  return { node: toNodeHandler(handler, { maxRequestBodySize: mcpBodyLimit }), close: () => handler.close() };
}
