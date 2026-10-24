import { readdirSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import path from 'node:path';
import { Inject, Module, type INestApplicationContext, type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import type { EventDescription } from '@mondapac-drive/shared-kernel';
import pino from 'pino';
import { AppModule } from '../../src/app.module';
import { CORE_MODULES } from '../../src/modules';
import { compareWithSnapshot, EventCatalogue } from '../../src/platform/events/event-catalogue';
import { SubscriptionRegistry } from '../../src/platform/events/event-subscriptions';
import { OUTBOX_WRITER } from '../../src/platform/events/outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import {
  RAW_READ_PORT,
  type RawReadPort,
} from '../../src/platform/persistence/raw-reads/raw-read-port';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { JobRegistry } from '../../src/platform/scheduler/job-registry';
import { WorkerRuntime } from '../../src/platform/worker/worker-runtime';
import { testAppConfig } from '../support/test-config';

// The contracts test of platform persistence design 5.3 and the "one module graph" of 8: the
// catalogue is built from the booted application, in both roles, and compared with the
// checked-in snapshot of every event type and its fields. A new type fails until the snapshot
// changes (so the security review sees each one); a changed field list of an existing version
// fails with "publish a new version". To accept a new type, add its entry, as the failure
// prints it, to event-catalogue.snapshot.json.

const SNAPSHOT = path.join(__dirname, 'event-catalogue.snapshot.json');
const MODULES_DIR = path.join(__dirname, '../../src/modules');

async function boot(role: 'api' | 'worker'): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.register({
        config: testAppConfig({ APP_ROLE: role }),
        logDestination: pino.destination(devNull),
      }),
    ],
  }).compile();
  return moduleRef.init();
}

describe('event catalogue and registries of the booted application (P 5.3, 8)', () => {
  const graphs = new Map<'api' | 'worker', INestApplicationContext>();

  beforeAll(async () => {
    for (const role of ['api', 'worker'] as const) graphs.set(role, await boot(role));
  });

  afterAll(async () => {
    for (const graph of graphs.values()) await graph.close();
  });

  it('matches the checked-in snapshot of every event type and its fields', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as EventDescription[];
    const current = graphs.get('api')!.get(EventCatalogue).snapshot();

    expect({ problems: compareWithSnapshot(current, snapshot), current }).toEqual({
      problems: [],
      current,
    });
  });

  it('seals the catalogue and the job registry once the application has bootstrapped', () => {
    expect(graphs.get('api')!.get(EventCatalogue).sealed).toBe(true);
    expect(() => graphs.get('api')!.get(JobRegistry).register('delivery', [])).toThrow(/sealed/);
  });

  it('builds the same catalogue and the same jobs in both roles', () => {
    const api = graphs.get('api')!;
    const worker = graphs.get('worker')!;

    expect(worker.get(EventCatalogue).snapshot()).toEqual(api.get(EventCatalogue).snapshot());
    expect(worker.get(JobRegistry).names()).toEqual(api.get(JobRegistry).names());
    expect(worker.get(SubscriptionRegistry).names()).toEqual(api.get(SubscriptionRegistry).names());
  });

  it("registers identity's mail and the delivery subscriptions of dispatch, notifications and tracking and seals the registry (P 6.4)", () => {
    const subscriptions = graphs.get('worker')!.get(SubscriptionRegistry);

    expect(subscriptions.names()).toEqual([
      'delivery.courier-assigned',
      'delivery.dispatch-exhausted',
      'dispatch.cancel-job',
      'dispatch.follow-delivery-status',
      'dispatch.open-job',
      'identity.invitation-mail',
      'identity.link-mail',
      'identity.other-sessions-signed-out-mail',
      'identity.password-changed-mail',
      'identity.second-factor-mail',
      'notifications.delivery-booked',
      'notifications.delivery-cancelled',
      'notifications.delivery-status-changed',
      'tracking.delivery-booked',
      'tracking.delivery-cancelled',
      'tracking.delivery-status-changed',
    ]);
    expect(subscriptions.subscribersOf('delivery.booked.v1')).toEqual([
      'dispatch.open-job',
      'notifications.delivery-booked',
      'tracking.delivery-booked',
    ]);
    expect(subscriptions.subscribersOf('delivery.status-changed.v1')).toEqual([
      'dispatch.follow-delivery-status',
      'notifications.delivery-status-changed',
      'tracking.delivery-status-changed',
    ]);
    expect(subscriptions.subscribersOf('delivery.cancelled.v1')).toEqual([
      'dispatch.cancel-job',
      'notifications.delivery-cancelled',
      'tracking.delivery-cancelled',
    ]);
    expect(subscriptions.subscribersOf('identity.invitation-issued.v1')).toEqual([
      'identity.invitation-mail',
    ]);
    expect(subscriptions.subscribersOf('identity.one-time-link-requested.v1')).toEqual([
      'identity.link-mail',
    ]);
    expect(subscriptions.subscribersOf('identity.account-password-changed.v1')).toEqual([
      'identity.password-changed-mail',
    ]);
    expect(subscriptions.subscribersOf('identity.account-other-sessions-signed-out.v1')).toEqual([
      'identity.other-sessions-signed-out-mail',
    ]);
    expect(subscriptions.subscribersOf('identity.second-factor-changed.v1')).toEqual([
      'identity.second-factor-mail',
    ]);
    expect(subscriptions.subscribersOf('dispatch.courier-assigned.v1')).toEqual([
      'delivery.courier-assigned',
    ]);
    expect(subscriptions.subscribersOf('dispatch.job-exhausted.v1')).toEqual([
      'delivery.dispatch-exhausted',
    ]);
    expect(subscriptions.sealed).toBe(true);
  });

  it('has the worker runtime in both graphs, started by neither', () => {
    for (const graph of graphs.values()) {
      expect(graph.get(WorkerRuntime)).toBeInstanceOf(WorkerRuntime);
    }
  });
});

