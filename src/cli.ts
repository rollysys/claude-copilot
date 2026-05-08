#!/usr/bin/env node
/**
 * claude-copilot — local Anthropic-compatible proxy that lets Claude Code
 * talk to Claude models through a GitHub Copilot Business subscription.
 *
 * Usage:
 *   claude-copilot run [-- claude-args...]   # one-command, auto-managed proxy
 *   claude-copilot serve [--port N] [--log]  # long-running proxy
 *   claude-copilot env   [--port N]          # print shell exports
 *   claude-copilot settings [--port N]       # print Claude settings.json snippet
 *   claude-copilot status                    # show login + endpoint info
 *   claude-copilot test                      # one-shot upstream smoke test
 */

import { spawn } from 'node:child_process';
import {
  COPILOT_API_VERSION,
  COPILOT_INTEGRATION_ID,
  COPILOT_USER_AGENT,
  CopilotAuthError,
  fetchCopilotUser,
  readCopilotToken,
} from './auth.js';
import { type CliOptions, parseArgs } from './parse-args.js';
import { startProxy } from './server.js';

const COPILOT_MESSAGES_ENDPOINT = '/v1/messages';
const CLAUDE_BIN = process.env.CLAUDE_COPILOT_CLAUDE_PATH || 'claude';

function buildClaudeEnv(baseUrl: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: 'ignored-by-claude-copilot',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4.6',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4.6',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4.5',
  };
}

function printHelp(): void {
  process.stdout.write(`claude-copilot — local Anthropic-compatible proxy backed by GitHub Copilot

Usage:
  claude-copilot [claude args...]              # default: spawn claude with proxy auto-attached
  claude-copilot run [--log|--port N] [-- claude args...]
  claude-copilot serve [--port N] [--log]      # long-running proxy daemon
  claude-copilot env [--port N]                # shell-export snippet for ANTHROPIC_*
  claude-copilot settings [--port N]           # JSON snippet for ~/.claude/settings.json
  claude-copilot status                        # login info + plan + endpoint
  claude-copilot test                          # one-shot upstream smoke test

claude-copilot's own flags:
  -p, --port <n>     Port to listen on (default 4141; \`run\` uses an ephemeral port unless set)
      --host <ip>    Bind address (default 127.0.0.1)
      --log          Log every forwarded request to stderr
  -h, --help         Show this help

Daily use — no env pollution, no orphan processes:

  claude-copilot                               # interactive Claude Code
  claude-copilot --print "Hello"               # any claude flag passes straight through
  claude-copilot --model opus -p "..."

To set claude-copilot's own flags (e.g. --log), use the explicit \`run\`:

  claude-copilot run --log -- --print "Hello"
  claude-copilot run --port 4242 -- --model opus

Long-running daemon (advanced):

  claude-copilot serve --port 4242 --log &
  eval "\$(claude-copilot env --port 4242)"
  claude

Project-scoped settings.json (no shell pollution):

  mkdir -p .claude
  claude-copilot settings --port 4242 > .claude/settings.local.json
  claude-copilot serve --port 4242 &
  claude            # picks up settings.local.json automatically

Environment:
  CLAUDE_COPILOT_CLAUDE_PATH   Path to the \`claude\` binary (default: \`claude\` on PATH)
  GH_COPILOT_TOKEN             Override token from keychain
  COPILOT_INTEGRATION_ID       Override Copilot integration id
  COPILOT_DROP_BETAS           Extra anthropic-beta tokens to silently drop (comma-separated)
  HTTPS_PROXY                  Forward upstream fetch through a proxy
`);
}

async function main(): Promise<void> {
  const { options, errors } = parseArgs(process.argv.slice(2));

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(2);
  }

  switch (options.command) {
    case 'help':     return printHelp();
    case 'serve':    return runServe(options);
    case 'run':      return runRun(options);
    case 'env':      return runEnv(options);
    case 'settings': return runSettings(options);
    case 'status':   return runStatus();
    case 'test':     return runTest();
  }
}

