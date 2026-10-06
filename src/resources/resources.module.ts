import { Module } from '@nestjs/common';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';
import { RoomPreferencesController } from './room-preferences.controller';
import { RoomPreferencesService } from './room-preferences.service';
import { LunchSettingsController } from './lunch-settings.controller';
import { LunchSettingsService } from './lunch-settings.service';
import { RoomTypesController } from './room-types.controller';
import { RoomTypesService } from './room-types.service';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { AcademicYearsController } from './academic-years.controller';
import { AcademicYearsService } from './academic-years.service';
import { StudentGroupsController } from './student-groups.controller';
import { StudentGroupsService } from './student-groups.service';
import { TeachingRequirementsController } from './teaching-requirements.controller';
import { TeachingRequirementsService } from './teaching-requirements.service';
import { AvailabilityConstraintsController } from './availability-constraints.controller';
import { AvailabilityConstraintsService } from './availability-constraints.service';
import { FrameTimesController } from './frame-times.controller';
import { LunchServingsController } from './lunch-servings.controller';
import { RastsController } from './rasts.controller';
import { LunchServingsService } from './lunch-servings.service';
import { RastsService } from './rasts.service';
import { LunchSittingsController } from './lunch-sittings.controller';
import { LunchSittingsService } from './lunch-sittings.service';
import { FrameTimesService } from './frame-times.service';
import { SchoolBreaksController } from './school-breaks.controller';
import { SchoolBreaksService } from './school-breaks.service';
import { TeacherWorkRulesController } from './teacher-work-rules.controller';
import { TeacherWorkRulesService } from './teacher-work-rules.service';
import { NationalTimplansController } from './national-timplans.controller';
import { NationalTimplansService } from './national-timplans.service';

/**
 * School catalog CRUD. Reads happen directly against Supabase under RLS from
 * the clients; every mutation flows through these endpoints so validation,
 * tenancy checks and auditing live in one place.
 *
 * Admin-only throughout, with one exception that is the point of the resource
 * rather than a hole in the rule: `TeacherWorkRulesController` also admits a
 * TEACHER, who may read the school's arbetstider and write their OWN row. Its
 * service refuses any other row, and so does the table's own
 * `teacher_work_rules_teacher_own` policy — for the writers that never reach
 * this module at all.
 *
 * The second exception is a read, not a write: `NationalTimplansController`
 * hands skolförordningens bilagor to every tenant role, because the statute is
 * public information and its tables grant SELECT to any active signed-in user.
 * Nothing in this module writes those tables — nothing in the API role can.
 */
@Module({
  controllers: [
    RoomTypesController,
    RoomPreferencesController,
    LunchSettingsController,
    SubjectsController,
    RoomsController,
    AcademicYearsController,
    StudentGroupsController,
    TeachingRequirementsController,
    AvailabilityConstraintsController,
    FrameTimesController,
    LunchServingsController,
    RastsController,
    LunchSittingsController,
    SchoolBreaksController,
    TeacherWorkRulesController,
    NationalTimplansController,
  ],
  providers: [
    RoomTypesService,
    RoomPreferencesService,
    LunchSettingsService,
    SubjectsService,
    RoomsService,
    AcademicYearsService,
    StudentGroupsService,
    TeachingRequirementsService,
    AvailabilityConstraintsService,
    FrameTimesService,
    LunchServingsService,
    RastsService,
    LunchSittingsService,
    SchoolBreaksService,
    TeacherWorkRulesService,
    NationalTimplansService,
  ],
})
export class ResourcesModule {}