describe("every module's outbox writer binding names its own folder (P 5.2)", () => {
  const folders = readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  /** The module name each OUTBOX_WRITER provider of a Nest module asks the factory for. */
  function boundNames(module: object): string[] {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, module) ?? []) as Provider[];
    const names: string[] = [];
    const forModule = jest
      .spyOn(PrismaOutboxWriterFactory.prototype, 'forModule')
      .mockImplementation((name) => {
        names.push(name);
        return { append: () => Promise.resolve() };
      });
    try {
      for (const provider of providers) {
        if (
          typeof provider === 'object' &&
          'provide' in provider &&
          provider.provide === OUTBOX_WRITER
        ) {
          // The dependencies are not used until append; the spy records the name.
          (provider as { useFactory: (...deps: never[]) => unknown }).useFactory();
        }
      }
    } finally {
      forModule.mockRestore();
    }
    return names;
  }

  it('has one Nest module per folder, in CORE_MODULES', () => {
    expect(CORE_MODULES).toHaveLength(folders.length);
  });

  it.each(folders)('%s binds no writer, or one for itself', (folder) => {
    const module = CORE_MODULES.find(
      (candidate) => candidate.name.toLowerCase() === `${folder.replaceAll('-', '')}module`,
    );
    expect(module).toBeDefined();

    expect(boundNames(module!).every((name) => name === folder)).toBe(true);
  });

  // The provider walk above sees only `provide: OUTBOX_WRITER` on each root Nest module; a
  // renamed token, a wrapping factory or a submodule would slip past it (security re-review of
  // slice 1b, NEW-L1). So the source is scanned too: outside persistence.module.ts, the only
  // allowed use is `PersistenceModule.outboxWriterFor('<m>')`, once, in modules/<m>/<m>.module.ts.
  it('calls outboxWriterFor only once per module, in its own <m>.module.ts, with its folder name', () => {
    const SRC = path.join(__dirname, '../../src');
    const DEFINITION = path.join('platform', 'persistence', 'persistence.module.ts');
    const offenders: string[] = [];

    for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
        continue;
      }
      const file = path.relative(SRC, path.join(entry.parentPath, entry.name));
      if (file === DEFINITION) continue;
      // Comments may name the helper (its own documentation does); code may not.
      const code = readFileSync(path.join(SRC, file), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '');
      const count = code.split('outboxWriterFor').length - 1;
      if (count === 0) continue;

      const [top, folder, name] = file.split(path.sep);
      const allowed =
        top === 'modules' &&
        name === `${folder}.module.ts` &&
        count === 1 &&
        new RegExp(`(?<![.\\w])PersistenceModule\\.outboxWriterFor\\('${folder}'\\),`).test(code);
      if (!allowed) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});

