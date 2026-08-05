import { Module } from '@nestjs/common';
import { RoomBookingsController } from './room-bookings.controller';
import { RoomBookingsService } from './room-bookings.service';

/**
 * Self-service room bookings (Skola24 Lokal parity). NotificationsModule is
 * @Global, so the approval notice needs no explicit import here.
 */
@Module({
  controllers: [RoomBookingsController],
  providers: [RoomBookingsService],
})
export class RoomBookingsModule {}
