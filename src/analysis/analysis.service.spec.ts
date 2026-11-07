import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { recordedReads } from '../../test/utils/recorded-reads';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { CoverReportsService, HoursResponse, HoursRow } from '../cover/cover-reports.service';
import type { PrismaService } from '../database/prisma.service';
import type { StaffingLoadService } from '../staffing/staffing-load.service';
import { readLoadInput } from '../staffing/load-input';
import { readPlannedInput } from '../timplan/timplan-coverage.service';
import { readPublishedSpans } from '../timplan/timplan-delivered.sql';
import { buildTeacherLoadReport } from '../staffing/teacher-load';
import { ANALYSIS_COST_NOT_YOURS, ANALYSIS_RANGE, AnalysisService } from './analysis.service';
import { ANNA, BO, CY, MA, groups, pupils, schoolInput } from './__fixtures__/school';

jest.mock('../timplan/timplan-coverage.service', () => ({ readPlannedInput: jest.fn() }));
jest.mock('../staffing/load-input', () => ({ readLoadInput: jest.fn() }));
jest.mock('../timplan/timplan-delivered.sql', () => ({
  ...jest.requireActual('../timplan/timplan-delivered.sql'),
  readPublishedSpans: jest.fn(),
}));

const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-18T10:00:00.000Z');

const rektor = () => testUser({ adminProfile: 'REKTOR', hrRead: false });
const withHr = () => testUser({ adminProfile: 'EXPEDITION', hrRead: true });
const withoutHr = () => testUser({ adminProfile: 'SCHEMALAGGARE', hrRead: false });
const reader = () => testUser({ adminProfile: 'LASARE', hrRead: false, userId: undefined, huvudman: { id: 'h', name: 'Kommunen', memberId: 'm', role: 'READER', firstName: 'A', lastName: 'B' } as never });

