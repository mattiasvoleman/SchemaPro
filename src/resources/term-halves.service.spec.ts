import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { WRITE_CONFLICT } from '../common/utils/prisma-errors';
import { RequirementImportChecks } from '../staffing/staffing-enforcement';
import type { StaffingFinding } from '../staffing/staffing-checks';
import { SAME_TEACHER_TWICE } from '../staffing/staffing-enforcement';
import { CLASS_ALREADY_SPLIT, NOT_A_CLASS, NOT_THE_CLASS_HALVES } from './student-groups.service';
import { TEACHING_BLOCK_NAME_TAKEN } from './teaching-blocks.service';
import {
  CLASS_HAS_ONE_HALF,
  HALF_HAS_SUBJECT,
  REQUIREMENT_HAS_PERIOD,
  REQUIREMENT_IN_A_BLOCK,
  SPRING_START_OUTSIDE_YEAR,
  TERM_SUBJECTS_SAME,
  TERM_TEACHER_TWICE,
  TermHalvesService,
} from './term-halves.service';

// The staffing judge, replaced so a test can say what it answers; what it
// decides is the import's and staffing-enforcement.spec.ts's.
jest.mock('../staffing/staffing-enforcement', () => ({
  ...jest.requireActual('../staffing/staffing-enforcement'),
  RequirementImportChecks: { open: jest.fn() },
}));
const openChecks = RequirementImportChecks.open as jest.MockedFunction<typeof RequirementImportChecks.open>;

const YEAR = '11111111-1111-4111-8111-111111111111';
const POST = '22222222-2222-4222-8222-222222222222';
const CLASS = '33333333-3333-4333-8333-333333333333';
const HALF_1 = '44444444-4444-4444-8444-444444444441';
const HALF_2 = '44444444-4444-4444-8444-444444444442';
const SLOJD = '55555555-5555-4555-8555-555555555555';
const TEXTIL = '66666666-6666-4666-8666-666666666666';
const TRA = '77777777-7777-4777-8777-777777777777';
const ANNA = '88888888-8888-4888-8888-888888888881';
const BO = '88888888-8888-4888-8888-888888888882';
const CECILIA = '88888888-8888-4888-8888-888888888883';
const AUTUMN = '99999999-9999-4999-8999-999999999991';
const SPRING = '99999999-9999-4999-8999-999999999992';

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** 7A's slöjd: two lessons of 1 × 80 + 1 × 40, ombyte, its own rule, odd weeks. */
const source = (overrides: Record<string, unknown> = {}) => ({
  id: POST,
  schoolId: 'school',
  academicYearId: YEAR,
  subjectId: SLOJD,
  studentGroupId: CLASS,
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 2,
  minutesPerLesson: 80,
  lessonLengths: [80, 40],
  minutesBefore: 5,
  minutesAfter: 10,
  teacherLoadPercent: 100,
  coTeacherLoadPercent: 100,
  ownDistribution: true,
  maxLessonsPerDay: 1,
  minDaysBetween: null,
  blockId: null,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  updatedAt: new Date('2026-10-20T08:00:00.000Z'),
  subject: { name: 'Slöjd' },
  block: null,
  studentGroup: { id: CLASS, name: '7A', kind: 'CLASS', halves: [] },
  ...overrides,
});

const DTO = {
  subjects: [
    { subjectId: TEXTIL, teacherId: ANNA },
    { subjectId: TRA, teacherId: BO },
  ],
  springStartDate: '2027-01-11',
};

