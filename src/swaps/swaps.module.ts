import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { SwapsController } from './swaps.controller';
import { SwapsService } from './swaps.service';

/** Byten och flyttar (G1): the rules and the write path it uses are CalendarModule's. */
@Module({
  imports: [CalendarModule],
  controllers: [SwapsController],
  providers: [SwapsService],
})
export class SwapsModule {}
