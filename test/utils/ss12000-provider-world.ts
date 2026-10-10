import { createHash, randomUUID } from 'node:crypto';
import type { TxMock } from './prisma-mock';

/**
 * An in-memory school behind the Prisma mock, for the SS12000 v2.0
 * provider's specs: every table the provider reads, the keys, the
 * subscriptions, and the SECURITY DEFINER functions it calls, answered as the
 * database would for one school. The code under test runs whole; what
 * Postgres itself enforces — RLS, the version triggers, the guards — is the
 * RLS suite's (section 31) and the adapter probe's, against a real database.
 *
 * Filters understood: equality (null included), { in }, { not }, { gt },
 * { gte }, { lt }, { lte }. `select` is ignored: whole rows come back, which
 * is what makes the privacy scans meaningful — a column the mappers do not
 * copy (a lesson's note, a post's reduction) is in every row they are given.
 */
type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date) && !Array.isArray(condition)) {
      const c = condition as Row;
      if ('not' in c && (c['not'] === null ? value === null || value === undefined : value === c['not'])) return false;
      if ('in' in c && !(c['in'] as unknown[]).includes(value)) return false;
      if ('gte' in c && !((value as Date | number) >= (c['gte'] as Date | number))) return false;
      if ('gt' in c && !((value as Date | number) > (c['gt'] as Date | number))) return false;
      if ('lte' in c && !((value as Date | number) <= (c['lte'] as Date | number))) return false;
      if ('lt' in c && !((value as Date | number) < (c['lt'] as Date | number))) return false;
      continue;
    }
    if (condition === null ? value !== null && value !== undefined : value !== condition) return false;
  }
  return true;
}

function table(rows: Row[], defaults: () => Row = () => ({})) {
  return {
    rows,
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((row) => matches(row, where)) ?? null,
    findUnique: async ({ where }: { where?: Row } = {}) => rows.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row | Row[] } = {}) => {
      let out = rows.filter((row) => matches(row, where));
      const order = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (order) {
        const [key, direction] = Object.entries(order)[0] as [string, 'asc' | 'desc'];
        out = [...out].sort((a, b) => {
          const x = a[key] as string | number | Date;
          const y = b[key] as string | number | Date;
          return (x < y ? -1 : x > y ? 1 : 0) * (direction === 'desc' ? -1 : 1);
        });
      }
      return out.map((row) => ({ ...row }));
    },
    count: async ({ where }: { where?: Row } = {}) => rows.filter((row) => matches(row, where)).length,
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), ...defaults(), ...data };
      rows.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      if (!row) throw new Error(`no row ${JSON.stringify(where)}`);
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
  };
}

const d = (day: string) => new Date(`${day}T00:00:00.000Z`);
const t = (instant: string) => new Date(instant);

