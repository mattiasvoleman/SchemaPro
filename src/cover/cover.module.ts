import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { CoverController, TeacherAbsenceReasonsController, TeacherAbsencesController } from './cover.controller';
import { CoverService } from './cover.service';
import { CoverSuggestionsService } from './cover-suggestions.service';
import { CoverReportsService } from './cover-reports.service';
import { CoverSettingsService } from './cover-settings.service';
import { TeacherAbsencesService } from './teacher-absences.service';
import { SupervisionCoverService } from './supervision-cover.service';

/**
 * Vikarieplanering: teacher absences, the cover board and its decisions,
 * suggestions and the day proposal, the substitute pool, the counter and the
 * hour statement, and an absent rastvakt's passes (SupervisionCoverService,
 * Rastvakt i vardagen). Imports CalendarModule for the day operations it builds on
 * (assignInTransaction and its siblings); the decision helpers it shares
 * with them are plain functions (cover-decisions.ts), so there is no cycle.
 */
@Module({
  imports: [CalendarModule],
  controllers: [TeacherAbsencesController, TeacherAbsenceReasonsController, CoverController],
  providers: [
    CoverService,
    CoverSuggestionsService,
    CoverReportsService,
    CoverSettingsService,
    TeacherAbsencesService,
    SupervisionCoverService,
  ],
})
export class CoverModule {}
