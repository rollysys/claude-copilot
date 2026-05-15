import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('readCopilotToken', () => {
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  let tmpHome = '';

  beforeEach(() => {
    delete process.env.GH_COPILOT_TOKEN;
    // Isolate ~/.copilot/config.json lookup from the host's real home.
    tmpHome = mkdtempSync(join(tmpdir(), 'claude-copilot-test-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.GH_COPILOT_TOKEN;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
  });

  it('returns GH_COPILOT_TOKEN when set, no keychain access', async () => {
    process.env.GH_COPILOT_TOKEN = 'gho_FAKE_FOR_TEST';
    const { readCopilotToken } = await import('../src/auth.js');
    expect(readCopilotToken()).toBe('gho_FAKE_FOR_TEST');
  });

  it('reads from ~/.copilot/config.json copilot_tokens map', async () => {
    mkdirSync(join(tmpHome, '.copilot'));
    writeFileSync(
      join(tmpHome, '.copilot', 'config.json'),
      JSON.stringify({
        copilot_tokens: { 'https://github.com:user': 'gho_FROM_CONFIG' },
      })
    );
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    const { readCopilotToken } = await import('../src/auth.js');
    expect(readCopilotToken()).toBe('gho_FROM_CONFIG');
  });

  it('reads from ~/.copilot/config.json copilotTokens (camelCase) map', async () => {
    mkdirSync(join(tmpHome, '.copilot'));
    writeFileSync(
      join(tmpHome, '.copilot', 'config.json'),
      JSON.stringify({
        copilotTokens: { 'https://github.com:user': 'gho_FROM_CAMELCASE' },
      })
    );
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    const { readCopilotToken } = await import('../src/auth.js');
    expect(readCopilotToken()).toBe('gho_FROM_CAMELCASE');
  });

  it('reads from ~/.copilot/config.json with JSONC comments', async () => {
    mkdirSync(join(tmpHome, '.copilot'));
    writeFileSync(
      join(tmpHome, '.copilot', 'config.json'),
      '// User settings belong in settings.json.\n' +
        JSON.stringify({
          copilotTokens: { 'https://github.com:user': 'gho_FROM_JSONC' },
        }) +
        '\n'
    );
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    const { readCopilotToken } = await import('../src/auth.js');
    expect(readCopilotToken()).toBe('gho_FROM_JSONC');
  });

  it('throws NotLoggedIn when no token source is available', async () => {
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    const { readCopilotToken, CopilotAuthError } = await import('../src/auth.js');
    expect(() => readCopilotToken()).toThrowError(CopilotAuthError);
    try {
      readCopilotToken();
    } catch (e: any) {
      expect(e.kind).toBe('NotLoggedIn');
      expect(e.message).toMatch(/GH_COPILOT_TOKEN/);
    }
  });
});

describe('COPILOT_INTEGRATION_ID env override', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('defaults to copilot-developer-cli', async () => {
    delete process.env.COPILOT_INTEGRATION_ID;
    const { COPILOT_INTEGRATION_ID } = await import('../src/auth.js');
    expect(COPILOT_INTEGRATION_ID).toBe('copilot-developer-cli');
  });

  it('honors env var override', async () => {
    process.env.COPILOT_INTEGRATION_ID = 'my-custom-integration';
    const { COPILOT_INTEGRATION_ID } = await import('../src/auth.js');
    expect(COPILOT_INTEGRATION_ID).toBe('my-custom-integration');
  });
});

describe('getChatHeaders', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.COPILOT_INTEGRATION_ID;
  });

  it('does not impersonate VS Code or Copilot Chat', async () => {
    const { getChatHeaders } = await import('../src/auth.js');
    const h = getChatHeaders('gho_test');
    const ua = h['User-Agent'];
    const headerKeys = Object.keys(h).map(k => k.toLowerCase());

    // Must not pretend to be VS Code or Copilot Chat extension
    expect(ua).not.toMatch(/vscode/i);
    expect(ua).not.toMatch(/GitHubCopilotChat/i);
    expect(ua).toMatch(/^claude-copilot\//);

    // Must NOT send editor-version or editor-plugin-version (those are VS Code extension fields)
    expect(headerKeys).not.toContain('editor-version');
    expect(headerKeys).not.toContain('editor-plugin-version');
  });

  it('sets the documented integration id default', async () => {
    const { getChatHeaders } = await import('../src/auth.js');
    const h = getChatHeaders('t');
    expect(h['Copilot-Integration-Id']).toBe('copilot-developer-cli');
  });
});
