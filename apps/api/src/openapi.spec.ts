import { Controller, Get, Post, Propfind, Search } from '@nestjs/common';
import { ApiOperation, type OpenAPIObject } from '@nestjs/swagger';
import { addMarketIdHeader, operationIdOf } from './openapi';
import { HealthController } from './platform/health/health.controller';

@Controller('offers')
class OffersController {
  @Get()
  list(): string[] {
    return [];
  }

  @Post()
  create(): void {}

  @Search()
  search(): string[] {
    return [];
  }

  @Propfind()
  properties(): string[] {
    return [];
  }

  /** Not a route: its name must never map an operation id. */
  helper(): void {}
}

@Controller('renamed')
class RenamingController {
  @Get()
  @ApiOperation({ operationId: 'HealthController_check' })
  read(): string {
    return 'renamed';
  }
}

function twinController(path: string): new () => object {
  @Controller(path)
  class TwinController {
    @Get()
    read(): string {
      return path;
    }
  }
  return TwinController;
}

type Operations = Record<string, Record<string, string>>;

/** A minimal document: path -> HTTP method -> operation id. */
function documentWith(operations: Operations): OpenAPIObject {
  const paths: OpenAPIObject['paths'] = {};
  for (const [path, methods] of Object.entries(operations)) {
    paths[path] = Object.fromEntries(
      Object.entries(methods).map(([method, operationId]) => [
        method,
        { operationId, responses: {}, parameters: [] },
      ]),
    );
  }
  return { openapi: '3.0.0', info: { title: 'test', version: '0' }, paths };
}

function headerOf(document: OpenAPIObject, path: string, method: string): unknown {
  const item = document.paths[path] as Record<string, { parameters?: object[] }> | undefined;
  return item?.[method]?.parameters?.find(
    (parameter) => 'in' in parameter && parameter.in === 'header',
  );
}

describe('addMarketIdHeader', () => {
  const operations: Operations = {
    '/health': { get: operationIdOf('HealthController', 'check') },
    '/offers': {
      get: operationIdOf('OffersController', 'list'),
      post: operationIdOf('OffersController', 'create'),
    },
  };

  it('adds x-market-id as a required header to every operation of a market-scoped controller', () => {
    const document = addMarketIdHeader(documentWith(operations), [
      HealthController,
      OffersController,
    ]);

    for (const method of ['get', 'post'] as const) {
      expect(headerOf(document, '/offers', method)).toMatchObject({
        name: 'x-market-id',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });
    }
  });

  it('skips only the operations of an exempt controller', () => {
    const document = addMarketIdHeader(documentWith(operations), [
      HealthController,
      OffersController,
    ]);

    expect(headerOf(document, '/health', 'get')).toBeUndefined();
  });

  it('replaces a declared x-market-id parameter instead of adding a second one', () => {
    const input = documentWith(operations);
    input.paths['/offers']!.get!.parameters = [
      { name: 'x-market-id', in: 'header', required: false },
    ];

    const parameters = addMarketIdHeader(input, [HealthController, OffersController]).paths[
      '/offers'
    ]?.get?.parameters;

    expect(parameters).toHaveLength(1);
    expect(parameters?.[0]).toMatchObject({ name: 'x-market-id', required: true });
  });

  it('throws when an operation id maps to no registered controller', () => {
    expect(() => addMarketIdHeader(documentWith(operations), [HealthController])).toThrow(
      /(GET|POST) \/offers maps to no registered controller/,
    );
  });

  it('throws when an operation has no id', () => {
    const input = documentWith(operations);
    delete input.paths['/offers']!.get!.operationId;

    expect(() => addMarketIdHeader(input, [HealthController, OffersController])).toThrow(
      /GET \/offers/,
    );
  });

  it('throws when two registered controllers share a class name', () => {
    const document = documentWith({ '/a': { get: operationIdOf('TwinController', 'read') } });

    expect(() => addMarketIdHeader(document, [twinController('a'), twinController('b')])).toThrow(
      /TwinController/,
    );
  });

  it.each([
    ['search', 'search'],
    ['propfind', 'properties'],
  ])(
    'adds the header to a %s operation too: every method of a path item counts',
    (verb, method) => {
      const document = addMarketIdHeader(
        documentWith({ '/offers': { [verb]: operationIdOf('OffersController', method) } }),
        [OffersController],
      );

      expect(headerOf(document, '/offers', verb)).toMatchObject({
        name: 'x-market-id',
        required: true,
      });
    },
  );

  it('throws on a path item key that holds no operation object', () => {
    const input = documentWith(operations);
    (input.paths['/offers'] as Record<string, unknown>)['x-extension'] = 'text';

    expect(() => addMarketIdHeader(input, [HealthController, OffersController])).toThrow(
      /X-EXTENSION \/offers is not an operation/,
    );
  });

  it('throws when two operations share an operation id', () => {
    const input = documentWith({
      '/health': { get: operationIdOf('HealthController', 'check') },
      '/offers': { get: operationIdOf('HealthController', 'check') },
    });

    expect(() => addMarketIdHeader(input, [HealthController, OffersController])).toThrow(
      /share the operation id "HealthController_check"/,
    );
  });

  it('throws when a route method sets its own operation id through @ApiOperation', () => {
    const input = documentWith({ '/renamed': { get: operationIdOf('HealthController', 'check') } });

    expect(() => addMarketIdHeader(input, [HealthController, RenamingController])).toThrow(
      /RenamingController.read sets its own operation id/,
    );
  });

  it('maps ids to route methods only: a helper method maps no operation', () => {
    const input = documentWith({ '/offers': { get: operationIdOf('OffersController', 'helper') } });

    expect(() => addMarketIdHeader(input, [OffersController])).toThrow(
      /GET \/offers maps to no registered controller/,
    );
  });
});
