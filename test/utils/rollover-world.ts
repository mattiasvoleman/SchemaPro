import type { PrismaClient } from '@prisma/client';
import type { PrismaMock } from './prisma-mock';

/**
 * A small school as rows, behind a transaction that answers the rollover's
 * and the activation's reads from them and RECORDS every call.
 *
 * The prisma mock auto-vivifies a jest.fn for any call, which is right for a
 * spec that stubs one answer. The rollover reads some twenty tables in a row
 * and computes its plan from all of them, so stubbing them one by one would
 * test the stubs. This answers each read from the rows, with a `where`
 * matcher just wide enough for the shapes the readers use (equality, `in`,
 * `not`, null; relation filters are not evaluated), and keeps every call —
 * which is what year-rollover.service.spec.ts's write audit inspects.
 *
 * Writes are recorded, and the creates are also applied, so a second read
 * sees them (an activation after a rollover).
 */

export type Row = Record<string, unknown>;

export interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
  /** For $queryRaw: the statement's text with its parameters as `?`. */
  sql?: string;
  values?: unknown[];
}

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const clock = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

export const IDS = {
  school: '33333333-3333-4333-8333-333333333333',
  yearA: 'a0000000-0000-4000-8000-00000000000a',
  g7a: 'b0000000-0000-4000-8000-000000000007',
  g8a: 'b0000000-0000-4000-8000-000000000008',
  g9a: 'b0000000-0000-4000-8000-000000000009',
  gMa7: 'b0000000-0000-4000-8000-0000000000a7',
  p7a1: 'c0000000-0000-4000-8000-000000000071',
  p7a2: 'c0000000-0000-4000-8000-000000000072',
  p8a1: 'c0000000-0000-4000-8000-000000000081',
  p9a1: 'c0000000-0000-4000-8000-000000000091',
  pGone: 'c0000000-0000-4000-8000-0000000000ff',
  anna: 'd0000000-0000-4000-8000-00000000000a',
  bo: 'd0000000-0000-4000-8000-00000000000b',
  ma: 'e0000000-0000-4000-8000-0000000000aa',
  sv: 'e0000000-0000-4000-8000-0000000000bb',
  tk: 'e0000000-0000-4000-8000-0000000000cc',
  hostlov: 'f0000000-0000-4000-8000-000000000001',
  jullov: 'f0000000-0000-4000-8000-000000000002',
  pasklov: 'f0000000-0000-4000-8000-000000000003',
  vecka53: 'f0000000-0000-4000-8000-000000000004',
  rule7a: 'f1000000-0000-4000-8000-000000000001',
  draftPlan: 'f2000000-0000-4000-8000-000000000001',
} as const;

