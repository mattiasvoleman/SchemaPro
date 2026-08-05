import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  RoomBookingsService,
  type RoomBookingResult,
} from './room-bookings.service';
import {
  CreateRoomBookingDto,
  DecideRoomBookingDto,
} from './dto/room-booking.dto';

/**
 * Self-service room bookings. Reads go straight to Supabase under RLS;
 * mutations pass through here. Teachers create/cancel their own bookings;
 * admins approve/reject pending requests on special rooms.
 */
@Controller('api/v1/room-bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoomBookingsController {
  constructor(private readonly bookings: RoomBookingsService) {}

  @Post()
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  create(
    @Body() dto: CreateRoomBookingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomBookingResult> {
    return this.bookings.create(dto, user);
  }

  @Patch(':id/cancel')
  @Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
  cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomBookingResult> {
    return this.bookings.cancel(id, user);
  }

  @Patch(':id/decide')
  @Roles(Role.SCHOOL_ADMIN)
  decide(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DecideRoomBookingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomBookingResult> {
    return this.bookings.decide(id, dto, user);
  }
}
