import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

/** One route of the application's routing table, read the way test/route-guards.e2e-spec.ts reads it. */
export interface TableRoute {
  controller: string;
  method: string;
  /** Upper case: GET, POST, ... as Nest names the request method. */
  verb: string;
  /** The whole path as Express routes it (`/api/v1/users/:id`), the handler's part included. */
  full: string;
}

const asList = (metadata: unknown): string[] =>
  (Array.isArray(metadata) ? metadata : [metadata ?? '']).map((part) => String(part));

const trimmed = (part: string): string => part.replace(/^\/+|\/+$/g, '');

/**
 * Every routed handler of every controller the app holds, from Nest's own
 * registry (DiscoveryService) and the metadata the route decorators wrote.
 * It does not ask the OpenAPI scanner anything: a document that lost a route
 * is found by comparing it with this, so this must not share its mistakes.
 */
export function routingTable(app: INestApplication): TableRoute[] {
  const scanner = new MetadataScanner();
  return app
    .get(DiscoveryService)
    .getControllers()
    .flatMap((wrapper) => {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) return [];
      const cls = wrapper.metatype as new (...args: never[]) => unknown;
      const bases = asList(Reflect.getMetadata(PATH_METADATA, cls));
      return scanner
        .getAllMethodNames(Object.getPrototypeOf(instance) as object)
        .filter((name) => Reflect.hasMetadata(PATH_METADATA, instance[name] as object))
        .flatMap((name) => {
          const handler = instance[name] as object;
          const verb = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
          return bases.flatMap((base) =>
            asList(Reflect.getMetadata(PATH_METADATA, handler)).map((own) => ({
              controller: cls.name,
              method: name,
              verb,
              full: `/${[base, own].map(trimmed).filter(Boolean).join('/')}`,
            })),
          );
        });
    });
}

/** `/api/v1/users/:id/invite` as an OpenAPI path: `/api/v1/users/{id}/invite`. */
export function openApiPathOf(full: string): string {
  return full.replace(/:([A-Za-z0-9_]+)(\([^)]*\))?\??/g, '{$1}');
}
