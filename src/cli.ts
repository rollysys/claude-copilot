#!/usr/bin/env node
/**
 * claude-copilot — local Anthropic-compatible proxy that lets Claude Code
 * talk to Claude models through a GitHub Copilot Business subscription.
 *
 * Usage:
 *   claude-copilot serve [--port 4141] [--host 127.0.0.1] [--log]
 *   claude-copilot env   [--port 4141]   # print export commands
 *   claude-copilot status                # show login + endpoint info
 *   claude-copilot test                  # one-shot upstream smoke test
 */

import {
  COPILOT_API_VERSION,
  COPILOT_INTEGRATION_ID,
  COPILOT_USER_AGENT,
  CopilotAuthError,
  fetchCopilotUser,
  readCopilotToken,
} from './auth.js';

const COPILOT_MESSAGES_ENDPOINT = '/v1/messages';
import { type CliOptions, parseArgs } from './parse-args.js';
import { startProxy } from './server.js';

function printHelp(): void {
  process.stdout.write(`claude-copilot — local Anthropic-compatible proxy backed by GitHub Copilot

Usage:
  claude-copilot [serve] [--port 4141] [--host 127.0.0.1] [--log]
  claude-copilot env [--port 4141]
  claude-copilot status
  claude-copilot test

Commands:
  serve   Start the local proxy (default).
  env     Print shell export commands to point Claude Code at the proxy.
  status  Show login info, plan, and upstream endpoint.
  test    Send one Anthropic-format request through to the upstream and print the response.

Flags:
  -p, --port <n>     Port to listen on (default 4141)
      --host <ip>    Bind address (default 127.0.0.1)
      --log          Log every forwarded request to stderr
  -h, --help         Show this help

Typical use:
  $ claude-copilot serve --port 4141 --log &
  $ eval "$(claude-copilot env --port 4141)"
  $ claude     # Claude Code now uses your Copilot subscription

Environment:
  GH_COPILOT_TOKEN          Override token from keychain
  COPILOT_INTEGRATION_ID    Override Copilot integration id
  HTTPS_PROXY               Forward upstream fetch through a proxy
`);
}

async function main(): Promise<void> {
  const { options, errors } = parseArgs(process.argv.slice(2));

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(2);
  }

  switch (options.command) {
    case 'help':   return printHelp();
    case 'serve':  return runServe(options);
    case 'env':    return runEnv(options);
    case 'status': return runStatus();
    case 'test':   return runTest();
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
      `Use it with Claude Code:\n` +
      `  eval "$(claude-copilot env --port ${handle.port})"\n` +
      `  claude\n` +
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

function runEnv(options: CliOptions): void {
  const base = `http://${options.host}:${options.port}`;
  process.stdout.write(
    [
      `export ANTHROPIC_BASE_URL=${base}`,
      `export ANTHROPIC_API_KEY=ignored-by-claude-copilot`,
      `export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4.6`,
      `export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4.6`,
      `export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4.5`,
      `# Run \`unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_DEFAULT_OPUS_MODEL ANTHROPIC_DEFAULT_SONNET_MODEL ANTHROPIC_DEFAULT_HAIKU_MODEL\` to revert.`,
    ].join('\n') + '\n'
  );
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
