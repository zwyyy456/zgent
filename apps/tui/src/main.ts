import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { clearLine, createInterface, cursorTo } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import type { Contracts, MainProfileView, MainSessionDetail, MainSessionView } from '@zgent/contracts';
import { Local } from './client.ts';

type Project = { id: string; label: string; root: string; branch: string };
type Task = Contracts['TaskView'];
type Approval = Contracts['PendingRequestView'];
type Workspace = { changed_paths: number | null; workspace: { state: string; managed_path: string } | null;
  application: { state: string } | null };
type Worker = Contracts['ProfileList']['profiles'][number];

const commands = ['/project','/sessions','/session','/new','/model','/worker','/base','/refresh','/tasks','/worktrees',
  '/diff','/apply','/discard','/resolve-apply','/resume','/cancel','/stop','/web','/help','/quit'];
const terminal = new Set(['succeeded','failed','cancelled','interrupted']);
const clean = (input: string) => input.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const fullPath = (path: string) => resolve(path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);
const qp = (name: string, value: string) => '?' + new URLSearchParams({ [name]: value });
const displayError = (error: unknown) => error instanceof Error ? error.message : String(error);

function complete(line: string): [string[], string] {
  const prefix = '/project ';
  if (line.startsWith(prefix)) {
    const value = line.slice(prefix.length);
    const parent = value.endsWith('/') ? value : value ? dirname(value) + '/' : '';
    const part = value.endsWith('/') || !value ? '' : basename(value);
    try {
      return [readdirSync(fullPath(parent || '.'), { withFileTypes: true }).filter(item => item.isDirectory() && item.name.startsWith(part))
        .map(item => prefix + parent + item.name + '/'), line];
    } catch { return [[], line]; }
  }
  return [commands.filter(command => command.startsWith(line)), line];
}

class Tui {
  local = new Local();
  rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ', completer: complete, terminal: process.stdout.isTTY });
  project?: Project;
  chat?: MainSessionDetail;
  opening?: AbortController;
  streaming?: AbortController;
  tasks = new Map<string, Task>();
  taskLines = new Map<string, string>();
  seenTurns = new Map<string, { output: string; state: string }>();
  summarizing = new Set<string>();
  workers: Worker[] = [];
  approval?: Approval;
  readingApproval = false;
  discard?: string;
  recent?: Project[];
  sessions: MainSessionView[] = [];
  models: MainSessionDetail['models'] = [];
  stopped = false;

  print(text = '') {
    if (process.stdout.isTTY) { cursorTo(process.stdout, 0); clearLine(process.stdout, 0); }
    process.stdout.write(clean(text) + '\n');
    if (!this.stopped && process.stdout.isTTY) this.rl.prompt(true);
  }

  get sessionPath() {
    if (!this.chat) throw new Error('请先用 /new 创建主会话。');
    return '/api/v1/sessions/' + this.chat.session_id;
  }

  status() {
    if (!this.project) return;
    const workerId = this.chat?.default_worker;
    const worker = this.workers.find(item => item.profile_id === workerId);
    this.print(`${this.project.root} (${this.project.branch})  ${this.chat?.profile.model ?? '等待主会话'}  ` +
      `Worker ${workerId ?? '—'}${worker ? ' · ' + worker.model.id : ''}  基线 ${this.chat?.base_mode ?? 'snapshot'}`);
  }

  async run(path?: string) {
    let pulse: ReturnType<typeof setInterval> | undefined;
    this.rl.on('SIGINT', () => {
      if (this.chat?.state === 'running' || this.chat?.state === 'waiting_input') {
        void this.local.api(this.sessionPath + '/interrupt', {}).catch(error => this.print(displayError(error)));
      } else this.rl.close();
    });
    try {
      await this.local.start();
      this.print('Zgent · /help 查看命令');
      try { await this.open(fullPath(path ?? process.cwd())); }
      catch (error) {
        this.print(displayError(error));
        if (!this.project) await this.projects();
      }
      pulse = setInterval(() => {
        for (const task of this.tasks.values()) if (task.state === 'running') void this.taskLine(task);
      }, 2500);
      for await (const raw of this.rl) {
        const line = raw.trim();
        if (line === '/quit') break;
        try { if (line) await this.line(line); }
        catch (error) { this.print(displayError(error)); }
        if (process.stdout.isTTY) this.rl.prompt(true);
      }
    } finally {
      this.stopped = true;
      clearInterval(pulse);
      this.opening?.abort(); this.streaming?.abort(); this.rl.close();
    }
  }

