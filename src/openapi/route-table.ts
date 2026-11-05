import {
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  RequestMethod,
  type PipeTransform,
  type Type,
} from '@nestjs/common';
import { HEADERS_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { MetadataScanner, Reflector, type ModulesContainer } from '@nestjs/core';
import { AREA_KEY, type AreaRequirement } from '../auth/decorators/area.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';

/** Throttler's metadata keys (@nestjs/throttler/dist/throttler.constants); the default throttler is the only one the API names. */
const THROTTLER_LIMIT_DEFAULT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL_DEFAULT = 'THROTTLER:TTLdefault';

export type HttpVerb = 'get' | 'post' | 'put' | 'delete' | 'patch' | 'options' | 'head';

/** What a pipe on a path parameter says about the value: the part of the contract a document can state. */
export type ParamKind = 'uuid' | 'integer' | 'boolean';

export interface RouteInfo {
  controller: Type<unknown>;
  method: string;
  verb: HttpVerb;
  /** The operationId the document gives the route: unique per controller class and method. */
  operationId: string;
  roles: readonly string[] | undefined;
  area: AreaRequirement | undefined;
  isPublic: boolean;
  /** The route's own rate limit (@Throttle), when it names one. */
  throttle: { limit: number; ttlSeconds: number } | undefined;
  /** Sets Content-Disposition or writes the response itself (@Res): a route that answers a file, not JSON. */
  file: { contentType: string | undefined } | undefined;
  /** What the pipes on the route's named path and query parameters say, by parameter name. */
  paramKinds: { path: Readonly<Record<string, ParamKind>>; query: Readonly<Record<string, ParamKind>> };
  /** The route reads a request body (@Body). */
  hasBody: boolean;
}

/** The operationId of a handler: the document's, the route table's and the test's one name for it. */
export function operationIdOf(controller: string, method: string): string {
  return `${controller}_${method}`;
}

const VERBS = new Map<RequestMethod, HttpVerb>([
  [RequestMethod.GET, 'get'],
  [RequestMethod.POST, 'post'],
  [RequestMethod.PUT, 'put'],
  [RequestMethod.DELETE, 'delete'],
  [RequestMethod.PATCH, 'patch'],
  [RequestMethod.OPTIONS, 'options'],
  [RequestMethod.HEAD, 'head'],
]);

interface RouteArg {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

/** A pipe is given as an instance (`new ParseUUIDPipe(...)`) or as its class (`ParseIntPipe`): either is one of that kind. */
function isPipeOf(pipe: unknown, kind: abstract new (...args: never[]) => PipeTransform): boolean {
  return pipe instanceof kind || (typeof pipe === 'function' && (pipe === kind || pipe.prototype instanceof kind));
}

function kindOfPipe(pipe: unknown): ParamKind | undefined {
  if (isPipeOf(pipe, ParseUUIDPipe)) return 'uuid';
  if (isPipeOf(pipe, ParseIntPipe)) return 'integer';
  if (isPipeOf(pipe, ParseBoolPipe)) return 'boolean';
  return undefined;
}

/**
 * Every routed handler of every controller, with what the guards and pipes say
 * about it. The paths themselves are not read here: @nestjs/swagger derives
 * them (global prefix, versioning, the controller's own path) and this adds to
 * the operation it made, found by its operationId.
 */
export function routesOf(modules: ModulesContainer): RouteInfo[] {
  const scanner = new MetadataScanner();
  const reflector = new Reflector();
  const routes: RouteInfo[] = [];
  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type<unknown> | null;
      if (!controller) continue;
      const prototype = controller.prototype as Record<string, unknown>;
      for (const method of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[method] as (...args: never[]) => unknown;
        const verb = VERBS.get(Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod);
        if (!verb) continue;
        const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as Record<string, RouteArg> | undefined) ?? {};
        const headers = (Reflect.getMetadata(HEADERS_METADATA, handler) as Array<{ name: string; value: string }> | undefined) ?? [];
        const writesItself = Object.keys(args).some((key) => key.startsWith(`${RouteParamtypes.RESPONSE}:`));
        const disposition = headers.some((header) => header.name.toLowerCase() === 'content-disposition');
        const contentType = headers.find((header) => header.name.toLowerCase() === 'content-type')?.value;
        const paramKinds: RouteInfo['paramKinds'] = { path: {}, query: {} };
        for (const [key, arg] of Object.entries(args)) {
          const where = key.startsWith(`${RouteParamtypes.PARAM}:`) ? 'path' : key.startsWith(`${RouteParamtypes.QUERY}:`) ? 'query' : undefined;
          if (!where || typeof arg.data !== 'string') continue;
          const kind = (arg.pipes ?? []).map(kindOfPipe).find((found) => found !== undefined);
          if (kind) (paramKinds[where] as Record<string, ParamKind>)[arg.data] = kind;
        }
        const limit = reflector.getAllAndOverride<number | undefined>(THROTTLER_LIMIT_DEFAULT, [handler, controller]);
        const ttl = reflector.getAllAndOverride<number | undefined>(THROTTLER_TTL_DEFAULT, [handler, controller]);
        routes.push({
          controller,
          method,
          verb,
          operationId: operationIdOf(controller.name, method),
          roles: reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [handler, controller]),
          area: reflector.getAllAndOverride<AreaRequirement | undefined>(AREA_KEY, [handler, controller]),
          isPublic: reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [handler, controller]) === true,
          throttle: typeof limit === 'number' && typeof ttl === 'number' ? { limit, ttlSeconds: Math.round(ttl / 1000) } : undefined,
          file: writesItself || disposition ? { contentType } : undefined,
          paramKinds,
          hasBody: Object.keys(args).some((key) => key.startsWith(`${RouteParamtypes.BODY}:`)),
        });
      }
    }
  }
  return routes;
}
