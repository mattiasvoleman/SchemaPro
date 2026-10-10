import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarLessonsController } from './calendar-lessons.controller';
import { CalendarLessonsService } from './calendar-lessons.service';
import { MasterLessonsController } from './master-lessons.controller';
import { MasterLessonsService } from './master-lessons.service';
import { ScheduleVersionsController } from './schedule-versions.controller';
import { ScheduleVersionsService } from './schedule-versions.service';

@Module({
  controllers: [
    // CalendarController (POST /calendar/publish) is registered by
    // PublicationModule, which logs and gates it.
    CalendarLessonsController,
    MasterLessonsController,
    ScheduleVersionsController,
  ],
  providers: [
    CalendarService,
    CalendarLessonsService,
    MasterLessonsService,
    ScheduleVersionsService,
  ],
  // The room optimisation snapshots the year inside its own apply transaction.
  exports: [ScheduleVersionsService, CalendarService],
})
export class CalendarModule {}
