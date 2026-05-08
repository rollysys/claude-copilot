import { describe, it, expect } from 'vitest';
import { filterAnthropicBeta } from '../src/server.js';

describe('filterAnthropicBeta', () => {
  it('drops listed tokens, keeps the rest', () => {
    const drop = new Set(['advisor-tool-2026-03-01']);
    expect(filterAnthropicBeta('a,advisor-tool-2026-03-01,b', drop)).toBe('a,b');
  });

  it('returns undefined when nothing remains', () => {
    const drop = new Set(['x', 'y']);
    expect(filterAnthropicBeta('x,y', drop)).toBeUndefined();
  });

  it('trims whitespace around tokens', () => {
    const drop = new Set(['x']);
    expect(filterAnthropicBeta(' a , x , b ', drop)).toBe('a,b');
  });

  it('returns undefined for empty input', () => {
    expect(filterAnthropicBeta('', new Set())).toBeUndefined();
  });
});
