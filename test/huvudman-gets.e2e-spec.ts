import { writeFileSync } from 'node:fs';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '../src/auth/decorators/public.decorator';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';
import { Role } from '../src/auth/enums/role.enum';
import { huvudmanReaderOf } from '../src/auth/huvudman-reader';
import type { AuthenticatedUser } from '../src/auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../src/database/prisma.service';
import { createTestApp, type TestHarness } from './utils/test-app';

/**
 * Huvudman (20261212090000), against a database with the RLS fixtures
 * (scripts/test/run-rls-tests.sh first): every GET a school administrator
 * reaches, asked as the roller school's own läsare (…0115) and as the
 * huvudman's reader P with the roller school chosen, through the real
 * gateway and the real database. Each answers the reader as it answers the
 * läsare (the status, and the answer's shape: its keys, recursively, and
 * the length of each list), or is named in DIFFERS with why.
 *
 * Runs only with HUVUDMAN_SWEEP_DATABASE_URL (the API role's URL of such a
 * database); CI's e2e job, which has none, skips it. HUVUDMAN_SWEEP_REPORT
 * names a file for the table of every route.
 */

const DATABASE = process.env['HUVUDMAN_SWEEP_DATABASE_URL'];
const REPORT = process.env['HUVUDMAN_SWEEP_REPORT'];
const LASARE = '00000000-0000-4000-8000-000000000115';
const P = 'fe000000-0000-4000-8000-000000000260';

/**
 * Where the reader is answered otherwise, and why. Each is a route of the
 * person's own, which the reader, who has no row at the school, does not
 * have; none is a school's data the läsare reads and the reader does not.
 */
const DIFFERS: Readonly<Record<string, string>> = {
  'GET /api/v1/me/schools': "the login's own list: the läsare's own rows; the reader's the huvudman's schools, with the huvudman",
  'GET /api/v1/huvudman': "the login's own memberships: the reader is a member of H, the läsare of no huvudman",
};

type Shape = string | { [key: string]: Shape } | [Shape | null, number];

function shapeOf(value: unknown): Shape {
  if (Array.isArray(value)) return [value.length > 0 ? shapeOf(value[0]) : null, value.length];
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]));
  }
  return value === null ? 'null' : typeof value;
}

const maybe = DATABASE ? describe : describe.skip;

