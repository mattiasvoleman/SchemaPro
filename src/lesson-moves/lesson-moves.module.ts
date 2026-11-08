import { Module } from '@nestjs/common';
import { LessonMovesController } from './lesson-moves.controller';
import { LessonMovesService } from './lesson-moves.service';

/**
 * Elevens lektion för dagen: one pupil, for one date, from a lesson to a
 * parallel one. Reads and writes the dated lessons only; the template is never
 * touched. See migration 20270122091000.
 */
@Module({
  controllers: [LessonMovesController],
  providers: [LessonMovesService],
})
export class LessonMovesModule {}
