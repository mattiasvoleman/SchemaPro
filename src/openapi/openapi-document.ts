import { readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type OperationObject,
  type ParameterObject,
  type PathItemObject,
  type ReferenceObject,
  type ResponseObject,
  type SchemaObject,
} from '@nestjs/swagger';
import type { ProblemDetails } from '../common/interfaces/problem-details.interface';
import { API_DESCRIPTION, BEARER_DESCRIPTION, SCHOOL_HEADER_NAME, SCHOOL_PARAMETER_DESCRIPTION } from './description';
import { operationIdOf, routesOf, type HttpVerb, type RouteInfo } from './route-table';

/** The routes the document describes: the gateway's own, versioned in the path. */
export const API_PREFIX = '/api/v1/';

/** The order an OpenAPI path item lists its operations in. */
const VERB_ORDER: readonly HttpVerb[] = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

const SCHEMA = '#/components/schemas/';

/**
 * The error body (src/common/filters/http-exception.filter.ts renders it).
 * `satisfies` is the check that the schema names every member of
 * ProblemDetails and nothing else: a member added to the interface fails the
 * typecheck here until it is described.
 */
const PROBLEM_PROPERTIES = {
  type: { type: 'string', description: 'Problemtypen; alltid `about:blank`.', example: 'about:blank' },
  title: { type: 'string', description: 'Statusens korta namn.', example: 'Bad Request' },
  status: { type: 'integer', description: 'HTTP-statusen.', example: 400 },
  detail: { type: 'string', description: 'Vad som gick fel, för den som läser.' },
  instance: { type: 'string', description: 'Sökvägen som anropades.' },
  traceId: { type: 'string', format: 'uuid', description: 'Ett id som gatewayens logg kan matchas mot. Interna detaljer lämnar aldrig gatewayen; de loggas under det.' },
  errors: {
    type: 'object',
    description: 'Fältvisa valideringsfel, när `detail` säger att fält inte höll för sina regler.',
    additionalProperties: { type: 'array', items: { type: 'string' } },
  },
  code: {
    type: 'string',
    pattern: '^[A-Za-z0-9_.:-]{1,64}$',
    description: 'Ett maskinläsbart namn på problemet, för den som ska förgrena på det i stället för att tolka `detail`.',
    example: 'AREA_NOT_YOURS',
  },
  params: {
    type: 'object',
    description: 'Värdena som kodens mening sätter in. Finns bara tillsammans med `code`.',
    additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] },
  },
} satisfies Record<keyof ProblemDetails, SchemaObject>;

const PROBLEM_SCHEMA: SchemaObject = {
  type: 'object',
  description: 'Felets form: RFC 7807 `application/problem+json`. Det är den enda form gatewayen svarar fel med.',
  properties: PROBLEM_PROPERTIES,
  required: ['type', 'title', 'status', 'detail', 'instance', 'traceId'],
};

const problem = (description: string): ResponseObject => ({
  description,
  content: { 'application/problem+json': { schema: { $ref: `${SCHEMA}Problem` } } },
});

const COMMON_RESPONSES: Readonly<Record<string, ResponseObject>> = {
  BadRequest: problem(
    'Förfrågan är ogiltig: ett fält som inte höll för sina regler (`errors`), ett fält som inte finns, ett id som inte är ett UUID eller en `X-School-Id` som inte är ett skol-id.',
  ),
  Unauthorized: problem('Anropet bär ingen giltig token.'),
  Forbidden: problem(
    'Personens roll eller administratörsprofil får inte anropet (`x-roles`, `x-admin-write`), eller kontot har ingen aktiv roll på den skola som anropet pekar ut. `code` säger vilket.',
  ),
  TooManyRequests: {
    ...problem('För många anrop från samma adress inom tidsfönstret. Vänta `Retry-After` sekunder.'),
    headers: {
      'Retry-After': { description: 'Sekunder tills anropet kan göras igen.', schema: { type: 'integer' } },
    },
  },
};

/** The status each common response answers, in the order the operations list them. */
const COMMON_STATUSES: ReadonlyArray<readonly [string, string]> = [
  ['400', 'BadRequest'],
  ['401', 'Unauthorized'],
  ['403', 'Forbidden'],
  ['429', 'TooManyRequests'],
];

const SCHOOL_PARAMETER: ParameterObject = {
  name: SCHOOL_HEADER_NAME,
  in: 'header',
  required: false,
  description: SCHOOL_PARAMETER_DESCRIPTION,
  schema: { type: 'string', format: 'uuid' },
};

