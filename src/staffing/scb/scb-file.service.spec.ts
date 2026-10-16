import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../../test/utils/prisma-mock';
import { recordedReads } from '../../../test/utils/recorded-reads';
import type { PrismaService } from '../../database/prisma.service';
import { ScbFileService } from './scb-file.service';
import { SCB_COLUMNS } from './scb-pedpers';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ANNA = '44444444-4444-4444-8444-444444444444';
const BO = '55555555-5555-4555-8555-555555555555';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_7A = '66666666-6666-4666-8666-666666666666';
const MA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UNIT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const col = (name: string) => SCB_COLUMNS.indexOf(name as (typeof SCB_COLUMNS)[number]);

describe('ScbFileService', () => {
  let service: ScbFileService;
  let tx: TxMock;
  let prisma: PrismaMock;

  const postRow = (userId: string, overrides: Record<string, unknown> = {}) => ({
    id: `post-${userId}`,
    userId,
    academicYearId: YEAR_ID,
    employmentPercent: new Prisma.Decimal('100.000'),
    reductionPercent: new Prisma.Decimal('0.000'),
    contractKind: 'FERIE',
    employmentForm: 'TILLSVIDARE',
    firstTeacherPercent: null,
    lecturerPercent: null,
    teachingTargetMinutesPerWeek: null,
    signature: null,
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ScbFileService(prisma as unknown as PrismaService);
    tx.academicYear.findUnique.mockImplementation(({ select }: { select: Record<string, unknown> }) =>
      Promise.resolve(
        'startDate' in select
          ? { startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: new Date('2027-06-11T00:00:00.000Z'), isActive: true, predecessorId: null }
          : { name: '2026/27', school: { name: 'Norra skolan', timezone: 'Europe/Stockholm' } },
      ),
    );
    tx.teacherEmployment.findMany.mockResolvedValue([
      postRow(ANNA, { employmentForm: 'VISSTID', firstTeacherPercent: 10 }),
      postRow(BO, { employmentForm: null }),
    ]);
    tx.teachingRequirement.findMany.mockResolvedValue([
      {
        id: 'req-1',
        subjectId: MA,
        studentGroupId: GROUP_7A,
        teacherId: ANNA,
        coTeacherId: null,
        lessonsPerWeek: 4,
        minutesPerLesson: 60,
        lessonLengths: [],
        teacherLoadPercent: 100,
        coTeacherLoadPercent: 100,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        subject: { name: 'Matematik' },
        studentGroup: { name: '7A', gradeLevel: 7 },
      },
    ]);
    tx.studentGroup.findMany.mockResolvedValue([{ id: GROUP_7A, gradeLevel: 7, name: '7A', kind: 'CLASS' }]);
    tx.teacherDuty.findMany.mockImplementation(({ where }: { where: { kind?: string } }) =>
      Promise.resolve(where.kind === 'FORSTELARARE' ? [{ userId: BO, validFrom: null, validTo: null }] : []),
    );
    tx.subject.findMany.mockResolvedValue([{ id: MA, nationalCode: 'MA', code: 'MA', name: 'Matematik' }]);
    tx.academicYearTimplan.findMany.mockResolvedValue([{ gradeLevel: 7, localTimplan: { schoolForm: 'GRUNDSKOLA' } }]);
    tx.schoolUnit.findMany.mockResolvedValue([{ id: UNIT, name: 'Norra skolan', code: '12345678', gradeFrom: 0, gradeTo: 9 }]);
    tx.user.findMany.mockResolvedValue([
      { id: ANNA, firstName: 'Anna', lastName: 'Öberg', role: 'TEACHER', isActive: true, deactivatedAt: null },
      { id: BO, firstName: 'Bo', lastName: 'Alm', role: 'TEACHER', isActive: false, deactivatedAt: new Date('2026-09-30T22:30:00.000Z') },
    ]);
  });

  it('builds the file in one RLS transaction, AnstForm and karriärtjänst from the post’s own row', async () => {
    const user = testUser({ channel: 'WEB' });
    // 23:30 UTC on 15 October is already the 16th in Stockholm: the school's day.
    const file = await service.build(YEAR_ID, user, new Date('2026-10-15T23:30:00.000Z'));

    expect(prisma.withRls).toHaveBeenCalledTimes(1);
    expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
    // The posts are read once: figures and SCB fields from one statement.
    expect(tx.teacherEmployment.findMany).toHaveBeenCalledTimes(1);
    expect(tx.schoolUnit.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL_ID } }));
    expect(tx.teacherDuty.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { academicYearId: YEAR_ID, kind: 'FORSTELARARE' } }),
    );

    expect(file.filename).toBe('scb-pedagogisk-personal-2026-27.txt');
    expect(file.rows.map((row) => [row[col('PersonNamn')], row[col('Datum')], row[col('AnstForm')], row[col('OmfLarare')], row[col('ForsteLarare')]])).toEqual([
      ['Bo Alm', '2026-10-16', '', '100', ''],
      ['Anna Öberg', '2026-10-16', 'V', '100', '10'],
    ]);
    expect(file.rows[1]![col('OmfMatematik')]).toBe('100');
    expect(file.missing).toEqual([
      { line: 1, name: 'Bo Alm', unit: 'Norra skolan', verksamhetstyp: '', fields: ['ANSTFORM', 'VERKSAMHETSTYP', 'FORSTELARARE_ANDEL'] },
    ]);
    // Closed at 00:30 on 1 October in Stockholm: the school's day, not UTC's.
    expect(file.notices).toContainEqual({ code: 'INACTIVE', params: { name: 'Bo Alm', date: '2026-10-01' } });
  });

  it('records the teachers the file names, EMPLOYMENT and PEOPLE, in the read’s transaction and nobody else', async () => {
    tx.teacherEmployment.findMany.mockResolvedValue([postRow(ANNA)]);
    await service.build(YEAR_ID, testUser({ channel: 'WEB' }));
    expect(recordedReads(tx)).toEqual([
      { kind: 'EMPLOYMENT', channel: 'WEB', ids: [ANNA] },
      { kind: 'PEOPLE', channel: 'WEB', ids: [ANNA] },
    ]);
    // Names and absences are asked only of the teachers in the file.
    expect(tx.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [ANNA] } } }));
    expect(tx.teacherAbsence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: { in: [ANNA] }, status: 'ACTIVE' }) }),
    );
  });

  it('names a long absence over the mätdatum in the school’s days, and records it as STAFF_ABSENCES', async () => {
    tx.teacherEmployment.findMany.mockResolvedValue([postRow(ANNA), postRow(BO)]);
    tx.teacherAbsence.findMany.mockResolvedValue([
      // 28 September 00:00 to 1 December 00:00 Stockholm: 28 September – 30 November.
      { userId: ANNA, startsAt: new Date('2026-09-27T22:00:00.000Z'), endsAt: new Date('2026-11-30T23:00:00.000Z') },
      // Two weeks: no notice, and not recorded.
      { userId: BO, startsAt: new Date('2026-10-05T22:00:00.000Z'), endsAt: new Date('2026-10-19T22:00:00.000Z') },
    ]);
    const file = await service.build(YEAR_ID, testUser({ channel: 'WEB' }));
    expect(file.notices).toContainEqual({ code: 'LONG_ABSENCE', params: { name: 'Anna Öberg', from: '2026-09-28', to: '2026-11-30' } });
    expect(file.notices.filter((notice) => notice.code === 'LONG_ABSENCE')).toHaveLength(1);
    expect(recordedReads(tx).find((read) => read.kind === 'STAFF_ABSENCES')).toEqual({ kind: 'STAFF_ABSENCES', channel: 'WEB', ids: [ANNA] });
  });

  it('reads the läsår’s absences, so records that follow on from each other are one, and records the joined one', async () => {
    tx.teacherEmployment.findMany.mockResolvedValue([postRow(BO)]);
    tx.teacherAbsence.findMany.mockResolvedValue([
      // 1–30 September and 1–28 October, Stockholm days: neither 30 days over the mätdatum alone.
      { userId: BO, startsAt: new Date('2026-08-31T22:00:00.000Z'), endsAt: new Date('2026-09-30T22:00:00.000Z') },
      { userId: BO, startsAt: new Date('2026-09-30T22:00:00.000Z'), endsAt: new Date('2026-10-28T23:00:00.000Z') },
    ]);
    const file = await service.build(YEAR_ID, testUser({ channel: 'WEB' }));
    // The window is the läsår, 17 August – 11 June, in the school's zone.
    expect(tx.teacherAbsence.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startsAt: { lt: new Date('2027-06-11T22:00:00.000Z') },
          endsAt: { gt: new Date('2026-08-16T22:00:00.000Z') },
        }),
      }),
    );
    expect(file.notices).toContainEqual({ code: 'LONG_ABSENCE', params: { name: 'Bo Alm', from: '2026-09-01', to: '2026-10-28' } });
    expect(recordedReads(tx).find((read) => read.kind === 'STAFF_ABSENCES')).toEqual({ kind: 'STAFF_ABSENCES', channel: 'WEB', ids: [BO] });
  });

  it('records nothing for a year with nobody to report', async () => {
    tx.teacherEmployment.findMany.mockResolvedValue([]);
    tx.teachingRequirement.findMany.mockResolvedValue([]);
    const file = await service.build(YEAR_ID, testUser());
    expect(file.rows).toEqual([]);
    expect(file.text).toBe('');
    expect(recordedReads(tx)).toEqual([]);
    expect(tx.user.findMany).not.toHaveBeenCalled();
  });

  it('answers 404 for a year RLS does not show', async () => {
    tx.academicYear.findUnique.mockResolvedValue(null);
    await expect(service.build(YEAR_ID, testUser())).rejects.toBeInstanceOf(NotFoundException);
    expect(recordedReads(tx)).toEqual([]);
  });
});