  async projects() {
    this.recent = await this.local.api<Project[]>('/api/v1/projects');
    this.print(this.recent.map((item, index) => `${index + 1}. ${item.root} · ${item.id}`).join('\n') || '暂无最近项目。');
    this.print('输入编号，或用 /project <路径> 打开仓库。');
  }

  async open(path: string) {
    const project = await this.local.api<Project>('/api/v1/projects', { path: fullPath(path) });
    this.opening?.abort(); this.streaming?.abort();
    this.tasks.clear(); this.taskLines.clear(); this.approval = undefined; this.chat = undefined; this.recent = undefined;
    this.project = project;
    const q = qp('project_id', project.id);
    const [sessions, workers, page] = await Promise.all([
      this.local.api<MainSessionView[]>('/api/v1/sessions' + q),
      this.local.api<Contracts['ProfileList']>('/api/v1/profiles' + q),
      this.local.api<Contracts['TaskList']>('/api/v1/tasks' + q),
    ]);
    this.sessions = sessions;
    this.workers = workers.profiles;
    this.tasks = new Map(page.tasks.map(task => [task.task_id, task]));
    const projectEvents = this.opening = new AbortController();
    let cursor = page.snapshot_event_cursor;
    void this.follow(() => '/api/v1/events' + q + '&after=' + cursor, projectEvents, event => {
      const frame = event as { cursor: string; data: { snapshot?: Task } };
      cursor = frame.cursor;
      if (frame.data.snapshot) this.observeTask(frame.data.snapshot);
    });
    void this.findApproval();
    const recent = sessions.find(item => item.checkout === project.root && item.state !== 'closed');
    if (recent) await this.attach(recent.session_id);
    else await this.newSession();
    this.status();
  }

  async newSession(profileId?: string) {
    if (!this.project) throw new Error('先用 /project 打开项目。');
    const profiles = await this.local.api<MainProfileView[]>('/api/v1/session-profiles' + qp('project_id', this.project.id));
    const profile = profileId ? profiles.find(item => item.id === profileId) : profiles.find(item => item.available && item.runtime === 'antigravity_acp');
    if (!profile?.available) {
      this.print('主控不可用。请检查本机 AGY CLI 和登录。' + (profiles.some(item => item.available) ? ' 可用档案 ' + profiles.filter(item => item.available).map(item => item.id).join(', ') : ''));
      return;
    }
    this.print('正在连接 ' + profile.label + '…');
    const chat = await this.local.api<MainSessionDetail>('/api/v1/sessions', { project_id: this.project.id,
      checkout: this.project.root, profile_id: profile.id, title: this.project.label });
    await this.attach(chat.session_id, chat);
    if (chat.models.length) this.modelList(chat);
  }

  async follow(path: () => string, controller: AbortController, receive: (value: unknown) => void) {
    while (!controller.signal.aborted) {
      try { await this.local.stream(path(), controller.signal, receive); }
      catch { /* Retry a disconnected local stream. */ }
      if (!controller.signal.aborted) await delay(750, undefined, { ref: false });
    }
  }

  async attach(id: string, initial?: MainSessionDetail) {
    this.streaming?.abort();
    this.seenTurns.clear();
    const chat = initial ?? await this.local.api<MainSessionDetail>('/api/v1/sessions/' + id);
    this.chat = chat;
    for (const turn of chat.turns) {
      if (turn.input && !turn.summary_of) this.print('你 > ' + turn.input);
    }
    this.showChat(chat);
    const stream = this.streaming = new AbortController();
    void this.follow(() => '/api/v1/sessions/' + id + '/stream', stream, value => this.showChat(value as MainSessionDetail));
  }

