import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { DECORATORS, DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { CLIENT_ADDRESS_HEADER } from './platform/http/client-address';
import { isMarketContextExempt } from './platform/market-context/market-context.guard';
import { takesMarketFromPath } from './platform/http/market-from-path.decorator';
import { MARKET_ID_HEADER } from './platform/market-context/market-id-header';

type PathItem = OpenAPIObject['paths'][string];
type Operation = NonNullable<PathItem['get']>;
type Parameter = NonNullable<Operation['parameters']>[number];
type ControllerClass = abstract new (...args: never[]) => unknown;

// The fields of a path item that are not operations. Every other key is treated as an
// operation, whatever its HTTP method (SEARCH, PROPFIND, ...), so none escapes the header.
const PATH_ITEM_FIELDS = new Set(['summary', 'description', 'servers', 'parameters', '$ref']);

const MARKET_ID_PARAMETER: Parameter = {
  name: MARKET_ID_HEADER,
  in: 'header',
  required: true,
  description:
    'The Market of the request: the code of a Market this Region Stack hosts. A missing, ' +
    'malformed or repeated value, or a Market that is not hosted here, is refused with 400 ' +
    'and the code market.header-missing, market.header-invalid or market.not-hosted.',
  schema: { type: 'string' },
};

const CLIENT_ADDRESS_PARAMETER: Parameter = {
  name: CLIENT_ADDRESS_HEADER,
  in: 'header',
  required: false,
  description:
    'Set only by a Mondapac BFF server (ADR-0037): `v1;k=<keyId>;t=<unix-seconds>;a=<address>;' +
    "s=<base64url HMAC-SHA-256>`, the browser's address proven under a key bound to the BFF's " +
    'network and to the x-market-id value. Any other client must not send it. A request from a ' +
    'BFF network without a valid proof, or a proof from anywhere else, is refused with 400 and ' +
    'the code client-address.untrusted.',
  schema: { type: 'string' },
};

/**
 * The operation id of a controller method. Set explicitly (not Swagger's default) because
 * `addMarketIdHeader` maps every id back to its controller class.
 */
export function operationIdOf(controllerKey: string, methodKey: string): string {
  return `${controllerKey}_${methodKey}`;
}

/** Builds the OpenAPI document from the controllers' decorators. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder().setTitle('Mondapac Drive API').setVersion('0.0.0').build();
  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey: string, methodKey: string) =>
      operationIdOf(controllerKey, methodKey),
  });
  return addClientAddressHeader(addMarketIdHeader(document, registeredControllers(app)));
}

/**
 * Adds the optional `x-client-address` header (ADR-0037) to every operation that carries
 * `x-market-id`: the client-address middleware skips only the health probes, which are exempt
 * from the Market too, so the two lists agree.
 */
export function addClientAddressHeader(document: OpenAPIObject): OpenAPIObject {
  for (const item of Object.values(document.paths)) {
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (PATH_ITEM_FIELDS.has(key)) continue;
      const operation = value as Operation;
      const isHeader = (parameter: Parameter, name: string): boolean =>
        'in' in parameter && parameter.in === 'header' && parameter.name.toLowerCase() === name;
      const parameters = operation.parameters ?? [];
      if (!parameters.some((parameter) => isHeader(parameter, MARKET_ID_HEADER))) continue;
      operation.parameters = [
        ...parameters.filter((parameter) => !isHeader(parameter, CLIENT_ADDRESS_HEADER)),
        { ...CLIENT_ADDRESS_PARAMETER },
      ];
    }
  }
  return document;
}

function registeredControllers(app: INestApplication): ControllerClass[] {
  const controllers = new Set<ControllerClass>();
  for (const moduleRef of app.get(ModulesContainer).values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      if (typeof wrapper.metatype === 'function') {
        controllers.add(wrapper.metatype as ControllerClass);
      }
    }
  }
  return [...controllers];
}

/**
 * Adds `x-market-id` as a required header parameter to every operation, except those of a
 * controller that `isMarketContextExempt` positively exempts: the predicate MarketContextGuard
 * uses, so the document and the guard agree (platform-foundations 5.1). No global parameter,
 * which would also mark `/health`.
 *
 * Fails closed instead of guessing whether an operation is exempt. It throws when:
 * - two registered controllers share a class name (their ids would be ambiguous);
 * - a route method sets its own operation id through `@ApiOperation` (an id is how an
 *   operation is mapped back to its controller, so it must be the generated one);
 * - an operation has no id, an id that maps to no route method of a registered controller,
 *   or an id that another operation of the document also uses.
 */
export function addMarketIdHeader(
  document: OpenAPIObject,
  controllers: readonly ControllerClass[],
): OpenAPIObject {
  const byName = new Map<string, ControllerClass>();
  for (const controller of controllers) {
    const other = byName.get(controller.name);
    if (other !== undefined && other !== controller) {
      throw new Error(`OpenAPI: two controllers share the class name "${controller.name}"`);
    }
    byName.set(controller.name, controller);
  }

  const scanner = new MetadataScanner();
  const byOperationId = new Map<string, ControllerClass>();
  for (const controller of byName.values()) {
    const prototype = controller.prototype as Record<string, unknown>;
    for (const method of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[method];
      // Route methods only: a helper method of a controller is never an operation.
      if (typeof handler !== 'function' || !Reflect.hasMetadata(PATH_METADATA, handler)) continue;

      const declared = Reflect.getMetadata(DECORATORS.API_OPERATION, handler) as
        { operationId?: unknown } | undefined;
      if (declared?.operationId !== undefined) {
        throw new Error(
          `OpenAPI: ${controller.name}.${method} sets its own operation id; ids are generated`,
        );
      }

      const id = operationIdOf(controller.name, method);
      const other = byOperationId.get(id);
      if (other !== undefined && other !== controller) {
        throw new Error(`OpenAPI: the operation id "${id}" fits two controllers`);
      }
      byOperationId.set(id, controller);
    }
  }

  const seen = new Map<string, string>();
  for (const [path, item] of Object.entries(document.paths)) {
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (PATH_ITEM_FIELDS.has(key)) continue;

      const name = `${key.toUpperCase()} ${path}`;
      if (typeof value !== 'object' || value === null) {
        throw new Error(`OpenAPI: ${name} is not an operation object`);
      }
      const operation = value as Operation;
      const id = operation.operationId;
      const controller = id === undefined ? undefined : byOperationId.get(id);
      if (id === undefined || controller === undefined) {
        throw new Error(
          `OpenAPI: ${name} maps to no registered controller (operation id ${JSON.stringify(id)})`,
        );
      }
      const first = seen.get(id);
      if (first !== undefined) {
        throw new Error(`OpenAPI: ${first} and ${name} share the operation id "${id}"`);
      }
      seen.set(id, name);

      if (isMarketContextExempt(controller) || takesMarketFromPath(controller)) continue;

      operation.parameters = [
        ...(operation.parameters ?? []).filter(
          (parameter) =>
            !(
              'in' in parameter &&
              parameter.in === 'header' &&
              parameter.name.toLowerCase() === MARKET_ID_HEADER
            ),
        ),
        { ...MARKET_ID_PARAMETER },
      ];
    }
  }
  return document;
}
