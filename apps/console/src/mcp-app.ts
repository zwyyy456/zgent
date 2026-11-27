import { App } from '@modelcontextprotocol/ext-apps';
import type { Contracts } from '@zgent/contracts';

type Snapshot = Contracts['TaskView'];
type Listed = { tasks: Snapshot[] };
type Retrieved = { task: Snapshot; page?: { content?: string; result?: { outcome_summary?: string } } };
const area = document.querySelector<HTMLElement>('main')!;
const status = document.createElement('p');
status.setAttribute('role', 'status');
const rows = document.createElement('ul');
const details = document.createElement('pre');
area.append(status, rows, details);
const app = new App({ name: 'Zgent tasks', version: '1.1.0' });
let origin = area.dataset.consoleOrigin ?? '';

function envelope(result: { structuredContent?: unknown; isError?: boolean }) {
  if (result.isError) throw new Error('任务查询失败。');
  const content = result.structuredContent as { ok?: boolean; data?: Partial<Listed & Retrieved> } | undefined;
  if (!content?.ok || !content.data) throw new Error('此工具没有返回任务资料。');
  return content.data;
}

function show(items: Snapshot[]) {
  rows.replaceChildren();
  status.textContent = items.length ? '' : '暂无任务。';
  for (const item of items) {
    const row = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = item.summary || item.task_id;
    const state = document.createElement('small');
    state.textContent = item.state + ' · ' + item.review_state;
    const read = document.createElement('button');
    read.textContent = '查看结果';
    read.addEventListener('click', async () => {
      try {
        const value = envelope(await app.callServerTool({ name: 'get_task', arguments: { task_id: item.task_id, section: 'result', max_chars: 4000 } }));
        details.textContent = value.page?.result?.outcome_summary || '暂无可显示的结果。';
      } catch { details.textContent = '无法读取此任务的结果。'; }
    });
    const open = document.createElement('button');
    open.textContent = '打开控制台';
    open.addEventListener('click', () => {
      const url = new URL('/console', origin);
      url.searchParams.set('task', item.task_id);
      url.searchParams.set('project', item.project_id);
      void app.openLink({ url: url.toString() }).catch(() => { status.textContent = '请从浏览器打开本地控制台。'; });
    });
    row.append(title, state, read, open);
    rows.append(row);
  }
}
app.ontoolresult = result => {
  try {
    const data = envelope(result);
    show(data.tasks ?? (data.task ? [data.task] : []));
    details.textContent = data.page?.result?.outcome_summary ?? data.page?.content ?? '';
  } catch { status.textContent = '无法读取任务。'; }
};
void app.connect().catch(() => { status.textContent = '无法连接 MCP 宿主。'; });
