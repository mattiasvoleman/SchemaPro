import 'reflect-metadata';
import { testUser } from '../../test/utils/prisma-mock';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { RoomBookingsController } from './room-bookings.controller';
import type { RoomBookingsService } from './room-bookings.service';
import type {
  CreateRoomBookingDto,
  DecideRoomBookingDto,
} from './dto/room-booking.dto';

const ROOM_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_ID = '55555555-5555-4555-8555-555555555555';

describe('RoomBookingsController', () => {
  let bookings: {
    create: jest.Mock;
    cancel: jest.Mock;
    decide: jest.Mock;
  };
  let controller: RoomBookingsController;
  const user = testUser();

  beforeEach(() => {
    bookings = {
      create: jest.fn().mockResolvedValue({ id: BOOKING_ID, status: 'APPROVED' }),
      cancel: jest.fn().mockResolvedValue({ id: BOOKING_ID, status: 'CANCELLED' }),
      decide: jest.fn().mockResolvedValue({ id: BOOKING_ID, status: 'REJECTED' }),
    };
    controller = new RoomBookingsController(
      bookings as unknown as RoomBookingsService,
    );
  });

  describe('delegation', () => {
    it('create passes the DTO and the principal through unchanged', async () => {
      const dto: CreateRoomBookingDto = {
        roomId: ROOM_ID,
        title: 'Rehearsal',
        startsAt: '2026-08-10T10:00:00.000Z',
        endsAt: '2026-08-10T11:00:00.000Z',
      };

      await expect(controller.create(dto, user)).resolves.toEqual({
        id: BOOKING_ID,
        status: 'APPROVED',
      });
      expect(bookings.create).toHaveBeenCalledWith(dto, user);
    });

    it('cancel passes the path id and the principal', async () => {
      await expect(controller.cancel(BOOKING_ID, user)).resolves.toEqual({
        id: BOOKING_ID,
        status: 'CANCELLED',
      });
      expect(bookings.cancel).toHaveBeenCalledWith(BOOKING_ID, user);
    });

    it('decide passes id, DTO and principal in order', async () => {
      const dto: DecideRoomBookingDto = { status: 'REJECTED', note: 'Taken' };

      await expect(controller.decide(BOOKING_ID, dto, user)).resolves.toEqual({
        id: BOOKING_ID,
        status: 'REJECTED',
      });
      expect(bookings.decide).toHaveBeenCalledWith(BOOKING_ID, dto, user);
    });

    it('propagates service failures instead of swallowing them', async () => {
      const boom = new Error('boom');
      bookings.cancel.mockRejectedValue(boom);

      await expect(controller.cancel(BOOKING_ID, user)).rejects.toBe(boom);
    });
  });

  // The decorators ARE the authorization and rate-limit model for these
  // routes — RolesGuard and ThrottlerGuard read this metadata at runtime.
  // A handler losing its decorator silently widens access.
  describe('route metadata', () => {
    const rolesOf = (handler: (...args: never[]) => unknown): Role[] =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[];

    it('guards the whole controller with JwtAuthGuard + RolesGuard', () => {
      // '__guards__' is Nest's GUARDS_METADATA constant.
      const guards = Reflect.getMetadata('__guards__', RoomBookingsController) as
        | unknown[]
        | undefined;
      expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    });

    it('opens booking creation and cancellation to teachers and admins only', () => {
      expect(rolesOf(RoomBookingsController.prototype.create)).toEqual([
        Role.TEACHER,
        Role.SCHOOL_ADMIN,
      ]);
      expect(rolesOf(RoomBookingsController.prototype.cancel)).toEqual([
        Role.TEACHER,
        Role.SCHOOL_ADMIN,
      ]);
    });

    it('restricts approval decisions to school admins', () => {
      expect(rolesOf(RoomBookingsController.prototype.decide)).toEqual([
        Role.SCHOOL_ADMIN,
      ]);
    });

    it('rate-limits booking creation to 20 per minute', () => {
      // @nestjs/throttler stores per-throttler metadata under
      // `THROTTLER:LIMIT<name>` / `THROTTLER:TTL<name>` on the handler.
      const create = RoomBookingsController.prototype.create;
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', create)).toBe(20);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', create)).toBe(60_000);
    });
  });
});
