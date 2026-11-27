import { readFileSync } from 'node:fs';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import type { McpServer } from '@modelcontextprotocol/server';

export const appUri = 'ui://zgent/tasks.html';
const script = readFileSync(new URL('../../../console/dist/mcp-app.js', import.meta.url), 'utf8').replace(/<\/script/gi, '<\\/script');

export function registerTaskApp(server: McpServer, origin: string) {
  const body = `<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:14px system-ui;color:inherit;margin:1rem}h2{margin:0}ul{padding:0;list-style:none}li{padding:.65rem 0;border-top:1px solid #a2a9a555}small{display:block;margin:.25rem 0;opacity:.8}button{margin-right:.4rem;margin-top:.2rem;padding:.25rem .5rem}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
<main data-console-origin="${origin}"><h2>Zgent 任务</h2></main><script>${script}</script></html>`;
  registerAppResource(server, 'Zgent tasks', appUri, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: appUri, mimeType: RESOURCE_MIME_TYPE, text: body }],
  }));
}
