import { Module } from '@nestjs/common';
import { StaffingPolicyController } from './staffing-policy.controller';
import { StaffingPolicyService } from './staffing-policy.service';
import { TeacherEmploymentsController } from './teacher-employments.controller';
import { TeacherEmploymentsService } from './teacher-employments.service';
import { TeacherQualificationsController } from './teacher-qualifications.controller';
import { TeacherQualificationsService } from './teacher-qualifications.service';
import { StaffingLoadController } from './staffing-load.controller';
import { StaffingLoadService } from './staffing-load.service';
import { TeacherDutiesController } from './teacher-duties.controller';
import { TeacherDutiesService } from './teacher-duties.service';

/**
 * Tjänstefördelning: the layer between the timplan and the solver that says
 * what a teacher's post is, what they may teach, and how much of the year's
 * requirements they carry.
 *
 * Its own module rather than more controllers in ResourcesModule, because its
 * role lists differ from that module's one rule. Resources is admin-only with
 * the work rules as the single argued exception; here a TEACHER reads their own
 * post, every behörighet and their own load, and the HR rows have a narrower
 * read arm than any scheduling table. Keeping that in one folder keeps the
 * argument in one place.
 *
 * Uppdrag (TeacherDuties) live here too: they are part of the tjänst, and the
 * one thing of theirs the solver sees is the UNAVAILABLE constraint a fixed
 * time becomes — an ordinary teacher block, with no label and no minutes.
 *
 * Nothing else here reaches the solver. Employment percentages, qualifications and
 * loads never cross the gateway boundary in this phase; the engine keeps
 * receiving requirements with opaque teacher ids and nothing else.
 */
@Module({
  controllers: [
    StaffingPolicyController,
    TeacherEmploymentsController,
    TeacherQualificationsController,
    StaffingLoadController,
    TeacherDutiesController,
  ],
  providers: [
    StaffingPolicyService,
    TeacherEmploymentsService,
    TeacherQualificationsService,
    StaffingLoadService,
    TeacherDutiesService,
  ],
  // The publish gate PUB_STAFFING_REFUSE reads the load report (src/publication).
  exports: [StaffingLoadService],
})
export class StaffingModule {}