const packageVersion = (): string =>
  (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;

const PARAM_SCHEMAS: Readonly<Record<string, SchemaObject>> = {
  uuid: { type: 'string', format: 'uuid' },
  integer: { type: 'integer' },
  boolean: { type: 'boolean' },
};

/**
 * The keywords of a schema in the order the document writes them. @nestjs/swagger
 * builds a schema by adding to it as it learns more, and what it learns first
 * depends on what the process built before (an enum it has met already is
 * found, not made), so the same class can come out `type, enum` the first time
 * and `enum, type` the next. A document must not depend on that: the keywords
 * are written in this order, any others after them alphabetically.
 *
 * An enum's values are sorted for the same reason. The plugin reads them off
 * the type checker's union, whose members come in the order the checker first
 * met them: that is the order of the compile (`nest build` and the language
 * service of a test run meet them differently, and a test run differently
 * again once a file changes), and it is no order the schema means anything by.
 */
const KEYWORD_ORDER = [
  '$ref', 'type', 'format', 'nullable', 'enum', 'default', 'example', 'title', 'description', 'pattern',
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'items', 'minProperties', 'maxProperties', 'properties', 'required',
  'additionalProperties', 'allOf', 'oneOf', 'anyOf', 'not', 'discriminator', 'readOnly', 'writeOnly', 'deprecated', 'externalDocs', 'xml',
];

const rank = (keyword: string): number => {
  const index = KEYWORD_ORDER.indexOf(keyword);
  return index === -1 ? KEYWORD_ORDER.length : index;
};

/** An enum's values in code-unit order: the same on every machine, whatever the locale. */
const byValue = (a: unknown, b: unknown): number => {
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

export function canonicalSchema<T extends SchemaObject | ReferenceObject>(schema: T): T {
  const source = schema as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const keyword of Object.keys(source).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))) {
    const value = source[keyword];
    if (keyword === 'properties' && value && typeof value === 'object') {
      // The members keep the order they are declared in; each one is a schema.
      ordered[keyword] = Object.fromEntries(Object.entries(value).map(([name, member]) => [name, canonicalSchema(member as SchemaObject)]));
    } else if ((keyword === 'items' || keyword === 'not' || keyword === 'additionalProperties') && value && typeof value === 'object') {
      ordered[keyword] = canonicalSchema(value as SchemaObject);
    } else if ((keyword === 'allOf' || keyword === 'oneOf' || keyword === 'anyOf') && Array.isArray(value)) {
      ordered[keyword] = value.map((member) => canonicalSchema(member as SchemaObject));
    } else if (keyword === 'enum' && Array.isArray(value)) {
      ordered[keyword] = [...value].sort(byValue);
    } else {
      ordered[keyword] = value;
    }
  }
  return ordered as T;
}

function canonicalRequestBody(body: NonNullable<OperationObject['requestBody']>): NonNullable<OperationObject['requestBody']> {
  return '$ref' in body ? body : { ...body, content: canonicalContent(body.content) ?? body.content };
}

/** A media-type map (a request or response body) with its schemas in canonical order. */
function canonicalContent(content: Record<string, { schema?: SchemaObject | ReferenceObject }> | undefined) {
  return content
    ? Object.fromEntries(Object.entries(content).map(([type, media]) => [type, media.schema ? { ...media, schema: canonicalSchema(media.schema) } : media]))
    : undefined;
}

/** An operation with the extensions this document adds to what @nestjs/swagger derived. */
export interface ShapedOperation extends OperationObject {
  /** The roles that may call the route (@Roles). */
  'x-roles'?: string[];
  /** What an administrator needs to write through it: areas they must all write, or a decision. */
  'x-admin-write'?: { areas: string[] } | { decides: true };
  /** The route's own rate limit (@Throttle), in place of the default. */
  'x-rate-limit'?: { limit: number; ttlSeconds: number };
}

/**
 * One operation as the document gives it: what @nestjs/swagger derived, with
 * what its decorators cannot know added from the route table: the type a pipe
 * puts on a path parameter, the school header, the security requirement, who
 * may call it and how often, the common error answers, and a file's body.
 */
export function shapeOperation(operation: OperationObject, route: RouteInfo): ShapedOperation {
  const parameters: Array<ParameterObject | ReferenceObject> = (operation.parameters ?? []).map((parameter) => {
    const named = parameter as ParameterObject;
    const kind = named.in === 'path' || named.in === 'query' ? route.paramKinds[named.in][named.name] : undefined;
    if (kind) return { ...named, schema: { ...PARAM_SCHEMAS[kind] } };
    return named.schema ? { ...named, schema: canonicalSchema(named.schema) } : parameter;
  });
  parameters.push({ $ref: '#/components/parameters/SchoolId' });

  const responses: Record<string, ResponseObject | ReferenceObject> = {};
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    const shaped = { ...(response as ResponseObject) };
    if (shaped.content) shaped.content = canonicalContent(shaped.content);
    if (!shaped.description) shaped.description = STATUS_CODES[Number(status)] ?? 'Svar';
    if (route.file && /^2\d\d$/.test(status) && status !== '204') {
      shaped.content = { [route.file.contentType ?? 'application/octet-stream']: { schema: { type: 'string', format: 'binary' } } };
    }
    responses[status] = shaped;
  }
  if (!route.isPublic) {
    for (const [status, name] of COMMON_STATUSES) responses[status] = { $ref: `#/components/responses/${name}` };
  }

  const writesAsAdministrator =
    route.area !== undefined && route.area.kind !== 'any' && !['get', 'head', 'options'].includes(route.verb) && route.roles?.includes('SCHOOL_ADMIN');

  const shaped: ShapedOperation = {
    tags: operation.tags,
    operationId: operation.operationId,
    ...(operation.summary ? { summary: operation.summary } : {}),
    ...(operation.description ? { description: operation.description } : {}),
    parameters,
    ...(operation.requestBody ? { requestBody: canonicalRequestBody(operation.requestBody) } : {}),
    responses,
    // The document's own requirement is the bearer token; a route open to
    // anybody says so with an empty one.
    ...(route.isPublic ? { security: [] } : {}),
    ...(route.roles ? { 'x-roles': [...route.roles] } : {}),
    ...(writesAsAdministrator ? { 'x-admin-write': route.area?.kind === 'decides' ? { decides: true as const } : { areas: [...(route.area as { areas: readonly string[] }).areas] } } : {}),
    ...(route.throttle ? { 'x-rate-limit': route.throttle } : {}),
  };
  return shaped;
}

