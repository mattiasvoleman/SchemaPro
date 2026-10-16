import { IsIn, IsOptional, IsUUID } from 'class-validator';

/** POST /api/v1/calendar-feeds: a new address for the caller's own week, or a guardian's child's. */
export class CreateCalendarFeedDto {
  /** A guardian's child; a teacher sends none, a pupil none or their own id. */
  @IsOptional()
  @IsUUID('all', { message: 'studentId: ett id.' })
  studentId?: string;

  /** The language the feed speaks; Swedish when not said. */
  @IsOptional()
  @IsIn(['sv', 'en'], { message: "locale: 'sv' eller 'en'." })
  locale?: 'sv' | 'en';
}
