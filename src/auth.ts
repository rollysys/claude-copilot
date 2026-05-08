/**
 * GitHub Copilot API helper.
 *
 * This module does NOT manage authentication itself. It reads the GitHub
 * OAuth token that the official `@github/copilot` CLI stored after
 * `copilot login`, then makes Copilot API calls on behalf of the same user
 * — using that user's quota, identity, and plan.
 *
 * Token sources (first match wins):
 *   1. `GH_COPILOT_TOKEN` environment variable
 *   2. macOS keychain: `security find-generic-password -s copilot-cli`
 *
 * On Linux/Windows you must set `GH_COPILOT_TOKEN` (the official CLI's
 * keychain layout there is platform-specific and not parsed by this module).
 *
 * Honors `HTTPS_PROXY` / `HTTP_PROXY` (Node's native fetch ignores them by
 * default).
 *
 * NOTE: The endpoints used here (`/copilot_internal/user`, `/chat/completions`,
 * `/models`) are not formally documented public APIs — they may change without
 * notice.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

// Honor HTTPS_PROXY/HTTP_PROXY/NO_PROXY for global fetch — Node's built-in fetch
// ignores these by default. EnvHttpProxyAgent reads them per-request and
// correctly bypasses the proxy for hosts matched by NO_PROXY (e.g. 127.0.0.1).
{
  const hasProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (hasProxy) {
    // Suppress the "EnvHttpProxyAgent is experimental" warning that undici
    // emits on first use. The agent has been stable in practice since undici 6.
    const origEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === 'string' ? warning : warning.message;
      if (text.includes('EnvHttpProxyAgent')) return;
      return (origEmitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;

    setGlobalDispatcher(new EnvHttpProxyAgent());

    // Restore for any later legitimate warnings.
    process.emitWarning = origEmitWarning;
  }
}

const COPILOT_USER_URL = 'https://api.github.com/copilot_internal/user';
const USER_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Default integration ID. This matches the value used by the official
 * `@github/copilot` CLI. The Copilot API enforces a server-side allow-list of
 * integration IDs; using the same value as the official CLI is the closest
 * "best fit" for a third-party CLI today.
 *
 * If you are operating an integration that GitHub has explicitly registered,
 * override via `COPILOT_INTEGRATION_ID` env var.
 */
export const COPILOT_INTEGRATION_ID =
  process.env.COPILOT_INTEGRATION_ID || 'copilot-developer-cli';

export const COPILOT_API_VERSION = '2026-01-09';
export const COPILOT_USER_AGENT = `claude-copilot/0.1 (${process.platform} ${process.arch})`;

export type CopilotAuthErrorKind =
  | 'NotLoggedIn'
  | 'TokenInvalid'
  | 'NoCopilotSubscription'
  | 'NetworkError';

export class CopilotAuthError extends Error {
  constructor(public kind: CopilotAuthErrorKind, message: string) {
    super(message);
    this.name = 'CopilotAuthError';
  }
}

export interface QuotaDetail {
  entitlement: number;
  remaining: number;
  percent_remaining: number;
  unlimited: boolean;
}

export interface CopilotUser {
  login: string;
  copilot_plan: string;
  quota_reset_date: string;
  quota_snapshots: {
    chat: QuotaDetail;
    completions: QuotaDetail;
    premium_interactions: QuotaDetail;
  };
  endpoints: {
    api: string;
    proxy?: string;
    telemetry?: string;
  };
}

export interface CopilotModel {
  id: string;
  name: string;
  vendor: string;
  model_picker_enabled: boolean;
  supported_endpoints?: string[];
}

interface CopilotModelsResponse {
  data: Array<{
    id: string;
    name: string;
    vendor: string;
    model_picker_enabled: boolean;
    policy?: { state: string };
    supported_endpoints?: string[];
  }>;
}