maybe("Huvudman: every GET a läsare reaches, as the huvudman's reader (a real database)", () => {
  let harness: TestHarness;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env['DATABASE_URL'] = DATABASE;
    prisma = new PrismaService();
    await prisma.$connect();
    harness = await createTestApp({ configure: (builder) => builder.overrideProvider(PrismaService).useValue(prisma) });
  });

  afterAll(async () => {
    await harness?.close();
    await prisma?.$disconnect();
  });

  it('answers the reader as it answers the läsare, route by route', async () => {
    // The two principals, as JwtStrategy builds them.
    const row = await prisma.withVerifiedSubject(LASARE, (db) =>
      db.user.findFirst({ where: { authId: LASARE }, select: { id: true, schoolId: true, adminProfile: true, hrRead: true } }),
    );
    expect(row?.adminProfile).toBe('LASARE');
    const school = row!.schoolId;
    const lasare: AuthenticatedUser = {
      authId: LASARE, role: Role.SCHOOL_ADMIN, userId: row!.id, schoolId: school, adminProfile: 'LASARE', hrRead: row!.hrRead,
    };
    const found = await huvudmanReaderOf(prisma, P, { school });
    expect(found?.schoolId).toBe(school);
    const { schoolId: _schoolId, ...huvudman } = found!;
    const reader: AuthenticatedUser = {
      authId: P, role: Role.SCHOOL_ADMIN, schoolId: school, adminProfile: 'LASARE', hrRead: false, huvudman,
    };

    // Ids of the roller school's, read as the läsare, for the path parameters.
    const first = async (table: string, where = 'true'): Promise<string> => {
      const rows = await prisma.queryWithRls(lasare, (db) =>
        db.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text AS id FROM "${table}" WHERE ${where} ORDER BY id LIMIT 1`),
      ).catch(() => []);
      return rows[0]?.id ?? '44444444-4444-4444-8444-444444444444';
    };
    const year = await first('AcademicYears');
    const ids = {
      AcademicYears: year,
      LocalTimplans: await first('LocalTimplans'),
      ScheduleVersions: await first('ScheduleVersions'),
      CalendarLessons: await first('CalendarLessons'),
      StudentGroups: await first('StudentGroups'),
      Users: await first('Users', `role = 'TEACHER'`),
      ScheduleCandidateRuns: await first('ScheduleCandidateRuns'),
      ScheduleCandidates: await first('ScheduleCandidates'),
      OptimizationJobs: await first('OptimizationJobs'),
      Ss12000SyncRuns: await first('Ss12000SyncRuns'),
    };
    const byPrefix: Array<[RegExp, string]> = [
      [/^\/api\/v1\/academic-years\/:id/, ids.AcademicYears],
      [/^\/api\/v1\/local-timplans\/:id/, ids.LocalTimplans],
      [/^\/api\/v1\/schedule-versions\/:id/, ids.ScheduleVersions],
      [/^\/api\/v1\/calendar-lessons\/:id/, ids.CalendarLessons],
      [/^\/api\/v1\/lesson-logs\/lessons\/:id/, ids.CalendarLessons],
      [/^\/api\/v1\/student-groups\/:id/, ids.StudentGroups],
      [/^\/api\/v1\/users\/:id/, ids.Users],
      [/^\/api\/v1\/optimization\/candidates\/:id/, ids.ScheduleCandidates],
      [/^\/api\/v1\/optimization\/jobs\/:id/, ids.OptimizationJobs],
      [/^\/api\/v1\/ss12000-sync\/runs\/:id/, ids.Ss12000SyncRuns],
    ];
    const named: Record<string, string> = {
      lessonId: ids.CalendarLessons, userId: ids.Users, groupId: ids.StudentGroups, runId: ids.ScheduleCandidateRuns,
    };
    // Dates inside the school's year: its third Monday and the six days after.
    const span = await prisma.queryWithRls(lasare, (db) =>
      db.$queryRawUnsafe<Array<{ monday: string; sunday: string }>>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS monday, to_char(d + 6, 'YYYY-MM-DD') AS sunday
           FROM (SELECT (date_trunc('week', "startDate") + interval '14 days')::date AS d FROM "AcademicYears" WHERE id = '${year}') x`,
      ),
    );
    const from = span[0]!.monday;
    const to = span[0]!.sunday;
    const pupil = await first('Users', `role = 'STUDENT' AND "isActive"`);
    const requirement = await first('TeachingRequirements');
    // The query each route needs, where it needs one.
    const needs: Readonly<Record<string, string>> = {
      '/api/v1/family/schedule': `?studentId=${pupil}&week=${from}`,
      '/api/v1/guardian-links': `?studentId=${pupil}`,
      '/api/v1/attendance/summary': `?since=${from}`,
      '/api/v1/staffing/delivered': `?academicYearId=${year}&from=${from}&to=${to}`,
      '/api/v1/staffing/suggest-teachers': `?requirementId=${requirement}`,
      '/api/v1/timplan-stages/card': `?studentId=${pupil}`,
      '/api/v1/print/timetables': `?kind=GROUP&date=${from}`,
      '/api/v1/timetable-validity': `?week=${from}`,
      '/api/v1/cover/board': `?from=${from}&to=${to}`,
      '/api/v1/lesson-logs/class-book': `?groupId=${ids.StudentGroups}&from=${from}&to=${to}`,
      '/api/v1/retention/preview': '?dataType=ATTENDANCE&months=24',
    };
    const queries = ['', `?academicYearId=${year}`, `?from=${from}&to=${to}`, `?date=${from}`,
      `?academicYearId=${year}&from=${from}&to=${to}`, `?week=${from}`];

    const discovery = harness.app.get(DiscoveryService);
    const scanner = new MetadataScanner();
    const reflector = harness.app.get(Reflector);
    const routes = discovery.getControllers().flatMap((wrapper) => {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) return [];
      const cls = wrapper.metatype as new (...args: never[]) => unknown;
      const base = Reflect.getMetadata(PATH_METADATA, cls) as string;
      return scanner
        .getAllMethodNames(Object.getPrototypeOf(instance) as object)
        .filter((name) => Reflect.hasMetadata(PATH_METADATA, (instance as never)[name]))
        .map((name) => {
          const handler = (instance as never)[name] as () => unknown;
          const own = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
          const ownPath = (Array.isArray(own) ? own[0] : own) ?? '';
          return {
            label: `${cls.name}.${name}`,
            verb: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod],
            path: `/${[base, ownPath].map((part) => String(part ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`,
            roles: reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [handler, cls]),
            isPublic: reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, cls]) === true,
          };
        });
    });
    const gets = routes.filter((route) => route.verb === 'GET' && !route.isPublic && route.roles?.includes('SCHOOL_ADMIN'));
    expect(gets.length).toBeGreaterThanOrEqual(96);

    const ask = (as: AuthenticatedUser, url: string) =>
      request(harness.app.getHttpServer()).get(url).set('x-test-user', JSON.stringify(as)).set('x-school-id', school);
    const rows: string[] = [];
    const wrong: string[] = [];
    let same = 0;
    let unreached = 0;
    for (const route of gets) {
      const prefix = byPrefix.find(([pattern]) => pattern.test(route.path))?.[1];
      const path = route.path
        .replace(/:id\b/g, prefix ?? '44444444-4444-4444-8444-444444444444')
        .replace(/:([A-Za-z]+)/g, (_all, name: string) => named[name] ?? 'rls-sweep');
      let url = path + (needs[route.path] ?? '');
      let theirs = await ask(lasare, url);
      for (const query of needs[route.path] ? [] : queries.slice(1)) {
        if (theirs.status !== 400) break;
        url = path + query;
        theirs = await ask(lasare, url);
      }
      const ours = await ask(reader, url);
      const ok = theirs.status >= 200 && theirs.status < 300;
      const alike = ours.status === theirs.status
        && JSON.stringify(shapeOf(ours.body)) === JSON.stringify(shapeOf(theirs.body))
        && (ours.headers['content-type'] ?? '') === (theirs.headers['content-type'] ?? '');
      if (!ok) unreached += 1;
      if (alike) same += 1;
      const why = DIFFERS[`GET ${route.path}`];
      const note = why ?? (ok ? '' : JSON.stringify(theirs.body ?? null).slice(0, 160).replace(/\|/g, '/'));
      rows.push(`| ${alike ? 'same' : 'DIFFERS'} | GET ${route.path} | ${url.replace(path, '') || '–'} | ${theirs.status} | ${ours.status} | ${note} |`);
      if (!alike && !why) {
        wrong.push(`GET ${url}: läsare ${theirs.status}, reader ${ours.status}${ours.status === theirs.status ? ' (another shape)' : ''} ${JSON.stringify(ours.body).slice(0, 160)}`);
      }
    }
    if (REPORT) {
      writeFileSync(REPORT, [
        `${gets.length} GET routes: ${same} answered alike, ${gets.length - same} otherwise; ${unreached} not 2xx for the läsare either.`,
        '', '| | Route | Query | Läsare | Reader | Why |', '|---|---|---|---|---|---|', ...rows,
      ].join('\n'));
    }
    expect(wrong).toEqual([]);
  });
});
