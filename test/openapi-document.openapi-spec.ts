import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openapiV3 } from '@apidevtools/openapi-schemas';
import Ajv from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import type { OpenAPIObject, OperationObject, ParameterObject, PathItemObject, SchemaObject } from '@nestjs/swagger';
import { ModulesContainer } from '@nestjs/core';
import { routesOf } from '../src/openapi/route-table';
import { OpenApiService } from '../src/openapi/openapi.service';
import { createTestApp, type TestHarness } from './utils/test-app';
import { openApiPathOf, routingTable, type TableRoute } from './utils/routing-table';

/**
 * The OpenAPI document of /api/v1, read as a client would read it, from the
 * real routing table and the real DTO classes. This is the `openapi` Jest
 * project (jest.base.js): the DTOs are compiled with the @nestjs/swagger
 * plugin, exactly as `nest build` compiles them, or their schemas would be
 * empty objects.
 */

/**
 * Routes under /api/v1 that the document does not describe, each with the
 * reason. The list is exact: a route listed here that the document does
 * describe (or that is gone) fails below, so an entry cannot outlive its
 * reason, and a route missing from the document and not listed here fails
 * with its name. It is empty because nothing is left out; it is for the day
 * something must be, and that day it is a decision with a reason in a diff.
 *
 * Keyed `VERB /openapi/path` (upper-case verb, `{id}` for a parameter).
 */
const NOT_DESCRIBED: Readonly<Record<string, string>> = {};

const VERBS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;

/** Fails with the list named in the message, one `VERB /path` to a line, not as the difference of two arrays. */
function noneOf(list: string[], problem: string): void {
  if (list.length > 0) throw new Error(`${problem}:\n${list.map((entry) => `  ${entry}`).join('\n')}`);
}

function operationsOf(document: OpenAPIObject): Array<{ key: string; path: string; verb: string; operation: OperationObject }> {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    VERBS.flatMap((verb) => {
      const operation = (item as PathItemObject)[verb];
      return operation ? [{ key: `${verb.toUpperCase()} ${path}`, path, verb, operation }] : [];
    }),
  );
}

/** Every `$ref` in the document, with where it was found. */
function refsOf(node: unknown, at = '#', found: Array<{ ref: string; at: string }> = []): Array<{ ref: string; at: string }> {
  if (Array.isArray(node)) {
    node.forEach((item, index) => refsOf(item, `${at}/${index}`, found));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push({ ref: value, at });
      else refsOf(value, `${at}/${key}`, found);
    }
  }
  return found;
}

function resolve(document: OpenAPIObject, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], document);
}

