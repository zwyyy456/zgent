import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const denied = ['read_file(*)', 'write_file(*)', 'command(*)', 'unsandboxed(*)',
  'read_url(*)', 'execute_url(*)', 'download_url(*)'];
const allowed = 'mcp(zgent/*)';

export function coordinatorSettings(home: string) {
  const file = join(home, '.gemini', 'antigravity-cli', 'settings.json');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ agentMode: 'default', allowNonWorkspaceAccess: false, enableTerminalSandbox: true,
      toolPermission: 'request-review', permissions: { deny: denied, allow: [allowed] } }, null, 2), { flag: 'wx', mode: 0o600 });
  }
  const value = JSON.parse(readFileSync(file, 'utf8')) as { allowNonWorkspaceAccess?: boolean; permissions?: { allow?: string[]; deny?: string[] } };
  if (value.allowNonWorkspaceAccess === true || !Array.isArray(value.permissions?.deny) ||
      !denied.every(rule => value.permissions!.deny!.includes(rule)) ||
      value.permissions?.allow?.some(rule => rule !== allowed)) {
    throw new Error('The ACP coordinator home does not enforce the Zgent tool policy. Use its dedicated home.');
  }
}
