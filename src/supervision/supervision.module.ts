import { Module } from '@nestjs/common';
import { SupervisionAreasController, SupervisionShiftsController } from './supervision.controller';
import { SupervisionService } from './supervision.service';

@Module({
  controllers: [SupervisionAreasController, SupervisionShiftsController],
  providers: [SupervisionService],
})
export class SupervisionModule {}
