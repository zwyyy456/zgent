import { createInterface } from 'node:readline';
const native = 'fixture-acp-session';
let model = 'fixture-google', mcp;
const options = () => [
  { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
  { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model,
    options: [{ value: 'fixture-google', name: 'Fixture Google' }, { value: 'fixture-google-2', name: 'Fixture Google 2' }] },
];
const send = value => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
const reply = (id, result) => send({ id, result });
let next = 0, negotiated = false, heldPrompt;
const pending = new Map();
function clientRequest(method, params) {
  const id = 'fixture-req-' + (++next);
  send({ id, method, params });
  return new Promise(resolve => pending.set(id, resolve));
}
async function mcpRequest(method, params) {
  const headers = Object.fromEntries(mcp.headers.map(header => [header.name, header.value]));
  const response = await fetch(mcp.url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++next, method, params }) });
  const body = await response.text();
  return JSON.parse(body.startsWith('{') ? body : body.split('\n').find(line => line.startsWith('data: ')).slice(6)).result;
}

async function requireReadOnly(taskId) {
  const read = await mcpRequest('tools/call', { name: 'inspect_project', arguments: { action: 'read', path: 'source.txt' } });
  if (read?.isError || !read?.content?.[0]?.text?.includes('working copy')) throw new Error('read-only turn lost project access');
  const mutations = {
    delegate_task: { project_id: 'fixture', profile_id: 'implement', brief: { goal: 'Should not run', acceptance_criteria: ['fixture'] } },
    send_to_task: { task_id: taskId, message: 'Should not be queued' },
    cancel_task: { task_id: taskId },
  };
  for (const [name, args] of Object.entries(mutations)) {
    const result = await mcpRequest('tools/call', { name, arguments: { ...args, request_id: 'read-only-' + next } });
    if (result?.structuredContent?.error?.code !== 'UNAVAILABLE') throw new Error('Missing read-only guard for ' + name);
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', async line => {
  const frame = JSON.parse(line), { id, method, params } = frame;
  if (!method && pending.has(id)) {
    pending.get(id)(frame.result);
    pending.delete(id);
    return;
  }
  try {
    if (method === 'initialize') {
      return reply(id, { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [] });
    }
    if (method === 'session/new' || method === 'session/load') {
      mcp = params.mcpServers[0];
      return reply(id, { sessionId: native, configOptions: options() });
    }
    if (method === 'session/set_config_option') {
      if (params.configId === 'model') model = params.value;
      return reply(id, { configOptions: options() });
    }
    if (method === 'session/cancel') {
      if (heldPrompt) reply(heldPrompt, { stopReason: 'cancelled' });
      heldPrompt = undefined;
      return;
    }
    if (method === '$/cancel_request') return;
    if (method === 'session/prompt') {
      if (!negotiated) {
        await mcpRequest('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'fixture-acp',version:'1'} });
        negotiated = true;
      }
      const prompt = params.prompt[0].text;
      if (prompt.includes('delegate fixture')) {
        const permOptions = [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }];
        const okPerm = await clientRequest('session/request_permission', { sessionId: native,
          toolCall: { toolCallId: 'tc-1', name: 'mcp_zgent_delegate_task', status: 'pending' }, options: permOptions });
        if (okPerm?.outcome?.outcome !== 'selected' || okPerm?.outcome?.optionId !== 'allow') throw new Error('expected zgent tool approval');
        const badPerm = await clientRequest('session/request_permission', { sessionId: native,
          toolCall: { toolCallId: 'tc-2', name: 'write_file', status: 'pending' }, options: permOptions });
        if (badPerm?.outcome?.outcome === 'selected' && badPerm?.outcome?.optionId === 'allow') throw new Error('unexpected write_file approval');
        const delegated = await mcpRequest('tools/call', { name: 'delegate_task', arguments: {
          project_id: 'fixture', profile_id: 'implement', request_id: 'fixture-acp-delegate-' + next,
          brief: { goal: 'fixture hold', acceptance_criteria: ['fixture'] },
        } });
        if (!delegated?.structuredContent?.ok) throw new Error('delegation failed');
      }
      if (prompt.includes('approval fixture')) {
        const delegated = await mcpRequest('tools/call', { name: 'delegate_task', arguments: {
          project_id: 'fixture', profile_id: 'implement', request_id: 'fixture-approval-' + next,
          brief: { goal: 'fixture approval', acceptance_criteria: ['fixture'] },
        } });
        if (!delegated?.structuredContent?.ok) throw new Error('approval delegation failed');
        heldPrompt = id;
        return;
      }
      if (prompt.includes('read-only fixture')) await requireReadOnly('fixture-task');
      if (prompt.includes('用户追问：')) {
        if (!prompt.includes('printf fixture-approved') || !prompt.includes('为什么需要？')) throw new Error('missing approval details');
        await requireReadOnly(/任务 (\S+)/.exec(prompt)?.[1]);
      }
      if (prompt.includes('snapshot fixture')) {
        const listing = await mcpRequest('tools/call', { name: 'inspect_project', arguments: { action: 'list' } });
        if (!listing?.content?.[0]?.text?.includes('fresh.txt') || listing.content[0].text.includes('ignored.txt')) throw new Error('project scope');
        const selected = /Default worker profile: (\S+)/.exec(prompt)?.[1];
        for (const part of ['first', 'second']) {
          const delegated = await mcpRequest('tools/call', { name: 'delegate_task', arguments: {
            project_id: 'fixture', profile_id: selected, request_id: 'snapshot-' + part,
            brief: { goal: 'Snapshot ' + part, acceptance_criteria: ['fixture'] },
          } });
          if (!delegated?.structuredContent?.ok) throw new Error('snapshot delegation failed');
        }
      }
      send({ method: 'session/update', params: { sessionId: native, update: { sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ACP response (' + model + ')' } } } });
      return reply(id, { stopReason: 'end_turn', usage: { inputTokens: 24, cachedReadTokens: 6, outputTokens: 7 } });
    }
  } catch {
    send({ id, error: { code: -32603, message: 'fixture operation failed' } });
  }
});
