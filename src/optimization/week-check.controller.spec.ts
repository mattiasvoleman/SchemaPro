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
import { WeekCheckDto } from './dto/week-check.dto';
import type { WeekCheckView } from './interfaces/week-check.interface';
import type { WeekCheckChoiceView } from './interfaces/week-check-choice.interface';
import type { OptimizationJobsService } from './optimization-jobs.service';
import { WeekCheckController } from './week-check.controller';
import type { WeekCheckChoiceService } from './week-check-choice.service';
import type { WeekCheckService } from './week-check.service';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';

const view: WeekCheckView = {
  verdict: 'OK',
  years: [],
  conflicts: null,
  skipped: ['LUNCH_STAGE'],
  elapsedMs: 12,
  checkedBy: 'ENGINE',
};

const choiceView: WeekCheckChoiceView = {
  status: 'NO_TIGHT_YEAR',
  years: [],
  qualificationsRecorded: true,
  releasedPosts: 0,
  notRun: 0,
  calls: 1,
  elapsedMs: 12,
};

describe('WeekCheckController', () => {
  let weekCheck: { check: jest.Mock };
  let choice: { choice: jest.Mock };
  let jobs: { refusalForReader: jest.Mock };
  let controller: WeekCheckController;

  beforeEach(() => {
    weekCheck = { check: jest.fn() };
    choice = { choice: jest.fn() };
    // As the service answers every error but a days refusal: the error itself.
    jobs = { refusalForReader: jest.fn(async (error: unknown) => error) };
    controller = new WeekCheckController(
      weekCheck as unknown as WeekCheckService,
      jobs as unknown as OptimizationJobsService,
      choice as unknown as WeekCheckChoiceService,
    );
  });

  it('asks about the DTO year as the caller, and answers with what the service says', async () => {
    weekCheck.check.mockResolvedValue(view);
    const user = testUser();

    await expect(controller.check({ academicYearId: YEAR_ID }, user)).resolves.toBe(view);
    expect(weekCheck.check).toHaveBeenCalledWith(YEAR_ID, user);
    expect(jobs.refusalForReader).not.toHaveBeenCalled();
  });

  it('words a refusal about a post\'s days for this caller before it leaves, as the synchronous trigger does', async () => {
    const raw = new HttpException({ message: 'days', code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK' }, HttpStatus.BAD_REQUEST);
    const worded = new HttpException({ message: 'hidden', code: 'TEACHER_WORK_DAYS_HIDDEN' }, HttpStatus.BAD_REQUEST);
    weekCheck.check.mockRejectedValue(raw);
    jobs.refusalForReader.mockResolvedValue(worded);
    const user = testUser();

    await expect(controller.check({ academicYearId: YEAR_ID }, user)).rejects.toBe(worded);
    expect(jobs.refusalForReader).toHaveBeenCalledWith(raw, YEAR_ID, user);
  });

  it('lets every other error through untouched', async () => {
    const down = new HttpException({ message: 'down' }, HttpStatus.SERVICE_UNAVAILABLE);
    weekCheck.check.mockRejectedValue(down);

    await expect(controller.check({ academicYearId: YEAR_ID }, testUser())).rejects.toBe(down);
  });

  describe('the choice: what the week would be if teachers could be chosen', () => {
    it('asks about the DTO year as the caller, and answers with what the service says', async () => {
      choice.choice.mockResolvedValue(choiceView);
      const user = testUser();

      await expect(controller.askChoice({ academicYearId: YEAR_ID }, user)).resolves.toBe(choiceView);
      expect(choice.choice).toHaveBeenCalledWith(YEAR_ID, user);
      expect(weekCheck.check).not.toHaveBeenCalled();
    });

    it('words a refusal about a post\'s days for this caller before it leaves, as the check does', async () => {
      const raw = new HttpException({ message: 'days', code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK' }, HttpStatus.BAD_REQUEST);
      const worded = new HttpException({ message: 'hidden', code: 'TEACHER_WORK_DAYS_HIDDEN' }, HttpStatus.BAD_REQUEST);
      choice.choice.mockRejectedValue(raw);
      jobs.refusalForReader.mockResolvedValue(worded);
      const user = testUser();

      await expect(controller.askChoice({ academicYearId: YEAR_ID }, user)).rejects.toBe(worded);
      expect(jobs.refusalForReader).toHaveBeenCalledWith(raw, YEAR_ID, user);
    });

    it('is POST /api/v1/optimization/week-check/choice, answering 200, behind the check\'s guards and areas', () => {
      const method = WeekCheckController.prototype.askChoice;
      expect(Reflect.getMetadata(PATH_METADATA, method)).toBe('week-check/choice');
      expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(HttpStatus.OK);
    });

    it('is throttled at three a minute, as the routes that wake the solver are: it is up to twelve checks in a row', () => {
      const method = WeekCheckController.prototype.askChoice;
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBe(3);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(60_000);
    });
  });

  describe('the route', () => {
    const method = WeekCheckController.prototype.check;

    it('is POST /api/v1/optimization/week-check, answering 200 and not 202: nothing is left running', () => {
      expect(Reflect.getMetadata(PATH_METADATA, WeekCheckController)).toBe('api/v1/optimization');
      expect(Reflect.getMetadata(PATH_METADATA, method)).toBe('week-check');
      expect(Reflect.getMetadata(METHOD_METADATA, method)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, method)).toBe(HttpStatus.OK);
    });

    it('is throttled at ten a minute: looser than the routes that wake the solver, and not unlimited', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', method)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', method)).toBe(60_000);
    });

    it('is the school administrator\'s, with the areas of the routes it sits beside, behind both guards', () => {
      expect(Reflect.getMetadata(ROLES_KEY, WeekCheckController)).toEqual([Role.SCHOOL_ADMIN]);
      expect(Reflect.getMetadata(AREA_KEY, WeekCheckController)).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING', 'DRIFT'] });
      expect(Reflect.getMetadata(GUARDS_METADATA, WeekCheckController)).toEqual([JwtAuthGuard, RolesGuard]);
    });
  });

  describe('the body', () => {
    const errorsOf = async (body: unknown) => validate(plainToInstance(WeekCheckDto, body));

    it('wants a version 4 uuid and nothing else is read from it', async () => {
      expect(await errorsOf({ academicYearId: YEAR_ID })).toEqual([]);
      for (const bad of [{}, { academicYearId: 'latest' }, { academicYearId: '44444444-4444-1444-8444-444444444444' }]) {
        expect((await errorsOf(bad)).length).toBeGreaterThan(0);
      }
    });
  });
});
