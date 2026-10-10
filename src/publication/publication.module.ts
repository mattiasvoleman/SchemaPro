import { Module } from '@nestjs/common';
import { CalendarController } from '../calendar/calendar.controller';
import { CalendarModule } from '../calendar/calendar.module';
import { StaffingModule } from '../staffing/staffing.module';
import { TimplanModule } from '../timplan/timplan.module';
import { PublicationsController } from './publications.controller';
import { PublicationsService } from './publications.service';

/**
 * Publicering: validity-dated publications, the school's gate policy and the
 * gated publish (migration 20261011090000).
 *
 * The old POST /calendar/publish lives here too, though its controller stays
 * in src/calendar: it now writes a log row and asks the school's REFUSE
 * gates, both of which are this module's, and CalendarModule cannot import
 * this one back (this one materialises through it).
 */
@Module({
  imports: [CalendarModule, StaffingModule, TimplanModule],
  controllers: [CalendarController, PublicationsController],
  providers: [PublicationsService],
  exports: [PublicationsService],
})
export class PublicationModule {}
