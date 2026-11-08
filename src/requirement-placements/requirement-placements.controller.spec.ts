import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { testUser } from '../../test/utils/prisma-mock';
import { AREA_KEY } from '../auth/decorators/area.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { MAX_PLACEMENTS_PER_POST, ReplacePlacementsDto } from './dto/requirement-placements.dto';
import { RequirementPlacementsController } from './requirement-placements.controller';
import type { RequirementPlacementsService } from './requirement-placements.service';

const YEAR = '44444444-4444-4444-8444-444444444444';
const POST = '55555555-5555-4555-8555-555555555555';
const ROOM = '66666666-6666-4666-8666-666666666666';

describe('RequirementPlacementsController', () => {
  let service: { listOfYear: jest.Mock; listOfPost: jest.Mock; replace: jest.Mock };
  let controller: RequirementPlacementsController;
  const user = testUser();

  beforeEach(() => {
    service = {
      listOfYear: jest.fn().mockResolvedValue([]),
      listOfPost: jest.fn().mockResolvedValue({ placements: [], verdicts: [] }),
      replace: jest.fn().mockResolvedValue({ placements: [], verdicts: [] }),
    };
    controller = new RequirementPlacementsController(service as unknown as RequirementPlacementsService);
  });

  describe('delegation', () => {
    it('lists the year with the caller as principal', async () => {
      await expect(controller.listOfYear(YEAR, user)).resolves.toEqual([]);
      expect(service.listOfYear).toHaveBeenCalledWith(YEAR, user);
    });

    it('lists one post\'s rows with their verdicts', async () => {
      await expect(controller.listOfPost(POST, user)).resolves.toEqual({ placements: [], verdicts: [] });
      expect(service.listOfPost).toHaveBeenCalledWith(POST, user);
    });

    it('replaces with the post, the body and the caller in that order', async () => {
      const dto = { placements: [] } as ReplacePlacementsDto;
      await controller.replace(POST, dto, user);
      expect(service.replace).toHaveBeenCalledWith(POST, dto, user);
    });

    it('propagates a refusal instead of swallowing it', async () => {
      const boom = new Error('boom');
      service.replace.mockRejectedValue(boom);
      await expect(controller.replace(POST, { placements: [] }, user)).rejects.toBe(boom);
    });
  });

  // The decorators ARE the authorization model: RolesGuard reads them at runtime.
  describe('route metadata', () => {
    const proto = RequirementPlacementsController.prototype;
    const path = (handler: (...args: never[]) => unknown) => Reflect.getMetadata(PATH_METADATA, handler) as string;
    const method = (handler: (...args: never[]) => unknown) => Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;

    it('guards the whole controller with JwtAuthGuard + RolesGuard, for school administrators in Planering', () => {
      expect(Reflect.getMetadata('__guards__', RequirementPlacementsController)).toEqual([JwtAuthGuard, RolesGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, RequirementPlacementsController)).toEqual([Role.SCHOOL_ADMIN]);
      expect(Reflect.getMetadata(AREA_KEY, RequirementPlacementsController)).toEqual({ kind: 'area', areas: ['PLANERING'] });
    });

    it('sits under the posts\' own prefix, the static list apart from the `:id` routes', () => {
      expect(Reflect.getMetadata(PATH_METADATA, RequirementPlacementsController)).toBe('api/v1/teaching-requirements');
      expect([path(proto.listOfYear), method(proto.listOfYear)]).toEqual(['placements', RequestMethod.GET]);
      expect([path(proto.listOfPost), method(proto.listOfPost)]).toEqual([':id/placements', RequestMethod.GET]);
      expect([path(proto.replace), method(proto.replace)]).toEqual([':id/placements', RequestMethod.PUT]);
    });

    it('leaves the area to the class: reading is every administrator\'s, only the PUT is a write', () => {
      for (const handler of [proto.listOfYear, proto.listOfPost, proto.replace]) {
        expect(Reflect.getMetadata(AREA_KEY, handler)).toBeUndefined();
        expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
      }
    });
  });
});

describe('ReplacePlacementsDto', () => {
  const valid = { dayOfWeek: 2, startTime: '10:00', minutes: 60, roomId: ROOM, recurrence: 'ALL_WEEKS' };
  const errorsOf = async (body: unknown) => (await validate(plainToInstance(ReplacePlacementsDto, body))).flatMap(describeError);
  const describeError = (error: { property: string; constraints?: Record<string, string>; children?: unknown[] }): string[] => [
    ...Object.keys(error.constraints ?? {}).map((key) => `${error.property}:${key}`),
    ...((error.children ?? []) as Array<Parameters<typeof describeError>[0]>).flatMap((child) => describeError(child).map((text) => `${error.property}.${text}`)),
  ];

  it('accepts a list of rows, and an empty list (which removes them all)', async () => {
    expect(await errorsOf({ placements: [valid, { ...valid, recurrence: 'ODD_WEEKS', dayOfWeek: 5 }] })).toEqual([]);
    expect(await errorsOf({ placements: [] })).toEqual([]);
  });

  it.each([
    ['a day below the week', { dayOfWeek: 0 }, 'dayOfWeek:min'],
    ['a day past Friday', { dayOfWeek: 6 }, 'dayOfWeek:max'],
    ['a fractional day', { dayOfWeek: 2.5 }, 'dayOfWeek:isInt'],
    ['a time without its leading zero', { startTime: '9:00' }, 'startTime:matches'],
    ['a time with seconds', { startTime: '10:00:00' }, 'startTime:matches'],
    ['a time off the clock', { startTime: '24:00' }, 'startTime:matches'],
    ['a lesson under 15 minutes', { minutes: 14 }, 'minutes:min'],
    ['a lesson over 240 minutes', { minutes: 241 }, 'minutes:max'],
    ['minutes in text', { minutes: '60' }, 'minutes:isInt'],
    ['a room that is no uuid', { roomId: 'simhallen' }, 'roomId:isUuid'],
    ['weeks that are none of the three', { recurrence: 'WEEKLY' }, 'recurrence:isEnum'],
  ])('refuses %s', async (_name, over, expected) => {
    const errors = await errorsOf({ placements: [{ ...valid, ...over }] });
    // A text fails the bounds as well as isInt; the point is that the row is refused and the field named.
    expect(errors).toContain(`placements.0.${expected}`);
    expect(errors.every((text) => text.startsWith('placements.0.'))).toBe(true);
  });

  it('refuses a body that is no list, and more than the most one post holds', async () => {
    expect(await errorsOf({ placements: 'x' })).toContain('placements:isArray');
    expect(await errorsOf({ placements: Array.from({ length: MAX_PLACEMENTS_PER_POST + 1 }, () => valid) })).toEqual(['placements:arrayMaxSize']);
    expect(await errorsOf({ placements: Array.from({ length: MAX_PLACEMENTS_PER_POST }, () => valid) })).toEqual([]);
  });
});
