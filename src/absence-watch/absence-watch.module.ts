import { Module } from '@nestjs/common';
import { AbsenceWatchController } from './absence-watch.controller';
import { AbsenceWatchJob } from './absence-watch.job';
import { AbsenceWatchService } from './absence-watch.service';

/**
 * Frånvarobevakning: the school's limits for absence (/admin/absence-watch),
 * the findings a mentor, rektor, kansli or guardian reads, and the nightly job
 * that counts them and writes the week's or month's digest. The job
 * registers with the global JobRunner and hands its notices to the global
 * NotificationsService.
 */
@Module({
  controllers: [AbsenceWatchController],
  providers: [AbsenceWatchService, AbsenceWatchJob],
})
export class AbsenceWatchModule {}
