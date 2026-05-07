#!/usr/bin/env node
/**
 * claude-copilot — non-interactive helper for the GitHub Copilot CLI.
 *
 * Reads the OAuth token from the official `@github/copilot` CLI's keychain
 * entry, then exposes `-p / --bare` style one-shot prompts plus helper
 * subcommands (status / models / usage / test).
 *
 * Authentication is delegated to the official CLI — run `copilot login` /
 * `copilot logout` to manage credentials.
 */

import {
  CopilotAuthError,
  COPILOT_CHAT_ENDPOINT,
  fetchCopilotUser,
  getChatHeaders,
  listModels,
  readCopilotToken,
} from './auth.js';
import { CliOptions, parseArgs } from './parse-args.js';
import { parseChatCompletionStream } from './sse.js';

const DEFAULT_MODEL = process.env.COPILOT_DEFAULT_MODEL || 'gpt-4.1';

function printHelp() {
  process.stdout.write(`claude-copilot — non-interactive helper for GitHub Copilot

Usage:
  claude-copilot <command>
  claude-copilot [-p <prompt>] [--bare | --json] [--model <id>] [--no-stream]
  echo "..." | claude-copilot

Commands:
  status        Show login info, plan, API endpoint
  models        List available models
  usage         Show Copilot quota usage
  test          Verify the chat API end-to-end
  login/logout  Use the official CLI: \`copilot login\` / \`copilot logout\`

One-shot prompt:
  -p, --print <prompt>   Send a prompt (omit for stdin)
  --bare                 Output answer body only (good for pipes)
  --json                 Output the full response as JSON (implies --no-stream)
  -m, --model <id>       Model id (default: ${DEFAULT_MODEL})
  -s, --system <text>    System prompt
  --max-tokens <n>       max_tokens
  --no-stream            Disable streaming
  -h, --help             Show this help

Environment:
  GH_COPILOT_TOKEN          Override token from keychain
  COPILOT_INTEGRATION_ID    Override Copilot integration id
  COPILOT_DEFAULT_MODEL     Override default model id
  HTTPS_PROXY               Forward all fetch through proxy

Note:
  This tool uses unofficial Copilot endpoints (\`/copilot_internal/user\`,
  \`/chat/completions\`, \`/models\`). They may change without notice.
`);
}

async function main() {
  const { options, errors } = parseArgs(process.argv.slice(2), DEFAULT_MODEL);

  if (errors.length > 0 && !options.help) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  if (options.command) {
    switch (options.command) {
      case 'status': return showStatus(options);
      case 'models': return showModels(options);
      case 'usage':  return showUsage(options);
      case 'test':   return testApi(options);
      case 'login':
      case 'logout':
        console.log(`This tool does not manage authentication. Use the official CLI:`);
        console.log(`  copilot ${options.command}`);
        return;
    }
  }

  let prompt = options.prompt;
  if ((prompt === undefined || prompt === '') && !process.stdin.isTTY) {
    prompt = await readStdin();
  }

  if (prompt && prompt.trim().length > 0) {
    return runPrompt(prompt, options);
  }

  printHelp();
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function getAuth() {
  const token = readCopilotToken();
  const user = await fetchCopilotUser(token);
  return { token, user, baseUrl: user.endpoints.api };
}

function reportError(opts: CliOptions, err: unknown, exitCode: number): never {
  if (opts.bare) {
    process.exitCode = exitCode;
    process.exit(exitCode);
  }
  if (opts.json) {
    const payload = { error: err instanceof Error ? err.message : String(err) };
    process.stdout.write(JSON.stringify(payload) + '\n');
    process.exitCode = exitCode;
    process.exit(exitCode);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = exitCode;
  process.exit(exitCode);
}

async function runPrompt(prompt: string, options: CliOptions) {
  let auth: Awaited<ReturnType<typeof getAuth>>;
  try {
    auth = await getAuth();
  } catch (e) {
    reportError(options, e, 2);
  }

  const messages: { role: string; content: string }[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  messages.push({ role: 'user', content: prompt });

  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: options.stream,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;

  const response = await fetch(`${auth.baseUrl}${COPILOT_CHAT_ENDPOINT}`, {
    method: 'POST',
    headers: getChatHeaders(auth.token),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    reportError(options, new Error(`API call failed: HTTP ${response.status}\n${text}`), 1);
  }

  if (options.stream) {
    if (!response.body) reportError(options, new Error('Empty response body'), 1);
    for await (const delta of parseChatCompletionStream(response.body)) {
      process.stdout.write(delta);
    }
    process.stdout.write('\n');
    return;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }

  const content = data.choices?.[0]?.message?.content ?? '';
  process.stdout.write(content);
  if (!content.endsWith('\n')) process.stdout.write('\n');
}

async function showStatus(options: CliOptions) {
  try {
    const auth = await getAuth();
    if (options.json) {
      process.stdout.write(JSON.stringify({
        login: auth.user.login,
        plan: auth.user.copilot_plan,
        api: auth.baseUrl,
        quota_reset_date: auth.user.quota_reset_date,
      }) + '\n');
      return;
    }
    console.log('User:        ', auth.user.login);
    console.log('Plan:        ', auth.user.copilot_plan);
    console.log('API:         ', auth.baseUrl);
    console.log('Quota reset: ', auth.user.quota_reset_date);
  } catch (e) {
    reportError(options, e, 2);
  }
}

async function showModels(options: CliOptions) {
  try {
    const auth = await getAuth();
    const models = await listModels(auth.token, auth.baseUrl);
    if (options.json) {
      process.stdout.write(JSON.stringify(models) + '\n');
      return;
    }
    for (const m of models) {
      console.log(`  - ${m.id} (${m.vendor})`);
    }
  } catch (e) {
    reportError(options, e, 2);
  }
}

async function showUsage(options: CliOptions) {
  try {
    const auth = await getAuth();
    const u = auth.user;
    if (options.json) {
      process.stdout.write(JSON.stringify({
        plan: u.copilot_plan,
        quota_reset_date: u.quota_reset_date,
        quota: u.quota_snapshots,
      }) + '\n');
      return;
    }
    const fmt = (q: typeof u.quota_snapshots.chat) =>
      q.unlimited ? 'unlimited' : `${q.remaining}/${q.entitlement} (${q.percent_remaining.toFixed(1)}%)`;
    console.log('Plan:        ', u.copilot_plan);
    console.log('Reset:       ', u.quota_reset_date);
    console.log('Chat:        ', fmt(u.quota_snapshots.chat));
    console.log('Completions: ', fmt(u.quota_snapshots.completions));
    console.log('Premium:     ', fmt(u.quota_snapshots.premium_interactions));
  } catch (e) {
    reportError(options, e, 2);
  }
}

async function testApi(options: CliOptions) {
  try {
    const auth = await getAuth();
    if (!options.json) {
      console.log(`User: ${auth.user.login} (${auth.user.copilot_plan})`);
      console.log(`API:  ${auth.baseUrl}`);
      console.log(`Testing model ${DEFAULT_MODEL}...`);
    }

    const response = await fetch(`${auth.baseUrl}${COPILOT_CHAT_ENDPOINT}`, {
      method: 'POST',
      headers: getChatHeaders(auth.token),
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'Say hello in one word' }],
        max_tokens: 10,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      reportError(options, new Error(`API call failed: HTTP ${response.status}\n${text}`), 1);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '(no content)';
    if (options.json) {
      process.stdout.write(JSON.stringify({ ok: true, model: DEFAULT_MODEL, content }) + '\n');
    } else {
      console.log(`Response: ${content}`);
    }
  } catch (e) {
    reportError(options, e, 2);
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
