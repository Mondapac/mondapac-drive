import type { StartedWorker } from './start-worker';

// The process entry itself (platform persistence design 8, PA7), not only the config loader:
// main.ts is loaded as `node dist/main` loads it, with the role entries and the `.env` loader
// replaced, and with process.exit, process.once and console.error observed.

jest.mock('./load-env-file', () => ({ loadEnvFile: jest.fn() }));
jest.mock('./start-api', () => ({ startApi: jest.fn() }));
jest.mock('./start-worker', () => ({ startWorker: jest.fn() }));

const BASE_ENV = {
  NODE_ENV: 'test',
  HOSTED_MARKETS: 'AU,ZZ',
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
};

/** Lets the entry's promise chains settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

interface Booted {
  readonly exit: jest.SpyInstance;
  readonly error: jest.SpyInstance;
  readonly listeners: Map<string, () => void>;
  readonly startApi: jest.Mock;
  readonly startWorker: jest.Mock;
}

/** Loads a fresh copy of main.ts under `env`, the role entries resolving as given. */
async function boot(
  env: Record<string, string>,
  started: { api?: unknown; worker?: Partial<StartedWorker> } = {},
): Promise<Booted> {
  const savedEnv = process.env;
  process.env = { ...env };
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const listeners = new Map<string, () => void>();
  jest
    .spyOn(process, 'once')
    .mockImplementation(
      ((signal: string, listener: () => void) =>
        listeners.set(signal, listener) && process) as never,
    );
  let startApi!: jest.Mock;
  let startWorker!: jest.Mock;
  try {
    // A fresh registry per case, so main.ts runs its entry again. require, not import(): the
    // dynamic import of this ESM-enabled Jest run does not go through ts-jest's CJS output.
    jest.isolateModules(() => {
      startApi = jest.requireMock<{ startApi: jest.Mock }>('./start-api').startApi;
      startWorker = jest.requireMock<{ startWorker: jest.Mock }>('./start-worker').startWorker;
      startApi.mockResolvedValue(started.api);
      startWorker.mockResolvedValue(started.worker);
      jest.requireActual('./main');
    });
    await settle();
  } finally {
    process.env = savedEnv;
  }
  return { exit, error, listeners, startApi, startWorker };
}

afterEach(() => jest.restoreAllMocks());

describe('the process entry, main.ts (P 8, PA7)', () => {
  it.each<[string, Record<string, string>]>([
    ['missing', { ...BASE_ENV }],
    ['empty', { ...BASE_ENV, APP_ROLE: '' }],
    ['unknown', { ...BASE_ENV, APP_ROLE: 'scheduler' }],
    ['of the wrong case', { ...BASE_ENV, APP_ROLE: 'Worker' }],
  ])('fails boot with exit 1 when APP_ROLE is %s, before either role starts', async (_c, env) => {
    const { exit, error, startApi, startWorker } = await boot(env);

    expect(error).toHaveBeenCalledWith(expect.stringMatching(/APP_ROLE is required/));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(startApi).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
  });

  it('starts the api role and only it, wiring no signal', async () => {
    const { exit, listeners, startApi, startWorker } = await boot(
      { ...BASE_ENV, APP_ROLE: 'api' },
      { api: {} },
    );

    expect(startApi).toHaveBeenCalledWith(expect.objectContaining({ appRole: 'api' }));
    expect(startWorker).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('exits 1 when a self-check refuses the api', async () => {
    const { exit } = await boot({ ...BASE_ENV, APP_ROLE: 'api' }, { api: undefined });

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when a self-check refuses the worker', async () => {
    const { exit, startApi } = await boot({ ...BASE_ENV, APP_ROLE: 'worker' });

    expect(exit).toHaveBeenCalledWith(1);
    expect(startApi).not.toHaveBeenCalled();
  });

  it.each(['SIGTERM', 'SIGINT'])('exits 0 after a clean worker stop on %s', async (signal) => {
    const stop = jest.fn().mockResolvedValue(undefined);
    const { exit, listeners, startApi } = await boot(
      { ...BASE_ENV, APP_ROLE: 'worker' },
      { worker: { stop } },
    );
    expect(startApi).not.toHaveBeenCalled();
    expect([...listeners.keys()]).toEqual(['SIGTERM', 'SIGINT']);
    expect(exit).not.toHaveBeenCalled();

    listeners.get(signal)!();
    await settle();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits 1 when the worker stop fails', async () => {
    const stop = jest.fn().mockRejectedValue(new Error('close failed'));
    const { exit, listeners } = await boot(
      { ...BASE_ENV, APP_ROLE: 'worker' },
      { worker: { stop } },
    );

    listeners.get('SIGTERM')!();
    await settle();

    expect(exit).toHaveBeenCalledWith(1);
  });
});