  showChat(chat: MainSessionDetail) {
    this.chat = chat;
    for (const turn of chat.turns) {
      const before = this.seenTurns.get(turn.turn_id);
      if (turn.output !== before?.output && turn.output) {
        const delta = before && turn.output.startsWith(before.output) ? turn.output.slice(before.output.length) : turn.output;
        this.print((before?.output ? '' : '主控 > ') + delta);
      }
      if (turn.state !== before?.state && turn.error) this.print(turn.error);
      if (turn.state !== before?.state && turn.usage?.inputTokens !== undefined) {
        const { inputTokens, cachedReadTokens, outputTokens } = turn.usage;
        const ratio = inputTokens && cachedReadTokens !== undefined && cachedReadTokens <= inputTokens ?
          `${(100 * cachedReadTokens / inputTokens).toFixed(1)}%` : '未知';
        this.print(`用量 输入 ${inputTokens} · 缓存读取 ${cachedReadTokens ?? '未知'} · 输出 ${outputTokens ?? '未知'} · 缓存占比 ${ratio}`);
      }
      this.seenTurns.set(turn.turn_id, { output: turn.output, state: turn.state });
    }
    for (const {snapshot} of chat.tasks) this.observeTask(snapshot);
    if (chat.state === 'ready') {
      const turn = chat.turns.find(item => {
        if (item.summary_of || !item.completed_at || this.summarizing.has(item.turn_id) || chat.turns.some(other => other.summary_of === item.turn_id)) return false;
        const tasks = chat.tasks.filter(task => task.turn_id === item.turn_id).map(task => task.snapshot);
        return tasks.length && tasks.every(task => terminal.has(task.state)) && tasks.some(task => (task.completed_at ?? '') > item.completed_at!);
      });
      if (turn) {
        this.summarizing.add(turn.turn_id);
        void this.local.api('/api/v1/sessions/' + chat.session_id + '/summary', { turn_id: turn.turn_id })
          .catch(() => this.summarizing.delete(turn.turn_id));
      }
    }
  }

  observeTask(task: Task) {
    if ((this.tasks.get(task.task_id)?.version ?? -1) > task.version) return;
    const previous = this.tasks.get(task.task_id);
    this.tasks.set(task.task_id, task);
    if (!previous || previous.state !== task.state) void this.taskLine(task);
    if (this.approval?.task_id === task.task_id && !task.pending_requests.some(item => item.pending_request_id === this.approval?.pending_request_id)) {
      this.approval = undefined;
    }
    void this.findApproval();
  }

  async taskLine(task: Task) {
    let count: number | null = null;
    try { count = (await this.local.api<Workspace>('/api/v1/tasks/' + task.task_id + '/workspace')).changed_paths; }
    catch { /* State is still available without the file count. */ }
    if (this.tasks.get(task.task_id)?.state !== task.state || this.stopped) return;
    const key = task.state + String(count);
    if (this.taskLines.get(task.task_id) === key) return;
    this.taskLines.set(task.task_id, key);
    const elapsed = Math.max(0, Math.round((Date.parse(task.completed_at ?? new Date().toISOString()) - Date.parse(task.started_at ?? task.created_at)) / 1000));
    this.print(`[${task.state}] ${task.profile_id} · ${elapsed}s · ${count ?? '—'} 文件 · ${task.task_id}`);
  }

  async findApproval() {
    if (this.approval || this.readingApproval || this.stopped) return;
    const next = [...this.tasks.values()].flatMap(task => task.pending_requests)[0];
    if (!next) return;
    this.readingApproval = true;
    try {
      const request = await this.local.api<Approval>('/api/v1/requests/' + next.pending_request_id);
      if (request.state !== 'pending' || !this.tasks.has(request.task_id)) return;
      this.approval = request;
      if (request.kind === 'user_question') {
        this.print(request.questions.map(question => question.prompt + (question.choices?.length ? '\n' +
          question.choices.map((choice, index) => `${index + 1}. ${choice.label}`).join('\n') : '')).join('\n'));
        this.print('输入答案。多个问题按顺序用 | 分隔。');
      } else {
        this.print(request.kind === 'permission_grant' ? JSON.stringify(request.requested_permissions, null, 2) :
          'operation_preview' in request ? request.operation_preview : request.kind);
        this.print((request.allowed_choices.includes('accept_once') ? '[y 允许一次] ' : '') + '[n 拒绝] [c 取消任务]');
      }
    } catch { /* The worker may have already resolved the request. */ }
    finally { this.readingApproval = false; }
  }

  async answer(request: Approval, line: string) {
    let input: Contracts['DecisionRequest'];
    const fields = { expected_revision: request.revision, operation_hash: request.operation_hash, decision_id: randomUUID() };
    if (request.kind === 'user_question') {
      const values = request.questions.length === 1 ? [line] : line.split('|').map(value => value.trim());
      if (values.length !== request.questions.length) throw new Error('请按顺序回答每个问题。');
      const answers = Object.fromEntries(request.questions.map((question, index) => {
        if (question.answer_kind === 'text') return [question.question_id, { kind: 'text' as const, value: values[index] }];
        const choice = question.choices?.[Number(values[index]) - 1];
        if (!choice) throw new Error('请选择有效编号。');
        return [question.question_id, { kind: 'single_choice' as const, choice_id: choice.choice_id }];
      })) as Extract<Contracts['DecisionRequest'], {kind: 'question_answer'}>['answers'];
      input = { ...fields, kind: 'question_answer', answers };
    } else if (line === 'n') input = { ...fields, kind: 'approval_denial', decision: 'deny' };
    else if (line === 'c') input = { ...fields, kind: 'task_cancellation', decision: 'cancel_task' };
    else if (line === 'y' && request.allowed_choices.includes('accept_once')) {
      input = request.kind === 'permission_grant' ? { ...fields, kind: 'permissions_approval', decision: 'accept_once',
        approved_permissions: request.requested_permissions } : { ...fields, kind: 'operation_approval', decision: 'accept_once' };
    } else throw new Error('请选择上面列出的选项。');
    await this.local.api('/api/v1/requests/' + request.pending_request_id + '/decision', input);
    this.approval = undefined;
    this.print('已提交决定。');
  }