/** The national grundskola version P2's plans hang on: stadier 1–3, 4–6, 7–9. */
export const GRUNDSKOLA_2024 = { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2024' } as const;

/**
 * 2026/27, active: 7A, 8A and 9A with pupils, a teaching group Ma7 with a 7A,
 * an 8A and a 9A pupil, timplansposter (one taught by Anna, one by Bo who has
 * left, one with Anna twice, a vårtermin teknik that ends the day the year
 * ends), four lov and a weekly class rule. Its åk 7–9 follow a DRAFT local
 * timplan (no entries, no decided plan in the school), so the rollover
 * carries two timplan rows with the 7A and 8A cohorts, åk 7 keeps its own,
 * and the G default still comes from the classes.
 */
export function defaultRolloverRows(): Record<string, Row[]> {
  const subject = (id: string, name: string) => ({ id, name });
  return {
    academicYear: [
      {
        id: IDS.yearA,
        schoolId: IDS.school,
        name: '2026/27',
        startDate: day('2026-08-17'),
        endDate: day('2027-06-11'),
        isActive: true,
        predecessorId: null,
        graduatingGradeLevel: null,
      },
    ],
    studentGroup: [
      { id: IDS.g7a, academicYearId: IDS.yearA, name: '7A', kind: 'CLASS', gradeLevel: 7, predecessorId: null },
      { id: IDS.g8a, academicYearId: IDS.yearA, name: '8A', kind: 'CLASS', gradeLevel: 8, predecessorId: null },
      { id: IDS.g9a, academicYearId: IDS.yearA, name: '9A', kind: 'CLASS', gradeLevel: 9, predecessorId: null },
      { id: IDS.gMa7, academicYearId: IDS.yearA, name: 'Ma7 grupp 1', kind: 'TEACHING_GROUP', gradeLevel: 7, predecessorId: null },
    ],
    user: [
      { id: IDS.p7a1, role: 'STUDENT', isActive: true, studentGroupId: IDS.g7a },
      { id: IDS.p7a2, role: 'STUDENT', isActive: true, studentGroupId: IDS.g7a },
      { id: IDS.p8a1, role: 'STUDENT', isActive: true, studentGroupId: IDS.g8a },
      { id: IDS.p9a1, role: 'STUDENT', isActive: true, studentGroupId: IDS.g9a },
      { id: IDS.pGone, role: 'STUDENT', isActive: false, studentGroupId: IDS.g7a },
      { id: IDS.anna, role: 'TEACHER', isActive: true, studentGroupId: null },
      { id: IDS.bo, role: 'TEACHER', isActive: false, studentGroupId: null },
    ],
    studentGroupMember: [
      { studentGroupId: IDS.gMa7, studentId: IDS.p7a1, student: { studentGroupId: IDS.g7a } },
      { studentGroupId: IDS.gMa7, studentId: IDS.p8a1, student: { studentGroupId: IDS.g8a } },
      { studentGroupId: IDS.gMa7, studentId: IDS.p9a1, student: { studentGroupId: IDS.g9a } },
    ],
    teachingRequirement: [
      requirement('r1', IDS.g7a, IDS.ma, subject(IDS.ma, 'Matematik'), { teacherId: IDS.anna }),
      requirement('r2', IDS.g7a, IDS.sv, subject(IDS.sv, 'Svenska'), { teacherId: IDS.bo }),
      requirement('r3', IDS.g8a, IDS.ma, subject(IDS.ma, 'Matematik'), { teacherId: IDS.anna, coTeacherId: IDS.anna }),
      requirement('r4', IDS.g9a, IDS.ma, subject(IDS.ma, 'Matematik'), { teacherId: IDS.anna }),
      requirement('r5', IDS.gMa7, IDS.ma, subject(IDS.ma, 'Matematik'), { teacherId: IDS.anna }),
      requirement('r6', IDS.g7a, IDS.tk, subject(IDS.tk, 'Teknik'), {
        startDate: day('2027-01-11'),
        endDate: day('2027-06-11'),
        recurrence: 'ODD_WEEKS',
      }),
    ],
    schoolBreak: [
      lov(IDS.hostlov, 'Höstlov', '2026-10-26', '2026-10-30'),
      lov(IDS.jullov, 'Jullov', '2026-12-21', '2027-01-06'),
      lov(IDS.pasklov, 'Påsklov', '2027-03-29', '2027-04-02'),
      lov(IDS.vecka53, 'Studiedagar v53', '2026-12-28', '2026-12-30'),
    ],
    availabilityConstraint: [
      {
        id: IDS.rule7a,
        resourceType: 'STUDENT_GROUP',
        studentGroupId: IDS.g7a,
        dayOfWeek: 5,
        date: null,
        startTime: clock('13:00'),
        endTime: clock('15:00'),
        type: 'UNAVAILABLE',
        reason: 'Elevens val',
        minGradeLevel: null,
        maxGradeLevel: null,
      },
    ],
    frameTime: [
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: clock('08:00'), endTime: clock('15:30') },
    ],
    localTimplan: [
      {
        id: IDS.draftPlan,
        name: 'Utkast 2027',
        schoolForm: 'GRUNDSKOLA',
        status: 'DRAFT',
        decidedAt: null,
        createdAt: new Date('2027-02-01T00:00:00Z'),
        nationalVersion: GRUNDSKOLA_2024,
        entries: [],
      },
    ],
    academicYearTimplan: [7, 8, 9].map((gradeLevel) => ({
      schoolId: IDS.school,
      academicYearId: IDS.yearA,
      gradeLevel,
      localTimplanId: IDS.draftPlan,
    })),
    subject: [subject(IDS.ma, 'Matematik'), subject(IDS.sv, 'Svenska'), subject(IDS.tk, 'Teknik')],
    staffingPolicy: [],
    teacherSubjectQualification: [],
    masterLesson: [{ academicYearId: IDS.yearA, isLocked: true }, { academicYearId: IDS.yearA, isLocked: false }],
    lunchSitting: [{ academicYearId: IDS.yearA, isGenerated: false }],
    teacherEmployment: [{ academicYearId: IDS.yearA }],
    teacherDuty: [{ academicYearId: IDS.yearA, blockedConstraintId: 'slot', kind: 'RASTVAKT' }],
  };

  function requirement(id: string, studentGroupId: string, subjectId: string, subjectRow: Row, extra: Row): Row {
    return {
      id: `00000000-0000-4000-8000-0000000000${id.slice(1).padStart(2, '0')}`,
      academicYearId: IDS.yearA,
      subjectId,
      studentGroupId,
      teacherId: null,
      coTeacherId: null,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      minutesBefore: 0,
      minutesAfter: 0,
      teacherLoadPercent: 100,
      coTeacherLoadPercent: 100,
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      subject: { name: subjectRow['name'] },
      ...extra,
    };
  }
  function lov(id: string, name: string, startDate: string, endDate: string): Row {
    return {
      id,
      academicYearId: IDS.yearA,
      name,
      kind: 'HOLIDAY',
      startDate: day(startDate),
      endDate: day(endDate),
      minGradeLevel: null,
      maxGradeLevel: null,
    };
  }
}

