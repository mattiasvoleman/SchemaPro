import { NotFoundException } from '@nestjs/common';
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
