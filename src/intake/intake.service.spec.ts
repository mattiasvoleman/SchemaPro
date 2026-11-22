import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { IntakeService } from './intake.service';

const admin = testUser({ schoolId: 'school-1' });
const YEAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');

/** A school as the database answers for it: a year, classes in two årskurser, and what the tests then take away. */
function setup(stand: { year?: object | null; classes?: object[]; groups?: object[]; policy?: object | null; rawRows?: object[] } = {}) {
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
      : (stand.groups ?? [{ name: 'Ma71', _count: { teachingMembers: 8 } }]),
  );
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
    tx['teachingRequirement']!['count']!.mockImplementation(async (args: { where: { teacherId?: null } }) => (args.where.teacherId === null ? 4 : 30));
    const view = await service.read(admin);
    expect(tx['staffingPolicy']!['findUnique']!.mock.calls[0]![0].where).toEqual({ schoolId: 'school-1' });
    expect(view.areas.flatMap((area) => area.gaps).find((gap) => gap.code === 'UNSTAFFED_POSTS')).toMatchObject({ count: 4, level: 'HARD' });
  });

  it('lists the classes with no årskurs and the empty teaching groups by name', async () => {
    const { service } = setup({
      classes: [
        { name: '7A', gradeLevel: 7 },
        { name: 'Förberedelse', gradeLevel: null },
      ],
      groups: [
        { name: 'Ma71', _count: { teachingMembers: 8 } },
        { name: 'En74', _count: { teachingMembers: 0 } },
      ],
    });
    const gaps = (await service.read(admin)).areas.flatMap((area) => area.gaps);
    expect(gaps.find((gap) => gap.code === 'CLASSES_WITHOUT_GRADE')).toMatchObject({ count: 1, items: ['Förberedelse'] });
    expect(gaps.find((gap) => gap.code === 'TEACHING_GROUPS_WITHOUT_MEMBERS')).toMatchObject({ count: 1, items: ['En74'] });
  });

  it('lists the classes the raw read finds without a post, and takes the cap from the rows it was given', async () => {
    const { service } = setup({ rawRows: [{ name: '9A' }, { name: '9B' }] });
    const gap = (await service.read(admin)).areas.flatMap((area) => area.gaps).find((entry) => entry.code === 'CLASSES_WITHOUT_POSTS')!;
    expect(gap).toMatchObject({ count: 2, items: ['9A', '9B'] });
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
