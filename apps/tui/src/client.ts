import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { defaultState, jsonResponse, ownerRequest, ownerSocket } from '../../daemon/src/os/local.ts';

export class Local {
  state = resolve(process.env.ZGENT_STATE_HOME ?? defaultState());

  get socket() { return ownerSocket(this.state); }

  async api<T = unknown>(path: string, body?: unknown) {
    const response = await ownerRequest(this.socket, path, body, AbortSignal.timeout(60_000));
    const result = await jsonResponse<T & {detail?: string}>(response);
    if (response.statusCode! >= 400) throw new Error(result.detail ?? `请求失败 (${response.statusCode})`);
    return result as T;
  }

  async running() {
    try {
      const response = await ownerRequest(this.socket, '/healthz', undefined, AbortSignal.timeout(500));
      response.resume();
      return response.statusCode === 200;
    }
    catch { return false; }
  }

  async start() {
    mkdirSync(this.state, { recursive: true, mode: 0o700 });
    this.state = realpathSync(this.state);
    const info = statSync(this.state);
    if (info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Zgent 状态目录须由当前用户拥有，权限为 0700。');
    if (await this.running()) return;
    const logPath = join(this.state, 'daemon.log');
    const log = openSync(logPath, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [fileURLToPath(new URL('../../daemon/src/launch.ts', import.meta.url)), this.state],
        { detached: true, stdio: ['ignore', log, log] });
      child.unref();
    } finally { closeSync(log); }
    child.on('error', () => {});
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await this.running()) return;
      if (child.exitCode !== null && child.exitCode !== 0) break;
      await delay(125);
    }
    throw new Error('Daemon 未启动。查看 ' + logPath);
  }

  async stream(path: string, signal: AbortSignal, receive: (value: unknown) => void) {
    const response = await ownerRequest(this.socket, path, undefined, signal);
    if (response.statusCode !== 200) throw new Error(`事件流不可用 (${response.statusCode})`);
    let buffer = '';
    for await (const chunk of response.setEncoding('utf8')) {
      buffer += chunk;
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const message = buffer.slice(0, boundary).split('\n').find(line => line.startsWith('data: '));
        buffer = buffer.slice(boundary + 2);
        if (message) receive(JSON.parse(message.slice(6)));
      }
    }
  }
}
