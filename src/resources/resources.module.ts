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
import { LunchServingsService } from './lunch-servings.service';
import { FrameTimesService } from './frame-times.service';
import { SchoolBreaksController } from './school-breaks.controller';
import { SchoolBreaksService } from './school-breaks.service';

/**
 * School catalog CRUD (admin-only). Reads happen directly against Supabase
 * under RLS from the clients; every mutation flows through these endpoints so
 * validation, tenancy checks and auditing live in one place.
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
    SchoolBreaksController,
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
    SchoolBreaksService,
  ],
})
export class ResourcesModule {}