/** Fixed ids, so specs can name them. */
export const W = {
  school: '33333333-3333-4333-8333-333333333333',
  otherSchool: '44444444-4444-4444-8444-444444444444',
  org: 'aaaaaaaa-0000-4000-8000-0000000000aa',
  pastYear: '10000000-0000-4000-8000-000000000001',
  year: '10000000-0000-4000-8000-000000000002',
  futureYear: '10000000-0000-4000-8000-000000000003',
  plan: '11000000-0000-4000-8000-000000000001',
  admin: '20000000-0000-4000-8000-000000000001',
  t1: '20000000-0000-4000-8000-000000000011',
  t2: '20000000-0000-4000-8000-000000000012',
  t3: '20000000-0000-4000-8000-000000000013',
  p1: '20000000-0000-4000-8000-000000000021',
  p1Source: 'bbbbbbbb-0000-1000-8000-000000000021', // a version-1 id, as IST's may be
  p2: '20000000-0000-4000-8000-000000000022',
  p3: '20000000-0000-4000-8000-000000000023',
  p4: '20000000-0000-4000-8000-000000000024',
  p5: '20000000-0000-4000-8000-000000000025',
  g1: '20000000-0000-4000-8000-000000000031',
  c7a: '30000000-0000-4000-8000-000000000001',
  c7aSource: 'cccccccc-0000-4000-8000-000000000001',
  c8b: '30000000-0000-4000-8000-000000000002',
  ma7: '30000000-0000-4000-8000-000000000003',
  c6a: '30000000-0000-4000-8000-000000000004',
  c8aFuture: '30000000-0000-4000-8000-000000000005',
  emp1: '40000000-0000-4000-8000-000000000001',
  emp1Past: '40000000-0000-4000-8000-000000000002',
  link2: '41000000-0000-4000-8000-000000000001',
  duty2Source: 'dddddddd-0000-4000-8000-000000000002',
  r1: '50000000-0000-4000-8000-000000000001',
  r2: '50000000-0000-4000-8000-000000000002',
  ma: '60000000-0000-4000-8000-000000000001',
  mentorstid: '60000000-0000-4000-8000-000000000002',
  m1: '70000000-0000-4000-8000-000000000001',
  m2: '70000000-0000-4000-8000-000000000002',
  m3Parked: '70000000-0000-4000-8000-000000000003',
  l1: '80000000-0000-4000-8000-000000000001',
  l2Substituted: '80000000-0000-4000-8000-000000000002',
  l3Adhoc: '80000000-0000-4000-8000-000000000003',
  l4Future: '80000000-0000-4000-8000-000000000004',
  l5Cancelled: '80000000-0000-4000-8000-000000000005',
  keyFull: '90000000-0000-4000-8000-000000000001',
  keyV1: '90000000-0000-4000-8000-000000000002',
  keyGroups: '90000000-0000-4000-8000-000000000003',
  keyRevoked: '90000000-0000-4000-8000-000000000004',
  keyNoGuardians: '90000000-0000-4000-8000-000000000005',
} as const;

/** The planted absence text: it must never appear in any v2 answer or notice. */
export const ABSENCE_TEXT = 'Karin har influensa och är sjukskriven';

export const keyOf = (n: number) => `sp_${n.toString(16).padStart(2, '0').repeat(24)}`;

export const ALL_V2_SCOPES = [
  'organisations.read',
  'persons.read',
  'responsibles.read',
  'groups.read',
  'duties.read',
  'activities.read',
  'calendarEvents.read',
  'rooms.read',
  'syllabuses.read',
  'subscriptions.write',
];

export class ProviderWorld {
  readonly school: Row = { id: W.school, name: 'Ekskolan', timezone: 'Europe/Stockholm', createdAt: t('2026-01-10T08:00:00Z'), updatedAt: t('2026-01-10T08:00:00Z') };
  readonly identity = { organisation_ids: [W.org] as string[], school_unit_codes: ['12345678'] as string[] };
  publishMode: 'DIRECT' | 'DRAFT' = 'DIRECT';
  readonly snapshotRanges: Array<{ id: string; publishedAt: Date; validFrom: Date; validTo: Date }> = [];
  readonly webhookSecrets = new Map<string, Row>();
  /** What app.ss12000_due_notifications answers on the next call. */
  due: Row[] = [];
  readonly settled: Row[] = [];
  readonly rawStatements: string[] = [];