function readTokenFromMacKeychain(): string | undefined {
  try {
    const out = execSync('security find-generic-password -s copilot-cli -w', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function readTokenFromLibSecret(): string | undefined {
  try {
    const search = execSync('secret-tool search --all service copilot-cli', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = search.match(/attribute\.account\s*=\s*(.+)/);
    if (!m) return undefined;
    const account = m[1].trim();
    const out = execSync('secret-tool lookup service copilot-cli account ' + JSON.stringify(account), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function readTokenFromConfigFile(): string | undefined {
  try {
    const configPath = join(homedir(), '.copilot', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      copilot_tokens?: Record<string, string>;
    };
    if (!config.copilot_tokens) return undefined;
    for (const v of Object.values(config.copilot_tokens)) {
      if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    }
  } catch {
    // file missing / unreadable / unparseable — not fatal
  }
  return undefined;
}

/**
 * Read the GitHub OAuth token issued to the official `copilot` CLI.
 *
 * Resolution order:
 *   1. `GH_COPILOT_TOKEN` environment variable
 *   2. macOS Keychain (`security find-generic-password`)
 *   3. Linux libsecret (`secret-tool`)
 *   4. Plaintext config at `~/.copilot/config.json` (cross-platform fallback)
 *
 * @throws {CopilotAuthError} kind=`NotLoggedIn` if no token can be located.
 */
export function readCopilotToken(): string {
  if (process.env.GH_COPILOT_TOKEN) return process.env.GH_COPILOT_TOKEN;

  if (process.platform === 'darwin') {
    const fromKeychain = readTokenFromMacKeychain();
    if (fromKeychain) return fromKeychain;
  } else if (process.platform === 'linux') {
    const fromSecret = readTokenFromLibSecret();
    if (fromSecret) return fromSecret;
  }

  const fromConfig = readTokenFromConfigFile();
  if (fromConfig) return fromConfig;

  throw new CopilotAuthError(
    'NotLoggedIn',
    'Could not find a copilot CLI token. Please:\n' +
      '  1. Install the official CLI: `npm i -g @github/copilot`\n' +
      '  2. Run: `copilot login`\n' +
      'Token sources tried:\n' +
      '  - GH_COPILOT_TOKEN environment variable\n' +
      (process.platform === 'darwin' ? '  - macOS Keychain (service: copilot-cli)\n' : '') +
      (process.platform === 'linux' ? '  - libsecret via `secret-tool` (install libsecret-tools if missing)\n' : '') +
      '  - ~/.copilot/config.json copilot_tokens map\n' +
      'On headless or unsupported setups, set GH_COPILOT_TOKEN directly.'
  );
}

let _userCache: { user: CopilotUser; at: number } | undefined;

/**
 * Fetch Copilot user info, including the plan-specific API endpoint host.
 * Cached for 5 minutes per process.
 */
export async function fetchCopilotUser(token: string, force = false): Promise<CopilotUser> {
  if (!force && _userCache && Date.now() - _userCache.at < USER_CACHE_TTL_MS) {
    return _userCache.user;
  }

  const r = await fetch(COPILOT_USER_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': COPILOT_USER_AGENT,
    },
  });

  if (r.status === 401) {
    throw new CopilotAuthError(
      'TokenInvalid',
      'GitHub OAuth token is invalid or expired. Re-run `copilot login`.'
    );
  }
  if (r.status === 403) {
    throw new CopilotAuthError(
      'NoCopilotSubscription',
      'This account does not have an active GitHub Copilot subscription.'
    );
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new CopilotAuthError(
      'NetworkError',
      `Failed to fetch Copilot user info: HTTP ${r.status} - ${text.slice(0, 200)}`
    );
  }

  const user = (await r.json()) as CopilotUser;
  _userCache = { user, at: Date.now() };
  return user;
}

export function getChatHeaders(
  token: string,
  intent: string = 'conversation-agent'
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Copilot-Integration-Id': COPILOT_INTEGRATION_ID,
    'X-GitHub-Api-Version': COPILOT_API_VERSION,
    'Openai-Intent': intent,
    'X-Initiator': 'user',
    'User-Agent': COPILOT_USER_AGENT,
  };
}

export async function listModels(token: string, baseUrl: string): Promise<CopilotModel[]> {
  const r = await fetch(`${baseUrl}/models`, { headers: getChatHeaders(token) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new CopilotAuthError(
      'NetworkError',
      `Failed to list models: HTTP ${r.status} - ${text.slice(0, 200)}`
    );
  }
  const data = (await r.json()) as CopilotModelsResponse;
  return data.data
    .filter(m => m.model_picker_enabled !== false || m.policy?.state === 'enabled')
    .map(m => ({
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      model_picker_enabled: m.model_picker_enabled,
      supported_endpoints: m.supported_endpoints,
    }));
}

/** Internal — for tests only. */
export function _resetCacheForTest() {
  _userCache = undefined;
}