describe('TermHalvesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: TermHalvesService;
  const admin = testUser();

  /** The class row's lock and the year's bounds are the two raw statements. */
  const givenYear = (year: { startDate: Date; endDate: Date } | null) => {
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('?').includes('"AcademicYears"') ? (year ? [year] : []) : [],
    );
  };

  /** The post as both reads find it: the locate, then the read under the lock. */
  const givenPost = (row: ReturnType<typeof source> | null) => {
    tx.teachingRequirement.findUnique.mockImplementation(async ({ select }: { select?: unknown }) =>
      row === null ? null : select ? { studentGroupId: row.studentGroupId, academicYearId: row.academicYearId } : row,
    );
  };

  beforeEach(() => {
    openChecks.mockReset();
    openChecks.mockResolvedValue(null);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TermHalvesService(prisma as unknown as PrismaService);
    givenYear({ startDate: day('2026-08-17'), endDate: day('2027-06-11') });
    givenPost(source());
    tx.subject.findMany.mockResolvedValue([
      { id: TEXTIL, name: 'Textilslöjd' },
      { id: TRA, name: 'Trä- och metallslöjd' },
    ]);
    tx.studentGroup.findUnique.mockResolvedValue({
      name: '7A',
      kind: 'CLASS',
      academicYearId: YEAR,
      gradeLevel: 7,
      _count: { halves: 0 },
    });
    tx.studentGroup.createManyAndReturn.mockResolvedValue([
      { id: HALF_1, name: '7A:1' },
      { id: HALF_2, name: '7A:2' },
    ]);
    tx.teachingRequirement.deleteMany.mockResolvedValue({ count: 1 });
    tx.teachingBlock.create.mockImplementation(
      async ({ data }: { data: { name: string; sameTimesAsBlockId: string | null } }) => ({
        id: data.name.endsWith('HT') ? AUTUMN : SPRING,
        name: data.name,
        sameTimesAsBlockId: data.sameTimesAsBlockId,
      }),
    );
    tx.teachingRequirement.createManyAndReturn.mockImplementation(
      async ({ data }: { data: Record<string, unknown>[] }) =>
        // Answered in another order than asked, as RETURNING may.
        data
          .map((row, index) => ({ ...row, id: `created-${index}` }))
          .reverse(),
    );
  });

  describe('a class without halves', () => {
    it('splits the class, writes one block per term and four posts that swap the subjects, and removes the class’s post', async () => {
      const result = await service.split(POST, DTO, admin);

      // The year FOR SHARE, then the class FOR NO KEY UPDATE: year
      // activation takes the year before the year's groups, and the other
      // order could wait on it in a cycle.
      const raw = tx.$queryRaw.mock.calls.map(([strings, id]) => [(strings as TemplateStringsArray).join('?'), id]);
      expect(raw[0]![0]).toContain('"AcademicYears"');
      expect(raw[0]![0]).toContain('FOR SHARE');
      expect(raw[0]![1]).toBe(YEAR);
      expect(raw[1]![0]).toContain('FOR NO KEY UPDATE');
      expect(raw[1]![1]).toBe(CLASS);

      expect(tx.studentGroup.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ name: '7A:1', kind: 'TEACHING_GROUP', halfOfId: CLASS, gradeLevel: 7 }),
          expect.objectContaining({ name: '7A:2', kind: 'TEACHING_GROUP', halfOfId: CLASS, gradeLevel: 7 }),
        ],
      });
      // The spring's block takes the autumn's times: the generator writes
      // each spring post at the autumn post's in its subject (same-times.ts).
      expect(tx.teachingBlock.create.mock.calls.map(([args]) => (args as { data: unknown }).data)).toEqual([
        { schoolId: admin.schoolId, academicYearId: YEAR, name: 'Slöjd 7A HT', sameTimesAsBlockId: null },
        { schoolId: admin.schoolId, academicYearId: YEAR, name: 'Slöjd 7A VT', sameTimesAsBlockId: AUTUMN },
      ]);

      const [{ data }] = tx.teachingRequirement.createManyAndReturn.mock.calls[0] as [{ data: Record<string, unknown>[] }];
      expect(data.map((row) => [row.studentGroupId, row.subjectId, row.teacherId, row.startDate, row.endDate, row.blockId])).toEqual([
        [HALF_1, TEXTIL, ANNA, null, day('2027-01-10'), AUTUMN],
        [HALF_1, TRA, BO, day('2027-01-11'), null, SPRING],
        [HALF_2, TRA, BO, null, day('2027-01-10'), AUTUMN],
        [HALF_2, TEXTIL, ANNA, day('2027-01-11'), null, SPRING],
      ]);
      // Each post carries the class's lessons as they were.
      for (const row of data) {
        expect(row).toEqual(
          expect.objectContaining({
            schoolId: admin.schoolId,
            academicYearId: YEAR,
            lessonsPerWeek: 2,
            minutesPerLesson: 80,
            lessonLengths: [80, 40],
            minutesBefore: 5,
            minutesAfter: 10,
            ownDistribution: true,
            maxLessonsPerDay: 1,
            minDaysBetween: null,
            recurrence: 'ALL_WEEKS',
            coTeacherId: null,
            teacherLoadPercent: 100,
            coTeacherLoadPercent: 100,
          }),
        );
      }

      // Removed only as it was read: the class's, in no block, without
      // dates, and unwritten since (updatedAt), so a PATCH of its weeks,
      // lengths or teacher in between is a 409, not lost.
      expect(tx.teachingRequirement.deleteMany).toHaveBeenCalledWith({
        where: {
          id: POST,
          studentGroupId: CLASS,
          blockId: null,
          startDate: null,
          endDate: null,
          lessonsPerWeek: 2,
          minutesPerLesson: 80,
          updatedAt: new Date('2026-10-20T08:00:00.000Z'),
        },
      });

      expect(result.createdHalves).toBe(true);
      expect(result.halves).toEqual([
        { id: HALF_1, name: '7A:1' },
        { id: HALF_2, name: '7A:2' },
      ]);
      expect(result.removedRequirementId).toBe(POST);
      expect(result.requirements.map((row) => [row.id, row.studentGroupId, row.subjectId, row.startDate, row.endDate])).toEqual([
        ['created-0', HALF_1, TEXTIL, null, '2027-01-10'],
        ['created-1', HALF_1, TRA, '2027-01-11', null],
        ['created-2', HALF_2, TRA, null, '2027-01-10'],
        ['created-3', HALF_2, TEXTIL, '2027-01-11', null],
      ]);
      expect(result.blocks).toEqual([
        { id: AUTUMN, name: 'Slöjd 7A HT', sameTimesAsBlockId: null, requirementIds: ['created-0', 'created-2'] },
        { id: SPRING, name: 'Slöjd 7A VT', sameTimesAsBlockId: AUTUMN, requirementIds: ['created-1', 'created-3'] },
      ]);
      expect(result.warnings).toEqual([]);
    });

    it('names the halves and the blocks as asked, trimmed', async () => {
      tx.studentGroup.createManyAndReturn.mockResolvedValue([
        { id: HALF_1, name: '7A grupp 1' },
        { id: HALF_2, name: '7A grupp 2' },
      ]);
      const result = await service.split(
        POST,
        { ...DTO, halfNames: [' 7A grupp 1', '7A grupp 2 '], blockNames: [' Slöjd 7A höst ', 'Slöjd 7A vår'] },
        admin,
      );

      expect(tx.studentGroup.createManyAndReturn).toHaveBeenCalledWith({
        data: [expect.objectContaining({ name: '7A grupp 1' }), expect.objectContaining({ name: '7A grupp 2' })],
      });
      expect(result.blocks.map((block) => block.name)).toEqual(['Slöjd 7A höst', 'Slöjd 7A vår']);
    });

    it('pairs the new halves with the subjects by the names asked for, not by the order the insert returns them in', async () => {
      tx.studentGroup.createManyAndReturn.mockResolvedValue([
        { id: HALF_2, name: '7A:2' },
        { id: HALF_1, name: '7A:1' },
      ]);

      const result = await service.split(POST, DTO, admin);

      expect(result.halves.map((half) => half.id)).toEqual([HALF_1, HALF_2]);
      const [{ data }] = tx.teachingRequirement.createManyAndReturn.mock.calls[0] as [{ data: Record<string, unknown>[] }];
      expect(data[0]).toEqual(expect.objectContaining({ studentGroupId: HALF_1, subjectId: TEXTIL, endDate: day('2027-01-10') }));
    });

    it('copies the weeks of a post on odd weeks to all four, so each block’s two posts agree', async () => {
      givenPost(source({ recurrence: 'ODD_WEEKS' }));

      await service.split(POST, DTO, admin);

      const [{ data }] = tx.teachingRequirement.createManyAndReturn.mock.calls[0] as [{ data: Record<string, unknown>[] }];
      expect(data.map((row) => row.recurrence)).toEqual(['ODD_WEEKS', 'ODD_WEEKS', 'ODD_WEEKS', 'ODD_WEEKS']);
    });

    it('leaves a subject without a teacher when none is named', async () => {
      await service.split(POST, { ...DTO, subjects: [{ subjectId: TEXTIL }, { subjectId: TRA, teacherId: null }] }, admin);

      const [{ data }] = tx.teachingRequirement.createManyAndReturn.mock.calls[0] as [{ data: Record<string, unknown>[] }];
      expect(data.map((row) => row.teacherId)).toEqual([null, null, null, null]);
      // Nobody to judge, so the policy is not even read.
      expect(openChecks).not.toHaveBeenCalled();
    });
  });

  it('uses the halves a class already has, in name order, and splits nothing', async () => {
    givenPost(
      source({
        studentGroup: {
          id: CLASS,
          name: '7A',
          kind: 'CLASS',
          halves: [
            { id: HALF_1, name: '7A:1' },
            { id: HALF_2, name: '7A:2' },
          ],
        },
      }),
    );

    const result = await service.split(POST, DTO, admin);

    expect(tx.studentGroup.createManyAndReturn).not.toHaveBeenCalled();
    expect(result.createdHalves).toBe(false);
    expect(result.halves.map((half) => half.id)).toEqual([HALF_1, HALF_2]);
    // Asked whether either half has either subject already.
    expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { studentGroupId: { in: [HALF_1, HALF_2] }, subjectId: { in: [TEXTIL, TRA] } },
      }),
    );
  });

  it('takes the class’s halves in the order the request names them, whatever their names sort as', async () => {
    givenPost(
      source({
        studentGroup: {
          id: CLASS,
          name: '7A',
          kind: 'CLASS',
          halves: [
            { id: HALF_1, name: '7A:1' },
            { id: HALF_2, name: '7A:2' },
          ],
        },
      }),
    );

    const result = await service.split(POST, { ...DTO, halfIds: [HALF_2, HALF_1] }, admin);

    expect(result.halves.map((half) => half.id)).toEqual([HALF_2, HALF_1]);
    const [{ data }] = tx.teachingRequirement.createManyAndReturn.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    // The first half named reads the first subject in the autumn.
    expect(data[0]).toEqual(expect.objectContaining({ studentGroupId: HALF_2, subjectId: TEXTIL, endDate: day('2027-01-10') }));
  });

  it('carries the co-teachers the request names, and the class’s load percentages, to every post', async () => {
    givenPost(source({ coTeacherId: CECILIA, teacherLoadPercent: 120, coTeacherLoadPercent: 80 }));

    await service.split(
      POST,
      { ...DTO, subjects: [{ subjectId: TEXTIL, teacherId: ANNA, coTeacherId: CECILIA }, { subjectId: TRA, teacherId: BO, coTeacherId: null }] },
      admin,
    );

    const [{ data }] = tx.teachingRequirement.createManyAndReturn.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(data.map((row) => [row.subjectId, row.teacherId, row.coTeacherId, row.teacherLoadPercent, row.coTeacherLoadPercent])).toEqual([
      [TEXTIL, ANNA, CECILIA, 120, 80],
      [TRA, BO, null, 120, 80],
      [TRA, BO, null, 120, 80],
      [TEXTIL, ANNA, CECILIA, 120, 80],
    ]);
  });

  it('carries the class’s co-teacher to the subject the request leaves it to, when the other names none', async () => {
    givenPost(source({ coTeacherId: CECILIA }));

    await service.split(POST, { ...DTO, subjects: [{ subjectId: TEXTIL, teacherId: ANNA }, { subjectId: TRA, teacherId: BO, coTeacherId: null }] }, admin);

    const [{ data }] = tx.teachingRequirement.createManyAndReturn.mock.calls[0] as [{ data: Record<string, unknown>[] }];
    expect(data.map((row) => row.coTeacherId)).toEqual([CECILIA, null, null, CECILIA]);
  });

  describe('the national code (Skapa timplansposter and the plan’s national rows)', () => {
    const coded = (codes: Record<string, string | null>) =>
      tx.subject.findMany.mockResolvedValue([
        { id: TEXTIL, name: 'Textilslöjd', nationalCode: codes[TEXTIL] ?? null },
        { id: TRA, name: 'Trä- och metallslöjd', nationalCode: codes[TRA] ?? null },
      ]);

    it('says nothing when both subjects carry the class’s post’s code', async () => {
      givenPost(source({ subject: { name: 'Slöjd', nationalCode: 'SL' } }));
      coded({ [TEXTIL]: 'SL', [TRA]: 'SL' });

      expect((await service.split(POST, DTO, admin)).codeWarnings).toEqual([]);
    });

    it('names a subject without the code, and splits all the same', async () => {
      givenPost(source({ subject: { name: 'Slöjd', nationalCode: 'SL' } }));
      coded({ [TEXTIL]: 'SL', [TRA]: null });

      const result = await service.split(POST, DTO, admin);

      expect(result.codeWarnings).toEqual([
        { subjectId: TRA, subjectName: 'Trä- och metallslöjd', nationalCode: null, lineNationalCode: 'SL' },
      ]);
      expect(tx.teachingRequirement.createManyAndReturn).toHaveBeenCalled();
    });

    it('names every chosen subject when the class’s post has no code, but not the post’s own subject', async () => {
      givenPost(source({ subject: { name: 'Slöjd', nationalCode: null } }));
      tx.subject.findMany.mockResolvedValue([
        { id: TRA, name: 'Trä- och metallslöjd', nationalCode: null },
        { id: SLOJD, name: 'Slöjd', nationalCode: null },
      ]);

      const result = await service.split(POST, { ...DTO, subjects: [{ subjectId: SLOJD }, { subjectId: TRA }] }, admin);

      expect(result.codeWarnings.map((warning) => warning.subjectId)).toEqual([TRA]);
    });
  });

  describe('refuses, before anything is written', () => {
    const nothingWritten = () => {
      expect(tx.teachingRequirement.deleteMany).not.toHaveBeenCalled();
      expect(tx.teachingBlock.create).not.toHaveBeenCalled();
      expect(tx.teachingRequirement.createManyAndReturn).not.toHaveBeenCalled();
    };

    it('the same subject twice, without opening a transaction', async () => {
      const error = await service
        .split(POST, { ...DTO, subjects: [{ subjectId: TEXTIL }, { subjectId: TEXTIL }] }, admin)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(expect.objectContaining({ code: TERM_SUBJECTS_SAME }));
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it.each([
      ['one teacher for both subjects', { teacherId: ANNA }, { teacherId: ANNA }],
      ['one subject’s teacher as the other’s co-teacher', { teacherId: ANNA }, { teacherId: BO, coTeacherId: ANNA }],
      ['one co-teacher for both subjects', { teacherId: ANNA, coTeacherId: CECILIA }, { teacherId: BO, coTeacherId: CECILIA }],
    ])('%s, whom each block would need at two posts at once', async (_, one, two) => {
      const error = await service
        .split(POST, { ...DTO, subjects: [{ subjectId: TEXTIL, ...one }, { subjectId: TRA, ...two }] }, admin)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(expect.objectContaining({ code: TERM_TEACHER_TWICE }));
      nothingWritten();
    });

    it('a teacher who is their own co-teacher, without opening a transaction', async () => {
      await expect(
        service.split(POST, { ...DTO, subjects: [{ subjectId: TEXTIL, teacherId: ANNA, coTeacherId: ANNA }, { subjectId: TRA }] }, admin),
      ).rejects.toThrow(SAME_TEACHER_TWICE);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('the class’s co-teacher, carried to a subject whose teacher the request makes them', async () => {
      givenPost(source({ coTeacherId: CECILIA }));

      const error = await service
        .split(POST, { ...DTO, subjects: [{ subjectId: TEXTIL, teacherId: CECILIA }, { subjectId: TRA, teacherId: BO, coTeacherId: null }] }, admin)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(/^subjects: Slöjd för 7A har läraren som medlärare i ämne 1\./);
      nothingWritten();
    });

    it('the class’s co-teacher, carried to both subjects when the request names none, and says which to choose', async () => {
      givenPost(source({ coTeacherId: CECILIA }));

      const error = await service.split(POST, DTO, admin).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual({
        message: expect.stringMatching(/Slöjd för 7A har en medlärare: välj vilket av ämnena hen följer, eller inget\.$/),
        code: TERM_TEACHER_TWICE,
      });
      nothingWritten();
    });

    it('halves the request names that are not the class’s two, or halves the class no longer has', async () => {
      givenPost(source({ studentGroup: { id: CLASS, name: '7A', kind: 'CLASS', halves: [{ id: HALF_1, name: '7A:1' }, { id: HALF_2, name: '7A:2' }] } }));
      for (const halfIds of [[HALF_1, POST], [HALF_1, HALF_1]]) {
        const error = await service.split(POST, { ...DTO, halfIds }, admin).catch((e: unknown) => e);
        expect((error as ConflictException).getResponse()).toEqual(expect.objectContaining({ code: NOT_THE_CLASS_HALVES }));
      }
      givenPost(source());
      const gone = await service.split(POST, { ...DTO, halfIds: [HALF_1, HALF_2] }, admin).catch((e: unknown) => e);
      expect((gone as ConflictException).getResponse()).toEqual(expect.objectContaining({ code: NOT_THE_CLASS_HALVES }));
      expect(tx.studentGroup.createManyAndReturn).not.toHaveBeenCalled();
      nothingWritten();
    });

    it('new half names for a class that has its halves since the request was drawn', async () => {
      givenPost(source({ studentGroup: { id: CLASS, name: '7A', kind: 'CLASS', halves: [{ id: HALF_1, name: '7A:1' }, { id: HALF_2, name: '7A:2' }] } }));

      const error = await service.split(POST, { ...DTO, halfNames: ['A', 'B'] }, admin).catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toEqual(expect.objectContaining({ code: CLASS_ALREADY_SPLIT }));
      nothingWritten();
    });

    it('both half ids and half names', async () => {
      await expect(
        service.split(POST, { ...DTO, halfIds: [HALF_1, HALF_2], halfNames: ['A', 'B'] }, admin),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('a post that is not there', async () => {
      givenPost(null);

      await expect(service.split(POST, DTO, admin)).rejects.toThrow(NotFoundException);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['a teaching group’s post', { studentGroup: { id: CLASS, name: 'Ma71', kind: 'TEACHING_GROUP', halves: [] } }, BadRequestException, NOT_A_CLASS],
      ['a post in a block', { blockId: AUTUMN, block: { name: 'Slöjd åk 7' } }, ConflictException, REQUIREMENT_IN_A_BLOCK],
      ['a post that already ends', { endDate: day('2027-01-10') }, BadRequestException, REQUIREMENT_HAS_PERIOD],
      ['a post that starts later', { startDate: day('2027-01-11') }, BadRequestException, REQUIREMENT_HAS_PERIOD],
      [
        'a class with one half left',
        { studentGroup: { id: CLASS, name: '7A', kind: 'CLASS', halves: [{ id: HALF_1, name: '7A:1' }] } },
        ConflictException,
        CLASS_HAS_ONE_HALF,
      ],
    ])('%s', async (_, overrides, type, code) => {
      givenPost(source(overrides));

      const error = await service.split(POST, DTO, admin).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(type);
      expect((error as ConflictException).getResponse()).toEqual(expect.objectContaining({ code }));
      expect(tx.studentGroup.createManyAndReturn).not.toHaveBeenCalled();
      nothingWritten();
    });

    it.each(['2026-08-17', '2026-08-01', '2027-06-12'])('a spring that starts on %s, leaving a term outside the year', async (springStartDate) => {
      const error = await service.split(POST, { ...DTO, springStartDate }, admin).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toEqual(
        expect.objectContaining({ code: SPRING_START_OUTSIDE_YEAR, message: expect.stringContaining('2026-08-17 till 2027-06-11') }),
      );
      nothingWritten();
    });

    it('accepts a spring that starts on the year’s last day', async () => {
      await service.split(POST, { ...DTO, springStartDate: '2027-06-11' }, admin);

      const [{ data }] = tx.teachingRequirement.createManyAndReturn.mock.calls[0] as [{ data: Record<string, unknown>[] }];
      expect(data[1]).toEqual(expect.objectContaining({ startDate: day('2027-06-11'), endDate: null }));
    });

    it('a half that already has a post in one of the subjects, naming it', async () => {
      tx.teachingRequirement.findMany.mockResolvedValue([
        { studentGroup: { name: '7A:2' }, subject: { name: 'Textilslöjd' } },
      ]);

      const error = await service.split(POST, DTO, admin).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        message: '7A:2 har redan en post i Textilslöjd. Ta bort den eller välj ett annat ämne.',
        code: HALF_HAS_SUBJECT,
      });
      nothingWritten();
    });

    it('a block name the year has', async () => {
      tx.teachingBlock.findMany.mockResolvedValue([{ name: 'Slöjd 7A VT' }]);

      const error = await service.split(POST, DTO, admin).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: TEACHING_BLOCK_NAME_TAKEN, message: expect.stringContaining('"Slöjd 7A VT"') }),
      );
      expect(tx.teachingBlock.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR, name: { in: ['Slöjd 7A HT', 'Slöjd 7A VT'] } } }),
      );
      nothingWritten();
    });

    it('the same block name for both terms', async () => {
      await expect(
        service.split(POST, { ...DTO, blockNames: ['Slöjd 7A', ' slöjd 7a'] }, admin),
      ).rejects.toThrow(BadRequestException);
      nothingWritten();
    });

    it('a subject that is not the school’s', async () => {
      tx.subject.findMany.mockResolvedValue([{ id: TEXTIL, name: 'Textilslöjd' }]);

      await expect(service.split(POST, DTO, admin)).rejects.toThrow(BadRequestException);
      nothingWritten();
    });

    it('a class Dela klassen itself refuses, with its code', async () => {
      tx.studentGroup.findUnique.mockResolvedValue({
        name: '7A',
        kind: 'CLASS',
        academicYearId: YEAR,
        gradeLevel: 7,
        _count: { halves: 2 },
      });

      const error = await service.split(POST, DTO, admin).catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toEqual(expect.objectContaining({ code: CLASS_ALREADY_SPLIT }));
      nothingWritten();
    });
  });

  it('answers 409 and writes no block or post when the class’s post changed while it was read', async () => {
    tx.teachingRequirement.deleteMany.mockResolvedValue({ count: 0 });

    const error = await service.split(POST, DTO, admin).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual(expect.objectContaining({ code: WRITE_CONFLICT }));
    expect(tx.teachingBlock.create).not.toHaveBeenCalled();
    expect(tx.teachingRequirement.createManyAndReturn).not.toHaveBeenCalled();
  });

  describe('the staffing policy', () => {
    const finding = (mode: 'WARN' | 'REFUSE'): StaffingFinding =>
      ({ code: 'STAFF_TEACHER_NOT_QUALIFIED', mode, params: { teacherName: 'Bo', subjectName: 'Trä- och metallslöjd', gradeLevels: '7' } }) as unknown as StaffingFinding;

    const givenChecks = (answer: (args: { subjectId: string; studentGroupId: string; requirementId: string | null }) => StaffingFinding[]) => {
      const judge = jest.fn((args: { subjectId: string; studentGroupId: string; requirementId: string | null; patch: unknown }) => ({
        findings: answer(args),
        after: { id: args.requirementId ?? 'new' } as never,
      }));
      const apply = jest.fn();
      const stored = jest.fn((id: string) =>
        id === POST
          ? ({ id: POST, subjectId: SLOJD, subjectName: 'Slöjd', studentGroupId: CLASS, groupName: '7A' } as never)
          : null,
      );
      openChecks.mockResolvedValue({ judge, apply, stored } as unknown as RequirementImportChecks);
      return { judge, apply };
    };

    it('takes the class’s post off its teacher first, then judges the four posts with their periods, each counted for the next', async () => {
      const { judge, apply } = givenChecks(() => []);

      await service.split(POST, DTO, admin);

      expect(openChecks).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ academicYearId: YEAR, teacherIds: [ANNA, BO], groupIds: [CLASS, HALF_1, HALF_2] }),
      );
      expect(judge.mock.calls[0]![0]).toEqual(
        expect.objectContaining({ requirementId: POST, patch: { teacherId: null, coTeacherId: null } }),
      );
      expect(judge.mock.calls.slice(1).map(([args]) => [args.studentGroupId, args.subjectId, args.patch])).toEqual([
        [HALF_1, TEXTIL, expect.objectContaining({ teacherId: ANNA, coTeacherId: null, teacherLoadPercent: 100, coTeacherLoadPercent: 100, lessonsPerWeek: 2, lessonLengths: [80, 40], startDate: null, endDate: '2027-01-10' })],
        [HALF_1, TRA, expect.objectContaining({ teacherId: BO, startDate: '2027-01-11', endDate: null })],
        [HALF_2, TRA, expect.objectContaining({ teacherId: BO, startDate: null, endDate: '2027-01-10' })],
        [HALF_2, TEXTIL, expect.objectContaining({ teacherId: ANNA, startDate: '2027-01-11', endDate: null })],
      ]);
      expect(apply).toHaveBeenCalledTimes(5);
      // Judged before the class's post is removed.
      expect(judge.mock.invocationCallOrder.at(-1)!).toBeLessThan(
        tx.teachingRequirement.deleteMany.mock.invocationCallOrder[0]!,
      );
    });

    it('charges each post’s teacher and co-teacher at the class’s percentages, and asks about the co-teacher too', async () => {
      givenPost(source({ coTeacherId: CECILIA, teacherLoadPercent: 120, coTeacherLoadPercent: 80 }));
      const { judge } = givenChecks(() => []);

      await service.split(
        POST,
        { ...DTO, subjects: [{ subjectId: TEXTIL, teacherId: null, coTeacherId: CECILIA }, { subjectId: TRA, teacherId: BO, coTeacherId: null }] },
        admin,
      );

      expect(openChecks).toHaveBeenCalledWith(tx, expect.objectContaining({ teacherIds: [CECILIA, BO] }));
      // The class's post's teachers first, then all four: a post with only a
      // co-teacher is asked about as well.
      expect(judge.mock.calls.slice(1).map(([args]) => [args.subjectId, args.patch])).toEqual([
        [TEXTIL, expect.objectContaining({ teacherId: null, coTeacherId: CECILIA, teacherLoadPercent: 120, coTeacherLoadPercent: 80 })],
        [TRA, expect.objectContaining({ teacherId: BO, coTeacherId: null, teacherLoadPercent: 120, coTeacherLoadPercent: 80 })],
        [TRA, expect.objectContaining({ teacherId: BO, coTeacherId: null })],
        [TEXTIL, expect.objectContaining({ teacherId: null, coTeacherId: CECILIA })],
      ]);
    });

    it('refuses with a 409 naming the half’s post, and writes nothing', async () => {
      givenChecks(({ subjectId, studentGroupId }) =>
        subjectId === TRA && studentGroupId === HALF_2 ? [finding('REFUSE')] : [],
      );

      const error = await service.split(POST, DTO, admin).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual(
        expect.objectContaining({
          message: expect.stringMatching(/^Trä- och metallslöjd för 7A:2: /),
          code: 'STAFF_TEACHER_NOT_QUALIFIED',
          params: expect.objectContaining({ subjectId: TRA, studentGroupId: HALF_2 }),
        }),
      );
      expect(tx.teachingRequirement.deleteMany).not.toHaveBeenCalled();
      expect(tx.teachingRequirement.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('answers each WARN with the post it is about', async () => {
      givenChecks(({ subjectId, requirementId }) => (requirementId === null && subjectId === TRA ? [finding('WARN')] : []));

      const result = await service.split(POST, DTO, admin);

      expect(result.warnings.map((warning) => [warning.code, warning.requirementId])).toEqual([
        ['STAFF_TEACHER_NOT_QUALIFIED', 'created-1'],
        ['STAFF_TEACHER_NOT_QUALIFIED', 'created-2'],
      ]);
    });
  });
});
