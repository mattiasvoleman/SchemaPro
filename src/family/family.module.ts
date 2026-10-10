import { Module } from '@nestjs/common';
import { FamilyController } from './family.controller';
import { FamilyService } from './family.service';
import { FamilyScheduleService } from './family-schedule.service';

@Module({
  controllers: [FamilyController],
  providers: [FamilyService, FamilyScheduleService],
})
export class FamilyModule {}
