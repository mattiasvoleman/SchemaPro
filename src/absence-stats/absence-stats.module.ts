import { Module } from '@nestjs/common';
import { AbsenceStatsController } from './absence-stats.controller';
import { AbsenceStatsJob } from './absence-stats.job';
import { AbsenceStatsService } from './absence-stats.service';

/**
 * Frånvarostatistik över tid: the school's absence month by month over three
 * läsår, per class and per pupil, with the patterns for a development talk and
 * the reporting rate beside (/admin/reports, /teacher/absence-stats), and the
 * nightly job that stores the months' sums. The job registers with the global
 * JobRunner and sends no notice.
 */
@Module({
  controllers: [AbsenceStatsController],
  providers: [AbsenceStatsService, AbsenceStatsJob],
})
export class AbsenceStatsModule {}
