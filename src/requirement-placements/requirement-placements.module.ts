import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { RequirementPlacementsController } from './requirement-placements.controller';
import { RequirementPlacementsService } from './requirement-placements.service';

/**
 * Förlagda poster: a timplanspost's lessons placed by the school before
 * Generera. The clash rule a row is judged by is the grundschema editor's own
 * (MasterLessonsService, CalendarModule's); Generera judges the same rows with
 * judgePlacements (placement-judge.ts) and the same service instance.
 */
@Module({
  imports: [CalendarModule],
  controllers: [RequirementPlacementsController],
  providers: [RequirementPlacementsService],
  exports: [RequirementPlacementsService],
})
export class RequirementPlacementsModule {}
