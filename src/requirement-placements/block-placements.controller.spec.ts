import 'reflect-metadata';
import { BadRequestException, ForbiddenException, ParseUUIDPipe, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type { AdminProfile } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { testUser } from '../../test/utils/prisma-mock';
import { AREA_KEY } from '../auth/decorators/area.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AREA_NOT_YOURS, RolesGuard } from '../auth/roles.guard';
import { BlockPlacementsController } from './block-placements.controller';
import type { BlockPlacementsService } from './block-placements.service';
import {
  MAX_PLACEMENTS_PER_BLOCK,
  MAX_ROOMS_PER_BLOCK_LESSON,
  ReplaceBlockPlacementsDto,
} from './dto/block-placements.dto';

const BLOCK = '44444444-4444-4444-8444-444444444444';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const ROOM = '66666666-6666-4666-8666-666666666666';

describe('BlockPlacementsController', () => {
  let service: { listOfBlock: jest.Mock; replace: jest.Mock };
  let controller: BlockPlacementsController;
  const user = testUser();

  beforeEach(() => {
    service = {
      listOfBlock: jest.fn().mockResolvedValue({ placements: [], verdicts: [], rowsKey: 'k', lengths: [] }),
      replace: jest.fn().mockResolvedValue({ placements: [], verdicts: [], rowsKey: 'k', lengths: [] }),
    };
    controller = new BlockPlacementsController(service as unknown as BlockPlacementsService);
  });

  describe('delegation', () => {
    it('lists one block\'s lessons with their verdicts, with the block and the caller as principal', async () => {
      await expect(controller.listOfBlock(BLOCK, user)).resolves.toEqual({ placements: [], verdicts: [], rowsKey: 'k', lengths: [] });
      expect(service.listOfBlock).toHaveBeenCalledWith(BLOCK, user);
    });

    it('replaces with the block, the body and the caller in that order, and answers what the service answers', async () => {
      const dto = { placements: [] } as ReplaceBlockPlacementsDto;
      await expect(controller.replace(BLOCK, dto, user)).resolves.toEqual({ placements: [], verdicts: [], rowsKey: 'k', lengths: [] });
      expect(service.replace).toHaveBeenCalledWith(BLOCK, dto, user);
    });

    it('propagates a refusal instead of swallowing it', async () => {
      const boom = new Error('boom');
      service.replace.mockRejectedValue(boom);
      await expect(controller.replace(BLOCK, { placements: [] }, user)).rejects.toBe(boom);
      service.listOfBlock.mockRejectedValue(boom);
      await expect(controller.listOfBlock(BLOCK, user)).rejects.toBe(boom);
    });
  });

  // The decorators ARE the authorization model: RolesGuard reads them at runtime.
  describe('route metadata', () => {
    const proto = BlockPlacementsController.prototype;
    const path = (handler: (...args: never[]) => unknown) => Reflect.getMetadata(PATH_METADATA, handler) as string;
    const method = (handler: (...args: never[]) => unknown) => Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;

    it('guards the whole controller with JwtAuthGuard + RolesGuard, for school administrators in Planering', () => {
      expect(Reflect.getMetadata('__guards__', BlockPlacementsController)).toEqual([JwtAuthGuard, RolesGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, BlockPlacementsController)).toEqual([Role.SCHOOL_ADMIN]);
      expect(Reflect.getMetadata(AREA_KEY, BlockPlacementsController)).toEqual({ kind: 'area', areas: ['PLANERING'] });
    });

    it('sits under the blocks\' own prefix, beside the block\'s other routes', () => {
      expect(Reflect.getMetadata(PATH_METADATA, BlockPlacementsController)).toBe('api/v1/teaching-blocks');
      expect([path(proto.listOfBlock), method(proto.listOfBlock)]).toEqual([':id/placements', RequestMethod.GET]);
      expect([path(proto.replace), method(proto.replace)]).toEqual([':id/placements', RequestMethod.PUT]);
    });

    it('leaves the area to the class: reading is every administrator\'s, only the PUT is a write', () => {
      for (const handler of [proto.listOfBlock, proto.replace]) {
        expect(Reflect.getMetadata(AREA_KEY, handler)).toBeUndefined();
        expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
      }
    });

    it('has the controller\'s two routes and no others', () => {
      expect(Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor').sort()).toEqual(['listOfBlock', 'replace']);
    });

    describe.each(['listOfBlock', 'replace'] as const)('%s: the :id', (handlerName) => {
      const pipeOf = (): ParseUUIDPipe => {
        const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, BlockPlacementsController, handlerName) as Record<string, { data?: string; pipes?: unknown[] }>;
        const id = Object.values(args).find((arg) => arg.data === 'id');
        expect(id).toBeDefined();
        expect(id!.pipes).toHaveLength(1);
        expect(id!.pipes![0]).toBeInstanceOf(ParseUUIDPipe);
        return id!.pipes![0] as ParseUUIDPipe;
      };
      const asked = { type: 'param' as const, data: 'id' };

      it('goes through a UUID pipe that takes a version 4 id', async () => {
        await expect(pipeOf().transform(BLOCK, asked)).resolves.toBe(BLOCK);
      });

      it.each([
        ['text', 'not-a-uuid'],
        ['an id with a letter too many', `${BLOCK}0`],
        ['a version 1 uuid', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'],
        ['an empty id', ''],
      ])('refuses %s with a 400 before the service is asked', async (_name, id) => {
        await expect(pipeOf().transform(id, asked)).rejects.toBeInstanceOf(BadRequestException);
      });
    });
  });

  /*
   * The guard is driven through the real Reflector and the metadata the controller carries, so that what is tested is what
   * the annotation grants: reading is every administrator's (RolesGuard asks an area only of a write), the PUT is Planering's.
   */
  describe('who may call it (RolesGuard)', () => {
    const guard = new RolesGuard(new Reflector());
    const administrator = (adminProfile: AdminProfile) => testUser({ role: 'SCHOOL_ADMIN', adminProfile } as never);
    const routed = (handler: 'listOfBlock' | 'replace', principal: unknown, requestMethod: string) =>
      new ExecutionContextHost(
        [{ user: principal, method: requestMethod }, {}, jest.fn()],
        BlockPlacementsController as never,
        BlockPlacementsController.prototype[handler] as never,
      );
    const refusal = (fn: () => unknown): Record<string, unknown> => {
      try {
        fn();
      } catch (error) {
        expect(error).toBeInstanceOf(ForbiddenException);
        return (error as ForbiddenException).getResponse() as Record<string, unknown>;
      }
      throw new Error('expected a 403');
    };

    it.each<AdminProfile>(['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'])('lets a %s administrator read a block\'s lessons', (profile) => {
      expect(guard.canActivate(routed('listOfBlock', administrator(profile), 'GET'))).toBe(true);
    });

    it.each<AdminProfile>(['FULL', 'REKTOR', 'SCHEMALAGGARE'])('lets a %s administrator replace them: the profile writes Planering', (profile) => {
      expect(guard.canActivate(routed('replace', administrator(profile), 'PUT'))).toBe(true);
    });

    it.each<AdminProfile>(['EXPEDITION', 'LASARE'])('refuses a %s administrator\'s PUT, by name and with the area, before anything is written', (profile) => {
      const body = refusal(() => guard.canActivate(routed('replace', administrator(profile), 'PUT')));
      expect(body).toMatchObject({ code: AREA_NOT_YOURS, area: 'PLANERING' });
    });

    it('refuses a teacher and a pupil, for the read as well as the write: the routes are the administrators\'', () => {
      for (const role of ['TEACHER', 'STUDENT'] as const) {
        const principal = testUser({ role } as never);
        expect(() => guard.canActivate(routed('listOfBlock', principal, 'GET'))).toThrow(ForbiddenException);
        expect(() => guard.canActivate(routed('replace', principal, 'PUT'))).toThrow(ForbiddenException);
      }
    });

    it('refuses a request with no principal', () => {
      expect(() => guard.canActivate(routed('listOfBlock', undefined, 'GET'))).toThrow(ForbiddenException);
    });
  });
});

describe('ReplaceBlockPlacementsDto', () => {
  const valid = { dayOfWeek: 2, startTime: '10:00', minutes: 60, rooms: [{ requirementId: MEMBER, roomId: ROOM }] };
  const errorsOf = async (body: unknown) => (await validate(plainToInstance(ReplaceBlockPlacementsDto, body))).flatMap(describeError);
  const describeError = (error: { property: string; constraints?: Record<string, string>; children?: unknown[] }): string[] => [
    ...Object.keys(error.constraints ?? {}).map((key) => `${error.property}:${key}`),
    ...((error.children ?? []) as Array<Parameters<typeof describeError>[0]>).flatMap((child) => describeError(child).map((text) => `${error.property}.${text}`)),
  ];

  it('accepts a list of lessons with rooms, with none, with an empty list of them, and an empty list of lessons (which removes them all)', async () => {
    expect(await errorsOf({ placements: [valid, { ...valid, dayOfWeek: 5, rooms: [] }, { dayOfWeek: 1, startTime: '08:00', minutes: 15 }] })).toEqual([]);
    expect(await errorsOf({ placements: [] })).toEqual([]);
  });

  it('takes the bounds of the school week and of a lesson: Monday to Friday, 15 to 240 minutes, the clock as HH:MM', async () => {
    for (const dayOfWeek of [1, 5]) expect(await errorsOf({ placements: [{ ...valid, dayOfWeek }] })).toEqual([]);
    for (const minutes of [15, 240]) expect(await errorsOf({ placements: [{ ...valid, minutes }] })).toEqual([]);
    for (const startTime of ['00:00', '08:00', '17:45', '23:59']) expect(await errorsOf({ placements: [{ ...valid, startTime }] })).toEqual([]);
  });

  it.each([
    ['a day below the week', { dayOfWeek: 0 }, 'dayOfWeek:min'],
    ['a day past Friday', { dayOfWeek: 6 }, 'dayOfWeek:max'],
    ['a fractional day', { dayOfWeek: 2.5 }, 'dayOfWeek:isInt'],
    ['a day in text', { dayOfWeek: '2' }, 'dayOfWeek:isInt'],
    ['a time without its leading zero', { startTime: '9:00' }, 'startTime:matches'],
    ['a time with seconds', { startTime: '10:00:00' }, 'startTime:matches'],
    ['a time off the clock', { startTime: '24:00' }, 'startTime:matches'],
    ['a minute off the clock', { startTime: '10:60' }, 'startTime:matches'],
    ['a time in text', { startTime: 'tio' }, 'startTime:matches'],
    ['a lesson under 15 minutes', { minutes: 14 }, 'minutes:min'],
    ['a lesson over 240 minutes', { minutes: 241 }, 'minutes:max'],
    ['a fractional length', { minutes: 60.5 }, 'minutes:isInt'],
    ['minutes in text', { minutes: '60' }, 'minutes:isInt'],
    ['rooms that are no list', { rooms: 'sal' }, 'rooms:isArray'],
    ['a member that is no uuid', { rooms: [{ requirementId: 'spanska', roomId: ROOM }] }, 'rooms.0.requirementId:isUuid'],
    ['a room that is no uuid', { rooms: [{ requirementId: MEMBER, roomId: 'sal-1' }] }, 'rooms.0.roomId:isUuid'],
    ['a room with no member', { rooms: [{ roomId: ROOM }] }, 'rooms.0.requirementId:isUuid'],
    ['a member with no room', { rooms: [{ requirementId: MEMBER }] }, 'rooms.0.roomId:isUuid'],
    ['a version 1 uuid for a room', { rooms: [{ requirementId: MEMBER, roomId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }] }, 'rooms.0.roomId:isUuid'],
  ])('refuses %s', async (_name, over, expected) => {
    const errors = await errorsOf({ placements: [{ ...valid, ...over }] });
    // A text fails the bounds as well as isInt; the point is that the lesson is refused and the field named.
    expect(errors).toContain(`placements.0.${expected}`);
    expect(errors.every((text) => text.startsWith('placements.0.'))).toBe(true);
  });

  it('refuses a body that is no list, and a body with none', async () => {
    expect(await errorsOf({ placements: 'x' })).toContain('placements:isArray');
    expect(await errorsOf({})).toContain('placements:isArray');
  });

  it('refuses more lessons than a block holds, and takes exactly that many', async () => {
    expect(await errorsOf({ placements: Array.from({ length: MAX_PLACEMENTS_PER_BLOCK + 1 }, () => valid) })).toEqual(['placements:arrayMaxSize']);
    expect(await errorsOf({ placements: Array.from({ length: MAX_PLACEMENTS_PER_BLOCK }, () => valid) })).toEqual([]);
  });

  it('refuses more rooms to one lesson than a block has members to give, and takes exactly that many', async () => {
    const room = { requirementId: MEMBER, roomId: ROOM };
    expect(await errorsOf({ placements: [{ ...valid, rooms: Array.from({ length: MAX_ROOMS_PER_BLOCK_LESSON + 1 }, () => room) }] })).toEqual([
      'placements.0.rooms:arrayMaxSize',
    ]);
    expect(await errorsOf({ placements: [{ ...valid, rooms: Array.from({ length: MAX_ROOMS_PER_BLOCK_LESSON }, () => room) }] })).toEqual([]);
  });

  it('names the lesson that is wrong, not the first one, among several', async () => {
    const errors = await errorsOf({ placements: [valid, valid, { ...valid, minutes: 5 }] });
    expect(errors).toEqual(['placements.2.minutes:min']);
  });

  describe('baseKey', () => {
    it('is optional, and a key as a read gives it (32 lower-case hex digits) is accepted', async () => {
      expect(await errorsOf({ placements: [] })).toEqual([]);
      expect(await errorsOf({ placements: [], baseKey: '0123456789abcdef0123456789abcdef' })).toEqual([]);
    });

    it.each([
      ['a short key', '0123456789abcdef'],
      ['a long key', '0123456789abcdef0123456789abcdef0'],
      ['upper-case digits', '0123456789ABCDEF0123456789ABCDEF'],
      ['a key that is not hex', 'ghijklmnopqrstuvwxyzghijklmnopqr'],
      ['an empty key', ''],
      ['a key with a line break after it', '0123456789abcdef0123456789abcdef\n'],
    ])('refuses %s', async (_name, baseKey) => {
      expect(await errorsOf({ placements: [], baseKey })).toEqual(['baseKey:matches']);
    });

    it('refuses a key that is no text', async () => {
      expect(await errorsOf({ placements: [], baseKey: 12 })).toEqual(['baseKey:matches']);
    });
  });
});
