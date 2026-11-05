import { Module } from '@nestjs/common';
import { CrisisAdminController, CrisisTeacherController } from './crisis.controller';
import { CrisisJob } from './crisis.job';
import { CrisisService } from './crisis.service';

/**
 * Krisläge (F2, 20270109091000): an alarm for utrymning or inrymning that
 * starts from the timetable, the teachers' marks, the live view and the
 * protocol. NotificationsModule and RealtimeModule are global.
 */
@Module({
  controllers: [CrisisAdminController, CrisisTeacherController],
  providers: [CrisisService, CrisisJob],
})
export class CrisisModule {}
