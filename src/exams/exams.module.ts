import { Module } from '@nestjs/common';
import { OptimizationModule } from '../optimization/optimization.module';
import { PublicationModule } from '../publication/publication.module';
import { ExamPlannerService } from './exam-planner.service';
import { ExamsController } from './exams.controller';
import { ExamsService } from './exams.service';

/**
 * Provplanering: the school's exams, the rooms exams are written in, and the
 * planner that lays them with the engine's small model. An exam is a
 * schemabrytande aktivitet (PublicationModule), so this module adds what an
 * activity does not hold: the window the school asked for, the rooms and the
 * invigilators.
 */
@Module({
  imports: [OptimizationModule, PublicationModule],
  controllers: [ExamsController],
  providers: [ExamsService, ExamPlannerService],
})
export class ExamsModule {}
