import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { request, type IncomingMessage } from 'node:http';

export function defaultState() {
  const xdg = process.env.XDG_STATE_HOME;
  return process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'zgent')
    : join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state'), 'zgent');
}

export function ownerSocket(state: string) {
  const path = join(state, 'owner.sock');
  const limit = process.platform === 'darwin' ? 104 : 108;
  if (Buffer.byteLength(path) >= limit) throw new Error('The Zgent state path is too long for owner.sock. Choose a shorter state directory.');
  return path;
}

export function ownerRequest(socketPath: string, path: string, body?: unknown, signal?: AbortSignal) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request({ socketPath, path, signal, method: data === undefined ? 'GET' : 'POST',
      ...(data === undefined ? {} : { headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }) }, resolve);
    req.once('error', reject);
    req.end(data);
  });
}

export async function jsonResponse<T>(response: IncomingMessage) {
  let text = '';
  for await (const chunk of response.setEncoding('utf8')) text += chunk;
  return JSON.parse(text) as T;
}
