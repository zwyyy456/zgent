export async function readEvents(path: string, signal: AbortSignal, onEvent: (value: unknown) => void) {
  const response = await fetch(path, { signal, cache: 'no-store', headers: { accept: 'text/event-stream' } });
  if (!response.ok || !response.body) return response.status;
  let buffer = '';
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return response.status;
      buffer += chunk.value;
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const lines = buffer.slice(0, end).split('\n');
        buffer = buffer.slice(end + 2);
        const data = lines.filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
        if (data) onEvent(JSON.parse(data));
      }
    }
  } finally {
    reader.releaseLock();
  }
}
