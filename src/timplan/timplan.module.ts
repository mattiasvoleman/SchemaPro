import { Module } from '@nestjs/common';
import { AcademicYearTimplansController } from './academic-year-timplans.controller';
import { AcademicYearTimplansService } from './academic-year-timplans.service';
import { LocalTimplansController } from './local-timplans.controller';
import { LocalTimplansService } from './local-timplans.service';
import { TimplanCoverageController } from './timplan-coverage.controller';
import { TimplanCoverageService } from './timplan-coverage.service';

/**
 * Den lokala timplanen: a school's own minutes per week per subject and
 * årskurs, the decision that fixes them, and their comparison with the
 * national timplan (src/common/timplan-coverage.ts).
 *
 * Its own module rather than more controllers in ResourcesModule, for the
 * reason StaffingModule gives: its role lists differ from that module's one
 * rule (teachers read here), and the decided-plan rule is argued in one place.
 *
 * Nothing here reaches the solver. A timplan is upstream of the requirements
 * the engine receives, and no field of it crosses the gateway boundary —
 * ai-engine-contract.spec.ts holds the payload's shape.
 */
@Module({
  controllers: [LocalTimplansController, AcademicYearTimplansController, TimplanCoverageController],
  providers: [LocalTimplansService, AcademicYearTimplansService, TimplanCoverageService],
})
export class TimplanModule {}
