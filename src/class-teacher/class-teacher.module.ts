import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { ClassTeacherAdminController } from './class-teacher-admin.controller';
import { ClassTeacherAdminService } from './class-teacher-admin.service';
import { ClassTeacherController } from './class-teacher.controller';
import { ClassTeacherEngine } from './class-teacher-engine';
import { ClassTeacherService } from './class-teacher.service';

/**
 * Klasslärarens schema: a teacher appointed to a class edits it inside the
 * frame the schemaläggare keeps, in a draft of the class's own, published by the
 * schemaläggare (or by the klasslärare, where the school allows it) through the
 * editor's own services.
 */
@Module({
  imports: [CalendarModule],
  controllers: [ClassTeacherController, ClassTeacherAdminController],
  providers: [ClassTeacherEngine, ClassTeacherService, ClassTeacherAdminService],
})
export class ClassTeacherModule {}