  readonly years: Row[] = [
    { id: W.pastYear, schoolId: W.school, startDate: d('2025-08-18'), endDate: d('2026-06-12'), isActive: false },
    { id: W.year, schoolId: W.school, startDate: d('2026-08-17'), endDate: d('2027-06-11'), isActive: true },
    { id: W.futureYear, schoolId: W.school, startDate: d('2027-08-16'), endDate: d('2028-06-09'), isActive: false },
  ];
  readonly localTimplans: Row[] = [{ id: W.plan, schoolId: W.school, schoolForm: 'GRUNDSKOLA' }];
  readonly yearTimplans: Row[] = [0, 6, 7, 8, 9].flatMap((grade) => [
    { schoolId: W.school, academicYearId: W.year, gradeLevel: grade, localTimplanId: W.plan },
    { schoolId: W.school, academicYearId: W.pastYear, gradeLevel: grade, localTimplanId: W.plan },
  ]);
  readonly users: Row[] = [
    this.person(W.admin, 'SCHOOL_ADMIN', 'Anna', 'Admin', 'anna@ekskolan.se'),
    this.person(W.t1, 'TEACHER', 'Tove', 'Lärare', 'tove@ekskolan.se'),
    this.person(W.t2, 'TEACHER', 'Tor', 'Vikarielänk', 'tor@ekskolan.se'),
    this.person(W.t3, 'TEACHER', 'Tea', 'Utantjänst', 'tea@ekskolan.se'),
    { ...this.person(W.p1, 'STUDENT', 'Palle', 'Girgensohn', 'palle@elev.ekskolan.se'), ss12000Id: W.p1Source, studentGroupId: W.c7a, phone: '070-1234567' },
    { ...this.person(W.p2, 'STUDENT', 'Petra', 'Elev', 'petra@elev.ekskolan.se'), studentGroupId: W.c7a },
    { ...this.person(W.p3, 'STUDENT', 'Pelle', 'Flyttad', 'pelle@elev.ekskolan.se'), studentGroupId: W.c8b },
    { ...this.person(W.p4, 'STUDENT', 'Pia', 'Nivå', 'pia@elev.ekskolan.se'), studentGroupId: W.c8b },
    { ...this.person(W.p5, 'STUDENT', 'Per', 'Slutat', 'per@elev.ekskolan.se'), isActive: false },
    this.person(W.g1, 'GUARDIAN', 'Gun', 'Vårdnadshavare', 'gun@privat.se'),
    // Another school's pupil: the world answers the key's school only, as RLS would.
  ];
  readonly groups: Row[] = [
    this.group(W.c7a, W.year, '7A', 'CLASS', 7, W.c7aSource),
    this.group(W.c8b, W.year, '8B', 'CLASS', 8),
    this.group(W.ma7, W.year, 'Ma7', 'TEACHING_GROUP', null),
    this.group(W.c6a, W.pastYear, '6A', 'CLASS', 6),
    this.group(W.c8aFuture, W.futureYear, '8A', 'CLASS', 8),
  ];
  readonly enrollments: Row[] = [
    { schoolId: W.school, studentId: W.p1, academicYearId: W.pastYear, studentGroupId: W.c6a, gradeLevel: 6, validFrom: d('2025-08-18'), validTo: d('2026-06-13') },
    { schoolId: W.school, studentId: W.p1, academicYearId: W.year, studentGroupId: W.c7a, gradeLevel: 7, validFrom: d('2026-08-17'), validTo: null },
    { schoolId: W.school, studentId: W.p2, academicYearId: W.year, studentGroupId: W.c7a, gradeLevel: 7, validFrom: d('2026-08-17'), validTo: null },
    { schoolId: W.school, studentId: W.p3, academicYearId: W.year, studentGroupId: W.c7a, gradeLevel: 7, validFrom: d('2026-08-17'), validTo: d('2026-09-21') },
    { schoolId: W.school, studentId: W.p3, academicYearId: W.year, studentGroupId: W.c8b, gradeLevel: 8, validFrom: d('2026-09-21'), validTo: null },
    { schoolId: W.school, studentId: W.p4, academicYearId: W.year, studentGroupId: W.c8b, gradeLevel: 8, validFrom: d('2026-08-17'), validTo: null },
    { schoolId: W.school, studentId: W.p5, academicYearId: W.year, studentGroupId: W.c7a, gradeLevel: 7, validFrom: d('2026-08-17'), validTo: d('2026-09-01') },
  ];
  readonly teachingMembers: Row[] = [{ schoolId: W.school, studentGroupId: W.ma7, studentId: W.p4 }];
  readonly guardianLinks: Row[] = [{ schoolId: W.school, guardianId: W.g1, studentId: W.p1 }];
  readonly policy: Row = { schoolId: W.school, shareEmploymentWithIntegrations: false, fullTimeAnnualHours: 1767 };
  readonly employments: Row[] = [
    {
      id: W.emp1, schoolId: W.school, userId: W.t1, academicYearId: W.year, employmentPercent: 80, reductionPercent: 20,
      signature: 'TL', contractKind: 'FERIE', note: 'Nedsättning: föräldraledig fredagar', teachingTargetMinutesPerWeek: 900,
      createdAt: t('2026-06-01T08:00:00Z'), updatedAt: t('2026-06-02T08:00:00Z'),
    },
    {
      id: W.emp1Past, schoolId: W.school, userId: W.t1, academicYearId: W.pastYear, employmentPercent: 100, reductionPercent: 0,
      signature: 'TL', contractKind: 'FERIE', note: null, teachingTargetMinutesPerWeek: null,
      createdAt: t('2025-06-01T08:00:00Z'), updatedAt: t('2025-06-01T08:00:00Z'),
    },
  ];
  readonly dutyLinks: Row[] = [
    { id: W.link2, schoolId: W.school, userId: W.t2, academicYearId: W.year, ss12000DutyId: W.duty2Source, dutyRole: 'Lärare', startDate: d('2026-08-17'), endDate: null, endedAt: null },
  ];
  readonly mentorships: Row[] = [
    { schoolId: W.school, userId: W.t1, academicYearId: W.year, kind: 'MENTORSKAP', studentGroupId: W.c7a, updatedAt: t('2026-08-20T08:00:00Z'), minutesPerWeek: 60, note: 'Mentor 7A' },
  ];
  readonly rooms: Row[] = [
    { id: W.r1, schoolId: W.school, name: 'Sal 101', capacity: 30, createdAt: t('2026-01-10T08:00:00Z'), updatedAt: t('2026-01-10T08:00:00Z') },
    { id: W.r2, schoolId: W.school, name: 'Aulan', capacity: null, createdAt: t('2026-01-10T08:00:00Z'), updatedAt: t('2026-02-10T08:00:00Z') },
  ];
  readonly subjects: Row[] = [
    { id: W.ma, schoolId: W.school, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true, createdAt: t('2026-01-10T08:00:00Z'), updatedAt: t('2026-01-10T08:00:00Z') },
    { id: W.mentorstid, schoolId: W.school, name: 'Mentorstid', nationalCode: null, countsTowardTimplan: false, createdAt: t('2026-01-10T08:00:00Z'), updatedAt: t('2026-01-10T08:00:00Z') },
  ];
  readonly masters: Row[] = [
    this.master(W.m1, W.ma, W.c7a, W.t1, W.t2, W.r1),
    this.master(W.m2, W.mentorstid, W.c8b, W.t3, null, null),
    { ...this.master(W.m3Parked, W.ma, W.c8b, W.t1, null, null), isParked: true },
  ];
  readonly masterGroups: Row[] = [{ schoolId: W.school, masterLessonId: W.m1, studentGroupId: W.ma7 }];
  readonly publications: Row[] = [];
  readonly publishedLessons: Row[] = [];
  readonly lessons: Row[] = [
    this.lesson(W.l1, W.m1, W.ma, W.c7a, W.r1, '2026-10-12T06:00:00Z', 'SCHEDULED'),
    { ...this.lesson(W.l2Substituted, W.m1, W.ma, W.c7a, W.r1, '2026-10-13T06:00:00Z', 'SCHEDULED'), note: `Vikarie: ${ABSENCE_TEXT}` },
    this.lesson(W.l3Adhoc, null, W.ma, W.c7a, null, '2026-10-14T06:00:00Z', 'SCHEDULED'),
    this.lesson(W.l4Future, null, W.ma, W.c8aFuture, null, '2026-10-15T06:00:00Z', 'SCHEDULED'),
    { ...this.lesson(W.l5Cancelled, W.m2, W.mentorstid, W.c8b, null, '2026-10-12T09:00:00Z', 'CANCELLED'), cancelCause: 'EVENT', note: `Inställd: ${ABSENCE_TEXT}` },
  ];
  readonly lessonTeachers: Row[] = [
    { schoolId: W.school, calendarLessonId: W.l1, teacherId: W.t1, role: 'LEAD' },
    { schoolId: W.school, calendarLessonId: W.l1, teacherId: W.t2, role: 'ASSISTANT' },
    { schoolId: W.school, calendarLessonId: W.l2Substituted, teacherId: W.t3, role: 'SUBSTITUTE' },
    { schoolId: W.school, calendarLessonId: W.l3Adhoc, teacherId: W.t1, role: 'LEAD' },
    { schoolId: W.school, calendarLessonId: W.l5Cancelled, teacherId: W.t3, role: 'LEAD' },
  ];
  readonly lessonGroups: Row[] = [{ schoolId: W.school, calendarLessonId: W.l1, studentGroupId: W.ma7 }];
  readonly lessonStudents: Row[] = [
    { schoolId: W.school, calendarLessonId: W.l3Adhoc, studentId: W.p4 },
    { schoolId: W.school, calendarLessonId: W.l1, studentId: W.p2 },
  ];
  readonly pendingRemovals: Row[] = [];
  readonly versions: Row[] = [
    { schoolId: W.school, resource: 'Person', entityId: W.p1, createdAt: t('2026-10-10T08:00:00Z'), modifiedAt: t('2026-10-10T09:00:00Z') },
    { schoolId: W.school, resource: 'Group', entityId: W.c7a, createdAt: t('2026-10-10T08:00:00Z'), modifiedAt: t('2026-10-11T09:00:00Z') },
    { schoolId: W.school, resource: 'Activity', entityId: W.m1, createdAt: t('2026-10-10T08:00:00Z'), modifiedAt: t('2026-10-11T10:00:00Z') },
  ];
  readonly tombstones: Row[] = [
    { schoolId: W.school, resource: 'Person', emittedId: W.p5, removedAt: t('2026-10-01T08:00:00Z') },
    { schoolId: W.school, resource: 'AdhocActivity', emittedId: '80000000-0000-4000-8000-0000000000ff', removedAt: t('2026-10-02T08:00:00Z') },
    { schoolId: W.school, resource: 'Room', emittedId: '50000000-0000-4000-8000-0000000000ff', removedAt: t('2026-10-03T08:00:00Z') },
  ];
  readonly keys: Row[] = [
    this.key(W.keyFull, keyOf(1), ['ss12000.v1', 'ss12000.v1.import', ...ALL_V2_SCOPES]),
    this.key(W.keyV1, keyOf(2), ['ss12000.v1', 'ss12000.v1.import']),
    this.key(W.keyGroups, keyOf(3), ['groups.read']),
    { ...this.key(W.keyRevoked, keyOf(4), ['ss12000.v1', ...ALL_V2_SCOPES]), revokedAt: t('2026-10-01T08:00:00Z') },
    this.key(W.keyNoGuardians, keyOf(5), ALL_V2_SCOPES.filter((scope) => scope !== 'responsibles.read')),
  ];
  readonly subscriptions: Row[] = [];
  readonly deliveries: Row[] = [];