/** Every `$ref` to a schema that `node` holds, at any depth. */
function schemaRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) schemaRefs(item, into);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith(SCHEMA)) into.add(value.slice(SCHEMA.length));
      else schemaRefs(value, into);
    }
  }
}

/** The schemas the document reaches from its paths and shared responses, and nothing else. */
function reachable(schemas: Record<string, SchemaObject>, roots: unknown): Record<string, SchemaObject> {
  const wanted = new Set<string>();
  schemaRefs(roots, wanted);
  const queue = [...wanted];
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const found = new Set<string>();
    schemaRefs(schemas[name], found);
    for (const next of found) {
      if (!wanted.has(next)) {
        wanted.add(next);
        queue.push(next);
      }
    }
  }
  return Object.fromEntries(
    [...wanted]
      .sort()
      .map((name) => {
        const schema = schemas[name];
        if (!schema) throw new Error(`The document refers to the schema ${name}, which @nestjs/swagger did not produce.`);
        return [name, canonicalSchema(schema)] as const;
      }),
  );
}

/**
 * The OpenAPI 3 document of the gateway's `/api/v1`, generated from the
 * controllers and the DTO classes by @nestjs/swagger and shaped here.
 *
 * Nothing in it depends on the order the modules were registered in or on the
 * environment: paths, operations and schemas are sorted, so the same code
 * gives the same bytes (docs/api/openapi.json is committed and a test holds
 * it to this). The DTO schemas are only as good as the build that made the
 * classes: `nest build` runs the plugin named in nest-cli.json, and the
 * `openapi` Jest project runs the same one.
 *
 * `modules` is the application's module container, which the document's
 * route table is read from; it is the app's own unless handed one.
 */
export function buildOpenApiDocument(
  app: INestApplication,
  modules: ModulesContainer = app.get(ModulesContainer, { strict: false }),
): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Rastra API')
    .setVersion(packageVersion())
    .setDescription(API_DESCRIPTION)
    .build();
  const raw = SwaggerModule.createDocument(app, config, { operationIdFactory: operationIdOf });

  const routes = new Map(routesOf(modules).map((route) => [route.operationId, route] as const));
  const paths: Record<string, PathItemObject> = {};
  const tags = new Set<string>();
  for (const path of Object.keys(raw.paths).filter((candidate) => candidate.startsWith(API_PREFIX)).sort()) {
    const item = raw.paths[path] as PathItemObject;
    const shaped: Record<string, OperationObject> = {};
    for (const verb of VERB_ORDER) {
      const operation = item[verb];
      if (!operation) continue;
      const route = routes.get(operation.operationId ?? '');
      if (!route) throw new Error(`${verb.toUpperCase()} ${path} (${operation.operationId}) is in the document but not in the route table.`);
      shaped[verb] = shapeOperation(operation, route);
      for (const tag of operation.tags ?? []) tags.add(tag);
    }
    paths[path] = shaped;
  }

  const responses = COMMON_RESPONSES;
  const schemas = reachable(
    { ...((raw.components?.schemas ?? {}) as Record<string, SchemaObject>), Problem: PROBLEM_SCHEMA },
    { paths, responses },
  );

  const document: OpenAPIObject = {
    openapi: '3.0.0',
    info: { title: raw.info.title, description: raw.info.description, version: raw.info.version },
    tags: [...tags].sort().map((name) => ({ name })),
    security: [{ bearer: [] }],
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: BEARER_DESCRIPTION },
      },
      parameters: { SchoolId: SCHOOL_PARAMETER },
      responses: { ...responses },
      schemas,
    },
  };
  // What a client reads is JSON: nothing undefined, nothing but plain values.
  return JSON.parse(JSON.stringify(document)) as OpenAPIObject;
}

/** The document as docs/api/openapi.json and the endpoint carry it: two-space indented, one trailing newline. */
export function serializeOpenApiDocument(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
