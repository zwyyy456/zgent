import type { ServerResponse } from 'node:http';
import type { Tasks } from './core/tasks.ts';
import type { Client } from './policy/config.ts';
import { Failure, invalid, iso } from './core/values.ts';

const maximum = 9_223_372_036_854_775_807n;
type Row = { cursor: string; event_id: string; event_type: string; project_id: string; task_id: string;
  task_version: number; created_at_ms: number; payload_json: string };

export function projectEvents(tasks: Tasks, client: Client, project: string, after: string, res: ServerResponse) {
  const { read_scope } = tasks.grant(client, project);
  if (!/^(0|[1-9]\d{0,18})$/.test(after) || BigInt(after) > maximum) throw invalid('Invalid event cursor.');
  const { oldest, latest } = tasks.store.one<{ oldest: string; latest: string }>(
    'SELECT CAST(COALESCE(MIN(event_seq),0) AS TEXT) oldest,CAST(COALESCE(MAX(event_seq),0) AS TEXT) latest FROM events')!;
  if (BigInt(after) > BigInt(latest)) throw new Failure(400, 'FUTURE_CURSOR', 'Event cursor is after the latest committed event.');
  if (after !== '0' && BigInt(after) < BigInt(oldest)) {
    throw new Failure(410, 'EVENT_CURSOR_EXPIRED', 'Reload the project task snapshot to resume.');
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', 'cache-control': 'no-store' });
  res.write(': connected\n\n');
  let cursor = after;
  let lastWrite = Date.now();
  const publish = () => {
    try {
      const rows = tasks.store.all<Row>(`SELECT CAST(e.event_seq AS TEXT) cursor,e.event_id,e.event_type,e.project_id,e.task_id,
        e.task_state_version task_version,e.created_at_ms,e.payload_json FROM events e JOIN tasks t ON t.task_id=e.task_id
        WHERE e.project_id=? AND e.event_seq>? AND (?='project' OR (?='own' AND t.created_by_client_id=?))
        ORDER BY e.event_seq LIMIT 100`, project, BigInt(cursor), read_scope, read_scope, client);
      for (const row of rows) {
        const frame = { schema_version: '1', event_id: row.event_id, cursor: row.cursor, event_type: row.event_type,
          project_id: row.project_id, task_id: row.task_id, task_version: row.task_version,
          occurred_at: iso(row.created_at_ms), data: JSON.parse(row.payload_json) };
        if (!res.write('event: orchestrator_event\ndata: ' + JSON.stringify(frame) + '\n\n')) {
          res.end();
          return;
        }
        cursor = row.cursor;
        lastWrite = Date.now();
      }
      if (Date.now() - lastWrite >= 15_000) {
        lastWrite = Date.now();
        if (!res.write(': heartbeat\n\n')) res.end();
      }
    } catch {
      res.destroy();
    }
  };
  const timer = setInterval(publish, 250);
  timer.unref();
  res.once('close', () => clearInterval(timer));
  publish();
}
