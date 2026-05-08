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
      passthroughArgs: [],
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

  it('settings command', () => {
    const { options } = parseArgs(['settings', '--port', '8080']);
    expect(options.command).toBe('settings');
    expect(options.port).toBe(8080);
  });

  describe('run command', () => {
    it('captures passthrough args verbatim', () => {
      const { options, errors } = parseArgs(['run', '--print', 'hello']);
      expect(errors).toEqual([]);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual(['--print', 'hello']);
    });

    it('passes through unknown flags after run', () => {
      // These would otherwise produce "unknown flag" errors
      const { options, errors } = parseArgs([
        'run', '--frobnicate', '--no-such-flag', 'positional',
      ]);
      expect(errors).toEqual([]);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual(['--frobnicate', '--no-such-flag', 'positional']);
    });

    it('strips an optional leading -- separator', () => {
      const { options } = parseArgs(['run', '--', '--print', 'hi']);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual(['--print', 'hi']);
    });

    it('respects --port placed before run', () => {
      const { options } = parseArgs(['--port', '9090', 'run', '--print', 'hi']);
      expect(options.command).toBe('run');
      expect(options.port).toBe(9090);
      expect(options.passthroughArgs).toEqual(['--print', 'hi']);
    });

    it('respects --log placed before run', () => {
      const { options } = parseArgs(['--log', 'run']);
      expect(options.command).toBe('run');
      expect(options.log).toBe(true);
      expect(options.passthroughArgs).toEqual([]);
    });

    it('run with no args', () => {
      const { options, errors } = parseArgs(['run']);
      expect(errors).toEqual([]);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual([]);
    });

    it('the `run` literal as a passthrough arg is not re-interpreted', () => {
      const { options } = parseArgs(['run', 'run', 'inner']);
      expect(options.command).toBe('run');
      // Second `run` should be a child arg, not a re-trigger
      expect(options.passthroughArgs).toEqual(['run', 'inner']);
    });
  });
});
