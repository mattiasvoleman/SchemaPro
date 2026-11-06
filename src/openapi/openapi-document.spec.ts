import 'reflect-metadata';
import { Body, Controller, Delete, Get, Header, Module, Param, ParseBoolPipe, ParseIntPipe, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Throttle } from '@nestjs/throttler';
import type { OpenAPIObject, OperationObject, SchemaObject } from '@nestjs/swagger';
import { Area, Decides, AnyAdministrator } from '../auth/decorators/area.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { buildOpenApiDocument, canonicalSchema, serializeOpenApiDocument, shapeOperation, type ShapedOperation } from './openapi-document';
import { OpenApiService } from './openapi.service';
import { operationIdOf, routesOf, type RouteInfo } from './route-table';

/** A route as the table reads it, with the parts a case does not care about left empty. */
const route = (over: Partial<RouteInfo> = {}): RouteInfo => ({
  controller: class Stub {},
  method: 'handler',
  verb: 'get',
  operationId: 'Stub_handler',
  roles: undefined,
  area: undefined,
  isPublic: false,
  throttle: undefined,
  file: undefined,
  paramKinds: { path: {}, query: {} },
  hasBody: false,
  ...over,
});

const operation = (over: Partial<OperationObject> = {}): OperationObject => ({
  operationId: 'Stub_handler',
  tags: ['Stub'],
  parameters: [],
  responses: { '200': { description: '' } },
  ...over,
});

describe('canonicalSchema', () => {
  it('writes the keywords in one order whichever order they were added in', () => {
    const a = canonicalSchema({ enum: ['A', 'B'], type: 'string' } as SchemaObject);
    const b = canonicalSchema({ type: 'string', enum: ['A', 'B'] } as SchemaObject);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual(['type', 'enum']);
  });

  it('sorts an enum’s values, which the plugin reads in the order the compiler met them', () => {
    const one = canonicalSchema({ type: 'string', enum: ['ROOM', 'ABSENT', 'GRADE_LEVEL'] } as SchemaObject);
    const other = canonicalSchema({ type: 'string', enum: ['GRADE_LEVEL', 'ROOM', 'ABSENT'] } as SchemaObject);
    expect(one.enum).toEqual(['ABSENT', 'GRADE_LEVEL', 'ROOM']);
    expect(JSON.stringify(one)).toBe(JSON.stringify(other));
    expect(canonicalSchema({ enum: [10, 9, 1] } as SchemaObject).enum).toEqual([1, 10, 9]);
  });

  it('keeps a DTO’s properties in the order they are declared, and orders each one’s keywords', () => {
    const schema = canonicalSchema({
      required: ['zebra'],
      properties: { zebra: { maxLength: 5, type: 'string' }, apple: { items: { format: 'uuid', type: 'string' }, type: 'array' } },
      type: 'object',
    } as SchemaObject);
    expect(Object.keys(schema)).toEqual(['type', 'properties', 'required']);
    expect(Object.keys(schema.properties ?? {})).toEqual(['zebra', 'apple']);
    expect(Object.keys((schema.properties?.['zebra'] ?? {}) as object)).toEqual(['type', 'maxLength']);
    expect(Object.keys(((schema.properties?.['apple'] as SchemaObject).items ?? {}) as object)).toEqual(['type', 'format']);
  });

  it('reaches into oneOf, additionalProperties and not, and puts unknown keywords last', () => {
    const schema = canonicalSchema({
      'x-note': 1,
      oneOf: [{ type: 'string' }, { type: 'number' }],
      additionalProperties: { nullable: true, type: 'string' },
      type: 'object',
    } as unknown as SchemaObject);
    expect(Object.keys(schema)).toEqual(['type', 'additionalProperties', 'oneOf', 'x-note']);
    expect(Object.keys(schema.additionalProperties as object)).toEqual(['type', 'nullable']);
  });
});

