/**
 * CLI argument parser. Pure function, no I/O.
 *
 * Modes:
 *   - Implicit run (default):     `claude-copilot [any claude args...]`
 *     Every argv goes through to claude unchanged. Use this for daily work.
 *
 *   - Explicit run + cc flags:    `claude-copilot run [--log|--port|--host] [-- claude args...]`
 *     Lets you set claude-copilot flags (--log, --port, --host) before passing
 *     args to claude. Anything cc doesn't recognize stops cc-flag parsing and
 *     becomes the passthrough; an explicit `--` is also supported as a clean
 *     separator.
 *
 *   - Other subcommands:          `claude-copilot {serve|env|settings|status|test}`
 *     These have their own dedicated UX.
 *
 *   - Help:                       `claude-copilot --help`
 *     `--help` / `-h` is the only flag claude-copilot intercepts in implicit
 *     run mode. To see claude's help instead, use `claude-copilot run -- --help`.
 */

export type Command = 'serve' | 'run' | 'env' | 'settings' | 'status' | 'test' | 'help';

export const KNOWN_COMMANDS: Command[] = [
  'serve',
  'run',
  'env',
  'settings',
  'status',
  'test',
  'help',
];

export interface CliOptions {
  command: Command;
  host: string;
  port: number;
  log: boolean;
  /** When command === 'run', the argv to forward to the spawned claude process. */
  passthroughArgs: string[];
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
    command: 'run',
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    log: false,
    passthroughArgs: [],
  };
  const errors: string[] = [];

  // Top-level help: `claude-copilot --help` shows our help, not claude's.
  // Users who want claude's help must use: `claude-copilot run -- --help`.
  if (argv.length > 0 && (argv[0] === '-h' || argv[0] === '--help')) {
    options.command = 'help';
    return { options, errors };
  }

  const first = argv[0];
  const isSubcommand = first !== undefined && (KNOWN_COMMANDS as string[]).includes(first);

  if (!isSubcommand) {
    // Implicit run: pass everything through to claude unchanged.
    options.command = 'run';
    options.passthroughArgs = [...argv];
    return { options, errors };
  }

  options.command = first as Command;
  const rest = argv.slice(1);

  if (options.command === 'run') {
    // Eat any leading cc-recognized flags. Stop at the first thing we don't
    // know (it becomes part of passthrough) or at an explicit `--`.
    let i = 0;
    while (i < rest.length) {
      const a = rest[i];
      if (a === '--') { i += 1; break; }
      const consumed = tryParseCcFlag(rest, i, options, errors);
      if (consumed === 0) break;
      i += consumed;
    }
    options.passthroughArgs = rest.slice(i);
    return { options, errors };
  }

  // Subcommands other than `run`: strict cc-flag parsing.
  parseSubcommandFlags(rest, options, errors);
  return { options, errors };
}

/**
 * Try to parse argv[i] as a claude-copilot flag.
 * Returns the number of argv slots consumed (0 = not a cc flag).
 */
function tryParseCcFlag(
  argv: string[],
  i: number,
  options: CliOptions,
  errors: string[]
): number {
  const a = argv[i];

  if (a === '--log') {
    options.log = true;
    return 1;
  }

  if (a === '--host') {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) {
      errors.push(`flag '--host' requires a value`);
      return 1;
    }
    options.host = v;
    return 2;
  }
  if (a.startsWith('--host=')) {
    options.host = a.slice('--host='.length);
    return 1;
  }

  if (a === '--port' || a === '-p') {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) {
      errors.push(`flag '${a}' requires a value`);
      return 1;
    }
    setPort(v, options, errors);
    return 2;
  }
  if (a.startsWith('--port=')) {
    setPort(a.slice('--port='.length), options, errors);
    return 1;
  }
  if (a.startsWith('-p=')) {
    setPort(a.slice('-p='.length), options, errors);
    return 1;
  }

  return 0;
}

function parseSubcommandFlags(rest: string[], options: CliOptions, errors: string[]): void {
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h' || a === '--help') {
      options.command = 'help';
      return;
    }
    const consumed = tryParseCcFlag(rest, i, options, errors);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    if (a.startsWith('-')) {
      errors.push(`unknown flag '${a}'`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length > 0) {
    errors.push(`unexpected extra arguments: ${positional.join(' ')}`);
  }
}

function setPort(raw: string, options: CliOptions, errors: string[]): void {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    errors.push(`--port expects an integer 0..65535, got '${raw}'`);
    return;
  }
  options.port = n;
}
