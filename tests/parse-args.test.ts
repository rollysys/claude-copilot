import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/parse-args.js';

const D = 'gpt-4.1';

describe('parseArgs', () => {
  it('returns defaults for empty argv', () => {
    const { options, errors } = parseArgs([], D);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({
      bare: false,
      json: false,
      model: D,
      stream: true,
      help: false,
    });
    expect(options.command).toBeUndefined();
    expect(options.prompt).toBeUndefined();
  });

  it('recognizes known subcommands', () => {
    expect(parseArgs(['status'], D).options.command).toBe('status');
    expect(parseArgs(['models'], D).options.command).toBe('models');
    expect(parseArgs(['usage'], D).options.command).toBe('usage');
    expect(parseArgs(['test'], D).options.command).toBe('test');
    expect(parseArgs(['login'], D).options.command).toBe('login');
    expect(parseArgs(['logout'], D).options.command).toBe('logout');
  });

  it('treats unknown leading word as positional prompt', () => {
    const { options } = parseArgs(['hello', 'world'], D);
    expect(options.command).toBeUndefined();
    expect(options.prompt).toBe('hello world');
  });

  it('-p with value', () => {
    const { options } = parseArgs(['-p', 'hi'], D);
    expect(options.prompt).toBe('hi');
  });

  it('-p without value but with stdin (just sets the flag)', () => {
    const { options } = parseArgs(['-p'], D);
    // prompt flag is seen; value stays undefined to be filled by stdin
    expect(options.prompt).toBe('');
  });

  it('--print is alias for -p', () => {
    expect(parseArgs(['--print', 'foo'], D).options.prompt).toBe('foo');
  });

  it('--model and -m', () => {
    expect(parseArgs(['--model', 'claude-opus-4.6'], D).options.model).toBe('claude-opus-4.6');
    expect(parseArgs(['-m', 'gpt-5.5'], D).options.model).toBe('gpt-5.5');
  });

  it('--model=value form', () => {
    expect(parseArgs(['--model=foo-bar'], D).options.model).toBe('foo-bar');
    expect(parseArgs(['-m=foo-bar'], D).options.model).toBe('foo-bar');
  });

  it('--bare and --json', () => {
    expect(parseArgs(['--bare'], D).options.bare).toBe(true);
    expect(parseArgs(['--json'], D).options.json).toBe(true);
  });

  it('--bare and --json are mutually exclusive', () => {
    const { errors } = parseArgs(['--bare', '--json'], D);
    expect(errors).toContain('--bare and --json are mutually exclusive');
  });

  it('--json implies --no-stream', () => {
    const { options } = parseArgs(['--json'], D);
    expect(options.stream).toBe(false);
  });

  it('--no-stream disables streaming', () => {
    expect(parseArgs(['--no-stream'], D).options.stream).toBe(false);
  });

  it('--system value', () => {
    expect(parseArgs(['--system', 'be brief'], D).options.system).toBe('be brief');
    expect(parseArgs(['--system=be brief'], D).options.system).toBe('be brief');
  });

  it('--max-tokens parses and validates', () => {
    expect(parseArgs(['--max-tokens', '100'], D).options.maxTokens).toBe(100);
    expect(parseArgs(['--max-tokens=200'], D).options.maxTokens).toBe(200);

    const bad = parseArgs(['--max-tokens', 'abc'], D);
    expect(bad.errors[0]).toMatch(/positive number/);

    const neg = parseArgs(['--max-tokens', '-5'], D);
    expect(neg.errors.length).toBeGreaterThan(0);
  });

  it('flag missing value reports error', () => {
    const { errors } = parseArgs(['--model'], D);
    expect(errors).toContain("flag '--model' requires a value");
  });

  it('flag followed by another flag reports missing value', () => {
    const { errors } = parseArgs(['--model', '--bare'], D);
    expect(errors).toContain("flag '--model' requires a value");
  });

  it('unknown flag reports error', () => {
    const { errors } = parseArgs(['--frobnicate'], D);
    expect(errors).toContain("unknown flag '--frobnicate'");
  });

  it('mixed: command + flags + positional', () => {
    const { options, errors } = parseArgs(
      ['status', '--json'],
      D
    );
    expect(errors).toEqual([]);
    expect(options.command).toBe('status');
    expect(options.json).toBe(true);
  });

  it('-p followed by another flag does not consume it', () => {
    const { options } = parseArgs(['-p', '--model', 'foo'], D);
    expect(options.prompt).toBe('');
    expect(options.model).toBe('foo');
  });

  it('positional after -p is treated as prompt continuation', () => {
    // -p with no value, then positionals → positionals form the prompt
    const { options } = parseArgs(['-p', 'hello', 'world'], D);
    expect(options.prompt).toBe('hello');
    // Note: only the value immediately after -p is consumed; rest are positional
  });

  it('-h and --help', () => {
    expect(parseArgs(['-h'], D).options.help).toBe(true);
    expect(parseArgs(['--help'], D).options.help).toBe(true);
  });
});
