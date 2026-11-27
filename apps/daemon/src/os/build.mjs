import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const system = { darwin: 'macos', linux: 'linux' }[process.platform];
if (!system) throw new Error('Supported platforms are macOS and Linux.');
mkdirSync('dist', { recursive: true });
execFileSync(process.env.CC ?? (system === 'macos' ? 'clang' : 'cc'),
  ['-Wall', '-Wextra', '-Werror', '-O2', 'src/os/process.c', 'src/os/' + system + '.c', '-o', 'dist/process'],
  { stdio: 'inherit' });