  modelList(chat: MainSessionDetail) {
    this.models = chat.models;
    this.print(this.models.map((model, index) => `${index + 1}. ${model.label} · ${model.id}`).join('\n') || '运行时未公布模型。');
    if (this.models.length) this.print('用 /model <编号或 ID> 切换。');
  }

  taskId(arg: string) {
    if (arg) return arg;
    const task = [...this.tasks.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (!task) throw new Error('暂无任务。');
    return task.task_id;
  }

  async diff(id: string) {
    const task = await this.local.api<Task>('/api/v1/tasks/' + id);
    const artifact = task.artifacts.find(item => item.kind === 'diff');
    if (!artifact) throw new Error('暂无可用 Diff。');
    const bytes: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: Contracts['ArtifactSlice'] = await this.local.api('/api/v1/artifacts/' + artifact.artifact_id + '?offset_bytes=' + offset);
      bytes.push(Buffer.from(page.data_base64, 'base64'));
      offset = page.next_offset_bytes;
    }
    const patch = clean(Buffer.concat(bytes).toString('utf8'));
    if (!process.stdout.isTTY) this.print(patch);
    else {
      cursorTo(process.stdout, 0); clearLine(process.stdout, 0);
      for (const line of patch.split('\n')) {
        const color = line.startsWith('+') ? '32' : line.startsWith('-') ? '31' : line.startsWith('@@') ? '36' : '0';
        process.stdout.write(`\x1b[${color}m${line}\x1b[0m\n`);
      }
    }
  }

  async send(input: string, resume?: string) {
    if (!this.chat) await this.newSession();
    if (!this.chat) return;
    await this.local.api(this.sessionPath + '/turn', { turn_id: randomUUID(), input, ...(resume ? { resume_task_id: resume } : {}) });
  }

