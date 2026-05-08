import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/parse-args.js';

describe('parseArgs', () => {
  it('defaults: serve on 127.0.0.1:4141, no log', () => {
    const { options, errors } = parseArgs([]);
    expect(errors).toEqual([]);
    expect(options).toEqual({
      command: 'serve',
      host: '127.0.0.1',
      port: 4141,
      log: false,
    });
  });

  it('recognizes commands', () => {
    expect(parseArgs(['serve']).options.command).toBe('serve');
    expect(parseArgs(['env']).options.command).toBe('env');
    expect(parseArgs(['status']).options.command).toBe('status');
    expect(parseArgs(['test']).options.command).toBe('test');
    expect(parseArgs(['help']).options.command).toBe('help');
  });

  it('--help / -h short-circuits', () => {
    expect(parseArgs(['-h']).options.command).toBe('help');
    expect(parseArgs(['--help']).options.command).toBe('help');
  });

  it('parses --port and --host', () => {
    const { options } = parseArgs(['serve', '--port', '8080', '--host', '0.0.0.0']);
    expect(options.port).toBe(8080);
    expect(options.host).toBe('0.0.0.0');
  });

  it('--port=value form', () => {
    expect(parseArgs(['--port=9999']).options.port).toBe(9999);
    expect(parseArgs(['--host=0.0.0.0']).options.host).toBe('0.0.0.0');
  });

  it('-p alias for --port', () => {
    expect(parseArgs(['-p', '7777']).options.port).toBe(7777);
  });

  it('--log enables logging', () => {
    expect(parseArgs(['--log']).options.log).toBe(true);
  });

  it('rejects unknown commands', () => {
    const { errors } = parseArgs(['frobnicate']);
    expect(errors).toContain("unknown command 'frobnicate'");
  });

  it('rejects unknown flags', () => {
    const { errors } = parseArgs(['--frobnicate']);
    expect(errors).toContain("unknown flag '--frobnicate'");
  });

  it('rejects missing flag values', () => {
    expect(parseArgs(['--port']).errors).toContain("flag '--port' requires a value");
    expect(parseArgs(['--host']).errors).toContain("flag '--host' requires a value");
  });

  it('rejects flag value that looks like another flag', () => {
    const { errors } = parseArgs(['--port', '--host']);
    expect(errors).toContain("flag '--port' requires a value");
  });

  it('rejects out-of-range ports', () => {
    expect(parseArgs(['--port', 'abc']).errors[0]).toMatch(/integer 0\.\.65535/);
    expect(parseArgs(['--port', '99999']).errors[0]).toMatch(/integer 0\.\.65535/);
    expect(parseArgs(['--port', '-1']).errors.length).toBeGreaterThan(0);
  });

  it('reports extra positionals', () => {
    const { errors } = parseArgs(['serve', 'extra']);
    expect(errors).toContain('unexpected extra arguments: extra');
  });

  it('command + flags together', () => {
    const { options, errors } = parseArgs(['env', '--port', '5050']);
    expect(errors).toEqual([]);
    expect(options.command).toBe('env');
    expect(options.port).toBe(5050);
  });
});
