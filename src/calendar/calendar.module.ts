import { Module } from '@nestjs/common';
import { CalendarController } from './calendar.controller';
import { CalendarService } from './calendar.service';
import { CalendarLessonsController } from './calendar-lessons.controller';
import { CalendarLessonsService } from './calendar-lessons.service';
import { MasterLessonsController } from './master-lessons.controller';
import { MasterLessonsService } from './master-lessons.service';
import { ScheduleVersionsController } from './schedule-versions.controller';
import { ScheduleVersionsService } from './schedule-versions.service';

@Module({
  controllers: [
    CalendarController,
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
})
export class CalendarModule {}