export function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, wanted]) => {
    // A compound unique (`academicYearId_gradeLevel: { … }`): every part must match.
    if (!(key in row) && key.includes('_') && wanted !== null && typeof wanted === 'object' && !(wanted instanceof Date)) {
      return matches(row, wanted as Row);
    }
    const value = row[key];
    if (wanted === null) return value === null || value === undefined;
    if (wanted instanceof Date) return value instanceof Date && value.getTime() === wanted.getTime();
    if (typeof wanted === 'object') {
      const filter = wanted as Row;
      if ('in' in filter) return (filter['in'] as unknown[]).includes(value);
      if ('not' in filter) {
        return filter['not'] === null ? value !== null && value !== undefined : value !== filter['not'];
      }
      // A relation filter (`student: { role }`): not evaluated here.
      return true;
    }
    return value === wanted;
  });
}

let sequence = 0;
const freshId = (): string =>
  `90000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;

export interface RolloverWorld {
  rows: Record<string, Row[]>;
  calls: RecordedCall[];
  tx: PrismaClient;
  /** Answers a $queryRaw; the default returns the year's bounds for a year read and [] otherwise. */
  queryRaw: (sql: string, values: unknown[]) => unknown[];
}

export function givenRolloverWorld(rows: Record<string, Row[]> = defaultRolloverRows()): RolloverWorld {
  const calls: RecordedCall[] = [];
  const world: RolloverWorld = {
    rows,
    calls,
    tx: undefined as unknown as PrismaClient,
    queryRaw: (sql, values) => {
      if (/FROM "AcademicYears"/.test(sql)) {
        return (rows['academicYear'] ?? []).filter((year) => year['id'] === values[0]);
      }
      return [];
    },
  };
  const table = (model: string): Row[] => (rows[model] ??= []);
  const model = (name: string) =>
    new Proxy(
      {} as Record<string, unknown>,
      {
        get(target: Record<string, unknown>, method) {
          if (typeof method !== 'string') return undefined;
          // A spec may replace one method (`world.tx.academicYear.create = …`).
          if (method in target) return target[method];
          return async (args: Row = {}) => {
            calls.push({ model: name, method, args });
            const where = args['where'] as Row | undefined;
            // The two relations the readers select, joined from the rows as they are now.
            // A selected to-many relation with its own `where`/`take` (a plan's
            // grade-0 entries): filtered here, as the database would.
            const project = (row: Row): Row => {
              const select = args['select'] as Row | undefined;
              if (!select) return row;
              const out = { ...row };
              for (const [field, spec] of Object.entries(select)) {
                if (!Array.isArray(out[field]) || spec === null || typeof spec !== 'object') continue;
                const { where: inner, take } = spec as { where?: Row; take?: number };
                let list = (out[field] as Row[]).filter((item) => matches(item, inner));
                if (take !== undefined) list = list.slice(0, take);
                out[field] = list;
              }
              return out;
            };
            const joined = (row: Row): Row =>
              project(
                name === 'studentGroupMember'
                  ? { ...row, student: { studentGroupId: table('user').find((user) => user['id'] === row['studentId'])?.['studentGroupId'] ?? null } }
                  : name === 'teachingRequirement'
                    ? { ...row, subject: { name: table('subject').find((subject) => subject['id'] === row['subjectId'])?.['name'] } }
                    : name === 'academicYearTimplan'
                      ? { ...row, localTimplan: table('localTimplan').find((plan) => plan['id'] === row['localTimplanId']) }
                      : row,
              );
            const found = table(name).filter((row) => matches(row, where));
            // orderBy as one object or a list of them, the first key of each.
            const orders = [args['orderBy'] ?? []].flat() as Record<string, 'asc' | 'desc'>[];
            const keys = orders.map((order) => Object.entries(order)[0]!).filter(Boolean);
            if (keys.length > 0) {
              const key = (row: Row, field: string): string | number => {
                const value = row[field];
                if (typeof value === 'number') return value;
                return value instanceof Date ? value.toISOString() : value === null || value === undefined ? '' : String(value);
              };
              found.sort((a, b) => {
                for (const [field, direction] of keys) {
                  const [x, y] = [key(a, field), key(b, field)];
                  if (x !== y) return (x < y ? -1 : 1) * (direction === 'desc' ? -1 : 1);
                }
                return 0;
              });
            }
            switch (method) {
              case 'findMany':
                return found.map(joined);
              case 'findUnique':
              case 'findFirst':
                return found[0] ? joined(found[0]) : null;
              case 'count':
                return found.length;
              case 'create': {
                const row = { id: freshId(), ...(args['data'] as Row) };
                table(name).push(row);
                return row;
              }
              case 'createMany':
              case 'createManyAndReturn': {
                const created = (args['data'] as Row[]).map((data) => ({ id: freshId(), ...data }));
                table(name).push(...created);
                return method === 'createMany' ? { count: created.length } : created;
              }
              case 'update': {
                const [row] = found;
                Object.assign(row!, args['data']);
                return row;
              }
              case 'updateMany': {
                for (const row of found) Object.assign(row, args['data']);
                return { count: found.length };
              }
              case 'deleteMany': {
                rows[name] = table(name).filter((row) => !found.includes(row));
                return { count: found.length };
              }
              default:
                throw new Error(`rollover world: ${name}.${method} is not modelled`);
            }
          };
        },
      },
    );
  world.tx = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      if (key === '$queryRaw') {
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join('?').replace(/\s+/g, ' ').trim();
          calls.push({ model: '$queryRaw', method: '$queryRaw', args: null, sql, values });
          return world.queryRaw(sql, values);
        };
      }
      return (target[key] ??= model(key));
    },
  }) as unknown as PrismaClient;
  return world;
}

/** A PrismaService stand-in whose every helper runs its callback on the world's tx. */
export function prismaFor(world: RolloverWorld): PrismaMock {
  const run = <T>(fn: (client: PrismaClient) => Promise<T>) => Promise.resolve(fn(world.tx));
  return {
    onModuleInit: jest.fn(),
    onModuleDestroy: jest.fn(),
    withRls: jest.fn((_user: unknown, fn: (client: PrismaClient) => Promise<unknown>) => run(fn)),
    queryWithRls: jest.fn((_user: unknown, fn: (client: PrismaClient) => Promise<unknown>) => run(fn)),
    withVerifiedSubject: jest.fn(),
    withServiceKeyLookup: jest.fn(),
    withServicePrincipal: jest.fn(),
    withSystemTransaction: jest.fn(),
  };
}
