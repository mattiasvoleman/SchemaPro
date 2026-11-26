import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { unstaffedRequirementsWhere } from '../staffing/unstaffed-requirements';
import { IntakeService } from './intake.service';

const admin = testUser({ schoolId: 'school-1' });
const YEAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');

/** A school as the database answers for it: a year, classes in two årskurser, and what the tests then take away. */
function setup(
  stand: {
    year?: object | null;
    classes?: object[];
    groups?: object[];
    groupCount?: number;
    policy?: object | null;
    rawRows?: object[];
    lunch?: object | null;
    watch?: object | null;
    ack?: object | null;
    publication?: object | null;
    cover?: object | null;
    roomTypes?: number;
    breaks?: number;
    shifts?: number;
  } = {},
) {
  const tx: TxMock = createTxMock();
  const prisma = createPrismaMock(tx);
  const year = stand.year === undefined ? { id: YEAR, name: '2026/2027', isActive: true, gradeNumbering: 'NIOARIG' } : stand.year;
  tx['academicYear']!['findFirst']!.mockResolvedValue(year);
  tx['academicYear']!['count']!.mockResolvedValue(1);
  tx['subject']!['count']!.mockResolvedValue(8);
  tx['room']!['count']!.mockResolvedValue(7);
  tx['rast']!['count']!.mockResolvedValue(2);
  tx['frameTime']!['findMany']!.mockResolvedValue([{ minGradeLevel: 7, maxGradeLevel: 9 }]);
  tx['user']!['count']!.mockResolvedValue(10);
  tx['staffingPolicy']!['findUnique']!.mockResolvedValue(stand.policy ?? null);
  tx['studentGroup']!['findMany']!.mockImplementation(async (args: { where: { kind: string } }) =>
    args.where.kind === 'CLASS'
      ? (stand.classes ?? [
          { name: '7A', gradeLevel: 7 },
          { name: '8A', gradeLevel: 8 },
        ])
      : (stand.groups ?? []),
  );
  tx['studentGroup']!['count']!.mockResolvedValue(stand.groupCount ?? 1);
  // The school's settings: each a row of its own or none, and none is off. Counts of the rows Generera does not read, only to say they are there.
  tx['roomType']!['count']!.mockResolvedValue(stand.roomTypes ?? 3);
  tx['lunchSetting']!['findUnique']!.mockResolvedValue(stand.lunch ?? null);
  tx['lunchServing']!['count']!.mockResolvedValue(2);
  tx['supervisionArea']!['count']!.mockResolvedValue(3);
  tx['absenceWatchSetting']!['findUnique']!.mockResolvedValue(stand.watch ?? null);
  tx['ackSetting']!['findUnique']!.mockResolvedValue(stand.ack ?? null);
  tx['publicationSettings']!['findUnique']!.mockResolvedValue(stand.publication ?? null);
  tx['coverSettings']!['findUnique']!.mockResolvedValue(stand.cover ?? null);
  tx['schoolBreak']!['count']!.mockResolvedValue(stand.breaks ?? 5);
  tx['supervisionShift']!['count']!.mockResolvedValue(stand.shifts ?? 12);
  tx['teachingRequirement']!['count']!.mockResolvedValue(30);
  tx['teacherEmployment']!['count']!.mockResolvedValue(10);
  tx.$queryRaw = jest.fn(async () => stand.rawRows ?? []);
  const service = new IntakeService(prisma as unknown as PrismaService);
  return { tx, service };
}

