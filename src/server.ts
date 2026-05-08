/**
 * Local HTTP proxy that exposes an Anthropic-compatible `/v1/messages`
 * endpoint and forwards requests to the GitHub Copilot Chat API.
 *
 * Designed to be the `ANTHROPIC_BASE_URL` for Claude Code:
 *
 *   $ claude-copilot serve --port 4141
 *   $ ANTHROPIC_BASE_URL=http://127.0.0.1:4141 ANTHROPIC_API_KEY=ignored claude
 *
 * The upstream's `/v1/messages` returns native Anthropic-format responses
 * (incl. streaming SSE), so this proxy just rewrites authentication headers
 * and pipes the body through.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import {
  COPILOT_API_VERSION,
  COPILOT_INTEGRATION_ID,
  COPILOT_USER_AGENT,
  CopilotAuthError,
  fetchCopilotUser,
  readCopilotToken,
  type CopilotUser,
} from './auth.js';
import { mapModelToCopilot } from './model-map.js';

export interface ServeOptions {
  host?: string;
  port?: number;
  log?: boolean;
  /** Override upstream base URL (used for tests). */
  upstreamBaseUrl?: string;
  /** Override token reader (used for tests). */
  token?: string;
  /** Override user info (used for tests). */
  user?: CopilotUser;
}

export interface ProxyHandle {
  server: Server;
  port: number;
  host: string;
  user: CopilotUser;
  upstreamBaseUrl: string;
  stop(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding', // fetch already decoded
  'content-length',   // recomputed by Node
]);

export async function startProxy(opts: ServeOptions = {}): Promise<ProxyHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4141;

  const token = opts.token ?? readCopilotToken();
  const user = opts.user ?? (await fetchCopilotUser(token));
  const upstreamBaseUrl = opts.upstreamBaseUrl ?? user.endpoints.api;
  const log = opts.log ?? false;

  const server = createServer((req, res) => {
    handle(req, res, token, upstreamBaseUrl, log).catch(err => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    port: actualPort,
    host,
    user,
    upstreamBaseUrl,
    stop: () => new Promise<void>(r => server.close(() => r())),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  upstreamBaseUrl: string,
  log: boolean
): Promise<void> {
  const url = req.url || '/';
  const method = req.method || 'GET';
  const path = url.split('?')[0];

  if (method === 'GET' && path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, upstream: upstreamBaseUrl }));
    return;
  }

  if (method === 'POST' && path === '/v1/messages') {
    await forwardMessages(req, res, token, upstreamBaseUrl, log);
    return;
  }

  // For anything else, mimic Anthropic's 404 shape.
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: {
      type: 'not_found_error',
      message: `Unknown endpoint: ${method} ${url}`,
    },
  }));
}

