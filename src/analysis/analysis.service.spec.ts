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
import { readXlsx } from '../schedule-exchange/xlsx';
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
      expect(result.employmentOn).toBe('2026-11-18');
      expect(result).not.toHaveProperty('hrHidden');
      expect(result).not.toHaveProperty('aggregateOnly');
      expect(result.loadModel).toBe('MINUTES');
      expect(result.notices).toEqual([]);
      // EMPLOYMENT for each teacher, and PEOPLE beside it where tjänstgöringsgrad is stated.
      const reads = recordedReads(tx);
      expect(reads.map((read) => read.kind)).toEqual(['EMPLOYMENT', 'PEOPLE']);
      expect(reads[0]!.ids.sort()).toEqual([ANNA, BO, CY].sort());
    });

    it("reads a post that changes during the year on the school's today held inside the läsår, and says which day", async () => {
      const input = schoolInput();
      const changing = {
        ...input,
        employments: [
          { ...input.employments[0]!, periods: [{ validFrom: '2027-01-01', validTo: null, employmentPercent: 60, reductionPercent: 0, teachingTargetMinutesPerWeek: null }] },
          ...input.employments.slice(1),
        ],
      };
      staffing.readReports.mockResolvedValue({
        read: { year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input: changing },
        planned: buildTeacherLoadReport(changing),
        scheduled: null,
      });
      const anna = (result: Awaited<ReturnType<AnalysisService['keyFigures']>>) => result.teachers?.find((row) => row.userId === ANNA)?.employmentPercent;

      // In November, before the period starts: the base row's 100 %.
      expect(anna(await service.keyFigures(YEAR_ID, rektor()))).toBe(100);

      // In February: the period's 60 %, and the school's heltidstjänster by tjänstgöringsgrad follow it.
      jest.spyOn(service, 'now').mockReturnValue(new Date('2027-02-10T10:00:00.000Z'));
      const february = await service.keyFigures(YEAR_ID, rektor());
      expect(february.employmentOn).toBe('2027-02-10');
      expect(anna(february)).toBe(60);
      expect(february.school.employmentFte).toBe(1.9);

      // A past year is read on its last day, a coming one on its first.
      jest.spyOn(service, 'now').mockReturnValue(new Date('2028-01-10T10:00:00.000Z'));
      expect((await service.keyFigures(YEAR_ID, rektor())).employmentOn).toBe('2027-06-11');
      jest.spyOn(service, 'now').mockReturnValue(new Date('2026-06-01T10:00:00.000Z'));
      const coming = await service.keyFigures(YEAR_ID, rektor());
      expect(coming.employmentOn).toBe('2026-08-17');
      expect(anna(coming)).toBe(100);
    });

    it('leaves tjänstgöringsgrad out for a reader without HR-läs, says so, and records the teachers as their tjänst alone', async () => {
      const result = await service.keyFigures(YEAR_ID, withoutHr());
      expect(result.hrHidden).toBe(true);
      expect(result).not.toHaveProperty('employmentOn');
      expect(result.teachers?.every((row) => row.employmentPercent === null)).toBe(true);
      expect(result.school).not.toHaveProperty('employmentFte');
      expect(recordedReads(tx).map((read) => read.kind)).toEqual(['EMPLOYMENT']);
    });

    it('gives the huvudman\'s reader the school\'s figures and no teacher, records nothing, and keeps HR out', async () => {
      const result = await service.keyFigures(YEAR_ID, reader());
      expect(result.aggregateOnly).toBe(true);
      expect(result.teachers).toBeNull();
      expect(result).not.toHaveProperty('hrHidden');
      expect(result).not.toHaveProperty('employmentOn');
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
      // The register as a database answers it: the rows asked for and no others, and nobody inactive.
      const register = [
        { id: ANNA, firstName: 'Anna', lastName: 'Åkesson', email: 'anna@example.invalid' },
        { id: BO, firstName: 'Bo', lastName: 'Berg', email: 'bo@example.invalid' },
        { id: CY, firstName: 'Cy', lastName: 'Ceder', email: 'cy@example.invalid' },
      ];
      tx.user.findMany.mockImplementation(async (args?: { where?: { id?: { in?: string[] }; isActive?: boolean } }) =>
        args?.where?.isActive === false ? [] : register.filter((person) => args?.where?.id?.in?.includes(person.id) ?? true),
      );
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

    it('calls a pool member who also has a post personal, and one who has none the vikariepool', async () => {
      // BO has a post (and is in the pool); pool-1 has none.
      tx.substitutePoolMember.findMany.mockResolvedValue([{ userId: 'pool-1' }, { userId: BO }]);
      const result = await service.payrollBasis(query, rektor());
      expect(result.people.find((person) => person.userId === BO)!.kind).toBe('STAFF');
      expect(result.people.find((person) => person.userId === 'pool-1')!.kind).toBe('POOL');
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
      // He has a signature, so his row can be paid: no notice about that.
      expect(result.notices.map((notice) => notice.code)).not.toContain('ANALYSIS_PROTECTED_WITHOUT_SIGNATURE');
      const reads = recordedReads(tx);
      expect(reads.map((read) => read.kind)).toEqual(['EMPLOYMENT', 'PEOPLE']);
      expect(reads[0]!.ids.sort()).toEqual([ANNA, BO, CY, 'pool-1'].sort());
    });

    it("says per person the post's signature and whether the school has marked them, and no name: the page needs nothing else", async () => {
      tx.personProtection.findMany.mockResolvedValue([{ userId: BO }]);
      const result = await service.payrollBasis(query, rektor());
      expect(result.people.map((person) => [person.userId, person.signature, person.protectedIdentity])).toEqual([
        [ANNA, 'ANN', false],
        [BO, 'BOO', true],
        [CY, 'CYY', false],
        ['pool-1', null, false],
      ]);
      expect(JSON.stringify(result)).not.toMatch(/Berg|Åkesson|Ceder|example\.invalid/);
      // The screen's answer reads no name at all.
      expect(tx.user.findMany.mock.calls.every(([args]) => (args as { where: { isActive?: boolean } }).where.isActive === false)).toBe(true);
    });

    it('says how many marked people have no signature, whose rows then say nothing of who they are', async () => {
      tx.personProtection.findMany.mockResolvedValue([{ userId: 'pool-1' }, { userId: BO }]);
      const result = await service.payrollBasis(query, rektor());
      expect(result.protectedInAnswer).toBe(2);
      expect(result.notices).toContainEqual({ code: 'ANALYSIS_PROTECTED_IN_FILE', params: { people: 2 } });
      expect(result.notices).toContainEqual({ code: 'ANALYSIS_PROTECTED_WITHOUT_SIGNATURE', params: { people: 1 } });
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

    describe('a person who has left (leavers.ts)', () => {
      const withDuty = () => {
        const input = schoolInput({ duties: [{ userId: ANNA, minutesPerWeek: 50, countsAsTeaching: false }] });
        (readLoadInput as jest.Mock).mockResolvedValue({ year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input });
      };
      /** Statement E asked again for one person: the whole period's rows for everybody, those rows for her alone. */
      const leaverStatement = (statement: { sql?: string }) => (statement.sql ?? '').includes('"endsAt" <=');
      const answerWith = (everyone: unknown[], her: unknown[]) =>
        tx.$queryRaw.mockImplementation(async (statement: { sql?: string; strings?: readonly string[] }) => {
          queries.push({ text: (statement.strings ?? []).join('?') });
          return leaverStatement(statement) ? her : everyone;
        });
      const leaverQueries = () => tx.$queryRaw.mock.calls.map((call) => call[0] as { sql: string; values: unknown[] }).filter(leaverStatement);
      const everyone = () => [credit(), credit({ studentGroupId: 'g8a', minutes: 180 }), credit({ role: 'ASSISTANT', personId: CY, studentGroupId: 'gman', minutes: 60 })];

      it('books the lessons that were over by the stamp and the uppdrag to the day before, and says someone left', async () => {
        withDuty();
        answerWith(everyone(), [credit({ minutes: 180, lessons: 3 })]);
        // 12:00 on 12 November in Stockholm.
        tx.user.findMany.mockResolvedValueOnce([{ id: ANNA, deactivatedAt: new Date('2026-11-12T11:00:00.000Z') }]);

        const result = await service.payrollBasis(query, rektor());

        const asked = leaverQueries();
        expect(asked).toHaveLength(1);
        // Her alone, the days up to the school's date of the stamp, and only what ended by the stamp.
        expect(asked[0]!.values).toContain(ANNA);
        expect(asked[0]!.values).toContainEqual(new Date('2026-11-12T11:00:00.000Z'));
        expect(asked[0]!.values).toEqual(expect.arrayContaining(['2026-11-02', '2026-11-12']));
        const anna = result.people.find((person) => person.userId === ANNA)!;
        // Not the 720 minutes the lessons still carrying her give; the uppdrag of 10 minutes a day for 2-11 November.
        expect(anna).toMatchObject({ teachingMinutes: 180, dutyMinutes: 80 });
        expect(result.people.find((person) => person.userId === CY)).toMatchObject({ teachingMinutes: 60 });
        expect(result.notices).toContainEqual({ code: 'ANALYSIS_LEFT_IN_PERIOD', params: { people: 1 } });
      });

      it('books nobody who left before the period began: no question asked, no line, and the notice', async () => {
        withDuty();
        answerWith(everyone(), [credit({ minutes: 9999 })]);
        tx.user.findMany.mockResolvedValueOnce([{ id: ANNA, deactivatedAt: new Date('2026-10-20T10:00:00.000Z') }]);

        const result = await service.payrollBasis(query, rektor());

        expect(leaverQueries()).toHaveLength(0);
        expect(result.people.some((person) => person.userId === ANNA)).toBe(false);
        expect(result.lines.some((line) => line.userId === ANNA)).toBe(false);
        expect(result.people.find((person) => person.userId === CY)).toMatchObject({ teachingMinutes: 60 });
        expect(result.notices).toContainEqual({ code: 'ANALYSIS_LEFT_IN_PERIOD', params: { people: 1 } });
      });

      it('leaves a person who left after the period as they always were, with no notice', async () => {
        withDuty();
        answerWith(everyone(), [credit({ minutes: 9999 })]);
        tx.user.findMany.mockResolvedValueOnce([{ id: ANNA, deactivatedAt: new Date('2026-12-01T10:00:00.000Z') }]);

        const result = await service.payrollBasis(query, rektor());

        expect(leaverQueries()).toHaveLength(0);
        expect(result.people.find((person) => person.userId === ANNA)).toMatchObject({ teachingMinutes: 720, dutyMinutes: 200 });
        expect(result.notices.map((notice) => notice.code)).not.toContain('ANALYSIS_LEFT_IN_PERIOD');
      });

      it('takes the school\'s date of the stamp, not UTC\'s: 00:30 on 13 November in Stockholm is still 12 November in UTC', async () => {
        withDuty();
        answerWith(everyone(), [credit({ minutes: 60, lessons: 1 })]);
        tx.user.findMany.mockResolvedValueOnce([{ id: ANNA, deactivatedAt: new Date('2026-11-12T23:30:00.000Z') }]);

        const result = await service.payrollBasis(query, rektor());

        expect(leaverQueries()[0]!.values).toEqual(expect.arrayContaining(['2026-11-02', '2026-11-13']));
        // The uppdrag run to the 12th: 2-6, 9-12 is nine days of 10 minutes.
        expect(result.people.find((person) => person.userId === ANNA)).toMatchObject({ teachingMinutes: 60, dutyMinutes: 90 });
      });

      it('books a vikarie\'s cover only if it was over when they left', async () => {
        cover.hours.mockResolvedValue(
          hours({
            rows: [
              coverRow({ lessonId: 'a', userId: 'pool-1', minutes: 45, endsAt: '2026-11-05T08:45:00.000Z' }),
              coverRow({ lessonId: 'b', userId: 'pool-1', minutes: 45, endsAt: '2026-11-10T09:00:00.000Z' }),
              coverRow({ lessonId: 'c', userId: 'pool-1', minutes: 45, endsAt: '2026-11-17T09:00:00.000Z' }),
            ],
          }),
        );
        // Over at 09:00 on the 10th counts; the one on the 17th does not.
        tx.user.findMany.mockResolvedValueOnce([{ id: 'pool-1', deactivatedAt: new Date('2026-11-10T09:00:00.000Z') }]);

        const result = await service.payrollBasis(query, rektor());

        expect(result.people.find((person) => person.userId === 'pool-1')).toMatchObject({ substituteMinutes: 90 });
        expect(result.notices).toContainEqual({ code: 'ANALYSIS_LEFT_IN_PERIOD', params: { people: 1 } });
      });

      it('asks nobody about activity when there is nobody in the rows, and asks for the people in them in one read', async () => {
        (readPublishedSpans as jest.Mock).mockResolvedValue({ horizon: [], published: null, publishedDays: [] });
        cover.hours.mockResolvedValue(hours());
        const input = schoolInput({ duties: [] });
        (readLoadInput as jest.Mock).mockResolvedValue({ year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input });
        tx.user.findMany.mockClear();
        await service.payrollBasis(query, rektor());
        expect(tx.user.findMany).not.toHaveBeenCalled();

        tx.$queryRaw.mockResolvedValue(everyone());
        (readPublishedSpans as jest.Mock).mockResolvedValue({ horizon: [], published: { from: '2026-08-17', through: '2027-06-11' }, publishedDays: [] });
        await service.payrollBasis(query, rektor());
        expect(tx.user.findMany).toHaveBeenCalledTimes(1);
        expect(tx.user.findMany).toHaveBeenCalledWith({
          where: { id: { in: expect.arrayContaining([ANNA, CY]) }, isActive: false, deactivatedAt: { not: null } },
          select: { id: true, deactivatedAt: true },
        });
      });
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
        expect(lines[0]).toBe(
          'Signatur;Löne-id;Efternamn;Förnamn;E-post;Typ;Tjänstgöringsgrad (%);Skoldel;Konto;Undervisning (min);Uppdrag (min);Vikariepass (min);Totalt (tim);Från;Till',
        );
        // Åkesson sorts after Berg and Ceder in Swedish; the vikarie pool member has no name row and sorts first.
        expect(lines.slice(1).map((line) => line.split(';')[2])).toEqual(['', 'Berg', 'Ceder', 'Åkesson']);
        expect(lines.find((line) => line.startsWith('ANN;'))).toBe('ANN;;Åkesson;Anna;anna@example.invalid;Personal;100;Högstadiet;4030;720;0;0;12,00;2026-11-02;2026-11-27');
        expect(lines.find((line) => line.startsWith('BOO;'))).toBe('BOO;;Berg;Bo;bo@example.invalid;Personal;50;Högstadiet;4030;0;0;45;0,75;2026-11-02;2026-11-27');
        expect(lines.find((line) => line.includes('Vikariepool'))).toContain(';Vikariepool;;');
        expect(result.protectedInFile).toBe(0);
        expect(result.notices.map((notice) => notice.code)).not.toContain('ANALYSIS_CHARACTERS_REPLACED');
      });

      it('says how many people with a protected identity are in the file, by name and not by count alone', async () => {
        tx.personProtection.findMany.mockResolvedValue([{ userId: BO }]);
        const result = await service.payrollFile({ ...query, format: 'CSV' }, rektor());
        expect(result.protectedInFile).toBe(1);
        expect(result.notices).toContainEqual({ code: 'ANALYSIS_PROTECTED_IN_FILE', params: { people: 1 } });
      });

      describe('a person with a protected identity', () => {
        const csvOf = async (marks: string[], format: 'CSV' = 'CSV') => {
          tx.personProtection.findMany.mockResolvedValue(marks.map((userId) => ({ userId })));
          const result = await service.payrollFile({ ...query, format }, rektor());
          return { result, lines: new TextDecoder('windows-1252').decode(Buffer.from(result.contentBase64, 'base64')).split('\r\n').filter(Boolean) };
        };

        it('is in the CSV by signature and every figure, with no name and no e-mail, and the others stand as before', async () => {
          const { result, lines } = await csvOf([BO]);
          // Payroll pays everyone: his row is there, with the post's signature and an empty Löne-id, name and e-mail.
          expect(lines.find((line) => line.startsWith('BOO;'))).toBe('BOO;;;;;Personal;50;Högstadiet;4030;0;0;45;0,75;2026-11-02;2026-11-27');
          expect(lines.join('\n')).not.toMatch(/Berg|\bBo\b|bo@example\.invalid/);
          // Everyone else is named as before.
          expect(lines.find((line) => line.startsWith('ANN;'))).toBe('ANN;;Åkesson;Anna;anna@example.invalid;Personal;100;Högstadiet;4030;720;0;0;12,00;2026-11-02;2026-11-27');
          expect(lines.find((line) => line.startsWith('CYY;'))).toContain('CYY;;Ceder;Cy;cy@example.invalid;Personal;80;');
          expect(result.protectedInFile).toBe(1);
          // His name is not even read: the names are asked for the unmarked alone.
          const asked = tx.user.findMany.mock.calls.map(([args]) => args as { where: { id?: { in?: string[] } } }).find((args) => args.where.id?.in !== undefined && !('isActive' in args.where));
          expect([...asked!.where.id!.in!].sort()).toEqual([ANNA, CY, 'pool-1'].sort());
        });

        it('is in the workbook the same way', async () => {
          tx.personProtection.findMany.mockResolvedValue([{ userId: BO }]);
          const result = await service.payrollFile({ ...query, format: 'XLSX' }, rektor());
          const read = readXlsx(Buffer.from(result.contentBase64, 'base64'));
          expect(read.rows.find((cells) => cells[0] === 'BOO')).toEqual(['BOO', '', '', '', '', 'Personal', '50', 'Högstadiet', '4030', '0', '0', '45', '0.75', '2026-11-02', '2026-11-27']);
          expect(read.rows.find((cells) => cells[0] === 'ANN')!.slice(0, 5)).toEqual(['ANN', '', 'Åkesson', 'Anna', 'anna@example.invalid']);
          expect(JSON.stringify(read.rows)).not.toMatch(/Berg|bo@example\.invalid/);
          expect(result.protectedInFile).toBe(1);
        });

        it('stands after the named, the marked in the order of their signatures', async () => {
          const input = schoolInput();
          // Cy's signature sorts before Bo's although his id sorts after: the signature decides.
          input.employments = input.employments.map((post) => (post.userId === CY ? { ...post, signature: 'ACY' } : post));
          (readLoadInput as jest.Mock).mockResolvedValue({ year: { startDate: '2026-08-17', endDate: '2027-06-11' }, input });
          const { result, lines } = await csvOf([BO, CY]);
          expect(lines.slice(1).map((line) => line.split(';').slice(0, 3))).toEqual([
            ['', '', ''],
            ['ANN', '', 'Åkesson'],
            ['ACY', '', ''],
            ['BOO', '', ''],
          ]);
          expect(result.protectedInFile).toBe(2);
        });

        it('with no signature is a row of figures alone, and the file says how many such rows it has', async () => {
          const { result, lines } = await csvOf(['pool-1']);
          expect(lines.find((line) => line.includes('Vikariepool'))).toBe(';;;;;Vikariepool;;Högstadiet;4030;0;0;45;0,75;2026-11-02;2026-11-27');
          expect(result.protectedInFile).toBe(1);
          expect(result.notices).toContainEqual({ code: 'ANALYSIS_PROTECTED_WITHOUT_SIGNATURE', params: { people: 1 } });
        });

        it('is never asked a name for when everyone in the file is marked', async () => {
          tx.user.findMany.mockClear();
          await csvOf([ANNA, BO, CY, 'pool-1']);
          expect(tx.user.findMany.mock.calls.every(([args]) => (args as { where: { isActive?: boolean } }).where.isActive === false)).toBe(true);
        });
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
        expect(text).toContain('\r\n;;;;;Vikariepool;');
      });
    });
  });

  it('knows the time', () => {
    const real = new AnalysisService(prisma as unknown as PrismaService, staffing as unknown as StaffingLoadService, cover as unknown as CoverReportsService);
    expect(Math.abs(real.now().getTime() - Date.now())).toBeLessThan(1000);
    expect(SCHOOL).toBeDefined();
  });
});
