import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { ScheduleExchangeController } from './exchange.controller';
import { ScheduleExchangeService } from './exchange.service';

/** Schemat som tabell och i öppna format (round 9, S0). */
@Module({
  imports: [CalendarModule],
  controllers: [ScheduleExchangeController],
  providers: [ScheduleExchangeService],
  // The whole-school export writes the grundschema with Schema som fil's own export.
  exports: [ScheduleExchangeService],
})
export class ScheduleExchangeModule {}