  private person(id: string, role: string, firstName: string, lastName: string, email: string): Row {
    return {
      id, schoolId: W.school, role, firstName, lastName, email, phone: null, isActive: true, ss12000Id: null, studentGroupId: null,
      authId: randomUUID(), invitedAt: null, createdAt: t('2026-02-01T08:00:00Z'), updatedAt: t('2026-03-01T08:00:00Z'),
    };
  }

  private group(id: string, year: string, name: string, kind: string, gradeLevel: number | null, ss12000Id: string | null = null): Row {
    return { id, schoolId: W.school, academicYearId: year, name, kind, gradeLevel, ss12000Id, createdAt: t('2026-05-01T08:00:00Z'), updatedAt: t('2026-05-02T08:00:00Z') };
  }

  private master(id: string, subjectId: string, groupId: string, teacherId: string | null, coTeacherId: string | null, roomId: string | null): Row {
    return {
      id, schoolId: W.school, academicYearId: W.year, subjectId, studentGroupId: groupId, teacherId, coTeacherId, roomId,
      dayOfWeek: 1, startTime: t('1970-01-01T08:00:00Z'), endTime: t('1970-01-01T09:00:00Z'), recurrence: 'ALL_WEEKS',
      startDate: null, endDate: null, isParked: false, isLocked: false, isGenerated: false,
      createdAt: t('2026-07-01T08:00:00Z'), updatedAt: t('2026-07-02T08:00:00Z'),
    };
  }

