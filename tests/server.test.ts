import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { filterAnthropicBeta, startProxy, type ProxyHandle } from '../src/server.js';
import type { CopilotUser } from '../src/auth.js';

interface UpstreamCapture {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let upstreamServer: Server;
let upstreamPort = 0;
let lastCaptured: UpstreamCapture | undefined;

const fakeUser: CopilotUser = {
  login: 'test-user',
  copilot_plan: 'test-plan',
  quota_reset_date: '2099-01-01',
  quota_snapshots: {
    chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
    completions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
    premium_interactions: { entitlement: 100, remaining: 50, percent_remaining: 50, unlimited: false },
  },
  endpoints: { api: '' /* set after upstream boots */ },
};

beforeAll(async () => {
  upstreamServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      lastCaptured = {
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      if (req.url === '/v1/messages' && req.method === 'POST') {
        const body = lastCaptured.body;
        let payload: any;
        try { payload = JSON.parse(body); } catch { payload = {}; }
        if (payload.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
          res.write('event: content_block_delta\ndata: {"delta":{"text":"hello"}}\n\n');
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'msg_test',
            content: [{ type: 'text', text: 'hello' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }));
      }
    });
  });
  await new Promise<void>(r => upstreamServer.listen(0, '127.0.0.1', () => r()));
  const addr = upstreamServer.address();
  upstreamPort = typeof addr === 'object' && addr ? addr.port : 0;
  fakeUser.endpoints.api = `http://127.0.0.1:${upstreamPort}`;
});

afterAll(async () => {
  await new Promise<void>(r => upstreamServer.close(() => r()));
});

async function withProxy<T>(opts: { log?: boolean }, fn: (h: ProxyHandle) => Promise<T>): Promise<T> {
  const handle = await startProxy({
    host: '127.0.0.1',
    port: 0, // pick free port
    token: 'gho_TESTTOKEN',
    user: fakeUser,
    upstreamBaseUrl: fakeUser.endpoints.api,
    log: opts.log,
  });
  try {
    return await fn(handle);
  } finally {
    await handle.stop();
  }
}

