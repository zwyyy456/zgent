import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.argv[2] === '--version') {
  console.log('codex-cli 0.167.1');
  process.exit(0);
}

if (process.argv[2] === 'sandbox') {
  const [script, , , , inside] = process.argv.slice(process.argv.indexOf('--') + 3);
  if (!script.endsWith('! /usr/bin/touch "$3"')) writeFileSync(inside, '');
  process.exit(0);
}

const send = frame => console.log(JSON.stringify(frame));
const reply = (id, result) => send({ id, result });
const notice = (method, params) => send({ method, params });
let turn, job, progress;
const threadId = 'test-thread';
const turnId = 'test-turn';

function complete(status = 'completed') {
  clearTimeout(progress);
  if (!turn || turn.status !== 'inProgress') return;
  turn.status = status;
  notice('turn/completed', { threadId, turn });
}

function result() {
  writeFileSync('solution.txt', 'generated in independent worktree\n');
  writeFileSync('new.bin', Buffer.from([0, 1, 4, 255]));
  notice('item/completed', { threadId, turnId, item: { type: 'commandExecution',
    id: 'check', command: 'example verification', status: 'completed', exitCode: 0, aggregatedOutput: 'example evidence' } });
  notice('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'final', text: 'Implemented and verified.' } });
  complete();
}

const lines = createInterface({ input: process.stdin });
lines.on('line', source => {
  const frame = JSON.parse(source);
  const { id, method, params } = frame;
  const opened = () => reply(id, { cwd: params.cwd, model: params.model, sandbox: { type: 'workspaceWrite' },
    approvalPolicy: params.approvalPolicy, activePermissionProfile: { id: params.permissions },
    runtimeWorkspaceRoots: params.runtimeWorkspaceRoots, approvalsReviewer: params.approvalsReviewer, thread: { id: threadId } });
  switch (method) {
    case 'initialize': return reply(id, { userAgent: 'test codex' });
    case 'initialized': return;
    case 'account/read': return reply(id, { account: { type: 'apiKey' }, requiresOpenaiAuth: true });
    case 'model/list': return reply(id, { data: [{ model: 'fixture-model', displayName: 'Fixture model' }, { model: 'gpt-6.2-sol', displayName: 'Sol' },
      { model: 'gpt-6.2-astra', displayName: 'Astra' }], nextCursor: null });
    case 'thread/resume':
      if (params.threadId !== threadId) throw new Error('Wrong thread');
      return opened();
    case 'thread/start': return opened();
    
    case 'turn/start':
      turn = { id: turnId, status: 'inProgress', items: [] };
      job = params.input[0].text;
      reply(id, { turn });
      if (job.includes('fixture approval')) {
        progress = setTimeout(() => send({ id: 'approval-1', method: 'item/commandExecution/requestApproval',
          params: { kind: 'command', threadId, turnId, itemId: 'check', command: 'printf fixture-approved', cwd: process.cwd(),
            availableDecisions: ['accept', 'decline'] } }), 75);
      } else if (job.includes('fixture question')) {
        progress = setTimeout(() => send({ id: 'question-1', method: 'item/tool/requestUserInput', params: {
          threadId, turnId, itemId: 'question', isBlocking: true, questions: [
            { id: 'style', header: 'Style', question: 'Choose style.', isOther: false, isSecret: false,
              options: [{ label: 'Simple', description: 'A simple result' }] },
          ],
        } }), 75);
      } else if (job.includes('fixture permissions')) {
        progress = setTimeout(() => send({ id: 'permission-1', method: 'item/permissions/requestApproval', params: {
          threadId, turnId, itemId: 'permission', cwd: process.cwd(), reason: 'Read the fixture source.',
          permissions: { network: null, fileSystem: { read: [join(process.cwd(), 'source.txt')], write: null } },
        } }), 75);
      } else if (job.includes('fixture hold')) {
        notice('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'hold-cmd', command: 'sleep 60', status: 'inProgress', exitCode: null } });
      } else progress = setTimeout(result, 800);
      return;
    case 'turn/steer':
      notice('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'steer', text: 'Received an additional message.' } });
      return reply(id, { turnId });
    case 'turn/interrupt':
      reply(id, {});
      return complete('interrupted');
    default:
      if (id === 'approval-1' || id === 'question-1' || id === 'permission-1') {
        notice('serverRequest/resolved', { threadId, requestId: id });
        if (frame.result?.decision === 'accept' || frame.result?.answers?.style?.answers?.[0] === 'Simple' ||
          frame.result?.scope === 'turn' && frame.result?.permissions?.fileSystem?.read?.[0] === join(process.cwd(), 'source.txt')) return result();
        return complete('failed');
      }
  }
});
lines.on('close', () => {
  clearTimeout(progress);
  if (job?.includes('fixture crash')) setTimeout(() => process.exit(), 6000);
});