  private lesson(id: string, master: string | null, subject: string, group: string, room: string | null, start: string, status: string): Row {
    const startsAt = t(start);
    return {
      id, schoolId: W.school, masterLessonId: master, subjectId: subject, studentGroupId: group, roomId: room,
      date: d(start.slice(0, 10)), startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), status, note: null, cancelCause: null,
      createdAt: t('2026-08-01T08:00:00Z'), updatedAt: t('2026-08-01T08:00:00Z'),
    };
  }

  private key(id: string, key: string, scopes: string[]): Row {
    return {
      id, schoolId: W.school, name: `Nyckel ${id.slice(-1)}`, keyHash: createHash('sha256').update(key).digest('hex'),
      createdById: W.admin, lastUsedAt: null, revokedAt: null, createdAt: t('2026-09-01T08:00:00Z'), scopes,
    };
  }

  install(tx: TxMock): void {
    const now = () => new Date();
    const own = (rows: Row[]) => rows.filter((row) => row['schoolId'] === undefined || row['schoolId'] === W.school);
    const models: Record<string, ReturnType<typeof table>> = {
      school: table([this.school]),
      academicYear: table(this.years),
      localTimplan: table(this.localTimplans),
      academicYearTimplan: table(this.yearTimplans),
      user: table(this.users),
      studentGroup: table(this.groups),
      studentEnrollment: table(this.enrollments),
      studentGroupMember: table(this.teachingMembers),
      guardianStudent: table(this.guardianLinks),
      staffingPolicy: table([this.policy]),
      teacherEmployment: table(this.employments),
      ss12000DutyLink: table(this.dutyLinks),
      teacherDuty: table(this.mentorships),
      room: table(this.rooms),
      subject: table(this.subjects),
      masterLesson: table(this.masters),
      masterLessonGroup: table(this.masterGroups),
      timetablePublication: table(this.publications),
      publishedLesson: table(this.publishedLessons),
      calendarLesson: table(this.lessons),
      calendarLessonTeacher: table(this.lessonTeachers),
      calendarLessonGroup: table(this.lessonGroups),
      calendarLessonStudent: table(this.lessonStudents),
      publicationPendingRemoval: table(this.pendingRemovals),
      ss12000EntityVersion: table(this.versions),
      ss12000Tombstone: table(this.tombstones),
      integrationApiKey: table(this.keys),
      ss12000Subscription: table(this.subscriptions, () => ({
        endedAt: null, suspendedAt: null, suspendedReason: null, lastNotifiedAt: null, nextAttemptAt: now(), attempts: 0,
        failingSince: null, claimedAt: null, createdAt: now(), updatedAt: now(), expiresAt: new Date(Date.now() + 30 * 86_400_000),
      })),
    };
    void own;
    for (const [model, impl] of Object.entries(models)) {
      for (const [method, fn] of Object.entries(impl)) {
        if (method === 'rows') continue;
        tx[model]![method]!.mockImplementation(fn as (...args: unknown[]) => unknown);
      }
    }
    // v1's feeds select relations: answer the ones they read.
    tx['user']!['findMany']!.mockImplementation(async (args: { where?: Row; select?: Row; orderBy?: Row }) => {
      const rows = await models['user']!.findMany(args);
      if (!args.select || !('guardianLinks' in args.select)) return rows;
      return rows.map((row) => ({
        ...row,
        guardianLinks: this.guardianLinks.filter((link) => link['guardianId'] === row['id']).map((link) => ({ studentId: link['studentId'] })),
        studentLinks: this.guardianLinks.filter((link) => link['studentId'] === row['id']).map((link) => ({ guardianId: link['guardianId'] })),
      }));
    });
    tx['studentGroup']!['findMany']!.mockImplementation(async (args: { where?: Row; select?: Row; orderBy?: Row }) => {
      const rows = await models['studentGroup']!.findMany(args);
      if (!args.select || !('members' in args.select)) return rows;
      return rows.map((row) => ({
        ...row,
        members: this.users.filter((user) => user['studentGroupId'] === row['id'] && user['isActive']).map((user) => ({ id: user['id'] })),
      }));
    });
    // A DRAFT school's masters are invisible to the service principal (RLS).
    tx['masterLesson']!['findMany']!.mockImplementation(async (args: { where?: Row }) =>
      this.publishMode === 'DRAFT' ? [] : models['masterLesson']!.findMany(args),
    );

    const sqlOf = (statement: unknown) => {
      const sql = statement as { strings?: string[]; values?: unknown[] };
      return { text: (sql.strings ?? []).join('?'), values: sql.values ?? [] };
    };
    (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (statement: unknown) => {
      const { text, values } = sqlOf(statement);
      this.rawStatements.push(text);
      if (text.includes('app.ss12000_provider_identity')) return [this.identity];
      if (text.includes('app.school_publish_mode')) return [{ mode: this.publishMode }];
      if (text.includes('app.publication_snapshot_ranges')) return this.snapshotRanges;
      if (text.includes('app.ss12000_webhook_secret_exists')) return [{ exists: this.webhookSecrets.size > 0 }];
      if (text.includes('app.integration_key_webhook_secret_presence')) {
        return [...this.webhookSecrets.entries()].map(([key, row]) => ({ key_id: key, set_at: row['set_at'], previous_valid_until: row['previous_valid_until'] ?? null }));
      }
      if (text.includes('app.integration_key_set_webhook_secret')) {
        const [key, ciphertext, iv, tag, encKeyId] = values as [string, Buffer, Buffer, Buffer, string];
        if (!this.keys.some((row) => row['id'] === key && row['revokedAt'] === null)) {
          throw Object.assign(new Error('INTEGRATION_KEY_NOT_FOUND'), { meta: { driverAdapterError: { cause: { originalCode: 'SS404' } } } });
        }
        const previous = this.webhookSecrets.get(key);
        const row = {
          school_id: W.school, ciphertext, iv, auth_tag: tag, enc_key_id: encKeyId, set_at: now(),
          ...(previous
            ? { previous_ciphertext: previous['ciphertext'], previous_iv: previous['iv'], previous_auth_tag: previous['auth_tag'], previous_enc_key_id: previous['enc_key_id'], previous_valid_until: new Date(Date.now() + 86_400_000) }
            : { previous_ciphertext: null, previous_iv: null, previous_auth_tag: null, previous_enc_key_id: null }),
        };
        this.webhookSecrets.set(key, row);
        return [{ set_at: row.set_at }];
      }
      if (text.includes('app.ss12000_webhook_secrets')) {
        const row = this.webhookSecrets.get(values[0] as string);
        return row ? [row] : [];
      }
      if (text.includes('app.ss12000_provider_housekeeping')) return [{ tombstones: 0, deliveries: 0, released: 0 }];
      if (text.includes('app.ss12000_due_notifications')) {
        const due = this.due;
        this.due = [];
        return due;
      }
      if (text.includes('app.ss12000_notification_settled')) {
        const [subscription, ok, status, outcome, watermark] = values as [string, boolean, number | null, string, string];
        this.settled.push({ subscription, ok, status, outcome, watermark });
        return [{ verdict: ok ? 'DELIVERED' : 'RETRY' }];
      }
      return [];
    });
  }
}