describe('proxy server', () => {
  it('GET /health returns ok', async () => {
    await withProxy({}, async (h) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/health`);
      expect(r.status).toBe(200);
      const j = await r.json() as { ok: boolean };
      expect(j.ok).toBe(true);
    });
  });

  it('forwards POST /v1/messages and rewrites auth headers', async () => {
    await withProxy({}, async (h) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'sk-ant-anything',  // Anthropic SDK style — should be ignored
          'authorization': 'Bearer client-side-key', // overwritten by proxy
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'claude-opus-4.6', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(r.status).toBe(200);
      const data = await r.json() as { content: Array<{ text: string }> };
      expect(data.content[0].text).toBe('hello');

      // Verify upstream got the right auth
      expect(lastCaptured?.headers['authorization']).toBe('Bearer gho_TESTTOKEN');
      expect(lastCaptured?.headers['copilot-integration-id']).toBe('copilot-developer-cli');
      expect(lastCaptured?.headers['anthropic-version']).toBe('2023-06-01');
      // Body must pass through verbatim
      const sentBody = JSON.parse(lastCaptured!.body);
      expect(sentBody.model).toBe('claude-opus-4.6');
    });
  });

  it('passes through SSE streaming responses', async () => {
    await withProxy({}, async (h) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4.6',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/event-stream/);

      const text = await r.text();
      expect(text).toContain('event: message_start');
      expect(text).toContain('event: message_stop');
      expect(text).toContain('data: [DONE]');
    });
  });

  it('returns Anthropic-style 404 for unknown paths', async () => {
    await withProxy({}, async (h) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/v1/unknown`);
      expect(r.status).toBe(404);
      const j = await r.json() as { type: string; error: { type: string } };
      expect(j.type).toBe('error');
      expect(j.error.type).toBe('not_found_error');
    });
  });

  it('forwards anthropic-beta header when present', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': 'computer-use-2024-10-22',
        },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      expect(lastCaptured?.headers['anthropic-beta']).toBe('computer-use-2024-10-22');
    });
  });

  it('matches /v1/messages even with query string', async () => {
    await withProxy({}, async (h) => {
      const r = await fetch(`http://127.0.0.1:${h.port}/v1/messages?beta=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-4-7', messages: [] }),
      });
      expect(r.status).toBe(200);
    });
  });

  it('rewrites Claude Code dash-style model id to Copilot dot-style', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      const sentBody = JSON.parse(lastCaptured!.body);
      expect(sentBody.model).toBe('claude-opus-4.7');
    });
  });

  it('strips output_config.effort entirely on haiku models', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [],
          output_config: { effort: 'high' },
        }),
      });
      const sent = JSON.parse(lastCaptured!.body);
      expect(sent.model).toBe('claude-haiku-4.5');
      expect(sent.output_config).toBeUndefined();
    });
  });

  it('preserves other output_config keys when stripping effort on haiku', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          messages: [],
          output_config: { effort: 'high', other: 'preserve-me' },
        }),
      });
      const sent = JSON.parse(lastCaptured!.body);
      expect(sent.output_config.effort).toBeUndefined();
      expect(sent.output_config.other).toBe('preserve-me');
    });
  });

  it('clamps output_config.effort to medium', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          messages: [],
          output_config: { effort: 'xhigh', other_field: true },
        }),
      });
      const sent = JSON.parse(lastCaptured!.body);
      expect(sent.output_config.effort).toBe('medium');
      expect(sent.output_config.other_field).toBe(true);
    });
  });

  it('leaves output_config alone when effort is supported', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4.1',
          messages: [],
          output_config: { effort: 'medium' },
        }),
      });
      const sent = JSON.parse(lastCaptured!.body);
      expect(sent.output_config.effort).toBe('medium');
    });
  });

  it('auto-retries with offending beta token stripped on 400', async () => {
    // Use a separate upstream that fails on first call with a learnable error
    // and succeeds on second call.
    let calls = 0;
    const adaptive = createServer((req, res) => {
      calls += 1;
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const beta = req.headers['anthropic-beta'] as string | undefined;
        if (calls === 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'unsupported beta header(s): unknown-future-beta-2026-12-01',
              code: 'invalid_request_body',
            },
          }));
        } else {
          // Verify retry stripped the bad token
          expect(beta).not.toMatch(/unknown-future-beta-2026-12-01/);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: 'msg_x', content: [{ type: 'text', text: 'ok' }] }));
        }
      });
    });
    await new Promise<void>(r => adaptive.listen(0, '127.0.0.1', () => r()));
    const port = (adaptive.address() as { port: number }).port;
    const upstream = `http://127.0.0.1:${port}`;

    try {
      const handle = await startProxy({
        host: '127.0.0.1',
        port: 0,
        token: 'gho_TEST',
        user: { ...fakeUser, endpoints: { api: upstream } },
        upstreamBaseUrl: upstream,
      });
      const r = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': 'good-beta,unknown-future-beta-2026-12-01',
        },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      expect(r.status).toBe(200);
      expect(calls).toBe(2);
      await handle.stop();
    } finally {
      await new Promise<void>(r => adaptive.close(() => r()));
    }
  });

  it('does not loop-retry on non-beta 400 errors', async () => {
    let calls = 0;
    const stub = createServer((req, res) => {
      calls += 1;
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid_model', code: 'model_not_supported' } }));
      });
    });
    await new Promise<void>(r => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as { port: number }).port;
    const upstream = `http://127.0.0.1:${port}`;

    try {
      const handle = await startProxy({
        host: '127.0.0.1', port: 0,
        token: 'gho_TEST',
        user: { ...fakeUser, endpoints: { api: upstream } },
        upstreamBaseUrl: upstream,
      });
      const r = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      expect(r.status).toBe(400);
      expect(calls).toBe(1); // exactly one — no retry
      await handle.stop();
    } finally {
      await new Promise<void>(r => stub.close(() => r()));
    }
  });

  it('drops known-incompatible anthropic-beta tokens', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': 'claude-code-20250219,advisor-tool-2026-03-01,effort-2025-11-24',
        },
        body: JSON.stringify({ model: 'claude-opus-4-7', messages: [] }),
      });
      const sent = lastCaptured?.headers['anthropic-beta'] as string;
      expect(sent).toBe('claude-code-20250219,effort-2025-11-24');
    });
  });

  it('omits anthropic-beta header entirely when only drop-listed tokens were sent', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': 'advisor-tool-2026-03-01',
        },
        body: JSON.stringify({ model: 'x', messages: [] }),
      });
      expect(lastCaptured?.headers['anthropic-beta']).toBeUndefined();
    });
  });

  it('leaves non-Claude model ids untouched', async () => {
    await withProxy({}, async (h) => {
      await fetch(`http://127.0.0.1:${h.port}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4.1', messages: [] }),
      });
      const sentBody = JSON.parse(lastCaptured!.body);
      expect(sentBody.model).toBe('gpt-4.1');
    });
  });
});
