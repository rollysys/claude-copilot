import { describe, it, expect } from 'vitest';
import { filterAnthropicBeta, parseUnsupportedBetas } from '../src/server.js';

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

describe('parseUnsupportedBetas', () => {
  it('extracts a single token', () => {
    const body = '{"error":{"message":"unsupported beta header(s): advisor-tool-2026-03-01","code":"invalid_request_body"}}';
    expect(parseUnsupportedBetas(body)).toEqual(['advisor-tool-2026-03-01']);
  });

  it('extracts multiple tokens separated by commas', () => {
    const body = 'unsupported beta header(s): foo-1, bar-2, baz-3';
    expect(parseUnsupportedBetas(body)).toEqual(['foo-1', 'bar-2', 'baz-3']);
  });

  it('returns empty array for unrelated errors', () => {
    expect(parseUnsupportedBetas('model_not_supported')).toEqual([]);
    expect(parseUnsupportedBetas('')).toEqual([]);
  });
});