async function forwardMessages(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  upstreamBaseUrl: string,
  log: boolean
): Promise<void> {
  const rawBody = await readBody(req);
  const { body, originalModel, mappedModel, stream } = rewriteRequestBody(rawBody);

  const upstreamRes = await fetch(`${upstreamBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: buildUpstreamHeaders(req, token),
    body: new Uint8Array(body),
    // Pass through abort if the client disconnects.
    signal: abortSignalFor(req),
  });

  // Build response headers, dropping hop-by-hop ones.
  const outHeaders: Record<string, string> = {};
  upstreamRes.headers.forEach((v, k) => {
    if (HOP_BY_HOP.has(k.toLowerCase())) return;
    outHeaders[k] = v;
  });

  // For error responses, buffer the body so we can both forward and log it.
  let errorBodyForLog: string | undefined;
  if (upstreamRes.status >= 400) {
    const text = await upstreamRes.text().catch(() => '');
    errorBodyForLog = text;
    res.writeHead(upstreamRes.status, outHeaders);
    res.end(text);
  } else {
    res.writeHead(upstreamRes.status, outHeaders);
    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise<void>(r => res.once('drain', r));
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    }
    res.end();
  }

  if (log) {
    const modelInfo = originalModel === mappedModel
      ? (mappedModel ?? '?')
      : `${originalModel} -> ${mappedModel}`;
    process.stderr.write(
      `[${new Date().toISOString()}] POST /v1/messages model=${modelInfo} stream=${stream} -> ${upstreamRes.status}\n`
    );
    if (upstreamRes.status >= 400 && errorBodyForLog) {
      process.stderr.write(`  upstream error: ${errorBodyForLog.slice(0, 300)}\n`);
    }
  }
}

interface RewrittenBody {
  body: Buffer;
  originalModel?: string;
  mappedModel?: string;
  stream: boolean;
}

/** Effort levels Copilot accepts on Anthropic models (others get clamped). */
const SUPPORTED_EFFORT = new Set(['medium']);

export function rewriteAnthropicBody(parsed: Record<string, unknown>): {
  body: Record<string, unknown>;
  changed: boolean;
} {
  let changed = false;
  const out: Record<string, unknown> = { ...parsed };

  if (typeof out.model === 'string') {
    const mapped = mapModelToCopilot(out.model);
    if (mapped !== out.model) {
      out.model = mapped;
      changed = true;
    }
  }

  // Clamp `output_config.effort` to a supported value (Copilot only takes "medium" today).
  const oc = out.output_config;
  if (oc && typeof oc === 'object' && !Array.isArray(oc)) {
    const ocObj = oc as Record<string, unknown>;
    if (typeof ocObj.effort === 'string' && !SUPPORTED_EFFORT.has(ocObj.effort)) {
      out.output_config = { ...ocObj, effort: 'medium' };
      changed = true;
    }
  }

  return { body: out, changed };
}

function rewriteRequestBody(raw: Buffer): RewrittenBody {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { body: raw, stream: false };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { body: raw, stream: false };
  }

  const stream = parsed.stream === true;
  const originalModel = typeof parsed.model === 'string' ? parsed.model : undefined;
  const { body: rewritten, changed } = rewriteAnthropicBody(parsed);
  const mappedModel = typeof rewritten.model === 'string' ? rewritten.model : originalModel;

  return {
    body: changed ? Buffer.from(JSON.stringify(rewritten), 'utf8') : raw,
    originalModel,
    mappedModel,
    stream,
  };
}

/**
 * `anthropic-beta` tokens that the Copilot upstream rejects with HTTP 400.
 * Anything in this set is silently dropped from the forwarded header.
 *
 * Add to it via the `COPILOT_DROP_BETAS` env var (comma-separated).
 */
const HARDCODED_DROP_BETAS = new Set([
  'advisor-tool-2026-03-01',
]);

function buildDropBetas(): Set<string> {
  const out = new Set(HARDCODED_DROP_BETAS);
  const extra = process.env.COPILOT_DROP_BETAS;
  if (extra) {
    for (const s of extra.split(',')) {
      const t = s.trim();
      if (t) out.add(t);
    }
  }
  return out;
}

const DROP_BETAS = buildDropBetas();

export function filterAnthropicBeta(value: string, drop: Set<string> = DROP_BETAS): string | undefined {
  const kept = value
    .split(',')
    .map(s => s.trim())
    .filter(s => s && !drop.has(s));
  return kept.length > 0 ? kept.join(',') : undefined;
}

function buildUpstreamHeaders(req: IncomingMessage, token: string): Record<string, string> {
  const anthropicVersion = (req.headers['anthropic-version'] as string) || '2023-06-01';
  const anthropicBeta = req.headers['anthropic-beta'] as string | undefined;
  const accept = (req.headers['accept'] as string) || 'application/json';

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': accept,
    'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
    'X-GitHub-Api-Version': COPILOT_API_VERSION,
    'anthropic-version': anthropicVersion,
    'User-Agent': COPILOT_USER_AGENT,
  };
  if (anthropicBeta) {
    const filtered = filterAnthropicBeta(anthropicBeta);
    if (filtered) headers['anthropic-beta'] = filtered;
  }

  return headers;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function abortSignalFor(req: IncomingMessage): AbortSignal {
  const ac = new AbortController();
  req.on('close', () => {
    if (req.destroyed && !req.complete) ac.abort();
  });
  return ac.signal;
}

export { CopilotAuthError };