describe('AnalysisService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let staffing: { readReports: jest.Mock };
  let cover: { hours: jest.Mock };
  let service: AnalysisService;
  let queries: Array<{ text: string }>;

  const planned = () => ({
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    groups,
    pupils,
    gradeNumbering: 'NIOARIG' as const,
    rostersFrom: undefined as 'ENROLLMENT' | undefined,
  });

  const hours = (overrides: Partial<HoursResponse> = {}): HoursResponse => ({
    from: '2026-11-02',
    to: '2026-11-27',
    rows: [],
    toCheck: [],
    summary: [],
    planned: [],
    ...overrides,
  });
  const coverRow = (overrides: Partial<HoursRow> = {}): HoursRow => ({
    lessonId: 'l1',
    userId: CY,
    kind: 'STAFF',
    date: '2026-11-05',
    startsAt: '2026-11-05T08:00:00.000Z',
    endsAt: '2026-11-05T08:45:00.000Z',
    minutes: 45,
    subjectId: MA,
    studentGroupId: 'g7a',
    roomId: null,
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    const input = schoolInput();
    staffing = {
      readReports: jest.fn().mockResolvedValue({
        read: { year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input },
        planned: buildTeacherLoadReport(input),
        scheduled: null,
      }),
    };
    (readLoadInput as jest.Mock).mockReset().mockResolvedValue({ year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input });
    cover = { hours: jest.fn().mockResolvedValue(hours()) };
    service = new AnalysisService(prisma as unknown as PrismaService, staffing as unknown as StaffingLoadService, cover as unknown as CoverReportsService);
    jest.spyOn(service, 'now').mockReturnValue(NOW);
    (readPlannedInput as jest.Mock).mockReset().mockResolvedValue(planned());
    (readPublishedSpans as jest.Mock).mockReset().mockResolvedValue({ horizon: [], published: { from: '2026-08-17', through: '2027-06-11' }, publishedDays: [] });
    queries = [];
    tx.academicYear.findUnique.mockResolvedValue({
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
      gradeNumbering: 'NIOARIG',
      school: { timezone: 'Europe/Stockholm' },
    });
    tx.$queryRaw.mockImplementation(async (statement: { strings?: readonly string[] }) => {
      const text = (statement.strings ?? []).join('?');
      queries.push({ text });
      return text.includes('"lessonId"') ? [] : [];
    });
  });

  // -------------------------------------------------------------------------
  describe('keyFigures', () => {
    it("states every teacher's figures with tjänstgöringsgrad for a reader of HR data, and records the reads", async () => {
      const result = await service.keyFigures(YEAR_ID, rektor());

      expect(staffing.readReports).toHaveBeenCalledWith(tx, expect.anything(), YEAR_ID, { scheduled: false });
      expect(result.teachers?.map((row) => row.userId).sort()).toEqual([ANNA, BO, CY].sort());
      expect(result.teachers?.find((row) => row.userId === ANNA)).toMatchObject({ employmentPercent: 100, pupils: 6 });
      expect(result.school).toMatchObject({ pupils: 6, teachers: 3, fullTimeTeachingMinutesPerWeek: 1080 });
      expect(result.school.employmentFte).toBe(2.3);
      expect(result).not.toHaveProperty('hrHidden');
      expect(result).not.toHaveProperty('aggregateOnly');
      expect(result.loadModel).toBe('MINUTES');
      expect(result.notices).toEqual([]);
      // EMPLOYMENT for each teacher, and PEOPLE beside it where tjänstgöringsgrad is stated.
      const reads = recordedReads(tx);
      expect(reads.map((read) => read.kind)).toEqual(['EMPLOYMENT', 'PEOPLE']);
      expect(reads[0]!.ids.sort()).toEqual([ANNA, BO, CY].sort());
    });

    it('leaves tjänstgöringsgrad out for a reader without HR-läs, says so, and records the teachers as their tjänst alone', async () => {
      const result = await service.keyFigures(YEAR_ID, withoutHr());
      expect(result.hrHidden).toBe(true);
      expect(result.teachers?.every((row) => row.employmentPercent === null)).toBe(true);
      expect(result.school).not.toHaveProperty('employmentFte');
      expect(recordedReads(tx).map((read) => read.kind)).toEqual(['EMPLOYMENT']);
    });

    it('gives the huvudman\'s reader the school\'s figures and no teacher, records nothing, and keeps HR out', async () => {
      const result = await service.keyFigures(YEAR_ID, reader());
      expect(result.aggregateOnly).toBe(true);
      expect(result.teachers).toBeNull();
      expect(result).not.toHaveProperty('hrHidden');
      expect(result.school.teachers).toBe(3);
      expect(result.school).not.toHaveProperty('employmentFte');
      expect(recordedReads(tx)).toEqual([]);
    });

    it('makes the report over the grundschema only when it is asked for, and states it per teacher then', async () => {
      const laid = buildTeacherLoadReport(schoolInput({ requirements: schoolInput().requirements.slice(0, 1) }));
      staffing.readReports.mockResolvedValue({
        read: { year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input: schoolInput() },
        planned: buildTeacherLoadReport(schoolInput()),
        scheduled: laid,
      });
      const asked = await service.keyFigures(YEAR_ID, rektor(), { schedule: true });
      expect(staffing.readReports).toHaveBeenLastCalledWith(tx, expect.anything(), YEAR_ID, { scheduled: true });
      expect(asked.teachers?.find((row) => row.userId === ANNA)?.scheduledMinutesPerWeek).toBe(180);
      staffing.readReports.mockClear();
      await service.keyFigures(YEAR_ID, rektor(), { schedule: false });
      expect(staffing.readReports).toHaveBeenLastCalledWith(tx, expect.anything(), YEAR_ID, { scheduled: false });
    });

    it('answers 404 for a year row security hides', async () => {
      (readPlannedInput as jest.Mock).mockResolvedValue(null);
      await expect(service.keyFigures(YEAR_ID, rektor())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('says what it could not judge: a past year from its class history, no riktmärke, no behörigheter', async () => {
      (readPlannedInput as jest.Mock).mockResolvedValue({ ...planned(), rostersFrom: 'ENROLLMENT' });
      const input = schoolInput({ policy: null, qualifications: [] });
      staffing.readReports.mockResolvedValue({
        read: { year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input },
        planned: buildTeacherLoadReport(input),
        scheduled: null,
      });
      const result = await service.keyFigures(YEAR_ID, rektor());
      expect(result.rostersFrom).toBe('ENROLLMENT');
      expect(result.notices.map((notice) => notice.code)).toEqual([
        'ANALYSIS_PUPILS_FROM_ENROLLMENT',
        'ANALYSIS_NO_FULL_TIME',
        'ANALYSIS_QUALIFICATIONS_NOT_RECORDED',
      ]);
      expect(result.school.teachingFte).toBeNull();
    });

    it('treats a riktmärke of 0 as none', async () => {
      const input = schoolInput();
      input.policy = { ...input.policy!, fullTimeTeachingMinutesPerWeek: 0 };
      staffing.readReports.mockResolvedValue({
        read: { year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input },
        planned: buildTeacherLoadReport(input),
        scheduled: null,
      });
      expect((await service.keyFigures(YEAR_ID, rektor())).school.fullTimeTeachingMinutesPerWeek).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('costBasis', () => {
    beforeEach(() => {
      tx.schoolPart.findMany.mockResolvedValue([{ id: 'high', name: 'Högstadiet', account: '4030', gradeFrom: 7, gradeTo: 9 }]);
      tx.staffCostRate.findMany.mockResolvedValue([
        { category: 'TEACHER', hourlyCost: '400.00' },
        { category: 'UNQUALIFIED_TEACHER', hourlyCost: '300.00' },
        { category: 'SUBSTITUTE', hourlyCost: '350.00' },
      ]);
    });

    it("is the school's economy: refused to a reader who reads no HR data, given to rektor, HR-läs and the huvudman's reader", async () => {
      await expect(service.costBasis({ academicYearId: YEAR_ID }, withoutHr())).rejects.toMatchObject({
        response: { code: ANALYSIS_COST_NOT_YOURS },
      });
      await expect(service.costBasis({ academicYearId: YEAR_ID }, withoutHr())).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.costBasis({ academicYearId: YEAR_ID }, rektor())).resolves.toBeDefined();
      await expect(service.costBasis({ academicYearId: YEAR_ID }, withHr())).resolves.toBeDefined();
      const aggregate = await service.costBasis({ academicYearId: YEAR_ID }, reader());
      expect(aggregate.aggregateOnly).toBe(true);
    });

    it('prices the planned hours by the stated rates, per skoldel, and reads the planned report alone', async () => {
      const result = await service.costBasis({ academicYearId: YEAR_ID }, rektor());
      expect(staffing.readReports).toHaveBeenCalledWith(tx, expect.anything(), YEAR_ID, { scheduled: false });
      expect(result.rates).toEqual([
        { category: 'TEACHER', hourlyCost: 400 },
        { category: 'UNQUALIFIED_TEACHER', hourlyCost: 300 },
        { category: 'SUBSTITUTE', hourlyCost: 350 },
      ]);
      expect(result.gradeNumbering).toBe('NIOARIG');
      expect(result.parts).toHaveLength(1);
      expect(result.parts[0]).toMatchObject({ schoolPartId: 'high', name: 'Högstadiet', pupils: 6 });
      expect(result.total.cost).toBeGreaterThan(0);
      expect(result.missingRates).toEqual([]);
      expect(result).not.toHaveProperty('aggregateOnly');
    });

    it("counts the vikarie's held lessons from the year's start to the school's yesterday unless asked otherwise", async () => {
      tx.$queryRaw.mockResolvedValueOnce([
        { lessonId: 'l1', userId: CY, date: '2026-11-05', startsAt: new Date(), endsAt: new Date(), minutes: 60, subjectId: MA, studentGroupId: 'g8a', roomId: null },
        { lessonId: 'l2', userId: CY, date: '2026-11-06', startsAt: new Date(), endsAt: new Date(), minutes: '30', subjectId: MA, studentGroupId: 'g8a', roomId: null },
      ]);
      const result = await service.costBasis({ academicYearId: YEAR_ID }, rektor());
      expect(result.substitutes).toEqual({ from: '2026-08-17', to: '2026-11-17' });
      expect(result.total.hours.SUBSTITUTE).toBe(1.5);
      const asked = await service.costBasis({ academicYearId: YEAR_ID, from: '2026-10-01', to: '2026-10-31' }, rektor());
      expect(asked.substitutes).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    });

    it('clamps the days into the year, and counts none for a year that has not begun', async () => {
      const clamped = await service.costBasis({ academicYearId: YEAR_ID, from: '2026-01-01', to: '2030-01-01' }, rektor());
      expect(clamped.substitutes).toEqual({ from: '2026-08-17', to: '2027-06-11' });
      jest.spyOn(service, 'now').mockReturnValue(new Date('2026-08-10T10:00:00.000Z'));
      queries.length = 0;
      const early = await service.costBasis({ academicYearId: YEAR_ID }, rektor());
      expect(early.substitutes).toBeNull();
      expect(early.total.hours.SUBSTITUTE).toBe(0);
      expect(queries).toEqual([]);
    });

    it('refuses one day without the other, and a range that ends before it begins', async () => {
      await expect(service.costBasis({ academicYearId: YEAR_ID, from: '2026-10-01' }, rektor())).rejects.toMatchObject({ response: { code: ANALYSIS_RANGE } });
      await expect(service.costBasis({ academicYearId: YEAR_ID, to: '2026-10-01' }, rektor())).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.costBasis({ academicYearId: YEAR_ID, from: '2026-10-02', to: '2026-10-01' }, rektor())).rejects.toMatchObject({
        response: { code: ANALYSIS_RANGE },
      });
    });

    it('answers 404 for a year row security hides, and says a past year was read from its class history', async () => {
      (readPlannedInput as jest.Mock).mockResolvedValue(null);
      await expect(service.costBasis({ academicYearId: YEAR_ID }, rektor())).rejects.toBeInstanceOf(NotFoundException);
      (readPlannedInput as jest.Mock).mockResolvedValue({ ...planned(), rostersFrom: 'ENROLLMENT', gradeNumbering: undefined });
      const past = await service.costBasis({ academicYearId: YEAR_ID }, rektor());
      expect(past.rostersFrom).toBe('ENROLLMENT');
      expect(past.gradeNumbering).toBe('NIOARIG');
      expect(past.notices.map((notice) => notice.code)).toContain('ANALYSIS_PUPILS_FROM_ENROLLMENT');
    });

    it('reads a school with no timezone as Stockholm', async () => {
      tx.academicYear.findUnique.mockResolvedValue({ school: null });
      const result = await service.costBasis({ academicYearId: YEAR_ID }, rektor());
      expect(result.substitutes).toEqual({ from: '2026-08-17', to: '2026-11-17' });
    });
  });

  // -------------------------------------------------------------------------
  describe('payroll', () => {
    const query = { academicYearId: YEAR_ID, from: '2026-11-02', to: '2026-11-27' };
    const credit = (overrides: Record<string, unknown> = {}) => ({
      kind: 'T',
      personId: ANNA,
      role: 'LEAD',
      subjectId: MA,
      studentGroupId: 'g7a',
      extraGroupIds: null,
      bucket: 'DELIVERED',
      minutes: 540,
      lessons: 9,
      ...overrides,
    });

    beforeEach(() => {
      tx.schoolPart.findMany.mockResolvedValue([{ id: 'high', name: 'Högstadiet', account: '4030', gradeFrom: 7, gradeTo: 9 }]);
      tx.$queryRaw.mockResolvedValue([
        credit(),
        credit({ studentGroupId: 'g8a', minutes: 180 }),
        credit({ role: 'ASSISTANT', personId: CY, studentGroupId: 'gman', minutes: 60 }),
        credit({ role: 'SUBSTITUTE', personId: BO, minutes: 45 }),
        credit({ bucket: 'DISPLACED', personId: BO, minutes: 99 }),
        credit({ kind: 'G', personId: null, role: null, minutes: 77 }),
        credit({ bucket: 'CANCELLED_MANUAL', minutes: 55 }),
      ]);
      tx.user.findMany.mockResolvedValue([
        { id: ANNA, firstName: 'Anna', lastName: 'Åkesson', email: 'anna@example.invalid' },
        { id: BO, firstName: 'Bo', lastName: 'Berg', email: 'bo@example.invalid' },
        { id: CY, firstName: 'Cy', lastName: 'Ceder', email: 'cy@example.invalid' },
      ]);
      tx.substitutePoolMember.findMany.mockResolvedValue([{ userId: 'pool-1' }]);
      cover.hours.mockResolvedValue(
        hours({ rows: [coverRow({ userId: 'pool-1', minutes: 45 }), coverRow({ lessonId: 'l2', userId: BO, minutes: 45, studentGroupId: 'g8a' })] }),
      );
    });

    it('is HR data through and through: refused before anything is read to a reader without HR-läs and to the huvudman\'s reader', async () => {
      for (const user of [withoutHr(), reader()]) {
        await expect(service.payrollBasis(query, user)).rejects.toMatchObject({ response: { code: 'HR_NOT_YOURS' } });
      }
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(cover.hours).not.toHaveBeenCalled();
    });

    it('books held teaching, the vikarie export\'s covers and the uppdrag per person and skoldel', async () => {
      const result = await service.payrollBasis(query, rektor());

      expect(cover.hours).toHaveBeenCalledWith('2026-11-02', '2026-11-27', undefined, expect.anything());
      const anna = result.people.find((person) => person.userId === ANNA)!;
      expect(anna).toMatchObject({ kind: 'STAFF', teachingMinutes: 720, substituteMinutes: 0, employmentPercent: 100 });
      // Only held lead and assistant rows are teaching: not the vikarie's own row, the displaced, the bortfall or the group lines.
      expect(result.people.find((person) => person.userId === CY)).toMatchObject({ teachingMinutes: 60 });
      expect(result.people.find((person) => person.userId === BO)).toMatchObject({ teachingMinutes: 0, substituteMinutes: 45 });
      // A pool member without a post is POOL, with no tjänstgöringsgrad.
      expect(result.people.find((person) => person.userId === 'pool-1')).toMatchObject({ kind: 'POOL', substituteMinutes: 45, employmentPercent: null });
      // Every group is in the one skoldel, and the line carries its konto.
      expect(result.lines.every((line) => line.schoolPartId === 'high' && line.account === '4030')).toBe(true);
      expect(result.parts).toHaveLength(1);
      expect(result.from).toBe('2026-11-02');
      expect(result.protectedInAnswer).toBe(0);
    });

    it('states the tjänstgöringsgrad in force on the period\'s last day, a post that changes during the year included', async () => {
      const input = schoolInput();
      input.employments = input.employments.map((post) =>
        post.userId === ANNA
          ? { ...post, periods: [{ validFrom: '2026-11-16', validTo: null, employmentPercent: 60, reductionPercent: 0, teachingTargetMinutesPerWeek: null }] }
          : post,
      );
      (readLoadInput as jest.Mock).mockResolvedValue({ year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input });
      const november = await service.payrollBasis(query, rektor());
      expect(november.people.find((person) => person.userId === ANNA)!.employmentPercent).toBe(60);
      const early = await service.payrollBasis({ ...query, from: '2026-11-02', to: '2026-11-13' }, rektor());
      expect(early.people.find((person) => person.userId === ANNA)!.employmentPercent).toBe(100);
    });

    it('takes a teaching group\'s skoldel from the skoldel most of its pupils are in', async () => {
      tx.schoolPart.findMany.mockResolvedValue([
        { id: 'seven', name: 'Sjuan', account: '4007', gradeFrom: 7, gradeTo: 7 },
        { id: 'eight', name: 'Åttan', account: '4008', gradeFrom: 8, gradeTo: 9 },
      ]);
      const result = await service.payrollBasis(query, rektor());
      // MaN holds p1 (7A) and p5 (8A): a tie, the lower årskurs.
      expect(result.lines.find((line) => line.userId === CY)!.schoolPartId).toBe('seven');
      expect(result.lines.filter((line) => line.userId === ANNA).map((line) => [line.schoolPartId, line.teachingMinutes])).toEqual([
        ['seven', 540],
        ['eight', 180],
      ]);
    });

    it('counts the people with a protected identity, keeps them in, and records everyone read as their tjänst and as people', async () => {
      tx.personProtection.findMany.mockResolvedValue([{ userId: BO }]);
      const result = await service.payrollBasis(query, rektor());
      expect(result.protectedInAnswer).toBe(1);
      expect(result.people.some((person) => person.userId === BO)).toBe(true);
      expect(result.notices).toContainEqual({ code: 'ANALYSIS_PROTECTED_IN_FILE', params: { people: 1 } });
      const reads = recordedReads(tx);
      expect(reads.map((read) => read.kind)).toEqual(['EMPLOYMENT', 'PEOPLE']);
      expect(reads[0]!.ids.sort()).toEqual([ANNA, BO, CY, 'pool-1'].sort());
    });

    it('says what is missing: nothing published, covers to check, uppdrag on no skoldel', async () => {
      (readPublishedSpans as jest.Mock).mockResolvedValue({ horizon: [], published: null, publishedDays: [] });
      cover.hours.mockResolvedValue(hours({ toCheck: [coverRow()] }));
      const input = schoolInput({ duties: [{ userId: ANNA, minutesPerWeek: 50, countsAsTeaching: false }] });
      (readLoadInput as jest.Mock).mockResolvedValue({ year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input });
      const result = await service.payrollBasis(query, rektor());
      expect(result.notices.map((notice) => notice.code)).toEqual(['ANALYSIS_NOTHING_PUBLISHED', 'ANALYSIS_COVER_TO_CHECK', 'ANALYSIS_DUTIES_UNALLOCATED']);
      expect(result.lines).toEqual([
        expect.objectContaining({ userId: ANNA, schoolPartId: null, account: null, dutyMinutes: 200 }),
      ]);
      expect(result.people).toHaveLength(1);
    });

    it('cuts a period to the läsår, says so, and refuses one outside it or longer than the vikarie export allows', async () => {
      const cut = await service.payrollBasis({ academicYearId: YEAR_ID, from: '2026-06-20', to: '2026-08-30' }, rektor());
      expect(cut.from).toBe('2026-08-17');
      expect(cut.notices).toContainEqual({ code: 'ANALYSIS_PERIOD_CLAMPED', params: { from: '2026-08-17', to: '2026-08-30' } });
      expect(cover.hours).toHaveBeenLastCalledWith('2026-08-17', '2026-08-30', undefined, expect.anything());
      await expect(service.payrollBasis({ academicYearId: YEAR_ID, from: '2027-06-20', to: '2027-06-30' }, rektor())).rejects.toMatchObject({
        response: { code: ANALYSIS_RANGE },
      });
      await expect(service.payrollBasis({ academicYearId: YEAR_ID, from: '2026-08-17', to: '2026-12-31' }, rektor())).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.payrollBasis({ academicYearId: YEAR_ID, from: '2026-11-10', to: '2026-11-01' }, rektor())).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers 404 for a year row security hides', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(service.payrollBasis(query, rektor())).rejects.toBeInstanceOf(NotFoundException);
      tx.academicYear.findUnique.mockResolvedValue({
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
      });
      (readPlannedInput as jest.Mock).mockResolvedValue(null);
      await expect(service.payrollBasis(query, rektor())).rejects.toBeInstanceOf(NotFoundException);
      (readPlannedInput as jest.Mock).mockResolvedValue(planned());
      (readLoadInput as jest.Mock).mockResolvedValue(null);
      await expect(service.payrollBasis(query, rektor())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('skips the credits when nobody has published, and the names when the answer has no people', async () => {
      (readPublishedSpans as jest.Mock).mockResolvedValue({ horizon: [], published: null, publishedDays: [] });
      cover.hours.mockResolvedValue(hours());
      const result = await service.payrollFile({ ...query, format: 'CSV' }, rektor());
      expect(Buffer.from(result.contentBase64, 'base64').toString('latin1')).toContain('Signatur');
      expect(tx.user.findMany).not.toHaveBeenCalled();
    });

    describe('the file', () => {
      it('is Excel\'s Swedish CSV in windows-1252, named by its period, with the people by name and signature, sorted', async () => {
        const result = await service.payrollFile({ ...query, format: 'CSV' }, rektor());
        expect(result.filename).toBe('loneunderlag-2026-11-02-2026-11-27.csv');
        expect(result.contentType).toBe('text/csv; charset=windows-1252');
        const text = new TextDecoder('windows-1252').decode(Buffer.from(result.contentBase64, 'base64'));
        const lines = text.split('\r\n').filter(Boolean);
        expect(lines[0]).toBe('Signatur;Efternamn;Förnamn;E-post;Typ;Tjänstgöringsgrad (%);Skoldel;Konto;Undervisning (min);Uppdrag (min);Vikariepass (min);Totalt (tim);Från;Till');
        // Åkesson sorts after Berg and Ceder in Swedish; the vikarie pool member has no name row and sorts first.
        expect(lines.slice(1).map((line) => line.split(';')[1])).toEqual(['', 'Berg', 'Ceder', 'Åkesson']);
        expect(lines.find((line) => line.startsWith('ANN;'))).toBe('ANN;Åkesson;Anna;anna@example.invalid;Personal;100;Högstadiet;4030;720;0;0;12,00;2026-11-02;2026-11-27');
        expect(lines.find((line) => line.includes('Vikariepool'))).toContain(';Vikariepool;;');
        expect(result.protectedInFile).toBe(0);
        expect(result.notices.map((notice) => notice.code)).not.toContain('ANALYSIS_CHARACTERS_REPLACED');
      });

      it('says how many characters 1252 could not hold', async () => {
        tx.user.findMany.mockResolvedValue([{ id: ANNA, firstName: 'Zoë', lastName: 'Łukasz', email: 'anna@example.invalid' }]);
        const result = await service.payrollFile({ ...query, format: 'CSV' }, rektor());
        expect(result.notices).toContainEqual({ code: 'ANALYSIS_CHARACTERS_REPLACED', params: { characters: 1 } });
      });

      it('is a workbook with the same table for XLSX', async () => {
        const result = await service.payrollFile({ ...query, format: 'XLSX' }, rektor());
        expect(result.filename).toBe('loneunderlag-2026-11-02-2026-11-27.xlsx');
        expect(result.contentType).toContain('spreadsheetml.sheet');
        const bytes = Buffer.from(result.contentBase64, 'base64');
        expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
      });

      it('names a person it has no user row for by nothing rather than failing, and leaves a missing signature empty', async () => {
        tx.user.findMany.mockResolvedValue([]);
        const result = await service.payrollFile({ ...query, format: 'CSV' }, rektor());
        const text = new TextDecoder('windows-1252').decode(Buffer.from(result.contentBase64, 'base64'));
        expect(text).toContain(';;;;Vikariepool;');
      });
    });
  });

  it('knows the time', () => {
    const real = new AnalysisService(prisma as unknown as PrismaService, staffing as unknown as StaffingLoadService, cover as unknown as CoverReportsService);
    expect(Math.abs(real.now().getTime() - Date.now())).toBeLessThan(1000);
    expect(SCHOOL).toBeDefined();
  });
});