async function runServe(options: CliOptions): Promise<void> {
  const handle = await startProxy({
    host: options.host,
    port: options.port,
    log: options.log,
  });

  process.stderr.write(
    `claude-copilot proxy listening on http://${handle.host}:${handle.port}\n` +
      `User:     ${handle.user.login} (${handle.user.copilot_plan})\n` +
      `Upstream: ${handle.upstreamBaseUrl}\n` +
      `\n` +
      `For one-shot use without setting any env vars, prefer:\n` +
      `  claude-copilot --print "Hello"\n` +
      `\n` +
      `Otherwise wire Claude Code to this proxy with one of:\n` +
      `  eval "$(claude-copilot env --port ${handle.port})"\n` +
      `  claude-copilot settings --port ${handle.port} > .claude/settings.local.json\n` +
      `\n` +
      `Press Ctrl-C to stop.\n`
  );

  const shutdown = async (sig: NodeJS.Signals) => {
    process.stderr.write(`\nReceived ${sig}, shutting down...\n`);
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runRun(options: CliOptions): Promise<void> {
  // Always pick a free port unless the user explicitly asked for one.
  const handle = await startProxy({
    host: options.host,
    port: options.port === 4141 ? 0 : options.port,  // default → ephemeral
    log: options.log,
  });

  const baseUrl = `http://${handle.host}:${handle.port}`;
  if (options.log) {
    process.stderr.write(`claude-copilot proxy: ${baseUrl} (user=${handle.user.login}, plan=${handle.user.copilot_plan})\n`);
  }

  const child = spawn(CLAUDE_BIN, options.passthroughArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...buildClaudeEnv(baseUrl) },
  });

  // Forward signals other than SIGINT (which the TTY already broadcasts).
  const forward = (sig: NodeJS.Signals) => () => { try { child.kill(sig); } catch { /* ignore */ } };
  process.on('SIGTERM', forward('SIGTERM'));
  process.on('SIGHUP', forward('SIGHUP'));
  // Suppress SIGINT in the parent: the TTY already delivers it to the child,
  // and we want to wait for child cleanup before exiting.
  process.on('SIGINT', () => { /* noop; let child handle */ });

  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', err => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        process.stderr.write(`error: \`${CLAUDE_BIN}\` not found on PATH. Install Claude Code or set CLAUDE_COPILOT_CLAUDE_PATH.\n`);
        resolve({ code: 127, signal: null });
      } else {
        process.stderr.write(`error spawning ${CLAUDE_BIN}: ${err.message}\n`);
        resolve({ code: 1, signal: null });
      }
    });
  });

  await handle.stop();

  if (exitInfo.signal) {
    // Convention: 128 + signal number; we don't have a clean way to look the
    // number up, so just exit non-zero.
    process.exit(1);
  }
  process.exit(exitInfo.code ?? 0);
}

function runEnv(options: CliOptions): void {
  const base = `http://${options.host}:${options.port}`;
  const env = buildClaudeEnv(base);
  const lines = Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`);
  lines.push(`# Run \`unset ${Object.keys(env).join(' ')}\` to revert.`);
  process.stdout.write(lines.join('\n') + '\n');
}

function runSettings(options: CliOptions): void {
  const base = `http://${options.host}:${options.port}`;
  const env = buildClaudeEnv(base);
  const settings = {
    env,
  };
  process.stdout.write(JSON.stringify(settings, null, 2) + '\n');
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runStatus(): Promise<void> {
  const token = readCopilotToken();
  const user = await fetchCopilotUser(token);
  console.log('User:           ', user.login);
  console.log('Plan:           ', user.copilot_plan);
  console.log('Upstream API:   ', user.endpoints.api);
  console.log('Quota reset:    ', user.quota_reset_date);
  const u = user.quota_snapshots;
  const fmt = (q: typeof u.chat) =>
    q.unlimited ? 'unlimited' : `${q.remaining}/${q.entitlement}`;
  console.log('Chat quota:     ', fmt(u.chat));
  console.log('Premium quota:  ', fmt(u.premium_interactions));
  console.log('Integration ID: ', COPILOT_INTEGRATION_ID);
}

async function runTest(): Promise<void> {
  const token = readCopilotToken();
  const user = await fetchCopilotUser(token);
  console.log(`Sending direct upstream test to ${user.endpoints.api}${COPILOT_MESSAGES_ENDPOINT} ...`);

  const response = await fetch(`${user.endpoints.api}${COPILOT_MESSAGES_ENDPOINT}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
      'X-GitHub-Api-Version': COPILOT_API_VERSION,
      'anthropic-version': '2023-06-01',
      'User-Agent': COPILOT_USER_AGENT,
    },
    body: JSON.stringify({
      model: 'claude-opus-4.6',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'Reply with only the word PONG.' }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.error(`Upstream returned HTTP ${response.status}\n${text}`);
    process.exit(1);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens: number; output_tokens: number };
  };
  const text = data.content?.find(c => c.type === 'text')?.text ?? '(no text)';
  console.log(`Response: ${text}`);
  if (data.usage) {
    console.log(`Tokens:   in=${data.usage.input_tokens} out=${data.usage.output_tokens}`);
  }
}

main().catch(e => {
  if (e instanceof CopilotAuthError) {
    console.error(e.message);
    process.exit(2);
  }
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
