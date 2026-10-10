import { Module } from '@nestjs/common';
import { CalendarController } from '../calendar/calendar.controller';
import { CalendarModule } from '../calendar/calendar.module';
import { StaffingModule } from '../staffing/staffing.module';
import { TimplanModule } from '../timplan/timplan.module';
import { PublicationsController } from './publications.controller';
import { PublicationsService } from './publications.service';
import { DraftService } from './draft.service';
import { CancellationBatchesController } from './cancellation-batches.controller';
import { CancellationBatchesService } from './cancellation-batches.service';
import { PublicLinksController } from './public-links.controller';
import { PublicLinksService } from './public-links.service';
import { PublicTimetableController } from './public-timetable.controller';
import { PublicViewerThrottlerGuard } from './public-viewer-throttler.guard';

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
  controllers: [
    CalendarController,
    PublicationsController,
    CancellationBatchesController,
    PublicLinksController,
    PublicTimetableController,
  ],
  providers: [PublicationsService, DraftService, CancellationBatchesService, PublicLinksService, PublicViewerThrottlerGuard],
  exports: [PublicationsService],
})
export class PublicationModule {}
