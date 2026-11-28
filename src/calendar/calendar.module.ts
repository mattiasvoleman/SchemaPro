import { Module } from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CalendarLessonsController } from './calendar-lessons.controller';
import { CalendarLessonsService } from './calendar-lessons.service';
import { MasterLessonsController } from './master-lessons.controller';
import { MasterLessonsService } from './master-lessons.service';
import { PossibleTimesService } from './possible-times.service';
import { WhatFitsService } from './what-fits.service';
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
    PossibleTimesService,
    ScheduleVersionsService,
    WhatFitsService,
  ],
  // The room optimisation snapshots the year inside its own apply transaction;
  // the cover board builds on the day operations (CoverModule).
  // The timetable import holds a file's lessons to the hand edit's clash rule.
  // Lägg det som går (board-fill) asks E3's question brick by brick and builds its world with the service's own reads.
  exports: [ScheduleVersionsService, CalendarService, CalendarLessonsService, MasterLessonsService, PossibleTimesService],
})
export class CalendarModule {}
