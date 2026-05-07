import { describe, it, expect } from 'vitest';
import { parseChatCompletionStream } from '../src/sse.js';

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('parseChatCompletionStream', () => {
  it('extracts delta.content from SSE events', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":", "}}]}\n',
      'data: {"choices":[{"delta":{"content":"world!"}}]}\n',
      'data: [DONE]\n',
    ];
    const out = await collect(parseChatCompletionStream(streamFrom(chunks)));
    expect(out).toEqual(['Hello', ', ', 'world!']);
  });

  it('handles split chunks across line boundaries', async () => {
    // Split a single SSE event across two TCP chunks
    const chunks = [
      'data: {"choices":[{"delta":{"con',
      'tent":"foo"}}]}\ndata: [DONE]\n',
    ];
    const out = await collect(parseChatCompletionStream(streamFrom(chunks)));
    expect(out).toEqual(['foo']);
  });

  it('skips non-data lines', async () => {
    const chunks = [
      ': comment\n',
      'event: ping\n',
      'data: {"choices":[{"delta":{"content":"x"}}]}\n',
      'data: [DONE]\n',
    ];
    const out = await collect(parseChatCompletionStream(streamFrom(chunks)));
    expect(out).toEqual(['x']);
  });

  it('skips empty content', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{}}]}\n',
      'data: {"choices":[{"delta":{"content":""}}]}\n',
      'data: {"choices":[{"delta":{"content":"a"}}]}\n',
      'data: [DONE]\n',
    ];
    const out = await collect(parseChatCompletionStream(streamFrom(chunks)));
    expect(out).toEqual(['a']);
  });

  it('ignores malformed JSON', async () => {
    const chunks = [
      'data: {not-json\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
      'data: [DONE]\n',
    ];
    const out = await collect(parseChatCompletionStream(streamFrom(chunks)));
    expect(out).toEqual(['ok']);
  });

  it('terminates on [DONE] without reading further', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n',
      'data: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"after-done"}}]}\n',
    ];
    const out = await collect(parseChatCompletionStream(streamFrom(chunks)));
    expect(out).toEqual(['a']);
  });
});
