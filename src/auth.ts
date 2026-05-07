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
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Honor HTTPS_PROXY for global fetch — Node's built-in fetch does not by default.
{
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
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
export const COPILOT_CHAT_ENDPOINT = '/chat/completions';

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

/**
 * Read the GitHub OAuth token issued to the official `copilot` CLI.
 *
 * @throws {CopilotAuthError} kind=`NotLoggedIn` if no token can be located.
 */
export function readCopilotToken(): string {
  if (process.env.GH_COPILOT_TOKEN) return process.env.GH_COPILOT_TOKEN;

  if (process.platform === 'darwin') {
    try {
      return execSync('security find-generic-password -s copilot-cli -w', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      throw new CopilotAuthError(
        'NotLoggedIn',
        'No copilot CLI token found in macOS keychain. ' +
          'Install the official CLI (`npm i -g @github/copilot`) and run `copilot login`.'
      );
    }
  }

  throw new CopilotAuthError(
    'NotLoggedIn',
    `Auto-detection of the copilot CLI token is not supported on ${process.platform}. ` +
      'Set the `GH_COPILOT_TOKEN` environment variable to your GitHub OAuth token.'
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
