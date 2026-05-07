/**
 * Minimal SSE parser for OpenAI-style streaming chat completions.
 * Returns chunks of `delta.content` from the stream.
 */

export async function* parseChatCompletionStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nlIdx: number;
    while ((nlIdx = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, nlIdx).trimEnd();
      buffer = buffer.slice(nlIdx + 1);

      if (!rawLine.startsWith('data:')) continue;
      const payload = rawLine.slice(5).trim();
      if (payload === '[DONE]') return;
      if (!payload) continue;

      try {
        const json = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: unknown } }>;
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) yield delta;
      } catch {
        // ignore malformed chunk
      }
    }
  }
}