describe('IntakeService.read', () => {
  it('reads the school\'s active year, and no other: it takes no year', async () => {
    const { tx, service } = setup();
    await service.read(admin);
    expect(tx['academicYear']!['findFirst']!.mock.calls).toHaveLength(1);
    expect(tx['academicYear']!['findFirst']!.mock.calls[0]![0]).toMatchObject({ where: { isActive: true } });
    expect(service.read.length).toBe(1);
  });

  it('answers a school with no active year as one with no year, and reads nothing of a year', async () => {
    const { tx, service } = setup({ year: null });
    const view = await service.read(admin);
    expect(view.year).toBeNull();
    expect(view.areas.flatMap((area) => area.gaps).find((gap) => gap.code === 'NO_YEAR')!.count).toBe(1);
    expect(tx['studentGroup']!['findMany']).not.toHaveBeenCalled();
    expect(tx['teachingRequirement']!['count']).not.toHaveBeenCalled();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('scopes every read of the year\'s own rows to the active year', async () => {
    const { tx, service } = setup();
    await service.read(admin);
    for (const call of tx['studentGroup']!['findMany']!.mock.calls) expect(call[0].where.academicYearId).toBe(YEAR);
    for (const call of tx['teachingRequirement']!['count']!.mock.calls) expect(call[0].where.academicYearId).toBe(YEAR);
    for (const call of tx['teacherEmployment']!['count']!.mock.calls) expect(call[0].where.academicYearId).toBe(YEAR);
    expect(tx['academicYearTimplan']!['findMany']!.mock.calls[0]![0].where.academicYearId).toBe(YEAR);
    expect(tx.$queryRaw.mock.calls[0]![0].values).toEqual(expect.arrayContaining([YEAR]));
  });

  it('counts the teachers as a teacher or an administrator marked as one, and the pupils as the active ones', async () => {
    const { tx, service } = setup();
    await service.read(admin);
    const wheres = tx['user']!['count']!.mock.calls.map((call) => call[0].where);
    expect(wheres[0]).toEqual({ isActive: true, OR: [{ role: 'TEACHER' }, { role: 'SCHOOL_ADMIN', teaches: true }] });
    expect(wheres).toContainEqual({ role: 'STUDENT', isActive: true });
    expect(wheres).toContainEqual({ role: 'STUDENT', isActive: true, studentGroupId: null });
  });

  it('reads the school\'s choice about a post with no teacher by the school it is asked for', async () => {
    const { tx, service } = setup({ policy: { unstaffedGeneration: 'REFUSE' } });
    tx['teachingRequirement']!['count']!.mockImplementation(async (args: { where: { OR?: unknown } }) => (args.where.OR !== undefined ? 4 : 30));
    const view = await service.read(admin);
    expect(tx['staffingPolicy']!['findUnique']!.mock.calls[0]![0].where).toEqual({ schoolId: 'school-1' });
    expect(view.areas.flatMap((area) => area.gaps).find((gap) => gap.code === 'UNSTAFFED_POSTS')).toMatchObject({ count: 4, level: 'HARD' });
  });

  it('counts the unstaffed posts as Generera\'s pre-flight and the publish gate do: no lead, or a share nobody teaches', async () => {
    const { tx, service } = setup();
    await service.read(admin);
    const wheres = tx['teachingRequirement']!['count']!.mock.calls.map((call) => call[0].where);
    expect(wheres).toContainEqual(unstaffedRequirementsWhere(YEAR));
    expect(unstaffedRequirementsWhere(YEAR)).toEqual({ academicYearId: YEAR, OR: [{ teacherId: null }, { shares: { some: { teacherId: null } } }] });
  });

  it('lists the classes with no årskurs and the teaching groups whose årskurs cannot be derived by name', async () => {
    const { service } = setup({
      classes: [
        { name: '7A', gradeLevel: 7 },
        { name: 'Förberedelse', gradeLevel: null },
      ],
      groups: [{ name: 'En74' }],
      groupCount: 2,
    });
    const view = await service.read(admin);
    const gaps = view.areas.flatMap((area) => area.gaps);
    expect(gaps.find((gap) => gap.code === 'CLASSES_WITHOUT_GRADE')).toMatchObject({ count: 1, items: ['Förberedelse'] });
    expect(gaps.find((gap) => gap.code === 'TEACHING_GROUPS_WITHOUT_MEMBERS')).toMatchObject({ count: 1, items: ['En74'] });
    expect(view.areas.find((area) => area.area === 'TEACHING_GROUPS')!.found).toEqual({ teachingGroups: 2 });
  });

  it('asks for the groups Generera binds to no årskurs and no others: a post, no pupil in a graded class, no årskurs of the group\'s own', async () => {
    const { tx, service } = setup();
    await service.read(admin);
    const unbound = tx['studentGroup']!['findMany']!.mock.calls.map((call) => call[0]).find((args) => args.where.kind === 'TEACHING_GROUP');
    // The gateway's gradeSpanOf and the Generera page's noYearTitle: pupils' home classes first, then the group's own årskurs, and only a
    // group the timplan names is laid. A half is made with its class's årskurs and planned before its pupils are placed.
    expect(unbound.where).toEqual({
      academicYearId: YEAR,
      kind: 'TEACHING_GROUP',
      gradeLevel: null,
      teachingRequirements: { some: { academicYearId: YEAR } },
      teachingMembers: { none: { student: { studentGroup: { gradeLevel: { not: null } } } } },
    });
    expect(tx['studentGroup']!['count']!.mock.calls[0]![0].where).toEqual({ academicYearId: YEAR, kind: 'TEACHING_GROUP' });
  });

  it('lists the FIRST classes by name, not the first the database gave: the cap is taken after the sort, from every name read', async () => {
    const names = ['9C', '9B', '10A', '7A', '7B', '8A', '8B', '9A', '7C', '8C', '10B', '10C'];
    const { service } = setup({
      classes: names.map((name) => ({ name, gradeLevel: null })),
      rawRows: names.map((name) => ({ name })),
    });
    const gaps = (await service.read(admin)).areas.flatMap((area) => area.gaps);
    for (const code of ['CLASSES_WITHOUT_GRADE', 'CLASSES_WITHOUT_POSTS'] as const) {
      expect(gaps.find((gap) => gap.code === code)).toMatchObject({ count: 12, items: ['7A', '7B', '7C', '8A', '8B', '8C', '9A', '9B'], more: 4 });
    }
  });

  it('lists the classes the raw read finds without a post, and takes the cap from the rows it was given', async () => {
    const { service } = setup({ rawRows: [{ name: '9A' }, { name: '9B' }] });
    const gap = (await service.read(admin)).areas.flatMap((area) => area.gaps).find((entry) => entry.code === 'CLASSES_WITHOUT_POSTS')!;
    expect(gap).toMatchObject({ count: 2, items: ['9A', '9B'] });
  });

  it('names the year\'s posts once and reaches the classes from them: no class is held against every post in an OR', async () => {
    const { tx, service } = setup();
    await service.read(admin);
    const text = sql(tx.$queryRaw.mock.calls[0]![0]);
    expect(text).toMatch(/WITH posts AS MATERIALIZED/);
    expect(text).not.toMatch(/\bOR\b/);
    // The three ways a class is reached: its own post, a post of its half, a post of a group one of its pupils is in.
    expect(text.match(/\bUNION\b/g)).toHaveLength(2);
  });

  describe('what the school has set up or turned on (P5)', () => {
    const gaps = async (stand: Parameters<typeof setup>[0] = {}) => {
      const { tx, service } = setup(stand);
      const view = await service.read(admin);
      return { tx, view, there: view.areas.flatMap((area) => area.gaps).filter((gap) => gap.count > 0).map((gap) => gap.code) };
    };
    const ON = { enabled: true };
    const VIEWER_ALL_OFF = { viewerClassMode: 'OFF', viewerGroupMode: 'OFF', viewerTeacherMode: 'OFF', viewerStudentMode: 'OFF', viewerRoomMode: 'OFF' };

    it('says a school with no settings row at all has every switch and lunch off: no row is off', async () => {
      const { there } = await gaps();
      expect(there).toEqual(expect.arrayContaining(['LUNCH_OFF', 'ABSENCE_WATCH_OFF', 'ACK_OFF', 'VIEWER_OFF', 'SICK_REPORT_OFF']));
    });

    it('says nothing is off for a school that has turned on lunch, bevakning, kvittens, Schemavisaren and sjukanmälan', async () => {
      const { there } = await gaps({
        lunch: { lunchEnabled: true },
        watch: ON,
        ack: ON,
        publication: { ...VIEWER_ALL_OFF, viewerTeacherMode: 'LIST' },
        cover: { teacherSelfReport: true },
      });
      // The rest of the school's gaps are what the stub holds; what is asked here is that none of what can be off is.
      expect(there.filter((code) => ['LUNCH_OFF', 'ABSENCE_WATCH_OFF', 'ACK_OFF', 'VIEWER_OFF', 'SICK_REPORT_OFF', 'NO_BREAKS', 'NO_SUPERVISION', 'NO_ROOM_TYPES'].includes(code))).toEqual([]);
    });

    it.each([
      ['a row with the switch off', { lunch: { lunchEnabled: false }, watch: { enabled: false }, ack: { enabled: false }, cover: { teacherSelfReport: false } }],
    ])('reads %s as off', async (_what, stand) => {
      const { there } = await gaps({ ...stand, publication: VIEWER_ALL_OFF });
      expect(there).toEqual(expect.arrayContaining(['LUNCH_OFF', 'ABSENCE_WATCH_OFF', 'ACK_OFF', 'VIEWER_OFF', 'SICK_REPORT_OFF']));
    });

    it.each(['viewerClassMode', 'viewerGroupMode', 'viewerTeacherMode', 'viewerStudentMode', 'viewerRoomMode'])(
      'reads Schemavisaren as on when any kind of schedule is shown in it (%s)',
      async (key) => {
        const mode = key === 'viewerStudentMode' ? 'CODE' : 'LIST';
        const { there } = await gaps({ publication: { ...VIEWER_ALL_OFF, [key]: mode } });
        expect(there).not.toContain('VIEWER_OFF');
      },
    );

    it('reads only the one flag of each setting, never the rest of its row', async () => {
      const { tx } = await gaps();
      expect(tx['lunchSetting']!['findUnique']!.mock.calls[0]![0]).toEqual({ where: { schoolId: 'school-1' }, select: { lunchEnabled: true } });
      expect(tx['absenceWatchSetting']!['findUnique']!.mock.calls[0]![0]).toEqual({ where: { schoolId: 'school-1' }, select: { enabled: true } });
      expect(tx['ackSetting']!['findUnique']!.mock.calls[0]![0]).toEqual({ where: { schoolId: 'school-1' }, select: { enabled: true } });
      expect(tx['coverSettings']!['findUnique']!.mock.calls[0]![0]).toEqual({ where: { schoolId: 'school-1' }, select: { teacherSelfReport: true } });
      expect(Object.keys(tx['publicationSettings']!['findUnique']!.mock.calls[0]![0].select).sort()).toEqual([
        'viewerClassMode',
        'viewerGroupMode',
        'viewerRoomMode',
        'viewerStudentMode',
        'viewerTeacherMode',
      ]);
    });

    it('counts the lov and the passes of the active year, and room types and rastvakt areas of the school', async () => {
      const { tx, view } = await gaps();
      expect(tx['schoolBreak']!['count']!.mock.calls[0]![0]).toEqual({ where: { academicYearId: YEAR } });
      expect(tx['supervisionShift']!['count']!.mock.calls[0]![0]).toEqual({ where: { academicYearId: YEAR } });
      expect(view.areas.find((area) => area.area === 'BREAKS')!.found).toEqual({ breaks: 5 });
      expect(view.areas.find((area) => area.area === 'SUPERVISION')!.found).toEqual({ supervisionAreas: 3, supervisionShifts: 12 });
      expect(view.areas.find((area) => area.area === 'ROOMS')!.found).toMatchObject({ roomTypes: 3 });
    });

    it('says no lov, no rastvakt and no room types when there are none', async () => {
      const { there } = await gaps({ breaks: 0, shifts: 0, roomTypes: 0 });
      expect(there).toEqual(expect.arrayContaining(['NO_BREAKS', 'NO_SUPERVISION', 'NO_ROOM_TYPES']));
    });

    it('reads no lov and no passes for a school with no active year, which waits for it', async () => {
      const { tx, there } = await gaps({ year: null });
      expect(tx['schoolBreak']!['count']).not.toHaveBeenCalled();
      expect(tx['supervisionShift']!['count']).not.toHaveBeenCalled();
      expect(there).not.toContain('NO_BREAKS');
      expect(there).not.toContain('NO_SUPERVISION');
      // What is the school's and not the year's is still said.
      expect(there).toContain('LUNCH_OFF');
    });

    it('reads no person: no shift is selected from, only counted', async () => {
      const { tx } = await gaps();
      expect(tx['supervisionShift']!['findMany']).not.toHaveBeenCalled();
      for (const model of ['schoolBreak', 'supervisionShift', 'supervisionArea', 'roomType', 'lunchServing']) {
        for (const call of tx[model]!['count']!.mock.calls) expect(call[0]?.select).toBeUndefined();
      }
    });
  });

  it('never reads a person: no list of users, and the one raw statement names no person column', async () => {
    const { tx, service } = setup();
    await service.read(admin);
    expect(tx['user']!['findMany']).not.toHaveBeenCalled();
    expect(tx['user']!['findFirst']).not.toHaveBeenCalled();
    for (const call of tx['user']!['count']!.mock.calls) expect(call[0].select).toBeUndefined();
    const text = sql(tx.$queryRaw.mock.calls[0]![0]);
    expect(text).not.toMatch(/email|firstName|lastName|signature|employmentPercent|reductionPercent/i);
    // Nor a percentage of a post: the employment table is counted, never selected from.
    for (const call of tx['teacherEmployment']!['count']!.mock.calls) expect(call[0].select).toBeUndefined();
    expect(tx['teacherEmployment']!['findMany']).not.toHaveBeenCalled();
  });
});
