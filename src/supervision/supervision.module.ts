import { Module } from '@nestjs/common';
import { SupervisionAreasController, SupervisionShiftsController, SupervisionWeekController } from './supervision.controller';
import { SupervisionService } from './supervision.service';

@Module({
  controllers: [SupervisionAreasController, SupervisionShiftsController, SupervisionWeekController],
  providers: [SupervisionService],
})
export class SupervisionModule {}
