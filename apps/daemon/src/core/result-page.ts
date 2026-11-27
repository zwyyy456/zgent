import type { Contracts } from '@zgent/contracts';
import { invalid } from './values.ts';

type ToolGetData = NonNullable<Extract<Contracts['get_taskOutput'], {ok: true}>['data']>;
type ResultPage = Extract<NonNullable<ToolGetData['page']>, {kind: 'result'}>;
export type Result = ResultPage['result'];

const properties = ['changes', 'verification', 'open_issues', 'artifact_refs'] as const;
const jsonChars = (value: Result) => Array.from(JSON.stringify(value)).length;

export function pageResult(full: Result, summary: string, start: number, limit: number) {
  const page: Result = { outcome_summary: '', changes: [], verification: [], open_issues: [], artifact_refs: [], truncated: false };
  const emptySize = jsonChars(page);
  if (limit < emptySize + 2) throw invalid('Increase max_chars to fit a structured result page.');

  const text = Array.from(summary);
  const parts = [
    ...full.changes.map(value => ({ key: 'changes', value } as const)),
    ...full.verification.map(value => ({ key: 'verification', value } as const)),
    ...full.open_issues.map(value => ({ key: 'open_issues', value } as const)),
    ...full.artifact_refs.map(value => ({ key: 'artifact_refs', value } as const)),
  ];
  const end = text.length + parts.length;
  if (start > end) throw invalid('Result cursor is outside the current content.');
  let offset = start;
  if (offset < text.length) {
    let lo = 0;
    let hi = Math.min(text.length - offset, 8000, limit - emptySize);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      page.outcome_summary = text.slice(offset, offset + mid).join('');
      if (jsonChars(page) <= limit) lo = mid;
      else hi = mid - 1;
    }
    if (!lo) throw invalid('Increase max_chars to fit the next result character.');
    page.outcome_summary = text.slice(offset, offset + lo).join('');
    offset += lo;
  }

  let omitted = false;
  while (offset >= text.length && offset < end) {
    const part = parts[offset - text.length];
    switch (part.key) {
      case 'changes': page.changes.push(part.value); break;
      case 'verification': page.verification.push(part.value); break;
      case 'open_issues': page.open_issues.push(part.value); break;
      case 'artifact_refs': page.artifact_refs.push(part.value); break;
    }
    if (jsonChars(page) <= limit) {
      offset++;
      continue;
    }
    page[part.key].pop();
    if (page.outcome_summary || properties.some(key => page[key].length)) break;
    omitted = true;
    offset++;
  }
  const more = offset < end;
  page.truncated = full.truncated || more || omitted;
  return { result: page, returned_chars: jsonChars(page), truncated: page.truncated, next: more ? offset : null };
}
