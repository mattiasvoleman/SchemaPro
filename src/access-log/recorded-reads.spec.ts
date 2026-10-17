import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import { Role } from '../auth/enums/role.enum';
import type { PrismaService } from '../database/prisma.service';
import { Ss12000Service } from '../integration/ss12000.service';
import { PublicLinksService } from '../publication/public-links.service';
import { StudentGroupsService } from '../resources/student-groups.service';
import { TeacherEmploymentsService } from '../staffing/teacher-employments.service';
import type { SupabaseAdminService } from '../users/supabase-admin.service';
import { UsersService } from '../users/users.service';

/*
 * The läslogg's writers outside their own specs: each read that hands out
 * other people's data records, in its own transaction, the kind and the ids
 * it answered (src/access-log/access-log.ts). The family's reads, the
 * register and the attendance report have theirs beside their other cases
 * (family-reads.service.spec.ts, attendance.service.spec.ts); the staff
 * absences, the load report and SS12000 v2 are measured through the real
 * adapter (scripts/test/prisma-adapter-probe.ts, (lä)).
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const KEY = '9c0b4a1e-3f2d-4b8a-9e6f-0a1b2c3d4e5f';
const P1 = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const P2 = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
const P3 = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';

let tx: TxMock;
let prisma: PrismaMock;

beforeEach(() => {
  tx = createTxMock();
  prisma = createPrismaMock(tx);
});

describe('GET /api/v1/users', () => {
  const service = () => new UsersService(prisma as unknown as PrismaService, {} as SupabaseAdminService);

  it('lists the school\'s people with contact details, invitedAt as ISO, and records everyone listed as PEOPLE', async () => {
    tx.user.findMany.mockResolvedValue([
      { id: P1, role: 'STUDENT', firstName: 'Ada', lastName: 'Ek', email: 'ada@x', phone: null, isActive: true, studentGroupId: 'g', invitedAt: null },
      { id: P2, role: 'TEACHER', firstName: 'Bo', lastName: 'Ek', email: 'bo@x', phone: '070', isActive: true, studentGroupId: null, invitedAt: new Date('2026-10-01T08:00:00.000Z') },
    ]);
    const people = await service().list(testUser({ channel: 'WEB' }));
    expect(people.map((person) => person.invitedAt)).toEqual([null, '2026-10-01T08:00:00.000Z']);
    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }] }),
    );
    expect(recordedReads(tx)).toEqual([{ kind: 'PEOPLE', channel: 'WEB', ids: [P1, P2] }]);
  });

  it('counts people per role with every role present, and records nothing: a count names nobody', async () => {
    tx.user.groupBy = jest.fn().mockResolvedValue([
      { role: 'STUDENT', _count: { _all: 412 } },
      { role: 'TEACHER', _count: { _all: 38 } },
    ]);
    await expect(service().counts(testUser())).resolves.toEqual({
      byRole: { STUDENT: 412, TEACHER: 38, SCHOOL_ADMIN: 0, GUARDIAN: 0 },
    });
    expect(prisma.queryWithRls).toHaveBeenCalledTimes(1);
    expect(recordedReads(tx)).toEqual([]);
  });
});

describe('student groups', () => {
  const service = () => new StudentGroupsService(prisma as unknown as PrismaService);

  it('every teaching-group membership, ids only, records the pupils as ROSTER', async () => {
    tx.studentGroupMember.findMany.mockResolvedValue([
      { studentId: P1, studentGroupId: 'g1' },
      { studentId: P2, studentGroupId: 'g1' },
      { studentId: P1, studentGroupId: 'g2' },
    ]);
    await expect(service().memberships(testUser({ channel: 'WEB' }))).resolves.toHaveLength(3);
    expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
      select: { studentId: true, studentGroupId: true },
      orderBy: [{ studentGroupId: 'asc' }, { studentId: 'asc' }],
    });
    expect(recordedReads(tx)).toEqual([{ kind: 'ROSTER', channel: 'WEB', ids: [P1, P2] }]);
  });

  it('one group\'s members record the members as ROSTER', async () => {
    tx.studentGroupMember.findMany.mockResolvedValue([
      { student: { id: P3, firstName: 'Cy', lastName: 'Ek', studentGroupId: 'home' } },
    ]);
    await expect(service().listMembers('g1', testUser({ channel: 'WEB' }))).resolves.toEqual([
      { id: P3, firstName: 'Cy', lastName: 'Ek', homeGroupId: 'home' },
    ]);
    expect(recordedReads(tx)).toEqual([{ kind: 'ROSTER', channel: 'WEB', ids: [P3] }]);
  });
});

describe('employment (HR)', () => {
  const service = () => new TeacherEmploymentsService(prisma as unknown as PrismaService);
  const post = (userId: string) => ({
    id: `post-${userId}`,
    schoolId: SCHOOL,
    userId,
    academicYearId: 'y',
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: 'FERIE',
    teachingTargetMinutesPerWeek: null,
    signature: null,
    note: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

  it('the year\'s posts record their teachers as EMPLOYMENT', async () => {
    tx.teacherEmployment.findMany.mockResolvedValue([post(P1), post(P2)]);
    await service().list('y', testUser({ channel: 'WEB' }));
    expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [P1, P2] }]);
  });

  it('a teacher\'s history records the teacher, once, and an empty history nothing', async () => {
    tx.teacherEmploymentLog.findMany.mockResolvedValueOnce([
      { id: 'v2', version: 2, entity: 'EMPLOYMENT', entityId: 'e', action: 'UPDATE', before: {}, after: {}, actorId: null, createdAt: new Date(0) },
      { id: 'v1', version: 1, entity: 'EMPLOYMENT', entityId: 'e', action: 'INSERT', before: null, after: {}, actorId: null, createdAt: new Date(0) },
    ]);
    await service().history(P1, 'y', testUser({ channel: 'WEB' }));
    expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [P1] }]);
    await service().history(P2, 'y', testUser({ channel: 'WEB' }));
    expect(recordedReads(tx)).toHaveLength(1);
  });

  it('saving a post records the teacher only when the answer carries periods the caller did not send', async () => {
    (tx as unknown as { $queryRaw: jest.Mock }).$queryRaw.mockResolvedValue([{ role: 'TEACHER' }]);
    const period = {
      id: 'per-1',
      employmentId: `post-${P1}`,
      validFrom: new Date('2026-11-02T00:00:00.000Z'),
      validTo: null,
      employmentPercent: 80,
      reductionPercent: 0,
      teachingTargetMinutesPerWeek: null,
    };
    tx.teacherEmployment.upsert.mockResolvedValueOnce({ ...post(P1), periods: [period] });
    await service().upsert(P1, 'y', { employmentPercent: 100 }, testUser({ channel: 'WEB' }));
    expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [P1] }]);
    // No periods: the answer is what was sent, a write's echo.
    tx.teacherEmployment.upsert.mockResolvedValueOnce({ ...post(P2), periods: [] });
    await service().upsert(P2, 'y', { employmentPercent: 100 }, testUser({ channel: 'WEB' }));
    expect(recordedReads(tx)).toHaveLength(1);
  });

  it('a teacher asking for a colleague\'s history is refused before anything is read or recorded', async () => {
    await expect(service().history(P2, 'y', testUser({ role: Role.TEACHER, userId: P1 }))).rejects.toThrow();
    expect(recordedReads(tx)).toEqual([]);
  });
});

describe('SS12000 v1 with an integration key', () => {
  const service = () => new Ss12000Service(prisma as unknown as PrismaService);

  it('persons act as the key and record the page as PEOPLE and its relations as GUARDIANS', async () => {
    tx.user.count.mockResolvedValue(3);
    tx.user.findMany.mockResolvedValue([
      { id: P1, role: 'STUDENT', firstName: 'Ada', lastName: 'Ek', email: 'ada@x', isActive: true, studentGroupId: null, guardianLinks: [], studentLinks: [{ guardianId: P2 }] },
      { id: P2, role: 'GUARDIAN', firstName: 'Gun', lastName: 'Ek', email: 'gun@x', isActive: true, studentGroupId: null, guardianLinks: [{ studentId: P1 }], studentLinks: [] },
      { id: P3, role: 'TEACHER', firstName: 'Bo', lastName: 'Ås', email: 'bo@x', isActive: true, studentGroupId: null, guardianLinks: [], studentLinks: [] },
    ]);
    await service().persons(SCHOOL, '100', '0', undefined, KEY);
    expect(prisma.withServicePrincipal).toHaveBeenCalledWith(SCHOOL, expect.any(Function), { keyId: KEY });
    expect(recordedReads(tx)).toEqual([
      { kind: 'PEOPLE', channel: null, ids: [P1, P2, P3] },
      { kind: 'GUARDIANS', channel: null, ids: [P1, P2] },
    ]);
  });

  it('without a key the principal is the one it always was', async () => {
    await service().persons(SCHOOL);
    expect(prisma.withServicePrincipal).toHaveBeenCalledWith(SCHOOL, expect.any(Function));
  });

  it('groups record their members as ROSTER', async () => {
    tx.studentGroup.count.mockResolvedValue(1);
    tx.studentGroup.findMany.mockResolvedValue([
      { id: 'g', name: '7A', gradeLevel: 7, academicYearId: 'y', members: [{ id: P1 }, { id: P3 }] },
    ]);
    await service().groups(SCHOOL, undefined, undefined, KEY);
    expect(recordedReads(tx)).toEqual([{ kind: 'ROSTER', channel: null, ids: [P1, P3] }]);
  });

  it('calendar events record the pupils named on a lesson as ROSTER', async () => {
    tx.calendarLesson.count.mockResolvedValue(1);
    tx.calendarLesson.findMany.mockResolvedValue([
      {
        id: 'l', masterLessonId: 'm', startsAt: new Date(0), endsAt: new Date(0), status: 'SCHEDULED',
        subject: { id: 's', name: 'Ma' }, studentGroup: { id: 'g', name: '7A' }, room: null,
        teachers: [{ teacherId: P3, role: 'LEAD' }], extraGroups: [], participants: [{ studentId: P2 }],
      },
    ]);
    await service().calendarEvents(SCHOOL, '2026-10-01', '2026-10-31', undefined, undefined, KEY);
    expect(recordedReads(tx)).toEqual([{ kind: 'ROSTER', channel: null, ids: [P2] }]);
  });
});

describe('GET /api/v1/teacher-public-labels (Läsbehörighet)', () => {
  it('records the teachers hidden from public timetables as PEOPLE: skyddad identitet is a fact about each', async () => {
    tx.teacherPublicLabel.findMany.mockResolvedValue([{ userId: P1 }, { userId: P2 }]);
    const service = new PublicLinksService(prisma as unknown as PrismaService);
    await expect(service.hiddenTeachers(testUser({ channel: 'WEB' }))).resolves.toEqual([P1, P2]);
    expect(tx.teacherPublicLabel.findMany).toHaveBeenCalledWith({
      where: { hidden: true },
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });
    expect(recordedReads(tx)).toEqual([{ kind: 'PEOPLE', channel: 'WEB', ids: [P1, P2] }]);
  });

  it('records nothing when no teacher is hidden', async () => {
    tx.teacherPublicLabel.findMany.mockResolvedValue([]);
    await new PublicLinksService(prisma as unknown as PrismaService).hiddenTeachers(testUser());
    expect(recordedReads(tx)).toEqual([]);
  });
});
