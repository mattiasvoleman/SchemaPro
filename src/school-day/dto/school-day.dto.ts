import { IsBoolean, IsIn, IsISO8601, IsOptional, Matches } from 'class-validator';
import type { TeacherView } from '../school-day.types';

/** A date from 2000-01-01 to 2100-12-31: the years the week arithmetic stays inside. */
const DAY = /^(20\d{2}|2100)-\d{2}-\d{2}$/;
/** A wall-clock time, 00:00 to 23:59. */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export const TEACHER_VIEWS: readonly TeacherView[] = ['NONE', 'ROOMS', 'ALL'];

/**
 * GET /api/v1/school-day. `from` is the first day, `to` the last (the same day
 * without it); at most seven days. The dates must exist (2026-02-30 does not)
 * and the message names the field.
 */
export class GridQueryDto {
  @Matches(DAY, { message: 'from: ett datum ÅÅÅÅ-MM-DD mellan 2000-01-01 och 2100-12-31.' })
  @IsISO8601({ strict: true }, { message: 'from: ett datum som finns, ÅÅÅÅ-MM-DD.' })
  from!: string;

  @IsOptional()
  @Matches(DAY, { message: 'to: ett datum ÅÅÅÅ-MM-DD mellan 2000-01-01 och 2100-12-31.' })
  @IsISO8601({ strict: true }, { message: 'to: ett datum som finns, ÅÅÅÅ-MM-DD.' })
  to?: string;
}

/** GET /api/v1/school-day/free: who and what is free from `from` to `to` (HH:MM) on `date`. */
export class FreeQueryDto {
  @Matches(DAY, { message: 'date: ett datum ÅÅÅÅ-MM-DD mellan 2000-01-01 och 2100-12-31.' })
  @IsISO8601({ strict: true }, { message: 'date: ett datum som finns, ÅÅÅÅ-MM-DD.' })
  date!: string;

  @Matches(CLOCK, { message: 'from: en tid TT:MM.' })
  from!: string;

  @Matches(CLOCK, { message: 'to: en tid TT:MM.' })
  to!: string;
}

/** PUT /api/v1/school-day/settings: what a teacher has of Skolans dag. */
export class SchoolDaySettingsDto {
  @IsIn(TEACHER_VIEWS, { message: 'teacherView: NONE, ROOMS eller ALL.' })
  teacherView!: TeacherView;

  /**
   * Whether a guardian is told when their child is moved to a parallel lesson for a day (Elevens lektion för
   * dagen). Left out: what the school has (off, for a school that never said). The teachers of the two lessons
   * are told either way.
   */
  @IsOptional()
  @IsBoolean({ message: 'guardianNoticeOnMove: true eller false.' })
  guardianNoticeOnMove?: boolean;
}
