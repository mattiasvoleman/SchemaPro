import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { BlockPlacementsController } from './block-placements.controller';
import { BlockPlacementsService } from './block-placements.service';
import { PlacementWriteInController } from './placement-write-in.controller';
import { PlacementWriteInService } from './placement-write-in.service';
import { RequirementPlacementsController } from './requirement-placements.controller';
import { RequirementPlacementsService } from './requirement-placements.service';

/**
 * Förlagda poster: a timplanspost's lessons placed by the school before
 * Generera. The clash rule a row is judged by is the grundschema editor's own
 * (MasterLessonsService, CalendarModule's); Generera judges the same rows with
 * judgePlacements (placement-judge.ts) and the same service instance. A parallel block's lessons (Förlagda block,
 * block-placements.service.ts) are placed here too, on the block's own routes.
 */
@Module({
  imports: [CalendarModule],
  controllers: [RequirementPlacementsController, BlockPlacementsController, PlacementWriteInController],
  providers: [RequirementPlacementsService, BlockPlacementsService, PlacementWriteInService],
  exports: [RequirementPlacementsService],
})
export class RequirementPlacementsModule {}
