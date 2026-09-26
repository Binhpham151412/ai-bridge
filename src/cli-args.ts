export type CliCommand = 'doctor' | 'start' | 'stop' | 'status' | 'resume' | 'logs' | 'reset' | 'pause';

export interface ParsedArgs {
  command: CliCommand | null;
  flags: Record<string, string>;
  error: string | null;
}

const COMMANDS: readonly CliCommand[] = ['doctor', 'start', 'stop', 'status', 'resume', 'logs', 'reset', 'pause'];

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: null, flags: {}, error: 'Usage: ai-bridge <doctor|start|stop|status> [--flag value ...]' };
  }
  const [first, ...rest] = argv;
  if (!(COMMANDS as string[]).includes(first)) {
    return { command: null, flags: {}, error: `Unknown command: ${first}` };
  }

  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      return { command: null, flags: {}, error: `Unexpected argument: ${token}` };
    }
    const name = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined) {
      return { command: null, flags: {}, error: `Flag --${name} requires a value` };
    }
    flags[name] = value;
    i++;
  }

  return { command: first as CliCommand, flags, error: null };
}
