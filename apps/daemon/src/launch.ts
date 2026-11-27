import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helper } from './os/process.ts';
import { defaultState } from './os/local.ts';

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  console.error('Zgent runs on macOS and Linux.');
  process.exit(1);
}
process.umask(0o077);
const requested = resolve(process.argv[2] ?? process.env.ZGENT_STATE_HOME ?? defaultState());
mkdirSync(requested, { recursive: true, mode: 0o700 });
const state = realpathSync(requested);
const info = statSync(state);
if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
  console.error(`The daemon directory ${JSON.stringify(state)} must be owned by the current user and have mode 0700.`);
  process.exit(1);
}
const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
const child = spawn(helper, ['lock', join(state, 'daemon.lock'), process.execPath, entry, state], { stdio: 'inherit' });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', () => {
  console.error('The platform helper is unavailable. Run pnpm build first.');
  process.exitCode = 1;
});
child.once('exit', async (code, signal) => {
  if (code === 73) {
    try {
      const { port = 43127 } = JSON.parse(readFileSync(join(state, 'config.private.json'), 'utf8'));
      const url = 'http://127.0.0.1:' + port;
      const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(2500) });
      if (!response.ok) throw new Error();
      console.log('Existing daemon: ' + url + '/console');
    } catch {
      console.error('Another daemon owns this state directory and has not answered its health endpoint.');
      process.exitCode = 1;
    }
  } else process.exitCode = code ?? (signal ? 1 : 0);
});
