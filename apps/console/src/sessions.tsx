import { useEffect, useState, type FormEvent } from 'react';
import type { MainProfileView, MainSessionDetail, MainSessionView } from '@zgent/contracts';
import { readEvents } from './stream.ts';

type Api = <T>(path: string, signal?: AbortSignal, body?: unknown, csrf?: string) => Promise<T>;
type Props = { projects: { id: string; label: string }[]; csrf: string; api: Api; expired: () => void };
const runtimeLabels = { antigravity_acp: 'Antigravity ACP', claude_agent_sdk: 'Claude Agent SDK' };
const stateLabels = { ready: '就绪', running: '回复中', waiting_input: '等待人工输入', stopping: '正在停止', disconnected: '连接已断开', closed: '已关闭' };
const taskStates: Record<string, string> = { queued: '排队中', starting: '启动中', running: '执行中', waiting_input: '等待人工输入',
  cancelling: '正在停止', recovering: '待对账', succeeded: '执行完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };

export function Conversations({ projects, csrf, api, expired }: Props) {
  const [project, setProject] = useState(projects[0]?.id ?? '');
  const [sessions, setSessions] = useState<MainSessionView[]>([]);
  const [profiles, setProfiles] = useState<MainProfileView[]>([]);
  const [selected, select] = useState('');
  const [detail, setDetail] = useState<MainSessionDetail>();
  const [profile, setProfile] = useState('');
  const [model, setModel] = useState('');
  const [text, setText] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, reload] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const sessionPath = '/api/v1/sessions/' + selected;
  const operating = detail && ['running','waiting_input','stopping'].includes(detail.state);
  const firstAgyTurn = detail?.profile.runtime === 'antigravity_acp' && detail.turns.length === 0;
  const preferredModel = firstAgyTurn ? profiles.find(item => item.id === detail.profile.id)?.model : undefined;

  useEffect(() => {
    if (!project) return;
    const controller = new AbortController();
    const params = '?project_id=' + encodeURIComponent(project);
    void Promise.all([api<MainSessionView[]>('/api/v1/sessions' + params, controller.signal),
      api<MainProfileView[]>('/api/v1/session-profiles' + params, controller.signal)]).then(([list, listProfiles]) => {
      setSessions(list);
      setProfiles(listProfiles);
      if (!selected && list[0]) select(list[0].session_id);
    }, error => { if (!controller.signal.aborted) setNotice(error.message); });
    return () => controller.abort();
  }, [project, refresh, api]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function open() {
      try {
        const status = await readEvents(sessionPath + '/stream', controller.signal, value => setDetail(value as MainSessionDetail));
        if (status === 401 && !controller.signal.aborted) { expired(); return; }
      } catch (error) {
        if (!controller.signal.aborted) setNotice((error as Error).message);
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void open(), 1500);
    }
    void open();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selected, sessionPath, expired]);

  async function action<T>(path: string, body: unknown) {
    setNotice('');
    setBusy(true);
    try { return await api<T>(path, undefined, body, csrf); }
    catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); reload(value => value + 1); }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await action<MainSessionDetail>('/api/v1/sessions',
      { project_id: project, title: form.get('title'), profile_id: form.get('profile') });
    if (result) { setDetail(result); select(result.session_id); setProfile(''); setModel(''); setShowNew(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    if (await action(sessionPath + '/turn', { turn_id: crypto.randomUUID(), input: text.trim() })) setText('');
  }

  return <main className="dashboard">
    <div className="page-heading"><div><h1>主会话</h1><p>通过 Antigravity 或 Claude 组织任务，查看各轮派发结果。</p></div></div>
    {notice && <p role="alert" className="notice">{notice}</p>}
    <div className="conversation-layout">
      <aside className="board conversation-list">
        <label>项目<select value={project} onChange={event => {
          setProject(event.target.value); setSessions([]); setProfiles([]); select(''); setDetail(undefined); setProfile(''); setModel(''); setText('');
        }}>{projects.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <button onClick={() => setShowNew(value => !value)}>新建主会话</button>
        {showNew && <form onSubmit={create}>
          <label>名称<input name="title" maxLength={160} required /></label>
          <label>主控档案<select name="profile" required>{profiles.filter(item => item.available).map(item =>
            <option key={item.id} value={item.id}>{item.label}{item.model ? ' · ' + item.model : ''}</option>)}</select></label>
          <button className="primary" disabled={busy || !profiles.some(item => item.available)}>{busy ? '正在连接运行时…' : '新建'}</button>
        </form>}
        {!profiles.length && <p className="subtle">此项目还没有配置主控档案。</p>}
        {sessions.map(item => <button className="conversation-choice" key={item.session_id} aria-pressed={selected === item.session_id}
          onClick={() => { select(item.session_id); setDetail(undefined); setProfile(''); setModel(''); setText(''); }}>
          {item.title}<small>{runtimeLabels[item.profile.runtime]}</small>
        </button>)}
      </aside>
      <section className="detail conversation-panel">
        {!detail ? <p className="subtle">选择或新建主会话。</p> : <>
          <div className="detail-head"><div><h2>{detail.title}</h2><p>{runtimeLabels[detail.profile.runtime]} {detail.runtime_version ?? ''} · {detail.profile.model} · {detail.profile.billing}</p></div>
            <span className="state">{stateLabels[detail.state]}</span></div>
          <details open={firstAgyTurn || undefined}>
            <summary>切换主控或模型</summary>
            {preferredModel && detail.models.length > 0 && !detail.models.some(item => item.id === preferredModel) &&
              <p className="subtle">档案中的模型当前不可用。请在发送前确认所选模型。</p>}
            <form onSubmit={async event => {
              event.preventDefault();
              const result = await action<MainSessionDetail>(sessionPath + '/profile',
                { profile_id: profile || detail.profile.id, model: (profile === '' || profile === detail.profile.id) && model ? model : undefined });
              if (result) { setDetail(result); select(result.session_id); setProfile(''); setModel(''); }
            }}>
              <label>主控档案<select value={profile || detail.profile.id} onChange={event => { setProfile(event.target.value); setModel(''); }}>
                {profiles.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}</option>)}
              </select></label>
              {(!profile || profile === detail.profile.id) && detail.models.length > 0 && <label>模型<select value={model || detail.profile.model} onChange={event => setModel(event.target.value)}>
                {!detail.models.some(item => item.id === detail.profile.model) && <option value={detail.profile.model}>{detail.profile.model}</option>}
                {detail.models.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
              <button disabled={busy || operating || detail.state === 'closed'}>应用选择</button>
            </form>
          </details>
          <div className="turns" aria-live="polite">{detail.turns.map(turn => {
            const tasks = detail.tasks.filter(item => item.turn_id === turn.turn_id);
            return <article key={turn.turn_id}>
              <p className="user-message">{turn.input}</p>
              <p className="model-message">{turn.output || (turn.state === 'running' ? '正在等待回复…' : '')}</p>
              {turn.error && <p role="alert" className="notice">{turn.error}</p>}
              {turn.usage?.total_tokens !== undefined && <small>用量 {turn.usage.total_tokens} tokens</small>}
              {tasks.length > 0 && <div className="turn-task-list"><ul>{tasks.map(({ snapshot }) => <li key={snapshot.task_id}>
                <a href={'/console?project=' + encodeURIComponent(snapshot.project_id) + '&task=' + encodeURIComponent(snapshot.task_id)}>
                  {snapshot.summary || snapshot.task_id}</a> <small>{taskStates[snapshot.state]}</small>
                {snapshot.pending_requests.map(item => <a key={item.pending_request_id} href={item.console_path}>打开人工请求</a>)}
              </li>)}</ul>
              {tasks.some(({ snapshot }) => ['queued','starting','running','waiting_input'].includes(snapshot.state)) &&
                <button disabled={busy} onClick={() => void action(sessionPath + '/cancel-group', { turn_id: turn.turn_id })}>取消本轮任务组</button>}</div>}
            </article>;
          })}</div>
          {detail.previous_session_id && <p className="subtle">此会话承接了前一个提供方的可见摘要和任务引用。</p>}
          {(detail.notifications.length > 0 || detail.tasks.length > 0) && <details className="session-notifications">
            <summary>关联任务与通知</summary><ul>{detail.tasks.map(({snapshot}) => <li key={snapshot.task_id}>
              <a href={'/console?project=' + encodeURIComponent(snapshot.project_id) + '&task=' + encodeURIComponent(snapshot.task_id)}>
                {snapshot.summary || snapshot.task_id}</a> <small>{taskStates[snapshot.state]}</small>
            </li>)}</ul>
            {detail.notifications.length > 0 && <ul>{detail.notifications.map(item => <li key={item.event_id}>
              <a href={'/console?project=' + encodeURIComponent(detail.project_id) + '&task=' + encodeURIComponent(item.task_id)}>
                {taskStates[item.state] ?? item.state}</a>
            </li>)}</ul>}
          </details>}
          {detail.state !== 'closed' && <form onSubmit={send} className="compose">
            <label>消息<textarea rows={4} value={text} maxLength={12000} onChange={event => setText(event.target.value)} /></label>
            <div className="actions">
              <button className="primary" disabled={busy || !!operating || !text.trim() ||
                (firstAgyTurn && Boolean(model) && model !== detail.profile.model)}>发送</button>
              {operating && <button type="button" disabled={busy || detail.state === 'stopping'}
                onClick={() => void action(sessionPath + '/interrupt', {})}>停止回答</button>}
              {!operating && <button type="button" disabled={busy} onClick={() => void action(sessionPath + '/close', {})}>关闭会话</button>}
            </div>
          </form>}
        </>}
      </section>
    </div>
  </main>;
}
