import { Module } from '@nestjs/common';
import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';
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

/**
 * School catalog CRUD (admin-only). Reads happen directly against Supabase
 * under RLS from the clients; every mutation flows through these endpoints so
 * validation, tenancy checks and auditing live in one place.
 */
@Module({
  controllers: [
    RoomTypesController,
    SubjectsController,
    RoomsController,
    AcademicYearsController,
    StudentGroupsController,
    TeachingRequirementsController,
    AvailabilityConstraintsController,
  ],
  providers: [
    RoomTypesService,
    SubjectsService,
    RoomsService,
    AcademicYearsService,
    StudentGroupsService,
    TeachingRequirementsService,
    AvailabilityConstraintsService,
  ],
})
export class ResourcesModule {}
