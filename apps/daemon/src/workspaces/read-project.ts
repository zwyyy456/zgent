import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { clip, invalid, redact } from '../core/values.ts';
import { within } from '../policy/config.ts';
import { projectFiles, projectGit } from './git.ts';

export function readProject(root: string, input: { action: 'list' | 'read' | 'search' | 'status' | 'diff' | 'log'; path?: string; query?: string }) {
  const { action, path, query } = input;
  const display = (text: string) => clip(redact(text), 32_000);
  if (action === 'diff' || action === 'log') return display(projectGit(root, action));
  const files = new Set(projectFiles(root));
  const prefix = path?.replace(/\/$/, '');
  const selected = [...files].filter(file => !prefix || prefix === '.' || file === prefix || file.startsWith(prefix + '/'));
  if (action === 'list') return display(selected.join('\n'));
  if (action === 'status') {
    const tracked = new Set(projectFiles(root, true));
    return display(projectGit(root, action) + selected.filter(file => !tracked.has(file)).map(file => '?? ' + file).join('\n'));
  }

  function read(file: string) {
    if (!files.has(file)) return;
    try {
      const actual = realpathSync(join(root, file));
      if (!within(root, actual) || !files.has(relative(root, actual))) return;
      const stat = statSync(actual);
      if (!stat.isFile() || stat.size > 512 * 1024) return;
      const bytes = readFileSync(actual);
      if (!bytes.includes(0)) return bytes.toString('utf8');
    } catch { return; }
  }
  if (action === 'read') {
    const text = path ? read(path) : undefined;
    if (text === undefined) throw invalid('Choose a readable text file in the project.');
    return display(text);
  }
  if (!query) throw invalid('Enter a search term.');
  const matches: string[] = [];
  for (const file of selected) {
    const text = read(file);
    if (!text) continue;
    for (const [index, line] of text.split('\n').entries()) {
      if (line.includes(query)) matches.push(`${file}:${index + 1}: ${clip(line, 400)}`);
      if (matches.length === 80) return display(matches.join('\n'));
    }
  }
  return display(matches.join('\n'));
}