describe('shapeOperation', () => {
  it('adds the school header and the common errors to a route, and describes a bare response', () => {
    const shaped = shapeOperation(operation(), route());
    expect(shaped.parameters).toEqual([{ $ref: '#/components/parameters/SchoolId' }]);
    expect(Object.keys(shaped.responses)).toEqual(['200', '400', '401', '403', '429']);
    expect(shaped.responses['200']).toEqual({ description: 'OK' });
    expect(shaped.responses['429']).toEqual({ $ref: '#/components/responses/TooManyRequests' });
    expect(shaped).not.toHaveProperty('security');
  });

  it('describes a created and an accepted response by their status', () => {
    const shaped = shapeOperation(operation({ responses: { '201': { description: '' }, '202': { description: 'Queued' } } }), route({ verb: 'post' }));
    expect(shaped.responses['201']).toEqual({ description: 'Created' });
    expect(shaped.responses['202']).toEqual({ description: 'Queued' });
  });

  it('says an open route needs no token and promises none of the errors a login brings', () => {
    const shaped = shapeOperation(operation(), route({ isPublic: true }));
    expect(shaped.security).toEqual([]);
    expect(Object.keys(shaped.responses)).toEqual(['200']);
  });

  it('describes a route that answers a file as one, not as JSON, with the content type it sets', () => {
    const csv = shapeOperation(
      operation({ responses: { '200': { description: '', content: { 'application/json': { schema: { type: 'object' } } } } } }),
      route({ file: { contentType: 'text/csv; charset=utf-8' } }),
    );
    expect(csv.responses['200']).toEqual({
      description: 'OK',
      content: { 'text/csv; charset=utf-8': { schema: { type: 'string', format: 'binary' } } },
    });
    const unknown = shapeOperation(operation({ responses: { '200': { description: 'File' } } }), route({ file: { contentType: undefined } }));
    expect(unknown.responses['200']).toEqual({
      description: 'File',
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    });
  });

  it('leaves the error answers of a file route as the problems they are', () => {
    const shaped = shapeOperation(operation(), route({ file: { contentType: 'text/csv' } }));
    expect(shaped.responses['403']).toEqual({ $ref: '#/components/responses/Forbidden' });
  });

  it('types a parameter by the pipe on it, in the path and the query', () => {
    const shaped = shapeOperation(
      operation({
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'n', in: 'query', required: false, schema: { type: 'number' } },
          { name: 'flag', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'free', in: 'query', required: false, schema: { type: 'string' } },
        ],
      }),
      route({ paramKinds: { path: { id: 'uuid' }, query: { n: 'integer', flag: 'boolean' } } }),
    );
    expect(shaped.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'n', in: 'query', required: false, schema: { type: 'integer' } },
      { name: 'flag', in: 'query', required: false, schema: { type: 'boolean' } },
      { name: 'free', in: 'query', required: false, schema: { type: 'string' } },
      { $ref: '#/components/parameters/SchoolId' },
    ]);
  });

  it('says who may call a route, what an administrator needs to write through it, and how often', () => {
    const write = shapeOperation(
      operation(),
      route({ verb: 'put', roles: ['SCHOOL_ADMIN'], area: { kind: 'area', areas: ['PLANERING', 'DRIFT'] }, throttle: { limit: 10, ttlSeconds: 60 } }),
    );
    expect(write['x-roles']).toEqual(['SCHOOL_ADMIN']);
    expect(write['x-admin-write']).toEqual({ areas: ['PLANERING', 'DRIFT'] });
    expect(write['x-rate-limit']).toEqual({ limit: 10, ttlSeconds: 60 });

    const decision = shapeOperation(operation(), route({ verb: 'delete', roles: ['SCHOOL_ADMIN'], area: { kind: 'decides' } }));
    expect(decision['x-admin-write']).toEqual({ decides: true });
  });

  it('names no area where none is asked: a read, a route for anyone, a route a teacher alone may call', () => {
    const area = { kind: 'area', areas: ['PLANERING'] } as const;
    expect(shapeOperation(operation(), route({ verb: 'get', roles: ['SCHOOL_ADMIN'], area }))).not.toHaveProperty('x-admin-write');
    expect(shapeOperation(operation(), route({ verb: 'post', roles: ['SCHOOL_ADMIN'], area: { kind: 'any', reason: 'own devices' } }))).not.toHaveProperty('x-admin-write');
    expect(shapeOperation(operation(), route({ verb: 'post', roles: ['TEACHER'], area }))).not.toHaveProperty('x-admin-write');
    expect(shapeOperation(operation(), route({ verb: 'post', roles: undefined, area }))).not.toHaveProperty('x-admin-write');
    expect(shapeOperation(operation(), route())).not.toHaveProperty('x-roles');
    expect(shapeOperation(operation(), route())).not.toHaveProperty('x-rate-limit');
  });

  it('keeps a summary, a description and a request body when the library made them', () => {
    const body = { required: true, content: { 'application/json': { schema: { enum: ['A'], type: 'string' } } } };
    const shaped = shapeOperation(operation({ summary: 'S', description: 'D', requestBody: body as OperationObject['requestBody'] }), route({ verb: 'post' }));
    expect(shaped.summary).toBe('S');
    expect(shaped.description).toBe('D');
    expect(JSON.stringify(shaped.requestBody)).toBe(JSON.stringify({ required: true, content: { 'application/json': { schema: { type: 'string', enum: ['A'] } } } }));
  });
});