describe('a module binds only its own raw read port (ADR-0030; Hassan R-1)', () => {
  it('calls rawReadFor only once per module, in its own <m>.module.ts, with its folder name', () => {
    const SRC = path.join(__dirname, '../../src');
    const DEFINITION = path.join('platform', 'persistence', 'persistence.module.ts');
    const offenders: string[] = [];

    for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) {
        continue;
      }
      const file = path.relative(SRC, path.join(entry.parentPath, entry.name));
      if (file === DEFINITION) continue;
      const code = readFileSync(path.join(SRC, file), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '');
      const count = code.split('rawReadFor').length - 1;
      if (count === 0) continue;

      const [top, folder, name] = file.split(path.sep);
      const allowed =
        top === 'modules' &&
        name === `${folder}.module.ts` &&
        count === 1 &&
        new RegExp(`(?<![.\\w])PersistenceModule\\.rawReadFor\\('${folder}'\\),`).test(code);
      if (!allowed) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('boots in the real graph: a module that binds rawReadFor gets its own port', async () => {
    @Module({ providers: [PersistenceModule.rawReadFor('delivery')] })
    class BoundModule {
      constructor(@Inject(RAW_READ_PORT) readonly port: RawReadPort) {}
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ APP_ROLE: 'api' }),
          logDestination: pino.destination(devNull),
        }),
        BoundModule,
      ],
    }).compile();
    expect(typeof moduleRef.get(BoundModule).port.rawRead).toBe('function');
    await moduleRef.close();
  });
});

describe('a module reaches only its own outbox writer (P 5.2; security review of slice 1b, M1)', () => {
  /** Compiles the application graph plus one module whose provider injects `token`. */
  function compileWith(token: unknown): Promise<unknown> {
    @Module({ providers: [{ provide: 'ROGUE', inject: [token as symbol], useFactory: () => 1 }] })
    class RogueModule {}
    return Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ APP_ROLE: 'api' }),
          logDestination: pino.destination(devNull),
        }),
        RogueModule,
      ],
    }).compile();
  }

  it('cannot resolve the outbox writer factory: it is not a provider', async () => {
    await expect(compileWith(PrismaOutboxWriterFactory)).rejects.toThrow(
      /can't resolve dependencies/i,
    );
  });

  it("cannot resolve another module's writer (no module exports its OUTBOX_WRITER)", async () => {
    await expect(compileWith(OUTBOX_WRITER)).rejects.toThrow(/can't resolve dependencies/i);
  });

  it('exports, from no module of the graph, anything that hands out a writer by module name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ APP_ROLE: 'api' }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();
    const container = (
      moduleRef as unknown as {
        container: { getModules(): Map<string, { metatype: object; exports: Set<unknown> }> };
      }
    ).container;
    const offenders: string[] = [];
    for (const nestModule of container.getModules().values()) {
      for (const token of nestModule.exports) {
        let instance: unknown;
        try {
          instance = moduleRef.get(token as symbol, { strict: false });
        } catch {
          continue; // A re-exported module, not a provider.
        }
        if (
          instance instanceof PrismaOutboxWriterFactory ||
          (typeof instance === 'object' && instance !== null && 'forModule' in instance)
        ) {
          offenders.push(`${(nestModule.metatype as { name: string }).name}:${String(token)}`);
        }
      }
    }
    await moduleRef.close();

    expect(offenders).toEqual([]);
  });
});
