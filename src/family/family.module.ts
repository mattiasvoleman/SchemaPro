import { Module } from '@nestjs/common';
import { FamilyController } from './family.controller';
import { FamilyService } from './family.service';
import { FamilyReadsService } from './family-reads.service';
import { FamilyScheduleService } from './family-schedule.service';
import { LeaveConsentJob } from './leave-consent.job';
import { LeaveService } from './leave.service';

@Module({
  controllers: [FamilyController],
  providers: [FamilyService, FamilyReadsService, FamilyScheduleService, LeaveService, LeaveConsentJob],
  // The whole-school export builds vardnadshavare.csv with the gateway's own read of the links.
  exports: [FamilyReadsService],
})
export class FamilyModule {}
