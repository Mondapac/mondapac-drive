import type { INestApplicationContext } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { TEST_MARKETS } from '../../../test/support/test-config';
import { ID_GENERATOR } from '../ids/ids.module';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import {
  OPERATOR_COMMAND_EXIT,
  parseOperatorArguments,
  runOperatorCommand,
  type OperatorCommand,
} from './operator-command';

// The platform runner of operator commands (platform-audit 9.2; identity design 7.4; slice 7b):
// its arguments, the Market's SYSTEM context it builds, the operator line written before the
// command acts (a failed line refuses), and an output of codes and ids only.

const EMAIL = 'Root.Admin@Example.com';
const USAGE = 'usage: test-command <act> --market <id> --email <address>';
const OPERATOR = { osUser: 'ops', host: 'bastion-1' };

function commandRecording(done = true) {
  const runs: { context: CallContext; values: Readonly<Record<string, string>> }[] = [];
  const command: OperatorCommand = {
    name: 'act',
    flags: ['email'],
    run: (_app, context, values) => {
      runs.push({ context, values });
      return Promise.resolve({
        done,
        body: done ? { outcome: 'acted', id: 'id-1' } : { outcome: 'act.refused' },
      });
    },
  };
  return { command, runs };
}

describe('parseOperatorArguments', () => {
  const { command } = commandRecording();

  it.each([
    [['act', '--market', 'AU', '--email', EMAIL]],
    [['act', '--email', EMAIL, '--market', 'AU']],
  ])('reads %j', (argv) => {
    expect(parseOperatorArguments([command], argv)).toEqual(
      ok({ command, marketId: 'AU', values: { email: EMAIL } }),
    );
  });

  it.each([
    [[]],
    [['other', '--market', 'AU', '--email', EMAIL]],
    [['act', '--market', 'AU']],
    [['act', '--email', EMAIL]],
    [['act', '--market', 'AU', '--email']],
    [['act', '--market', 'AU', '--email', '']],
    [['act', '--market', 'AU', '--market', 'ZZ', '--email', EMAIL]],
    [['act', '--market', 'AU', '--email', EMAIL, '--extra', 'x']],
    [['act', 'market', 'AU', '--email', EMAIL]],
    [['act', '--market=AU', '--email', EMAIL]],
  ])('refuses %j', (argv) => {
    expect(parseOperatorArguments([command], argv)).toEqual(err('usage'));
  });
});

describe.each(TEST_MARKETS)('runOperatorCommand for market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);

  function appFor() {
    const factory = {
      forMarket: (requested: string) =>
        requested === code ? ok(market) : err({ code: 'market.not-hosted' }),
    };
    const ids = new SequenceIdGenerator(
      new FixedClock(Temporal.Instant.from('2026-10-08T06:00:00Z')),
    );
    return {
      get: (token: unknown) =>
        token === MarketContextFactory ? factory : token === ID_GENERATOR ? ids : undefined,
    } as unknown as INestApplicationContext;
  }

  it('writes the operator line first, then runs the command as the Market system actor', async () => {
    const { command, runs } = commandRecording();
    const order: string[] = [];
    const logged: string[] = [];
    const output: string[] = [];

    const exit = await runOperatorCommand(
      appFor(),
      [command],
      ['act', '--market', code, '--email', EMAIL],
      OPERATOR,
      (line) => {
        order.push('log');
        logged.push(line);
        return Promise.resolve();
      },
      (line) => {
        order.push('output');
        output.push(line);
      },
      USAGE,
    );

    expect(exit).toBe(OPERATOR_COMMAND_EXIT.done);
    expect(order).toEqual(['log', 'output']);
    expect(runs).toHaveLength(1);
    const context = runs[0]!.context;
    expect(context.actor.kind).toBe('system');
    expect(context.market.marketId).toBe(code);
    expect(runs[0]!.values).toEqual({ email: EMAIL });

    const line = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(line).toEqual({
      msg: 'operator-command',
      osUser: 'ops',
      host: 'bastion-1',
      command: 'act',
      marketId: code,
      correlationId: context.correlationId,
    });
    expect(JSON.parse(output[0]!)).toEqual({
      command: 'act',
      marketId: code,
      correlationId: context.correlationId,
      outcome: 'acted',
      id: 'id-1',
    });
    // The address is personal data: never in the operator line or the output.
    expect([...logged, ...output].join('\n')).not.toContain(EMAIL);
    expect([...logged, ...output].join('\n').toLowerCase()).not.toContain(EMAIL.toLowerCase());
  });

  it('refuses, and runs nothing, when the operator line cannot be written', async () => {
    const { command, runs } = commandRecording();
    const output: string[] = [];

    const exit = await runOperatorCommand(
      appFor(),
      [command],
      ['act', '--market', code, '--email', EMAIL],
      OPERATOR,
      () => Promise.reject(new Error('sink down')),
      (line) => output.push(line),
      USAGE,
    );

    expect(exit).toBe(OPERATOR_COMMAND_EXIT.refused);
    expect(runs).toEqual([]);
    expect(output).toEqual(['act: the operator log could not be written; nothing was done']);
  });

  it('refuses a Market this stack does not host, before any line or run, without echoing it', async () => {
    const { command, runs } = commandRecording();
    const logged: string[] = [];
    const output: string[] = [];

    const exit = await runOperatorCommand(
      appFor(),
      [command],
      ['act', '--market', 'QQ', '--email', EMAIL],
      OPERATOR,
      (line) => {
        logged.push(line);
        return Promise.resolve();
      },
      (line) => output.push(line),
      USAGE,
    );

    expect(exit).toBe(OPERATOR_COMMAND_EXIT.refused);
    expect(runs).toEqual([]);
    expect(logged).toEqual([]);
    expect(output).toEqual(['act: that Market is not hosted by this stack']);
  });

  it('prints the usage for malformed arguments and runs nothing', async () => {
    const { command, runs } = commandRecording();
    const output: string[] = [];

    const exit = await runOperatorCommand(
      appFor(),
      [command],
      ['act', '--market', code],
      OPERATOR,
      () => Promise.resolve(),
      (line) => output.push(line),
      USAGE,
    );

    expect(exit).toBe(OPERATOR_COMMAND_EXIT.refused);
    expect(runs).toEqual([]);
    expect(output).toEqual([USAGE]);
  });

  it('exits 2 with the use case code when the command declines', async () => {
    const { command } = commandRecording(false);
    const output: string[] = [];

    const exit = await runOperatorCommand(
      appFor(),
      [command],
      ['act', '--market', code, '--email', EMAIL],
      OPERATOR,
      () => Promise.resolve(),
      (line) => output.push(line),
      USAGE,
    );

    expect(exit).toBe(OPERATOR_COMMAND_EXIT.declined);
    expect(JSON.parse(output[0]!)).toMatchObject({ outcome: 'act.refused', marketId: code });
  });
});
