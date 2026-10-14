import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { TimplanRequirementsService } from './timplan-requirements.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const PLAN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const MA = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const SV = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const A7 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';

describe('TimplanRequirementsService', () => {
  let service: TimplanRequirementsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TimplanRequirementsService(prisma as unknown as PrismaService);
    tx.localTimplan.findUnique.mockResolvedValue({
      id: PLAN_ID,
      name: 'Grundskolan 2027',
      status: 'DRAFT',
      entries: [
        { subjectId: MA, gradeLevel: 7, minutesPerWeek: 175 },
        { subjectId: SV, gradeLevel: 7, minutesPerWeek: 200 },
      ],
    });
    tx.academicYear.findUnique.mockResolvedValue({ id: YEAR_ID });
    tx.academicYearTimplan.findMany.mockResolvedValue([{ gradeLevel: 7 }]);
    tx.studentGroup.findMany.mockResolvedValue([{ id: A7, name: '7A', gradeLevel: 7 }]);
    tx.subject.findMany.mockResolvedValue([
      { id: MA, name: 'Matematik' },
      { id: SV, name: 'Svenska' },
    ]);
  });

  const dto = (dryRun: boolean) => ({ academicYearId: YEAR_ID, minutesPerLesson: 60, dryRun });

  it('previews without writing, and says the plan is a draft', async () => {
    const answer = await service.generate(PLAN_ID, dto(true), testUser());

    expect(answer).toMatchObject({ planStatus: 'DRAFT', gradeLevels: [7], dryRun: true, created: 0 });
    expect(answer.rows.map((row) => [row.subjectName, row.lessonsPerWeek, row.surplusMinutesPerWeek])).toEqual([
      ['Matematik', 3, 5],
      ['Svenska', 4, 40],
    ]);
    expect(tx.teachingRequirement.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('reads only CLASS groups of the attached årskurser, and the year’s existing pairs for them', async () => {
    await service.generate(PLAN_ID, dto(true), testUser());
    expect(tx.academicYearTimplan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { academicYearId: YEAR_ID, localTimplanId: PLAN_ID } }),
    );
    expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
      where: { academicYearId: YEAR_ID, kind: 'CLASS', gradeLevel: { in: [7] } },
      select: { id: true, name: true, gradeLevel: true },
    });
    expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith({
      where: { academicYearId: YEAR_ID, studentGroupId: { in: [A7] } },
      select: { studentGroupId: true, subjectId: true },
    });
  });

  it('applies with ON CONFLICT DO NOTHING and no teacher, and moves a row somebody else created meanwhile to skipped', async () => {
    tx.teachingRequirement.createManyAndReturn.mockResolvedValue([
      { id: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', studentGroupId: A7, subjectId: MA },
    ]);

    const answer = await service.generate(PLAN_ID, dto(false), testUser());

    const call = tx.teachingRequirement.createManyAndReturn.mock.calls[0]![0] as {
      data: Record<string, unknown>[];
      skipDuplicates: boolean;
    };
    expect(call.skipDuplicates).toBe(true);
    expect(call.data[0]).toEqual({
      schoolId: SCHOOL_ID,
      academicYearId: YEAR_ID,
      subjectId: MA,
      studentGroupId: A7,
      lessonsPerWeek: 3,
      minutesPerLesson: 60,
      teacherId: null,
      coTeacherId: null,
      teacherLoadPercent: 100,
      coTeacherLoadPercent: 100,
      minutesBefore: 0,
      minutesAfter: 0,
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
    });
    expect(answer.created).toBe(1);
    expect(answer.rows).toEqual([
      expect.objectContaining({ subjectId: MA, requirementId: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1' }),
    ]);
    expect(answer.skipped).toEqual([expect.objectContaining({ subjectId: SV, reason: 'EXISTS' })]);
  });

  describe('språkval as a block', () => {
    const DE = 'd7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7';
    const ES = 'd6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6';
    const TY7 = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
    const SP7 = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
    const BLOCK = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
    const languages = (dryRun: boolean) => ({
      ...dto(dryRun),
      languageGroups: [
        { gradeLevel: 7, subjectId: DE, studentGroupId: TY7 },
        { gradeLevel: 7, subjectId: ES, studentGroupId: SP7 },
      ],
    });

    beforeEach(() => {
      tx.localTimplan.findUnique.mockResolvedValue({
        id: PLAN_ID,
        name: 'Grundskolan 2027',
        status: 'DECIDED',
        entries: [
          { subjectId: MA, gradeLevel: 7, minutesPerWeek: 180 },
          { subjectId: DE, gradeLevel: 7, minutesPerWeek: 120 },
          { subjectId: ES, gradeLevel: 7, minutesPerWeek: 120 },
        ],
      });
      tx.studentGroup.findMany.mockImplementation(async ({ where }: { where: { kind: string } }) =>
        where.kind === 'CLASS'
          ? [{ id: A7, name: '7A', gradeLevel: 7 }]
          : [
              { id: TY7, name: 'Ty7' },
              { id: SP7, name: 'Sp7' },
            ],
      );
      tx.subject.findMany.mockResolvedValue([
        { id: MA, name: 'Matematik', nationalCode: 'MA' },
        { id: DE, name: 'Tyska', nationalCode: 'M2' },
        { id: ES, name: 'Spanska', nationalCode: 'M2' },
      ]);
      tx.teachingBlock.upsert.mockResolvedValue({ id: BLOCK });
      tx.teachingRequirement.createManyAndReturn.mockImplementation(async ({ data }: { data: Record<string, string>[] }) =>
        data.map((row, index) => ({ id: `f${index}`, studentGroupId: row['studentGroupId'], subjectId: row['subjectId'] })),
      );
    });

    it('previews the block and the rows in it, reading the groups as teaching groups of the year', async () => {
      const answer = await service.generate(PLAN_ID, languages(true), testUser());

      expect(answer.blocks).toEqual([{ name: 'Språkval åk 7', gradeLevel: 7 }]);
      expect(answer.rows.filter((row) => row.blockName).map((row) => row.groupName)).toEqual(['Sp7', 'Ty7']);
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
        where: { id: { in: [TY7, SP7] }, academicYearId: YEAR_ID, kind: 'TEACHING_GROUP' },
        select: { id: true, name: true },
      });
      expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID, studentGroupId: { in: [A7, TY7, SP7] } },
        select: { studentGroupId: true, subjectId: true },
      });
      expect(tx.teachingBlock.upsert).not.toHaveBeenCalled();
    });

    it('writes the year’s block of that name first, and the rows name it in the one INSERT', async () => {
      await service.generate(PLAN_ID, languages(false), testUser());

      expect(tx.teachingBlock.upsert).toHaveBeenCalledWith({
        where: { schoolId_academicYearId_name: { schoolId: SCHOOL_ID, academicYearId: YEAR_ID, name: 'Språkval åk 7' } },
        create: { schoolId: SCHOOL_ID, academicYearId: YEAR_ID, name: 'Språkval åk 7' },
        update: {},
        select: { id: true },
      });
      const { data } = tx.teachingRequirement.createManyAndReturn.mock.calls[0]![0] as {
        data: Record<string, unknown>[];
      };
      expect(data.map((row) => [row['studentGroupId'], row['blockId'] ?? null])).toEqual([
        [A7, null],
        [SP7, BLOCK],
        [TY7, BLOCK],
      ]);
      expect(tx.teachingBlock.upsert.mock.invocationCallOrder[0]).toBeLessThan(
        tx.teachingRequirement.createManyAndReturn.mock.invocationCallOrder[0]!,
      );
    });

    it.each([true, false])(
      'refuses a block of that name holding another årskurs\' posts, preview and apply alike (dryRun %s)',
      async (dryRun) => {
        tx.teachingBlock.findMany.mockResolvedValue([
          {
            name: 'Språkval åk 7',
            requirements: [
              { studentGroup: { name: 'Ty8', gradeLevel: 8 } },
              { studentGroup: { name: 'Ma7 grupp 1', gradeLevel: 7 } },
              { studentGroup: { name: 'Fr8', gradeLevel: 8 } },
              { studentGroup: { name: 'Elevens val', gradeLevel: null } },
            ],
          },
        ]);

        const refusal = await service.generate(PLAN_ID, languages(dryRun), testUser()).catch((error) => error);

        expect(refusal).toBeInstanceOf(ConflictException);
        expect(refusal.getResponse()).toMatchObject({
          code: 'LANGUAGE_BLOCK_IN_OTHER_GRADE',
          message: expect.stringContaining('"Språkval åk 7", och det håller poster i en annan årskurs (Fr8, Ty8)'),
        });
        expect(tx.teachingBlock.findMany).toHaveBeenCalledWith({
          where: { academicYearId: YEAR_ID, name: { in: ['Språkval åk 7'] } },
          select: {
            name: true,
            requirements: {
              select: {
                lessonsPerWeek: true,
                minutesPerLesson: true,
                lessonLengths: true,
                recurrence: true,
                startDate: true,
                endDate: true,
                studentGroup: { select: { name: true, gradeLevel: true } },
              },
            },
          },
        });
        expect(tx.teachingBlock.upsert).not.toHaveBeenCalled();
        expect(tx.teachingRequirement.createManyAndReturn).not.toHaveBeenCalled();
      },
    );

    // A member of the year's "Språkval åk 7" as the pre-check reads it: the
    // proposal's 2 × 60 on all weeks unless the case says otherwise.
    const held = (name: string, gradeLevel: number | null, extra: Record<string, unknown> = {}) => ({
      lessonsPerWeek: 2,
      minutesPerLesson: 60,
      lessonLengths: [],
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      studentGroup: { name, gradeLevel },
      ...extra,
    });

    it.each([true, false])(
      'refuses a block of that name whose posts have other lessons, naming both, preview and apply alike (dryRun %s)',
      async (dryRun) => {
        tx.teachingBlock.findMany.mockResolvedValue([
          {
            name: 'Språkval åk 7',
            requirements: [held('Fr7', 7, { lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] })],
          },
        ]);

        const refusal = await service.generate(PLAN_ID, languages(dryRun), testUser()).catch((error) => error);

        expect(refusal).toBeInstanceOf(ConflictException);
        expect(refusal.getResponse()).toMatchObject({
          code: 'LANGUAGE_BLOCK_HAS_OTHER_LESSONS',
          message: expect.stringContaining(
            'Blocket "Språkval åk 7" har lektionerna 1 × 80 + 1 × 40, och språkvalets nya poster skulle få 2 × 60.',
          ),
        });
        expect(tx.teachingBlock.upsert).not.toHaveBeenCalled();
        expect(tx.teachingRequirement.createManyAndReturn).not.toHaveBeenCalled();
      },
    );

    it('refuses a block of that name whose posts have weeks of their own', async () => {
      tx.teachingBlock.findMany.mockResolvedValue([
        { name: 'Språkval åk 7', requirements: [held('Fr7', 7, { recurrence: 'ODD_WEEKS' })] },
      ]);

      const refusal = await service.generate(PLAN_ID, languages(true), testUser()).catch((error) => error);

      expect(refusal.getResponse()).toMatchObject({
        code: 'LANGUAGE_BLOCK_HAS_OTHER_LESSONS',
        message: expect.stringContaining('måste ha samma veckor'),
      });
    });

    it('joins a block of that name whose posts are in its årskurs, or in groups without one', async () => {
      tx.teachingBlock.findMany.mockResolvedValue([
        { name: 'Språkval åk 7', requirements: [held('Fr7', 7), held('Sp-grupp', null)] },
      ]);

      await service.generate(PLAN_ID, languages(false), testUser());

      expect(tx.teachingBlock.upsert).toHaveBeenCalledTimes(1);
      expect(tx.teachingRequirement.createManyAndReturn).toHaveBeenCalledTimes(1);
    });

    it('refuses a group that is no teaching group of the year, naming the row', async () => {
      tx.studentGroup.findMany.mockImplementation(async ({ where }: { where: { kind: string } }) =>
        where.kind === 'CLASS' ? [{ id: A7, name: '7A', gradeLevel: 7 }] : [{ id: TY7, name: 'Ty7' }],
      );

      await expect(service.generate(PLAN_ID, languages(false), testUser())).rejects.toThrow(
        'languageGroups: rad 2: gruppen är ingen undervisningsgrupp i läsåret.',
      );
      expect(tx.teachingRequirement.createManyAndReturn).not.toHaveBeenCalled();
    });
  });

  it('SPLIT writes the lengths of a split row, and only of a split row', async () => {
    tx.teachingRequirement.createManyAndReturn.mockResolvedValue([
      { id: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1', studentGroupId: A7, subjectId: MA },
      { id: 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2', studentGroupId: A7, subjectId: SV },
    ]);

    const answer = await service.generate(PLAN_ID, { ...dto(false), remainder: 'SPLIT' }, testUser());

    const call = tx.teachingRequirement.createManyAndReturn.mock.calls[0]![0] as { data: Record<string, unknown>[] };
    // Matematik 175 at 60: 2 × 60 + 1 × 55. Svenska 200 at 60: the 20 folded, 1 × 80 + 2 × 60.
    expect(call.data.map((row) => [row['lessonsPerWeek'], row['minutesPerLesson'], row['lessonLengths']])).toEqual([
      [3, 60, [60, 60, 55]],
      [3, 80, [80, 60, 60]],
    ]);
    expect(answer).toMatchObject({ remainder: 'SPLIT', created: 2 });
  });

  it('an omitted remainder is ROUND_UP, with no echo and no list', async () => {
    const answer = await service.generate(PLAN_ID, dto(true), testUser());
    expect(answer).not.toHaveProperty('remainder');
    expect(JSON.stringify(answer)).not.toContain('lessonLengths');
  });

  it('is idempotent: a second apply finds both rows and writes nothing', async () => {
    tx.teachingRequirement.findMany.mockResolvedValue([
      { studentGroupId: A7, subjectId: MA },
      { studentGroupId: A7, subjectId: SV },
    ]);
    const answer = await service.generate(PLAN_ID, dto(false), testUser());
    expect(answer).toMatchObject({ created: 0, rows: [] });
    expect(answer.skipped).toHaveLength(2);
    expect(tx.teachingRequirement.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('404s a plan or a year RLS hides', async () => {
    tx.localTimplan.findUnique.mockResolvedValueOnce(null);
    await expect(service.generate(PLAN_ID, dto(true), testUser())).rejects.toThrow('Den lokala timplanen finns inte.');
    tx.academicYear.findUnique.mockResolvedValueOnce(null);
    await expect(service.generate(PLAN_ID, dto(true), testUser())).rejects.toThrow(NotFoundException);
  });

  it('answers an empty proposal for a year that does not follow the plan, reading no classes', async () => {
    tx.academicYearTimplan.findMany.mockResolvedValue([]);
    const answer = await service.generate(PLAN_ID, dto(false), testUser());
    expect(answer).toMatchObject({ gradeLevels: [], rows: [], skipped: [], created: 0 });
    expect(tx.studentGroup.findMany).not.toHaveBeenCalled();
  });
});