  async line(line: string) {
    if (!line.startsWith('/')) {
      if (this.discard) {
        const task = this.discard; this.discard = undefined;
        if (line === 'y') { await this.local.api('/api/v1/tasks/' + task + '/discard', { confirm_removal: true }); this.print('候选工作区已清理。'); }
        return;
      }
      if (this.approval) return this.answer(this.approval, line);
      if (this.recent && /^\d+$/.test(line)) {
        const project = this.recent[Number(line) - 1];
        if (project) return this.open(project.root);
      }
      return this.send(line);
    }
    const [command, ...rest] = line.split(' ');
    const arg = rest.join(' ').trim();
    if (command === '/project') return arg ? this.open(arg) : this.projects();
    if (command === '/web') {
      const { url } = await this.local.api<{url: string}>('/console/link', {});
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
      child.on('error', () => this.print('无法打开浏览器。')); child.unref(); return;
    }
    if (command === '/help') { this.print(commands.join('  ')); return; }
    if (!this.project) throw new Error('先用 /project 打开项目。');
    const projectQuery = qp('project_id', this.project.id);
    switch (command) {
      case '/new': await this.newSession(arg || undefined); this.status(); return;
      case '/sessions':
        this.sessions = await this.local.api<MainSessionView[]>('/api/v1/sessions' + projectQuery);
        this.print(this.sessions.map((session, index) => `${index + 1}. ${session.title} · ${session.profile.model} · ${session.session_id}`).join('\n'));
        return;
      case '/session': {
        const id = this.sessions[Number(arg) - 1]?.session_id ?? arg;
        const session = this.sessions.find(item => item.session_id === id);
        if (!session) throw new Error('先用 /sessions 查看项目主会话。');
        if (session.checkout && session.checkout !== this.project.root) {
          this.project = await this.local.api('/api/v1/projects', { path: session.checkout });
        }
        await this.attach(id); this.status(); return;
      }
      case '/model': {
        const chat = await this.local.api<MainSessionDetail>(this.sessionPath + '/models');
        if (!arg) { this.modelList(chat); return; }
        const model = (this.models[Number(arg) - 1] ?? chat.models.find(item => item.id === arg))?.id;
        if (!model) throw new Error('用 /model 查看可用模型。');
        this.chat = await this.local.api(this.sessionPath + '/profile', { profile_id: chat.profile.id, model });
        this.status(); return;
      }
      case '/worker':
      case '/refresh': {
        if (command === '/refresh') await this.local.api('/api/v1/model-catalog', {});
        this.workers = (await this.local.api<Contracts['ProfileList']>('/api/v1/profiles' + projectQuery)).profiles;
        if (command === '/worker' && arg) {
          this.chat = await this.local.api(this.sessionPath + '/preferences', { worker: arg });
          this.status();
        } else this.print(this.workers.map(item => `${item.profile_id} · ${item.model.id} · ${item.availability.reason ?? item.availability.status}`).join('\n'));
        return;
      }
      case '/base':
        if (arg !== 'head' && arg !== 'snapshot') throw new Error('用 /base head 或 /base snapshot。');
        this.chat = await this.local.api(this.sessionPath + '/preferences', { base: arg }); this.status(); return;
      case '/tasks': {
        const page = await this.local.api<Contracts['TaskList']>('/api/v1/tasks' + projectQuery);
        for (const task of page.tasks) this.tasks.set(task.task_id, task);
        const states = await Promise.all(page.tasks.slice(0, 20).map(task => this.local.api<Workspace>('/api/v1/tasks/' + task.task_id + '/workspace')
          .then(workspace => workspace.application?.state).catch(() => undefined)));
        this.print(page.tasks.slice(0, 20).map((task, index) =>
          `${task.task_id} · ${task.profile_id} · ${task.state}${states[index] ? ' · ' + states[index] : ''} · ${task.summary}`).join('\n') || '暂无任务。');
        return;
      }
      case '/worktrees': {
        const rows = await this.local.api<{task_id: string; state: string; managed_path: string}[]>('/api/v1/workspaces' + projectQuery);
        this.print(rows.map(row => `${row.task_id} · ${row.state} · ${row.managed_path}`).join('\n') || '暂无保留工作区。'); return;
      }
      case '/diff': return this.diff(this.taskId(arg));
      case '/apply': {
        const result = await this.local.api<{state: string; cleanup: string | null}>('/api/v1/tasks/' + this.taskId(arg) + '/apply', { checkout: this.project.root });
        this.print(result.state === 'already_applied' ? '已应用过。' : '已应用增量补丁。');
        if (result.cleanup) this.print(result.cleanup);
        return;
      }
      case '/discard':
        this.discard = this.taskId(arg); this.print(`删除候选工作区 ${this.discard}？按 y 确认。`); return;
      case '/resolve-apply': {
        const [id, state] = arg.split(' ');
        if (!id || !['applied','unapplied'].includes(state)) throw new Error('核对文件后，输入 /resolve-apply <任务 ID> applied 或 unapplied。');
        await this.local.api('/api/v1/tasks/' + id + '/resolve-application', { applied: state === 'applied' });
        this.print('已记录应用状态。'); return;
      }
      case '/resume': {
        const [id, ...words] = rest;
        if (!id || !words.join(' ').trim()) throw new Error('用 /resume <任务 ID> <续做说明>。');
        return this.send('请继续任务 ' + id + ' 并派活实现。\n' + words.join(' '), id);
      }
      case '/cancel': {
        const id = this.taskId(arg);
        if (terminal.has(this.tasks.get(id)?.state ?? '')) throw new Error('任务已结束。');
        await this.local.api('/api/v1/tasks/' + id + '/cancel', { command_id: randomUUID() }); return;
      }
      case '/stop': await this.local.api(this.sessionPath + '/interrupt', {}); return;
      default: this.print('用 /help 查看可用命令。');
    }
  }
}

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  console.log('zgent [Git 路径] | zgent daemon status | zgent daemon stop');
} else if (args[0] === 'daemon') {
  const local = new Local();
  if (args[1] === 'status') console.log(await local.running() ? 'Daemon 运行中。' : 'Daemon 已停止。');
  else if (args[1] === 'stop') { if (await local.running()) await local.api('/daemon/stop', {}); console.log('已请求停止 Daemon。'); }
  else throw new Error('用 zgent daemon status 或 zgent daemon stop。');
} else await new Tui().run(args[0]);
