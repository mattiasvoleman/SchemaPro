import 'reflect-metadata';
import { HttpStatus, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AREA_KEY } from '../auth/decorators/area.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { testUser } from '../../test/utils/prisma-mock';
import type { SuggestionsView } from './suggestions';
import { SuggestionsController } from './suggestions.controller';
import type { SuggestionsService } from './suggestions.service';

const JOB_ID = '66666666-6666-4666-8666-666666666666';

const view: SuggestionsView = {
  version: 1, state: 'RUNNING', startedAt: '2027-03-05T10:00:00.000Z', finishedAt: null, verdict: null, verified: false,
  total: 0, searchSeconds: null, verifySeconds: null, changes: [], failure: null,
};

describe('SuggestionsController', () => {
  let suggestions: { start: jest.Mock };
  let controller: SuggestionsController;

  beforeEach(() => {
    suggestions = { start: jest.fn() };
    controller = new SuggestionsController(suggestions as unknown as SuggestionsService);
  });

  it('starts the analysis of the run in the path as the caller, and answers with what the service says', async () => {
    suggestions.start.mockResolvedValue(view);
    const user = testUser();

    await expect(controller.start(JOB_ID, user)).resolves.toBe(view);
    expect(suggestions.start).toHaveBeenCalledWith(JOB_ID, user);
  });

  it("lets the service's refusal through untouched: a run it may not be asked for is its own 409", async () => {
    const refusal = new Error('409');
    suggestions.start.mockRejectedValue(refusal);
    await expect(controller.start(JOB_ID, testUser())).rejects.toBe(refusal);
  });

  describe('the route', () => {
    const handler = SuggestionsController.prototype.start;

    it('is POST /api/v1/optimization/jobs/:id/suggestions, answered 202: the page polls the run', () => {
      expect(Reflect.getMetadata(PATH_METADATA, SuggestionsController)).toBe('api/v1/optimization');
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('jobs/:id/suggestions');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(HttpStatus.ACCEPTED);
    });

    it("is guarded exactly as the routes of a run are: school administrators who write Schemaläggning and Drift (every area the class names)", () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, SuggestionsController)).toEqual([JwtAuthGuard, RolesGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, SuggestionsController)).toEqual([Role.SCHOOL_ADMIN]);
      expect(Reflect.getMetadata(AREA_KEY, SuggestionsController)).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING', 'DRIFT'] });
    });

    it('is throttled as the routes that wake the solver are: three a minute', () => {
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(3);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    });
  });
});