// ---------------------------------------------------------------------------
// A small application of every kind of route the document has to tell apart.
// ---------------------------------------------------------------------------

@Controller('api/v1/things')
@Roles(Role.SCHOOL_ADMIN)
@Area('PLANERING')
class ThingsController {
  @Get(':id')
  one(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Query('n', ParseIntPipe) n: number): string {
    return `${id}${n}`;
  }

  @Post()
  @Throttle({ default: { limit: 7, ttl: 30_000 } })
  create(@Body() body: unknown): unknown {
    return body;
  }

  @Delete(':id')
  @Decides()
  remove(@Param('id') id: string, @Query('on', ParseBoolPipe) on: boolean): string {
    return `${id}${String(on)}`;
  }

  @Get('report/file')
  @Header('Content-Disposition', 'attachment; filename="report.csv"')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  report(): string {
    return 'a,b';
  }

  @Post('devices')
  @AnyAdministrator('Writes nothing of the school’s: the person’s own devices.')
  device(): void {
    return undefined;
  }
}

@Controller('api/v1/self-written')
@Roles(Role.TEACHER)
class SelfWrittenController {
  @Get()
  feed(@Res() response: { send(body: string): void }): void {
    response.send('BEGIN:VCALENDAR');
  }
}

@Controller('api/v1/open')
@Public()
class OpenController {
  @Get()
  hello(): string {
    return 'hello';
  }
}

@Controller('ss12000/v1')
class ProviderController {
  @Get('persons')
  persons(): string[] {
    return [];
  }
}

@Controller('health')
class ProbeController {
  @Get()
  live(): string {
    return 'ok';
  }
}

@Module({ controllers: [ThingsController, SelfWrittenController, OpenController, ProviderController, ProbeController], providers: [OpenApiService] })
class SmallModule {}

