import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Contracts } from '@zgent/contracts';
import { Conversations } from './sessions.tsx';
import { readEvents } from './stream.ts';

type Session = { csrf: string; projects: { id: string; label: string }[] };
type Task = Contracts['TaskView'];
type Request = Contracts['PendingRequestView'];
type Artifact = Task['artifacts'][number];
type WorkspaceInfo = { task_id: string; base_commit: string; can_resume_context: boolean; error_code: string | null;
  workspace: { managed_path: string; state: string } | null;
  tracked_snapshot: { original_head: string; oid: string; excluded_untracked: string[] } | null };
type RetainedWorkspace = { task_id: string; title: string; managed_path: string; state: string; dirty_state: string };

const states: Record<Task['state'], string> = {
  queued: '排队中', starting: '启动中', running: '执行中', waiting_input: '等待人工输入', cancelling: '正在停止',
  recovering: '待对账', succeeded: '执行完成', failed: '执行失败', cancelled: '已取消', interrupted: '已中断',
};
const kinds: Record<Request['kind'], string> = {
  command_approval: '命令审批', file_approval: '文件变更审批', permission_grant: '本轮权限审批',
  user_question: '需要回答的问题', billing_confirmation: '计费确认',
};
const review = { accepted: '已接受', rejected: '已拒绝', unreviewed: '待验收' };
const artifactNames: Record<Artifact['kind'], string> = {
  diff: '累计 Diff', patch: '暂存区补丁', result: '执行结果', log: '命令记录', report: '工作区报告', verification: '验证', file: '文件',
};
const terminal = (state: Task['state']) => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
const time = (date: string) => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(date));
const describe = (error: unknown) => error instanceof Error ? error.message : '请求失败。';

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function api<T>(path: string, signal?: AbortSignal, body?: unknown, csrf?: string): Promise<T> {
  const response = await fetch(path, { signal, cache: 'no-store',
    ...(body ? { method: 'POST', headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new ApiError(response.status, result.detail ?? '请求失败。');
  return result as T;
}

function App() {
  const [tab, switchTab] = useState<'tasks'|'sessions'>('tasks');
  const [session, setSession] = useState<Session | null | undefined>();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const code = new URLSearchParams(location.hash.slice(1)).get('pair');
    if (code) history.replaceState(null, '', location.pathname + location.search);
    void (code ? api<Session>('/console/pair', controller.signal, { code })
      : api<Session>('/console/session', controller.signal)).then(setSession, error => {
      if (controller.signal.aborted) return;
      setSession(null);
      if (!(error instanceof ApiError && error.status === 401)) setNotice(describe(error));
    });
    return () => controller.abort();
  }, []);
  const expire = useCallback(() => { setSession(null); setNotice('会话已失效。'); }, []);

  return <>
    <header className="site-header"><a href="/console" className="brand"><span className="brand-mark" aria-hidden="true">Z</span>Zgent</a>
      {session ? <nav className="header-nav" aria-label="控制台"><button aria-pressed={tab === 'tasks'} onClick={() => switchTab('tasks')}>任务</button>
        <button aria-pressed={tab === 'sessions'} onClick={() => switchTab('sessions')}>主会话</button></nav> : <span className="header-label">本地控制台</span>}
    </header>
    {session === undefined ? <main className="center" aria-busy="true">正在连接本地服务…</main> : session
      ? (tab === 'tasks' ? <Dashboard session={session} expire={expire} /> :
        <Conversations projects={session.projects} csrf={session.csrf} api={api} expired={expire} />)
      : <main className="center"><div className="pair-card">
        <h1>打开本地控制台</h1><p>在 Zgent 终端中输入 <code>/web</code>。</p>
        {notice && <p role="alert" className="notice">{notice}</p>}
      </div></main>}
  </>;
}

function Dashboard({ session, expire }: { session: Session; expire: () => void }) {
  const link = new URLSearchParams(location.search);
  const [project, setProject] = useState(session.projects.find(item => item.id === link.get('project'))?.id ?? session.projects[0]?.id ?? '');
  const [list, setList] = useState<Task[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [older, setOlder] = useState<Task[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>();
  const [selected, select] = useState<string | undefined>(() => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(link.get('task') ?? '')
    ? link.get('task')! : undefined);
  const [task, setTask] = useState<Task>();
  const [requestId, selectRequest] = useState(location.pathname.split('/')[3]);
  const [request, setRequest] = useState<Request>();
  const [readiness, setReadiness] = useState<Contracts['Readiness']>();
  const [profiles, setProfiles] = useState<Contracts['ProfileList']['profiles']>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [workspaceDetail, setWorkspace] = useState<WorkspaceInfo>();
  const [catalog, setCatalog] = useState<{runtime:string; models:{id:string; label:string}[]}[]>([]);
  const [retained, setRetained] = useState<RetainedWorkspace[]>([]);
  const [creating, setCreating] = useState(false);
  const [resume, setResume] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const [refresh, reload] = useState(0);

  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = '?project_id=' + encodeURIComponent(project);
    let after: string | undefined;
    async function follow() {
      try {
        after ??= (await api<Contracts['TaskList']>('/api/v1/tasks' + query, controller.signal)).snapshot_event_cursor;
        const status = await readEvents('/api/v1/events' + query + '&after=' + after, controller.signal, event => {
          const cursor = (event as { cursor?: string }).cursor;
          if (!cursor) return;
          after = cursor;
          if (timer) return;
          timer = setTimeout(() => { timer = undefined; reload(value => value + 1); }, 200);
        });
        if (status === 401 && !controller.signal.aborted) { expire(); return; }
        if (status === 410) after = undefined;
      } catch {
        // Project snapshots continue while the event connection is retried.
      }
      if (!controller.signal.aborted) {
        setStreaming(false);
        timer = setTimeout(() => { timer = undefined; void follow(); }, 2000);
      }
    }
    setStreaming(true);
    void follow();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [project, expire]);

  useEffect(() => {
    if (!project) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const controller = new AbortController();
    async function poll() {
      if (!alive) return;
      try {
        if (document.visibilityState === 'visible') {
          const query = '?project_id=' + encodeURIComponent(project);
          const [page, state, models, detail, interaction, workspaceDetail, retainedList, modelCatalog] = await Promise.all([
            api<Contracts['TaskList']>('/api/v1/tasks' + query, controller.signal),
            api<Contracts['Readiness']>('/api/v1/readiness', controller.signal),
            api<Contracts['ProfileList']>('/api/v1/profiles' + query, controller.signal),
            selected ? api<Task>('/api/v1/tasks/' + selected, controller.signal) : Promise.resolve(undefined),
            requestId ? api<Request>('/api/v1/requests/' + requestId, controller.signal).catch(error => {
              if (error instanceof ApiError && error.status === 404) return undefined;
              throw error;
            }) : Promise.resolve(undefined),
            selected ? api<WorkspaceInfo>('/api/v1/tasks/' + selected + '/workspace', controller.signal) : Promise.resolve(undefined),
            api<RetainedWorkspace[]>('/api/v1/workspaces' + query, controller.signal),
            api<typeof catalog>('/api/v1/model-catalog', controller.signal),
          ]);
          if (!alive) return;
          setList(previous => {
            const old = new Map(previous.map(item => [item.task_id, item]));
            return page.tasks.map(item => (old.get(item.task_id)?.version ?? -1) > item.version ? old.get(item.task_id)! : item);
          });
          setCursor(page.next_cursor);
          setTask(previous => previous && detail && previous.task_id === detail.task_id && previous.version > detail.version ? previous : detail);
          setRequest(previous => previous && interaction && previous.pending_request_id === interaction.pending_request_id &&
            previous.revision > interaction.revision ? previous : interaction);
          setWorkspace(workspaceDetail);
          setRetained(retainedList);
          setCatalog(modelCatalog);
          setProfiles(models.profiles);
          setReadiness(state);
          failures = 0;
        }
      } catch (error) {
        if (alive) {
          if (error instanceof ApiError && error.status === 401) { expire(); return; }
          setError(describe(error));
          failures++;
        }
      }
      if (alive) timer = setTimeout(poll, Math.min(15_000, (streaming && !requestId ? 5000 : 1500) * 2 ** failures));
    }
    void poll();
    return () => { alive = false; clearTimeout(timer); controller.abort(); };
  }, [project, selected, requestId, refresh, expire, streaming]);

  async function mutate(path: string, data: unknown) {
    setError('');
    setBusy(true);
    try { await api(path, undefined, data, session.csrf); return true; }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) expire();
      else setError(describe(error));
      return false;
    } finally {
      setBusy(false);
      reload(value => value + 1);
    }
  }

  const nextPage = olderCursor === undefined ? cursor : olderCursor;

  async function more() {
    if (!nextPage) return;
    const projectAtRequest = project;
    try {
      const page = await api<Contracts['TaskList']>('/api/v1/tasks?' + new URLSearchParams({ project_id: project, cursor: nextPage }));
      const selectElement = document.querySelector<HTMLSelectElement>('#project');
      if (selectElement?.value !== projectAtRequest) return;
      setOlder(old => [...new Map([...old, ...page.tasks].map(row => [row.task_id, row])).values()]);
      setOlderCursor(page.next_cursor);
    } catch (error) {
      if (error instanceof ApiError && error.status === 410) {
        setOlder([]);
        setOlderCursor(undefined);
        reload(value => value + 1);
      }
      setError(describe(error));
    }
  }

  const rows = [...list, ...older.filter(item => !list.some(current => current.task_id === item.task_id))];
  const visible = task?.task_id === selected ? task : rows.find(item => item.task_id === selected);
  const workspace = workspaceDetail?.task_id === visible?.task_id ? workspaceDetail : undefined;
  return <main className="dashboard">
    <div className="page-heading">
      <div><h1>任务</h1><p>查看 worker 执行状态、处理人工请求和验收产物。</p></div>
      <div className="service-status" role="status"><span className={readiness?.ready ? 'online' : 'idle'} />
        {readiness?.phase === 'degraded' ? '运行时不可用' : readiness?.ready ? '服务就绪' : readiness?.phase === 'recovering' ? '正在对账' : '正在启动'}
      </div>
    </div>
    {error && <div className="notice" role="alert"><span>{error}</span><button onClick={() => setError('')}>关闭</button></div>}
    {requestId && request && <RequestPanel key={requestId} request={request} task={visible} busy={busy}
      close={() => selectRequest('')} submit={async input => { await mutate('/api/v1/requests/' + requestId + '/decision', input); }} />}
    <section className="board">
      <div className="toolbar">
        <label htmlFor="project">项目</label>
        <select id="project" value={project} onChange={event => {
          setProject(event.target.value); select(undefined); selectRequest(''); setTask(undefined); setRequest(undefined);
          setList([]); setCursor(null); setOlder([]); setOlderCursor(undefined); setProfiles([]); setWorkspace(undefined); setRetained([]); setCreating(false);
        }}>{session.projects.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        <button onClick={() => { setResume(undefined); setCreating(value => !value); }}>派发任务</button>
      </div>
      {creating && <TaskForm key={resume ?? project} project={project} profiles={profiles} resume={resume}
        busy={busy} submit={async input => {
          if (await mutate('/api/v1/tasks', input)) { setCreating(false); setResume(undefined); }
        }} />}
      {profiles.some(profile => profile.availability.status !== 'available') && <div className="profile-notices">
        {profiles.filter(profile => profile.availability.status !== 'available').map(profile =>
          <p key={profile.profile_id}><strong>{profile.display_name}</strong> {profile.availability.reason ?? profile.availability.status}</p>)}
      </div>}
      <div className="table-scroll"><table>
        <thead><tr><th scope="col">任务</th><th scope="col">执行</th><th scope="col">验收</th><th scope="col">更新于</th></tr></thead>
        <tbody>{rows.map(item => <tr className={item.task_id === selected ? 'selected' : ''} key={item.task_id}>
          <td><button className="row-button" aria-pressed={item.task_id === selected} onClick={() => { select(item.task_id); selectRequest(''); }}>
            {item.summary || item.task_id}</button><small>{item.profile_id}</small></td>
          <td><span className={'state ' + item.state}>{states[item.state]}</span></td>
          <td>{terminal(item.state) ? review[item.review_state] : '—'}</td><td><time dateTime={item.updated_at}>{time(item.updated_at)}</time></td>
        </tr>)}</tbody>
      </table></div>
      {!list.length && <p className="empty">{readiness ? '此项目暂无任务。可在已登记的 MCP 客户端派发。' : '正在读取任务…'}</p>}
      {nextPage && <div className="toolbar"><button onClick={() => void more()}>加载更多任务</button></div>}
    </section>
    {visible && <section className="detail" aria-label="任务详情">
      <div className="detail-head"><div><h2>任务详情</h2><p className="task-id">{visible.task_id}</p></div>
        <span className={'state ' + visible.state}>{states[visible.state]}</span></div>
      <p className="task-summary">{visible.summary}</p>
      <dl className="task-metadata">
        <dt>档案</dt><dd>{visible.profile_id}</dd>
        <dt>运行时与模型</dt><dd>{visible.runtime ? visible.runtime.adapter + ' · ' + visible.runtime.model_id : '待启动'}</dd>
        <dt>开始与结束</dt><dd>{visible.started_at ? time(visible.started_at) : '—'} / {visible.completed_at ? time(visible.completed_at) : '—'}</dd>
        {workspace?.error_code && <><dt>失败类别</dt><dd>{workspace.error_code}</dd></>}
        <dt>用量</dt><dd>{visible.actual_usage?.total_tokens ?? '未知'}</dd>
        {workspace?.workspace && <><dt>工作区</dt><dd>{workspace.workspace.state === 'removed' ? '已清理' : workspace.workspace.managed_path}</dd></>}
      </dl>
      {workspace?.tracked_snapshot && <details><summary>已跟踪修改快照</summary>
        <p>原 HEAD <code>{workspace.tracked_snapshot.original_head}</code></p>
        <p>快照 <code>{workspace.tracked_snapshot.oid}</code></p>
        {workspace.tracked_snapshot.excluded_untracked.length > 0 &&
          <><p>排除的未跟踪文件</p><ul>{workspace.tracked_snapshot.excluded_untracked.map(file => <li key={file}>{file}</li>)}</ul></>}
      </details>}
      {visible.recovery && <p className="notice">{visible.recovery.summary}</p>}
      {visible.pending_requests.map(item => <button key={item.pending_request_id} className="interaction"
        onClick={() => selectRequest(item.pending_request_id)}>{kinds[item.kind]} · {item.summary}</button>)}
      <div className="actions">
        {!terminal(visible.state) && visible.state !== 'cancelling' && visible.state !== 'recovering' &&
          <button className="danger" disabled={busy} onClick={() => void mutate('/api/v1/tasks/' + visible.task_id + '/cancel',
            { command_id: crypto.randomUUID(), expected_version: visible.version })}>取消执行</button>}
        {visible.state === 'recovering' && <button disabled={busy} onClick={() => {
          if (window.confirm('确认旧 worker 和相关进程均已停止后再继续。')) void mutate('/api/v1/tasks/' + visible.task_id + '/confirm-stopped',
            { expected_version: visible.version, confirm_stopped: true });
        }}>确认停止并对账</button>}
        {workspace?.can_resume_context && <button onClick={() => { setResume(visible.task_id); setCreating(true); window.scrollTo(0, 0); }}>用此上下文派发新任务</button>}
        {workspace?.workspace?.state === 'retained' && terminal(visible.state) && <button disabled={busy} onClick={() => {
          if (window.confirm('清理工作区前请检查本地文件。候选分支和已保存的产物会保留。')) {
            void mutate('/api/v1/tasks/' + visible.task_id + '/remove-workspace', { confirm_removal: true });
          }
        }}>清理工作区</button>}
        {terminal(visible.state) && <>
          <button disabled={busy || visible.review_state === 'accepted'} onClick={() => void mutate('/api/v1/tasks/' + visible.task_id + '/review',
            { request_id: crypto.randomUUID(), expected_version: visible.version, review_state: 'accepted' })}>接受结果</button>
          <button disabled={busy || visible.review_state === 'rejected'} onClick={() => void mutate('/api/v1/tasks/' + visible.task_id + '/review',
            { request_id: crypto.randomUUID(), expected_version: visible.version, review_state: 'rejected' })}>拒绝结果</button>
        </>}
      </div>
      {visible.artifacts.length > 0 && <Artifacts key={visible.task_id} artifacts={visible.artifacts} />}
    </section>}
    {catalog.some(item => item.models.length) && <details className="detail"><summary>运行时发现的模型 ID</summary>
      {catalog.filter(item => item.models.length).map(item => <section key={item.runtime}><h3>{item.runtime}</h3>
        <ul>{item.models.map(model => <li key={model.id}>{model.label} · <code>{model.id}</code></li>)}</ul></section>)}
    </details>}
    {retained.length > 0 && <details className="detail"><summary>保留及待清理工作区</summary>
      <ul>{retained.map(item => <li key={item.task_id}><button className="row-button" onClick={() => select(item.task_id)}>{item.title}</button>
        <small>{item.state} · {item.dirty_state} · {item.managed_path}</small></li>)}</ul>
    </details>}
  </main>;
}

function TaskForm({ project, profiles, resume, busy, submit }: { project: string; profiles: Contracts['ProfileList']['profiles'];
  resume?: string; busy: boolean; submit: (body: unknown) => Promise<void> }) {
  const enabled = profiles.filter(profile => profile.availability.status === 'available' && (!resume || profile.adapter === 'codex_app_server'));
  return <form className="task-form" onSubmit={event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const goal = String(form.get('goal') ?? '').trim();
    const criteria = String(form.get('criteria') ?? '').split('\n').map(line => line.trim()).filter(Boolean);
    if (!goal || !criteria.length) return;
    void submit({ request: { request_id: crypto.randomUUID(), project_id: project, profile_id: form.get('profile'),
      brief: { goal, acceptance_criteria: criteria } }, include_tracked_changes: form.has('snapshot'), resume_task_id: resume });
  }}>
    <label>档案<select name="profile" required>{enabled.map(profile => <option key={profile.profile_id} value={profile.profile_id}>
      {profile.display_name} · {profile.model.display_name}</option>)}</select></label>
    {resume && <p className="subtle">在新工作区使用之前的 Codex 上下文。</p>}
    <label>任务目标<textarea name="goal" rows={3} required maxLength={12000} /></label>
    <label>验收条件（每行一项）<textarea name="criteria" rows={3} required maxLength={8000} /></label>
    <label><input name="snapshot" type="checkbox" /> 纳入当前已跟踪的未提交修改</label>
    <button className="primary" disabled={busy || !enabled.length}>提交任务</button>
  </form>;
}

function RequestPanel({ request, task, busy, close, submit }: { request: Request; task?: Task; busy: boolean;
  close: () => void; submit: (input: Contracts['DecisionRequest']) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [permissions, setPermissions] = useState(request.kind === 'permission_grant' ? JSON.stringify(request.requested_permissions, null, 2) : '');
  const [error, setError] = useState('');
  const choices = request.allowed_choices as string[];
  const available = request.state === 'pending' && (!task || task.task_id !== request.task_id || task.state === 'waiting_input');
  const base = () => ({ expected_revision: request.revision, decision_id: crypto.randomUUID(), operation_hash: request.operation_hash });

  function approve() {
    if (request.kind === 'permission_grant') {
      try { void submit({ ...base(), kind: 'permissions_approval', decision: 'accept_once', approved_permissions: JSON.parse(permissions) }); }
      catch { setError('请填写有效的权限 JSON。'); }
    } else void submit({ ...base(), kind: 'operation_approval', decision: 'accept_once' });
  }

  function answer(event: FormEvent) {
    event.preventDefault();
    if (request.kind !== 'user_question') return;
    const result = Object.fromEntries(request.questions.map(question => [question.question_id,
      question.answer_kind === 'single_choice' ? { kind: 'single_choice', choice_id: answers[question.question_id] ?? '' } :
        { kind: 'text', value: answers[question.question_id] ?? '' }])) as Extract<Contracts['DecisionRequest'], {kind: 'question_answer'}>['answers'];
    void submit({ ...base(), kind: 'question_answer', answers: result });
  }

  return <section className="request-card" aria-label="人工请求">
    <div className="detail-head"><div><h2>{kinds[request.kind]}</h2><p>{request.summary}</p></div><button onClick={close}>关闭</button></div>
    <p className="subtle">有效至 {time(request.expires_at)}</p>
    {(request.kind === 'command_approval' || request.kind === 'file_approval') && <pre>{request.operation_preview}</pre>}
    {request.kind === 'permission_grant' && <>
      <h3>请求的原生权限</h3><pre>{JSON.stringify(request.requested_permissions, null, 2)}</pre>
      {available && choices.includes('accept_once') && <label>仅授予本轮所需的权限子集
        <textarea value={permissions} onChange={event => setPermissions(event.target.value)} rows={5} spellCheck={false} /></label>}
    </>}
    {request.kind === 'user_question' && <form onSubmit={answer}>
      {request.questions.map(question => <label key={question.question_id}>{question.title}<small>{question.prompt}</small>
        {question.answer_kind === 'single_choice' ? <select required value={answers[question.question_id] ?? ''}
          onChange={event => setAnswers(value => ({ ...value, [question.question_id]: event.target.value }))}>
          <option value="">请选择</option>{question.choices.map(choice => <option key={choice.choice_id} value={choice.choice_id}>
            {choice.label}{choice.description ? ' · ' + choice.description : ''}
          </option>)}</select> : <textarea value={answers[question.question_id] ?? ''} maxLength={16000}
          onChange={event => setAnswers(value => ({ ...value, [question.question_id]: event.target.value }))} rows={3} />}
      </label>)}
      {available && <button className="primary" disabled={busy}>发送回答</button>}
    </form>}
    {error && <p role="alert" className="notice">{error}</p>}
    {available ? <div className="actions">
      {choices.includes('accept_once') && <button className="primary" disabled={busy} onClick={approve}>
        {request.kind === 'permission_grant' ? '允许所选权限（本轮）' : '允许这一次'}</button>}
      {choices.includes('deny') && <button disabled={busy} onClick={() => void submit({ ...base(), kind: 'approval_denial', decision: 'deny' })}>拒绝请求</button>}
      {choices.includes('cancel_task') && <button className="danger" disabled={busy}
        onClick={() => void submit({ ...base(), kind: 'task_cancellation', decision: 'cancel_task' })}>取消任务</button>}
    </div> : <p className="subtle">{request.state === 'provider_resolved' ? 'Codex 已处理请求。' :
      request.delivery_state === 'delivery_unknown' ? '决定的投递情况待核对。' :
        request.delivery_state === 'sent' ? '决定已发送，等待 Codex 处理。' :
          request.state === 'decision_recorded' ? '决定已记录，正在投递。' : '请求已关闭。'}</p>}
  </section>;
}

function Artifacts({ artifacts }: { artifacts: Artifact[] }) {
  const [active, setActive] = useState<Artifact>();
  useEffect(() => { if (!active) setActive(artifacts.find(item => item.kind === 'result') ?? artifacts[0]); }, [artifacts, active]);
  return <div className="artifacts">
    <div className="actions">{artifacts.map(item => <button key={item.artifact_id} aria-pressed={active?.artifact_id === item.artifact_id}
      onClick={() => setActive(item)}>{artifactNames[item.kind]}</button>)}</div>
    {active && <ArtifactText key={active.artifact_id} artifact={active} />}
  </div>;
}

function ArtifactText({ artifact }: { artifact: Artifact }) {
  const [text, setText] = useState('');
  const [offset, setOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [decoder] = useState(() => new TextDecoder());
  const read = useCallback(async (position: number, signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      const page = await api<Contracts['ArtifactSlice']>('/api/v1/artifacts/' + artifact.artifact_id + '?offset_bytes=' + position, signal);
      const bytes = Uint8Array.from(atob(page.data_base64), char => char.charCodeAt(0));
      const content = decoder.decode(bytes, { stream: !page.eof });
      setText(old => position ? old + content : content);
      setOffset(page.next_offset_bytes);
    } catch (error) {
      if (!signal?.aborted) setError(describe(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [artifact.artifact_id, decoder]);
  useEffect(() => {
    const controller = new AbortController();
    void read(0, controller.signal);
    return () => controller.abort();
  }, [read]);

  async function download() {
    setLoading(true);
    setError('');
    try {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let position: number | null = 0;
      let size = 0;
      while (position !== null) {
        const page: Contracts['ArtifactSlice'] = await api('/api/v1/artifacts/' + artifact.artifact_id + '?offset_bytes=' + position + '&max_bytes=262144');
        const bytes = Uint8Array.from(atob(page.data_base64), char => char.charCodeAt(0));
        chunks.push(bytes);
        size += bytes.length;
        position = page.next_offset_bytes;
      }
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
        byte => byte.toString(16).padStart(2, '0')).join('');
      if (size !== artifact.size_bytes || digest !== artifact.sha256) throw new Error('产物校验失败，请重新下载。');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = artifact.kind === 'diff' ? 'zgent.diff' : artifact.kind === 'patch' ? 'zgent-index.patch' : 'zgent-' + artifact.kind + '.txt';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { setError(describe(error)); }
    finally { setLoading(false); }
  }

  function body(): ReactNode {
    if (artifact.kind !== 'diff' && artifact.kind !== 'patch') return text || (loading ? '正在读取…' : '产物为空。');
    return text ? text.split('\n').map((line, index) => <span key={index}
      className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : line.startsWith('@@') ? 'hunk' : ''}>{line + '\n'}</span>)
      : loading ? '正在读取…' : '无差异。';
  }

  return <>
    {error && <p role="alert" className="notice">{error}</p>}
    <pre aria-busy={loading}>{body()}</pre>
    <div className="actions">{offset !== null && <button disabled={loading} onClick={() => void read(offset)}>读取更多</button>}
      <button disabled={loading} onClick={() => void download()}>下载完整产物</button></div>
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);
