/**
 * CLI argument parser. Pure function, no I/O — easy to test.
 */

export const KNOWN_COMMANDS = new Set([
  'status',
  'login',
  'logout',
  'models',
  'usage',
  'test',
]);

export interface CliOptions {
  command?: string;
  prompt?: string;
  bare: boolean;
  json: boolean;
  model: string;
  stream: boolean;
  system?: string;
  maxTokens?: number;
  help: boolean;
}

export interface ParseArgsResult {
  options: CliOptions;
  errors: string[];
}

export function parseArgs(argv: string[], defaultModel: string): ParseArgsResult {
  const options: CliOptions = {
    bare: false,
    json: false,
    model: defaultModel,
    stream: true,
    help: false,
  };
  const errors: string[] = [];
  const positional: string[] = [];
  let promptViaFlag: string | undefined;
  let promptFlagSeen = false;

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
    if (a === '-p' || a === '--print') {
      promptFlagSeen = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        promptViaFlag = next;
        i += 1;
      }
    } else if (a === '--bare') {
      options.bare = true;
    } else if (a === '--json') {
      options.json = true;
    } else if (a === '--stream') {
      options.stream = true;
    } else if (a === '--no-stream') {
      options.stream = false;
    } else if (a === '-h' || a === '--help') {
      options.help = true;
    } else if (a === '--model' || a === '-m') {
      const v = requireValue(a, i);
      if (v !== undefined) {
        options.model = v;
        i += 1;
      }
    } else if (a.startsWith('--model=')) {
      options.model = a.slice('--model='.length);
    } else if (a.startsWith('-m=')) {
      options.model = a.slice('-m='.length);
    } else if (a === '--system' || a === '-s') {
      const v = requireValue(a, i);
      if (v !== undefined) {
        options.system = v;
        i += 1;
      }
    } else if (a.startsWith('--system=')) {
      options.system = a.slice('--system='.length);
    } else if (a === '--max-tokens') {
      const v = requireValue(a, i);
      if (v !== undefined) {
        const n = Number(v);
        if (Number.isNaN(n) || n <= 0) {
          errors.push(`--max-tokens expects a positive number, got '${v}'`);
        } else {
          options.maxTokens = n;
        }
        i += 1;
      }
    } else if (a.startsWith('--max-tokens=')) {
      const v = a.slice('--max-tokens='.length);
      const n = Number(v);
      if (Number.isNaN(n) || n <= 0) {
        errors.push(`--max-tokens expects a positive number, got '${v}'`);
      } else {
        options.maxTokens = n;
      }
    } else if (a.startsWith('-')) {
      errors.push(`unknown flag '${a}'`);
    } else {
      positional.push(a);
    }
  }

  if (positional.length && KNOWN_COMMANDS.has(positional[0])) {
    options.command = positional.shift();
  }
  if (promptFlagSeen || positional.length) {
    options.prompt = promptViaFlag ?? positional.join(' ');
  }

  if (options.bare && options.json) {
    errors.push('--bare and --json are mutually exclusive');
  }
  if (options.json && options.stream) {
    // JSON mode implies a single response object — disable stream.
    options.stream = false;
  }

  return { options, errors };
}