describe('buildOpenApiDocument over a small application', () => {
  let app: NestExpressApplication;
  let document: OpenAPIObject;
  const shapedAt = (path: string, verb: 'get' | 'post' | 'delete') => document.paths[path]?.[verb] as ShapedOperation | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SmallModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    document = buildOpenApiDocument(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('describes the routes under /api/v1 and nothing else', () => {
    expect(Object.keys(document.paths)).toEqual([
      '/api/v1/open',
      '/api/v1/self-written',
      '/api/v1/things',
      '/api/v1/things/devices',
      '/api/v1/things/report/file',
      '/api/v1/things/{id}',
    ]);
  });

  it('is an OpenAPI 3 document titled Rastra API, at the package’s version, whose description says what it leaves out', () => {
    expect(document.openapi).toMatch(/^3\.0\./);
    expect(document.info.title).toBe('Rastra API');
    expect(document.info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(document.info.description).toContain('/ss12000/v1');
    expect(document.info.description).toContain('/public/v1');
    expect(document.info.description).toContain('X-School-Id');
    expect(document.info.description).toContain('läslogg');
    expect(document.info.description).toContain('RFC 7807');
    expect(document.info.description).toContain('ISO 8601');
  });

  it('puts the operations of a path in the order a reader expects, and tags them by controller', () => {
    expect(Object.keys(document.paths['/api/v1/things/{id}'] ?? {})).toEqual(['get', 'delete']);
    expect(document.paths['/api/v1/things']?.post?.tags).toEqual(['Things']);
    expect(document.tags).toEqual([{ name: 'Open' }, { name: 'SelfWritten' }, { name: 'Things' }]);
  });

  it('types parameters by their pipes and says what the route asks of the caller', () => {
    const one = shapedAt('/api/v1/things/{id}', 'get');
    expect(one?.parameters).toEqual([
      { name: 'id', required: true, in: 'path', schema: { type: 'string', format: 'uuid' } },
      { name: 'n', required: true, in: 'query', schema: { type: 'integer' } },
      { $ref: '#/components/parameters/SchoolId' },
    ]);
    expect(one?.['x-roles']).toEqual(['SCHOOL_ADMIN']);
    expect(shapedAt('/api/v1/things', 'post')?.['x-admin-write']).toEqual({ areas: ['PLANERING'] });
    expect(shapedAt('/api/v1/things', 'post')?.['x-rate-limit']).toEqual({ limit: 7, ttlSeconds: 30 });
    expect(shapedAt('/api/v1/things/{id}', 'delete')?.['x-admin-write']).toEqual({ decides: true });
    expect(document.paths['/api/v1/things/devices']?.post).not.toHaveProperty('x-admin-write');
  });

  it('answers a file route with a file: the one that sets Content-Disposition, and the one that writes its own response', () => {
    expect(document.paths['/api/v1/things/report/file']?.get?.responses['200']).toEqual({
      description: 'OK',
      content: { 'text/csv; charset=utf-8': { schema: { type: 'string', format: 'binary' } } },
    });
    expect(document.paths['/api/v1/self-written']?.get?.responses['200']).toEqual({
      description: 'OK',
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    });
    expect(document.paths['/api/v1/things/{id}']?.get?.responses['200']).not.toHaveProperty('content.text/csv');
  });

  it('marks a route open to anybody as needing no token', () => {
    expect(document.paths['/api/v1/open']?.get).toHaveProperty('security', []);
    expect(document.paths['/api/v1/things']?.post).not.toHaveProperty('security');
    expect(document.security).toEqual([{ bearer: [] }]);
  });

  it('is plain JSON text, the same on every build, ending in one newline', () => {
    const text = serializeOpenApiDocument(document);
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(document);
    expect(serializeOpenApiDocument(buildOpenApiDocument(app))).toBe(text);
  });

  it('refuses a document with an operation the route table does not know', () => {
    const modules = new ModulesContainer();
    expect(() => buildOpenApiDocument(app, modules)).toThrow(/is in the document but not in the route table/);
  });
});

describe('routesOf', () => {
  it('reads the verb, the roles, the area, the limit and the pipes of every handler, and which ones answer a file', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SmallModule] }).compile();
    const routes = routesOf(moduleRef.get(ModulesContainer));
    const byId = new Map(routes.map((found) => [found.operationId, found]));

    expect(byId.size).toBe(routes.length);
    expect(byId.get(operationIdOf('ThingsController', 'one'))).toMatchObject({
      verb: 'get',
      roles: ['SCHOOL_ADMIN'],
      area: { kind: 'area', areas: ['PLANERING'] },
      isPublic: false,
      file: undefined,
      hasBody: false,
      paramKinds: { path: { id: 'uuid' }, query: { n: 'integer' } },
    });
    expect(byId.get(operationIdOf('ThingsController', 'create'))).toMatchObject({ verb: 'post', hasBody: true, throttle: { limit: 7, ttlSeconds: 30 } });
    expect(byId.get(operationIdOf('ThingsController', 'remove'))).toMatchObject({ area: { kind: 'decides' }, paramKinds: { path: {}, query: { on: 'boolean' } } });
    expect(byId.get(operationIdOf('ThingsController', 'report'))?.file).toEqual({ contentType: 'text/csv; charset=utf-8' });
    expect(byId.get(operationIdOf('SelfWrittenController', 'feed'))?.file).toEqual({ contentType: undefined });
    expect(byId.get(operationIdOf('OpenController', 'hello'))).toMatchObject({ isPublic: true, roles: undefined });
    await moduleRef.close();
  });
});

describe('OpenApiService', () => {
  it('builds the document once, on the first ask, and serves the same text and the same object after', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SmallModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    const service = app.get(OpenApiService);

    const first = service.document();
    expect(service.document()).toBe(first);
    expect(service.text()).toBe(service.text());
    expect(JSON.parse(service.text())).toEqual(first);
    expect(Object.keys(first.paths)).toContain('/api/v1/things/{id}');
    await app.close();
  });
});
