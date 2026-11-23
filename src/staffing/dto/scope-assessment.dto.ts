import { AssignmentScopeException } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

/** The note's bound, the table's CHECK AssignmentScopeAssessments_note_is_sane (20270306090000). */
export const SCOPE_NOTE_MAX = 500;
/** The level's sanity bound, the table's CHECK AssignmentScopeAssessments_level_is_sane. The ordinance's own edge is the service's. */
export const SCOPE_LEVEL_MAX = 1500;

/** Trimmed, and an empty value is no value: the table holds NULL, never ''. Anything not a string is the validators'. */
const trimmedOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Rektorns bedömning av en lärares omfattning för ett läsår (SFS 2026:1487 3 och 8 §§) och ett registrerat undantag (11 §).
 *
 * KEYED ON THE TEACHER AND THE YEAR, both in the URL and neither in the body: one row per pair, so PUT /:userId?academicYearId= is the
 * whole write surface, as with the post. THE WHOLE ROW IS REPLACED, every time: what is absent is null, so a PUT that names only a
 * level takes an exception away. A form sends everything it shows.
 *
 * Neither field is required, but one is: a body with no level and no exception says nothing, and is refused (the service; the table
 * says the same with a CHECK). To take the assessment away is DELETE.
 */
export class UpsertScopeAssessmentDto {
  /** The teacher's highest teaching time at full time, hours per läsår. Absent or null: none set, and the ordinance's edge holds. */
  @IsOptional()
  @IsInt({ message: 'Nivån anges i hela timmar per läsår.' })
  @Min(1, { message: 'Nivån är minst 1 timme — lämna fältet tomt för en lärare utan egen nivå.' })
  @Max(SCOPE_LEVEL_MAX, { message: `Nivån kan vara högst ${SCOPE_LEVEL_MAX} timmar.` })
  teachingLevelHours?: number | null;

  /** OWN_INITIATIVE (11 § p. 1) or SMALL_GROUP (11 § p. 3). Absent or null: no exception. */
  @IsOptional()
  @IsEnum(AssignmentScopeException, { message: 'Undantaget är OWN_INITIATIVE (eget initiativ) eller SMALL_GROUP (enskild elev eller mindre grupp).' })
  exceptionKind?: AssignmentScopeException | null;

  /** The day the teacher took the initiative: required for OWN_INITIATIVE, refused for anything else. */
  @IsOptional()
  @IsCalendarDate({ message: 'Dagen anges som ÅÅÅÅ-MM-DD och måste finnas.' })
  ownInitiativeOn?: string | null;

  @IsOptional()
  @Transform(trimmedOrNull)
  @IsString({ message: 'Anteckningen anges som text.' })
  @MaxLength(SCOPE_NOTE_MAX, { message: `Anteckningen kan vara högst ${SCOPE_NOTE_MAX} tecken.` })
  // PostgreSQL's text cannot hold a NUL (SQLSTATE 22021), which reached the caller as a 500 "unexpected database error": no NUL here.
  @Matches(/^[^\u0000]*$/, { message: 'Anteckningen kan inte innehålla nolltecken (U+0000).' })
  note?: string | null;
}
