import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/parse-args.js';

describe('parseArgs', () => {
  describe('implicit run (default)', () => {
    it('no args → run with empty passthrough', () => {
      const { options, errors } = parseArgs([]);
      expect(errors).toEqual([]);
      expect(options).toEqual({
        command: 'run',
        host: '127.0.0.1',
        port: 4141,
        log: false,
        passthroughArgs: [],
      });
    });

    it('any args become claude passthrough verbatim', () => {
      const { options, errors } = parseArgs(['--print', 'Hello']);
      expect(errors).toEqual([]);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual(['--print', 'Hello']);
    });

    it('preserves dashes, equals, and unknown flags', () => {
      const { options, errors } = parseArgs([
        '--model', 'opus', '--frobnicate', '-p', 'Hi', 'positional',
      ]);
      expect(errors).toEqual([]);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual([
        '--model', 'opus', '--frobnicate', '-p', 'Hi', 'positional',
      ]);
    });

    it('does not parse cc-flags in implicit mode (--port goes to claude)', () => {
      const { options } = parseArgs(['--port', '9999']);
      expect(options.command).toBe('run');
      expect(options.port).toBe(4141); // default unchanged
      expect(options.passthroughArgs).toEqual(['--port', '9999']);
    });

    it('does not parse --log in implicit mode either', () => {
      const { options } = parseArgs(['--log']);
      expect(options.log).toBe(false);
      expect(options.passthroughArgs).toEqual(['--log']);
    });
  });

  describe('top-level help', () => {
    it('-h shows help, not passthrough', () => {
      const { options } = parseArgs(['-h']);
      expect(options.command).toBe('help');
      expect(options.passthroughArgs).toEqual([]);
    });

    it('--help shows help', () => {
      const { options } = parseArgs(['--help']);
      expect(options.command).toBe('help');
    });

    it('--help only triggers when first', () => {
      // After other args, --help is just passed through
      const { options } = parseArgs(['--print', '--help']);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual(['--print', '--help']);
    });
  });

  describe('explicit subcommands', () => {
    it('serve', () => {
      const { options } = parseArgs(['serve']);
      expect(options.command).toBe('serve');
    });
    it('env', () => {
      const { options } = parseArgs(['env', '--port', '5050']);
      expect(options.command).toBe('env');
      expect(options.port).toBe(5050);
    });
    it('settings', () => {
      const { options } = parseArgs(['settings', '--port', '8080']);
      expect(options.command).toBe('settings');
      expect(options.port).toBe(8080);
    });
    it('status', () => {
      expect(parseArgs(['status']).options.command).toBe('status');
    });
    it('test', () => {
      expect(parseArgs(['test']).options.command).toBe('test');
    });
    it('rejects unknown flags on subcommands', () => {
      const { errors } = parseArgs(['serve', '--frobnicate']);
      expect(errors).toContain("unknown flag '--frobnicate'");
    });
    it('rejects extra positionals on subcommands', () => {
      const { errors } = parseArgs(['env', 'extra']);
      expect(errors).toContain('unexpected extra arguments: extra');
    });
    it('flag missing value', () => {
      expect(parseArgs(['serve', '--port']).errors).toContain("flag '--port' requires a value");
    });
    it('out-of-range port', () => {
      expect(parseArgs(['serve', '--port', 'abc']).errors[0]).toMatch(/integer 0\.\.65535/);
      expect(parseArgs(['serve', '--port', '99999']).errors[0]).toMatch(/integer 0\.\.65535/);
    });
    it('--port=N form', () => {
      expect(parseArgs(['serve', '--port=9999']).options.port).toBe(9999);
    });
    it('--host=value form', () => {
      expect(parseArgs(['serve', '--host=0.0.0.0']).options.host).toBe('0.0.0.0');
    });
    it('-p alias', () => {
      expect(parseArgs(['serve', '-p', '7777']).options.port).toBe(7777);
    });
    it('-h on subcommand shows help', () => {
      expect(parseArgs(['serve', '-h']).options.command).toBe('help');
    });
  });

  describe('explicit run', () => {
    it('with no args is the same as implicit run', () => {
      const { options, errors } = parseArgs(['run']);
      expect(errors).toEqual([]);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual([]);
    });

    it('parses --log before passthrough', () => {
      const { options, errors } = parseArgs(['run', '--log', '--', '--print', 'hi']);
      expect(errors).toEqual([]);
      expect(options.log).toBe(true);
      expect(options.passthroughArgs).toEqual(['--print', 'hi']);
    });

    it('parses --port before passthrough', () => {
      const { options } = parseArgs(['run', '--port', '4242', '--', '--print', 'hi']);
      expect(options.port).toBe(4242);
      expect(options.passthroughArgs).toEqual(['--print', 'hi']);
    });

    it('first unknown flag stops cc parsing without --', () => {
      // --print is not a cc flag → stop cc parsing, --print + rest = passthrough
      const { options, errors } = parseArgs(['run', '--print', 'hi']);
      expect(errors).toEqual([]);
      expect(options.command).toBe('run');
      expect(options.passthroughArgs).toEqual(['--print', 'hi']);
    });

    it('cc flags before unknown flag are still parsed', () => {
      const { options } = parseArgs(['run', '--log', '--print', 'hi']);
      expect(options.log).toBe(true);
      expect(options.passthroughArgs).toEqual(['--print', 'hi']);
    });

    it('explicit -- separator is consumed', () => {
      const { options } = parseArgs(['run', '--', '--print', 'hi']);
      expect(options.passthroughArgs).toEqual(['--print', 'hi']);
    });

    it('the literal `run` after run is passthrough, not re-triggered', () => {
      const { options } = parseArgs(['run', '--', 'run', 'inner']);
      expect(options.passthroughArgs).toEqual(['run', 'inner']);
    });
  });

  describe('errors that should still surface', () => {
    it('--port with no value reports error (implicit run does not since it does not parse)', () => {
      // Not in implicit run — we don't error on cc flags there.
      // But `serve --port` does:
      expect(parseArgs(['serve', '--port']).errors).toContain("flag '--port' requires a value");
    });
  });
});