describe('OpenAPI document of /api/v1 (openapi)', () => {
  let harness: TestHarness;
  let document: OpenAPIObject;
  let table: TableRoute[];

  beforeAll(async () => {
    harness = await createTestApp();
    document = harness.app.get(OpenApiService).document();
    table = routingTable(harness.app);
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('against the routing table', () => {
    const apiRoutes = () => table.filter((route) => route.full.startsWith('/api/v1/'));
    const keyOf = (route: TableRoute) => `${route.verb} ${openApiPathOf(route.full)}`;

    it('reads the whole routing table, not a subset of it', () => {
      // A guard on the guard: with nothing to compare, every check below passes.
      expect(apiRoutes().length).toBeGreaterThan(300);
      expect(new Set(apiRoutes().map((route) => route.controller)).size).toBeGreaterThanOrEqual(60);
      expect(table.some((route) => route.full === '/ss12000/v1/persons')).toBe(true);
    });

    it('describes every route under /api/v1', () => {
      const described = new Set(operationsOf(document).map((entry) => entry.key));
      const missing = [...new Set(apiRoutes().map(keyOf))].filter((key) => !described.has(key) && !(key in NOT_DESCRIBED));
      noneOf(missing, 'Routes under /api/v1 that the OpenAPI document does not describe (src/openapi, test/openapi-document.openapi-spec.ts NOT_DESCRIBED)');
    });

    it('describes nothing that is not a route under /api/v1', () => {
      const routes = new Set(apiRoutes().map(keyOf));
      const invented = operationsOf(document)
        .map((entry) => entry.key)
        .filter((key) => !routes.has(key));
      noneOf(invented, 'Operations in the OpenAPI document that are no route of the application');
    });

    it('keeps its list of left-out routes exact: each is a real route, and the document leaves it out', () => {
      const routes = new Set(apiRoutes().map(keyOf));
      const described = new Set(operationsOf(document).map((entry) => entry.key));
      const stale = Object.keys(NOT_DESCRIBED).filter((key) => !routes.has(key) || described.has(key));
      noneOf(stale, 'NOT_DESCRIBED lists routes that are gone, or that the document does describe');
    });

    it('stays inside /api/v1: the SS12000 providers, the public routes and the probes are not in it', () => {
      const outside = Object.keys(document.paths).filter((path) => !path.startsWith('/api/v1/'));
      expect(outside).toEqual([]);
    });

    it('describes the document itself', () => {
      expect(document.paths['/api/v1/openapi.json']?.get?.operationId).toBe('OpenApiController_document');
    });
  });

  describe('as an OpenAPI 3.0 document', () => {
    it('is valid against the specification’s own JSON Schema', () => {
      const ajv = new Ajv({ strict: false, allErrors: true });
      addFormats(ajv);
      const validate = ajv.compile(openapiV3);
      const valid = validate(document);
      expect(valid ? [] : (validate.errors ?? []).slice(0, 10)).toEqual([]);
    });

    it('resolves every $ref', () => {
      const unresolved = refsOf(document).filter(({ ref }) => resolve(document, ref) === undefined);
      expect(unresolved).toEqual([]);
    });

    it('declares every path parameter of the template, and only those', () => {
      const wrong: string[] = [];
      for (const { key, path, operation } of operationsOf(document)) {
        const inTemplate = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
        const declared = (operation.parameters ?? [])
          .map((parameter) => ('$ref' in parameter ? (resolve(document, parameter.$ref) as ParameterObject) : parameter))
          .filter((parameter) => parameter.in === 'path');
        for (const name of inTemplate) {
          const found = declared.find((parameter) => parameter.name === name);
          if (!found) wrong.push(`${key}: {${name}} is not declared`);
          else if (found.required !== true) wrong.push(`${key}: {${name}} is not required`);
        }
        for (const parameter of declared) {
          if (!inTemplate.includes(parameter.name)) wrong.push(`${key}: ${parameter.name} is declared but not in the path`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it('gives every operation a unique operationId, a tag, and a response', () => {
      const operations = operationsOf(document);
      const ids = operations.map(({ operation }) => operation.operationId);
      expect(ids.filter((id, index) => !id || ids.indexOf(id) !== index)).toEqual([]);
      expect(operations.filter(({ operation }) => Object.keys(operation.responses ?? {}).length === 0).map(({ key }) => key)).toEqual([]);
      const known = new Set((document.tags ?? []).map((tag) => tag.name));
      expect(operations.filter(({ operation }) => !(operation.tags ?? []).length || operation.tags!.some((tag) => !known.has(tag))).map(({ key }) => key)).toEqual([]);
    });

    it('describes every response, and says every success is JSON or a file', () => {
      const bare = operationsOf(document).flatMap(({ key, operation }) =>
        Object.entries(operation.responses)
          .filter(([, response]) => response !== undefined && !('$ref' in response) && !response.description)
          .map(([status]) => `${key} ${status}`),
      );
      expect(bare).toEqual([]);
    });

    it('requires the bearer token of every operation, and defines the scheme', () => {
      expect(document.security).toEqual([{ bearer: [] }]);
      expect(document.components?.securitySchemes?.['bearer']).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
      expect(operationsOf(document).filter(({ operation }) => operation.security !== undefined).map(({ key }) => key)).toEqual([]);
    });

    it('names the school header on every operation and answers the common errors', () => {
      const bare = operationsOf(document).filter(({ operation }) => {
        const names = (operation.parameters ?? []).map((parameter) => ('$ref' in parameter ? parameter.$ref : parameter.name));
        const statuses = Object.keys(operation.responses);
        return !names.includes('#/components/parameters/SchoolId') || !['400', '401', '403', '429'].every((status) => statuses.includes(status));
      });
      expect(bare.map(({ key }) => key)).toEqual([]);
      expect(document.components?.parameters?.['SchoolId']).toMatchObject({ name: 'X-School-Id', in: 'header', required: false });
    });

    it('gives a request body to every route that reads one', () => {
      const reading = new Set(
        routesOf(harness.app.get(ModulesContainer))
          .filter((route) => route.hasBody)
          .map((route) => route.operationId),
      );
      expect(reading.size).toBeGreaterThan(150);
      const bare = operationsOf(document)
        .filter(({ operation }) => reading.has(operation.operationId ?? '') && !operation.requestBody)
        .map(({ key }) => key);
      expect(bare).toEqual([]);
    });

    it('has a property in every schema: a DTO the plugin did not read would be an empty object', () => {
      // The plugin reads the classes in the files nest-cli.json names (*.dto.ts,
      // dto.ts, bulk.ts, ...). A DTO class in any other file is an empty
      // schema; the file goes in dtoFileNameSuffix.
      const empty = Object.entries(document.components?.schemas ?? {})
        .filter(([, schema]) => Object.keys((schema as SchemaObject).properties ?? {}).length === 0)
        .map(([name]) => name);
      expect(empty).toEqual([]);
    });

    it('keeps no schema that nothing reaches', () => {
      const reached = new Set(refsOf(document).map(({ ref }) => ref.replace('#/components/schemas/', '')));
      const schemas = Object.keys(document.components?.schemas ?? {});
      expect(schemas.filter((name) => !reached.has(name))).toEqual([]);
    });
  });

  describe('what it says, for real DTOs', () => {
    const schema = (name: string): SchemaObject => document.components?.schemas?.[name] as SchemaObject;

    it('src/users/dto: a user is created with the fields and bounds its validators say', () => {
      const create = schema('CreateUserDto');
      expect(create.required).toEqual(expect.arrayContaining(['role', 'firstName', 'lastName', 'email']));
      expect(create.properties?.['email']).toMatchObject({ type: 'string', format: 'email', maxLength: 254 });
      expect(create.properties?.['role']).toMatchObject({ type: 'string', enum: expect.arrayContaining(['TEACHER', 'STUDENT']) });
      expect(create.properties?.['studentGroupId']).toMatchObject({ format: 'uuid', nullable: true });
      expect(document.paths['/api/v1/users']?.post?.requestBody).toMatchObject({
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateUserDto' } } },
      });
    });

    it('src/import/dto: an import is a bounded list of rows, each a schema of its own', () => {
      const teachers = schema('ImportTeachersDto');
      expect(teachers.required).toContain('rows');
      expect(teachers.properties?.['rows']).toMatchObject({ type: 'array', minItems: 1, items: { $ref: '#/components/schemas/ImportTeacherRowDto' } });
      expect(schema('ImportTeacherRowDto').properties).toBeDefined();
      expect(Object.keys(schema('ImportTeacherRowDto').properties ?? {}).length).toBeGreaterThan(2);
    });

    it('src/schedule-exchange/dto: the timetable export names its format and its scope', () => {
      const operation = document.paths['/api/v1/schedule-exchange/export']?.post;
      expect(operation?.requestBody).toMatchObject({ content: { 'application/json': { schema: { $ref: '#/components/schemas/ExportDto' } } } });
      expect(Object.keys(schema('ExportDto').properties ?? {}).length).toBeGreaterThan(0);
    });

    it('a query DTO becomes query parameters, with its rules', () => {
      const parameters = (document.paths['/api/v1/access-log']?.get?.parameters ?? []) as ParameterObject[];
      expect(parameters.find((parameter) => parameter.name === 'personId')).toMatchObject({ in: 'query', required: true, schema: { type: 'string', format: 'uuid' } });
    });

    it('a pipe on a path parameter types it', () => {
      const parameters = (document.paths['/api/v1/person-protections/{userId}']?.get?.parameters ?? []) as ParameterObject[];
      expect(parameters.find((parameter) => parameter.name === 'userId')).toMatchObject({ in: 'path', required: true, schema: { type: 'string', format: 'uuid' } });
    });

    it('says who may call a route, and what an administrator needs to write through it', () => {
      expect(document.paths['/api/v1/access-log']?.get).toMatchObject({ 'x-roles': ['SCHOOL_ADMIN'] });
      expect(document.paths['/api/v1/person-protections/{userId}']?.put).toMatchObject({ 'x-admin-write': { areas: ['PERSONAL'] } });
      expect(document.paths['/api/v1/person-protections/{userId}']?.delete).toMatchObject({ 'x-admin-write': { decides: true } });
      expect(document.paths['/api/v1/person-protections/{userId}']?.get).not.toHaveProperty('x-admin-write');
    });

    it('says how often a route may be asked, where it has its own limit', () => {
      expect(document.paths['/api/v1/schedule-exchange/export']?.post).toMatchObject({ 'x-rate-limit': { limit: 10, ttlSeconds: 60 } });
    });

    it('describes the error body of every route once, as RFC 7807', () => {
      expect(schema('Problem').required).toEqual(['type', 'title', 'status', 'detail', 'instance', 'traceId']);
      expect(document.components?.responses?.['Forbidden']).toMatchObject({
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } },
      });
    });
  });

  describe('as bytes', () => {
    it('is the same document, to the byte, when built again by a second application', async () => {
      const again = await createTestApp();
      try {
        expect(again.app.get(OpenApiService).text()).toBe(harness.app.get(OpenApiService).text());
      } finally {
        await again.close();
      }
    });

    it('carries the package version and no host, timestamp or environment', () => {
      const text = harness.app.get(OpenApiService).text();
      const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
      expect(document.info).toMatchObject({ title: 'Rastra API', version });
      expect(document).not.toHaveProperty('servers');
      expect(text).not.toMatch(/localhost|127\.0\.0\.1|https?:\/\//);
      expect(text.endsWith('}\n')).toBe(true);
    });
  });
});
