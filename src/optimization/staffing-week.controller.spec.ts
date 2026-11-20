import 'reflect-metadata';
import { HttpException, HttpStatus, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AREA_KEY } from '../auth/decorators/area.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { testUser } from '../../test/utils/prisma-mock';
import { StaffingWeekDto } from './dto/staffing-week.dto';
import type { StaffingWeekView } from './interfaces/staffing-week.interface';
import type { OptimizationJobsService } from './optimization-jobs.service';
import { StaffingWeekController } from './staffing-week.controller';
import type { StaffingWeekService } from './staffing-week.service';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const BASIS = 'a'.repeat(64);
const REQ = '11111111-1111-4111-8111-111111111111';
const EVA = '22222222-2222-4222-8222-222222222222';
const OLA = '33333333-3333-4333-8333-333333333333';

const view: StaffingWeekView = {
  status: 'NOT_CHECKED',
  reason: 'NO_CHANGES',
  years: [],
  verdicts: null,
  worse: false,
  basisSha256: null,
  overlay: { given: 0, laidOver: 0, notLaidOver: 0, fromNobody: 0, newToTheWeek: 0 },
  calls: 0,
  elapsedMs: 1,
};

describe('StaffingWeekController', () => {
  let week: { check: jest.Mock };
  let jobs: { refusalForReader: jest.Mock };
  let controller: StaffingWeekController;
  const body = (overrides: Partial<StaffingWeekDto> = {}): StaffingWeekDto => ({
    academicYearId: YEAR_ID,
    basisSha256: BASIS,
    changes: [{ requirementId: REQ, fromTeacherId: EVA, toTeacherId: OLA }],
    ...overrides,
  });

  beforeEach(() => {
    week = { check: jest.fn() };
    jobs = { refusalForReader: jest.fn(async (error: unknown) => error) };
    controller = new StaffingWeekController(week as unknown as StaffingWeekService, jobs as unknown as OptimizationJobsService);
  });

  it('asks about the DTO as the caller, and answers with what the service says', async () => {
    week.check.mockResolvedValue(view);
    const user = testUser();
    const dto = body();

    await expect(controller.weekOfProposal(dto, user)).resolves.toBe(view);
    expect(week.check).toHaveBeenCalledWith(dto, user);
    expect(jobs.refusalForReader).not.toHaveBeenCalled();
  });

  it('words a refusal about a post\'s days for this caller before it leaves, as the check does', async () => {
    const raw = new HttpException({ message: 'days', code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK' }, HttpStatus.BAD_REQUEST);
    const worded = new HttpException({ message: 'hidden', code: 'TEACHER_WORK_DAYS_HIDDEN' }, HttpStatus.BAD_REQUEST);
    week.check.mockRejectedValue(raw);
    jobs.refusalForReader.mockResolvedValue(worded);
    const user = testUser();

    await expect(controller.weekOfProposal(body(), user)).rejects.toBe(worded);
    expect(jobs.refusalForReader).toHaveBeenCalledWith(raw, YEAR_ID, user);
  });

  it('lets a stale proposal through as the 409 it is', async () => {
    const stale = new HttpException({ message: 'old', code: 'STAFF_PROPOSAL_STALE' }, HttpStatus.CONFLICT);
    week.check.mockRejectedValue(stale);

    await expect(controller.weekOfProposal(body(), testUser())).rejects.toBe(stale);
  });

  describe('the route', () => {
    const method = StaffingWeekController.prototype.weekOfProposal;

    it('is POST /api/v1/optimization/staffing/proposal/week, answering 200 and not 202: nothing is left running', () => {
      expect(Reflect.getMetadata(PATH_METADATA, StaffingWeekController)).toBe('api/v1/optimization');
      expect(Reflect.getMetadata(PATH_METADATA, method)).toBe('staffing/proposal/week');
      expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(HttpStatus.OK);
    });

    it('is throttled at six a minute: two checks of the engine for a request, between the check\'s ten and the proposal\'s five', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBe(6);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(60_000);
    });

    it('is the school administrator\'s, with the proposal\'s areas, behind both guards', () => {
      expect(Reflect.getMetadata(ROLES_KEY, StaffingWeekController)).toEqual([Role.SCHOOL_ADMIN]);
      expect(Reflect.getMetadata(AREA_KEY, StaffingWeekController)).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING', 'DRIFT'] });
      expect(Reflect.getMetadata(GUARDS_METADATA, StaffingWeekController)).toEqual([JwtAuthGuard, RolesGuard]);
    });
  });

  describe('the body', () => {
    const errorsOf = async (value: unknown) => validate(plainToInstance(StaffingWeekDto, value));
    const good = { academicYearId: YEAR_ID, basisSha256: BASIS, changes: [{ requirementId: REQ, fromTeacherId: EVA, toTeacherId: OLA }] };

    it('takes a year, the proposal\'s basis and the changes, a post nobody teaches as from null, and an empty selection', async () => {
      expect(await errorsOf(good)).toEqual([]);
      expect(await errorsOf({ ...good, changes: [{ requirementId: REQ, fromTeacherId: null, toTeacherId: OLA }] })).toEqual([]);
      expect(await errorsOf({ ...good, changes: [] })).toEqual([]);
    });

    it('refuses what an apply would refuse: another basis, a lead that is nobody (a proposal never unstaffs), a repeated post, ids that are not uuids, and no list', async () => {
      const bad: unknown[] = [
        { ...good, basisSha256: 'not-a-digest' },
        { ...good, basisSha256: undefined },
        { ...good, changes: [{ requirementId: REQ, fromTeacherId: EVA, toTeacherId: null }] },
        { ...good, changes: [{ requirementId: REQ, fromTeacherId: EVA }] },
        { ...good, changes: [good.changes[0], good.changes[0]] },
        { ...good, changes: [{ requirementId: 'x', fromTeacherId: EVA, toTeacherId: OLA }] },
        { ...good, changes: [{ requirementId: REQ, fromTeacherId: 'x', toTeacherId: OLA }] },
        { ...good, changes: 'all' },
        { ...good, changes: undefined },
        { ...good, academicYearId: 'latest' },
      ];
      for (const value of bad) expect((await errorsOf(value)).length).toBeGreaterThan(0);
    });

    it('takes at most as many changes as an apply does', async () => {
      const many = (count: number) =>
        Array.from({ length: count }, (_, index) => ({
          requirementId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          fromTeacherId: null,
          toTeacherId: OLA,
        }));
      expect(await errorsOf({ ...good, changes: many(5000) })).toEqual([]);
      expect((await errorsOf({ ...good, changes: many(5001) })).length).toBeGreaterThan(0);
    });
  });
});
