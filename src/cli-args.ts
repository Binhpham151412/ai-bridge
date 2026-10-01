export type CliCommand = 'doctor' | 'start' | 'stop' | 'status' | 'resume' | 'logs' | 'reset' | 'pause' | 'workflow';

/** `ai-bridge workflow <subcommand>` (docs/39 M5.8). */
export const WORKFLOW_SUBCOMMANDS = ['validate', 'run', 'status', 'pause', 'resume', 'stop', 'list'] as const;
export type WorkflowSubcommand = (typeof WORKFLOW_SUBCOMMANDS)[number];

export interface ParsedArgs {
  command: CliCommand | null;
  /** Only for `workflow`. */
  subcommand: WorkflowSubcommand | null;
  flags: Record<string, string>;
  error: string | null;
}

const COMMANDS: readonly CliCommand[] = ['doctor', 'start', 'stop', 'status', 'resume', 'logs', 'reset', 'pause', 'workflow'];

const failed = (error: string): ParsedArgs => ({ command: null, subcommand: null, flags: {}, error });

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return failed('Usage: ai-bridge <doctor|start|stop|status|workflow> [--flag value ...]');
  }
  const [first, ...afterCommand] = argv;
  if (!(COMMANDS as string[]).includes(first)) {
    return failed(`Unknown command: ${first}`);
  }

  let subcommand: WorkflowSubcommand | null = null;
  let rest = afterCommand;
  if (first === 'workflow') {
    const sub = afterCommand[0];
    if (sub === undefined || sub.startsWith('--')) return failed(`Usage: ai-bridge workflow <${WORKFLOW_SUBCOMMANDS.join('|')}> [--flag value ...]`);
    if (!(WORKFLOW_SUBCOMMANDS as readonly string[]).includes(sub)) return failed(`Unknown workflow command: ${sub}`);
    subcommand = sub as WorkflowSubcommand;
    rest = afterCommand.slice(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      return failed(`Unexpected argument: ${token}`);
    }
    const name = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined) {
      return failed(`Flag --${name} requires a value`);
    }
    flags[name] = value;
    i++;
  }

  return { command: first as CliCommand, subcommand, flags, error: null };
}
