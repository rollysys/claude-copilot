/**
 * CLI argument parser. Pure function, no I/O.
 */

export type Command = 'serve' | 'status' | 'test' | 'env' | 'help';

export const KNOWN_COMMANDS: Command[] = ['serve', 'status', 'test', 'env', 'help'];

export interface CliOptions {
  command: Command;
  host: string;
  port: number;
  log: boolean;
}

export interface ParseArgsResult {
  options: CliOptions;
  errors: string[];
}

const DEFAULTS = {
  host: '127.0.0.1',
  port: 4141,
} as const;

export function parseArgs(argv: string[]): ParseArgsResult {
  const options: CliOptions = {
    command: 'serve',
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    log: false,
  };
  const errors: string[] = [];
  const positional: string[] = [];

  const requireValue = (flag: string, i: number): string | undefined => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) {
      errors.push(`flag '${flag}' requires a value`);
      return undefined;
    }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      options.command = 'help';
    } else if (a === '--log') {
      options.log = true;
    } else if (a === '--host') {
      const v = requireValue(a, i);
      if (v !== undefined) { options.host = v; i += 1; }
    } else if (a.startsWith('--host=')) {
      options.host = a.slice('--host='.length);
    } else if (a === '--port' || a === '-p') {
      const v = requireValue(a, i);
      if (v !== undefined) {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 65535) {
          errors.push(`--port expects an integer 0..65535, got '${v}'`);
        } else {
          options.port = n;
        }
        i += 1;
      }
    } else if (a.startsWith('--port=')) {
      const v = a.slice('--port='.length);
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        errors.push(`--port expects an integer 0..65535, got '${v}'`);
      } else {
        options.port = n;
      }
    } else if (a.startsWith('-')) {
      errors.push(`unknown flag '${a}'`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length > 0) {
    const cmd = positional[0];
    if ((KNOWN_COMMANDS as string[]).includes(cmd)) {
      options.command = cmd as Command;
    } else {
      errors.push(`unknown command '${cmd}'`);
    }
    if (positional.length > 1) {
      errors.push(`unexpected extra arguments: ${positional.slice(1).join(' ')}`);
    }
  }

  return { options, errors };
}
