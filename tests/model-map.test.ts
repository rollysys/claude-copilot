import { describe, it, expect } from 'vitest';
import { mapModelToCopilot } from '../src/model-map.js';

describe('mapModelToCopilot', () => {
  it('converts dash-style version to dot-style', () => {
    expect(mapModelToCopilot('claude-opus-4-7')).toBe('claude-opus-4.7');
    expect(mapModelToCopilot('claude-opus-4-6')).toBe('claude-opus-4.6');
    expect(mapModelToCopilot('claude-sonnet-4-6')).toBe('claude-sonnet-4.6');
    expect(mapModelToCopilot('claude-sonnet-4-5')).toBe('claude-sonnet-4.5');
    expect(mapModelToCopilot('claude-haiku-4-5')).toBe('claude-haiku-4.5');
    expect(mapModelToCopilot('claude-opus-4-5')).toBe('claude-opus-4.5');
  });

  it('strips trailing 8-digit date stamp on claude ids', () => {
    expect(mapModelToCopilot('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
    expect(mapModelToCopilot('claude-opus-4-7-20260101')).toBe('claude-opus-4.7');
    expect(mapModelToCopilot('claude-3-5-sonnet-20241022')).toBe('claude-3.5-sonnet');
  });

  it('does not strip date-like suffixes on non-claude ids', () => {
    expect(mapModelToCopilot('gpt-4.1-2025-04-14')).toBe('gpt-4.1-2025-04-14');
  });

  it('leaves dot-style ids untouched', () => {
    expect(mapModelToCopilot('claude-opus-4.7')).toBe('claude-opus-4.7');
    expect(mapModelToCopilot('claude-sonnet-4.6')).toBe('claude-sonnet-4.6');
  });

  it('passes non-claude models through unchanged', () => {
    expect(mapModelToCopilot('gpt-4.1')).toBe('gpt-4.1');
    expect(mapModelToCopilot('gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(mapModelToCopilot('grok-code-fast-1')).toBe('grok-code-fast-1');
  });

  it('handles edge cases gracefully', () => {
    expect(mapModelToCopilot('claude-')).toBe('claude-');
    expect(mapModelToCopilot('claude-foo')).toBe('claude-foo');
    expect(mapModelToCopilot('claude-3')).toBe('claude-3');
  });
});
