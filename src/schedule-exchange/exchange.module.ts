import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { ScheduleExchangeController } from './exchange.controller';
import { ScheduleExchangeService } from './exchange.service';

/** Schemat som tabell och i öppna format (round 9, S0). */
@Module({
  imports: [CalendarModule],
  controllers: [ScheduleExchangeController],
  providers: [ScheduleExchangeService],
})
export class ScheduleExchangeModule {}
