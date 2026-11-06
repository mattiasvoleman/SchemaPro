import { Module } from '@nestjs/common';
import { ReportingRateController } from './reporting-rate.controller';
import { ReportingRateJob } from './reporting-rate.job';
import { ReportingRateService } from './reporting-rate.service';

/**
 * Rapporteringsgrad: each teacher's share of held lessons with a saved
 * register (/admin/reporting-rate for the administrators, a page of their own
 * for a teacher), and the nightly job that stores the days and sends the
 * reminders and the weekly notice of the schools that turned them on. The job
 * registers with the global JobRunner and hands its notices to the global
 * NotificationsService.
 */
@Module({
  controllers: [ReportingRateController],
  providers: [ReportingRateService, ReportingRateJob],
})
export class ReportingRateModule {}
