import { Module } from '@nestjs/common';
import { RoomLoansController, SharingController } from './sharing.controller';
import { RoomLoansService } from './room-loans.service';
import { SharingService } from './sharing.service';

@Module({
  controllers: [SharingController, RoomLoansController],
  providers: [SharingService, RoomLoansService],
  exports: [SharingService, RoomLoansService],
})
export class SharingModule {}
