import type { INestApplicationContext } from '@nestjs/common';
import { err, ok, parseCorrelationId } from '@mondapac-drive/shared-kernel';
import type { CallContext, IdGenerator, Result } from '@mondapac-drive/shared-kernel';
import { createCallContext, systemActor } from '@mondapac-drive/shared-kernel/contexts';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketContextFactory } from '../market-context/market-context.factory';

/**
 * An operator command that acts as a Market's `SYSTEM` actor (platform-audit 9.2; identity
 * design 7.4). A module declares it and publishes it through its `index.ts`; the platform runner
 * below parses the arguments, builds the context and writes the operator line, so a module never
 * mints a system actor (rule `contexts-are-built-by-platform`).
 */
export interface OperatorCommand {
  /** The first argument: `first-admin`, `reset-admin-second-factor`. */
  readonly name: string;
  /** The value flags besides `--market`, each given exactly once (`email` for `--email`). */
  readonly flags: readonly string[];
  /**
   * Runs the command's use case with the context. The values are the operator's input: never
   * written to a log or the output by the runner.
   */
  run(
    app: INestApplicationContext,
    context: CallContext,
    values: Readonly<Record<string, string>>,
  ): Promise<OperatorCommandOutcome>;
}

/** What a command answers: done or declined by its use case, and a body of codes and ids only. */
export interface OperatorCommandOutcome {
  readonly done: boolean;
  readonly body: Readonly<Record<string, unknown>>;
}

/** The exit codes of an operator command. */
export const OPERATOR_COMMAND_EXIT = Object.freeze({
  /** Done. */
  done: 0,
  /** A usage error, a Market this stack does not host, or an operator line that failed. */
  refused: 1,
  /** The use case refused; its code is printed (for example `first-admin.exists`). */
  declined: 2,
});

/** Who runs the command, read by the entry file from the operating system. */
export interface OperatorIdentity {
  readonly osUser: string;
  readonly host: string;
}

/**
 * The external operator log of platform-audit 9.2 (Hassan L6): one line, outside the application
 * database, written before the command acts. Kazem owns the sink; until it exists the entry file
 * writes the line to standard error. A write that fails refuses the command.
 */
export type OperatorLog = (line: string) => Promise<void>;

export interface ParsedOperatorArguments {
  readonly command: OperatorCommand;
  readonly marketId: string;
  readonly values: Readonly<Record<string, string>>;
}

/** Reads `<command> --market <id> --<flag> <value>...`; anything else is a usage error. */
export function parseOperatorArguments(
  commands: readonly OperatorCommand[],
  argv: readonly string[],
): Result<ParsedOperatorArguments, 'usage'> {
  const [name, ...rest] = argv;
  const command = commands.find((candidate) => candidate.name === name);
  if (command === undefined) return err('usage');
  const allowed = new Set(['market', ...command.flags]);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === undefined || !flag.startsWith('--')) return err('usage');
    const key = flag.slice(2);
    if (!allowed.has(key) || values.has(key)) return err('usage');
    if (value === undefined || value.length === 0) return err('usage');
    values.set(key, value);
  }
  if (values.size !== allowed.size) return err('usage');
  const marketId = values.get('market')!;
  values.delete('market');
  return ok({ command, marketId, values: Object.freeze(Object.fromEntries(values)) });
}

/**
 * Runs one operator command: the named Market's context from the factory (an unhosted Market is
 * refused), the Market's `SYSTEM` actor and a new correlation id; then the operator line (OS
 * user, host, command, Market, correlation id; never a flag's value) to the external log; then
 * the command. The audit row its use case writes carries the same correlation id, which links
 * the two (platform-audit 9.2). Output: one JSON line of codes and ids. Answers the exit code.
 */
export async function runOperatorCommand(
  app: INestApplicationContext,
  commands: readonly OperatorCommand[],
  argv: readonly string[],
  operator: OperatorIdentity,
  operatorLog: OperatorLog,
  write: (line: string) => void,
  usage: string,
): Promise<number> {
  const parsed = parseOperatorArguments(commands, argv);
  if (!parsed.ok) {
    write(usage);
    return OPERATOR_COMMAND_EXIT.refused;
  }
  const { command, marketId, values } = parsed.value;
  const market = app.get(MarketContextFactory).forMarket(marketId);
  const correlationId = parseCorrelationId(app.get<IdGenerator>(ID_GENERATOR).next<'operator'>());
  if (!market.ok || !correlationId.ok) {
    // The operator's input is not echoed.
    write(`${command.name}: that Market is not hosted by this stack`);
    return OPERATOR_COMMAND_EXIT.refused;
  }
  const context = createCallContext(market.value, systemActor(market.value), correlationId.value);
  try {
    await operatorLog(
      JSON.stringify({
        msg: 'operator-command',
        osUser: operator.osUser,
        host: operator.host,
        command: command.name,
        marketId: market.value.marketId,
        correlationId: context.correlationId,
      }),
    );
  } catch {
    write(`${command.name}: the operator log could not be written; nothing was done`);
    return OPERATOR_COMMAND_EXIT.refused;
  }
  const outcome = await command.run(app, context, values);
  write(
    JSON.stringify({
      command: command.name,
      marketId: market.value.marketId,
      correlationId: context.correlationId,
      ...outcome.body,
    }),
  );
  return outcome.done ? OPERATOR_COMMAND_EXIT.done : OPERATOR_COMMAND_EXIT.declined;
}
