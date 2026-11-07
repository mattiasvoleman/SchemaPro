import { Module } from '@nestjs/common';
import { SchoolDayController } from './school-day.controller';
import { SchoolDayService } from './school-day.service';
import { SchoolDayThrottlerGuard } from './school-day-throttler.guard';

/**
 * Skolans dag i ett svep: the school's day and week as grids over its classes,
 * teachers and rooms, and the search for who and what is free over an
 * interval. Reads only; it writes the one row of the school's decision about
 * the teachers' share.
 */
@Module({
  controllers: [SchoolDayController],
  providers: [SchoolDayService, SchoolDayThrottlerGuard],
})
export class SchoolDayModule {}
