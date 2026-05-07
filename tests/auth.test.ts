import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('readCopilotToken', () => {
  const origEnv = { ...process.env };
  const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    delete process.env.GH_COPILOT_TOKEN;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...origEnv };
    if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
  });

  it('returns GH_COPILOT_TOKEN when set, no keychain access', async () => {
    process.env.GH_COPILOT_TOKEN = 'gho_FAKE_FOR_TEST';
    const { readCopilotToken } = await import('../src/auth.js');
    expect(readCopilotToken()).toBe('gho_FAKE_FOR_TEST');
  });

  it('throws NotLoggedIn on unsupported platform without env var', async () => {
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
