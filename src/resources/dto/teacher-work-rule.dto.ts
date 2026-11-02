import { Transform } from 'class-transformer';
import { IsBoolean, IsDivisibleBy, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import {
  MAX_TEACHING_MINUTES_PER_DAY_MAX,
  MAX_TEACHING_MINUTES_PER_DAY_MIN,
  MAX_TEACHING_MINUTES_PER_DAY_STEP,
  PREFERRED_FREE_DAY_MAX,
  PREFERRED_FREE_DAY_MIN,
} from '../../common/teacher-day';

const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * En lärares arbetstid: the lunch they are owed, and the rest between two days.
 *
 * ONE PAYLOAD, NO SEPARATE CREATE, like the lunch settings: the table holds one
 * row per teacher, so the endpoint upserts the teacher's row rather than
 * pretending there is a collection of them to page through. The teacher is named
 * in the path, never in the body — a body that could name a different person
 * than the URL is a second answer to "whose rule is this", and the ownership
 * check would then have two fields to agree about.
 *
 * EVERY FIELD IS OPTIONAL, AND ABSENT MEANS "this rule does not apply to this
 * teacher". Not "zero" and not "the default": there is no default anywhere in
 * this feature, because a number nobody chose would start refusing weeks that
 * used to solve. The suggested values — 30 minutes inside 10:30-13:30, and 660
 * minutes of rest — are suggestions the form offers, not values this DTO or the
 * database supplies.
 *
 * BUT FOR LÄRARENS DAG (the daily cap and the wished free day, 20261123090000),
 * where absent KEEPS what the row holds and null clears it: they are the
 * administrator's, a teacher writes this row too, and a body from before them
 * must not take them away. See the two fields.
 *
 * The bounds mirror the table's CHECK constraints exactly, and neither copy is
 * redundant. A school admin's own Supabase key can PATCH the table straight
 * through PostgREST without meeting this class at all, and a rule the solver
 * cannot express is not a bad request once — it is a week refused on every run
 * until somebody edits the row.
 *
 * MESSAGES: Swedish on every bound that states a RULE, because an admin reads
 * those in the form and class-validator's default sentence names a constant
 * rather than a reason. English on the two time formats, like every neighbouring
 * DTO here, because a value that is not HH:MM is a client bug and not a decision
 * anybody made.
 */
export class UpsertTeacherWorkRuleDto {
  /**
   * Minutes of lunch, somewhere inside the window below.
   *
   * A multiple of five because the solver's grid is (see
   * src/common/solver-grid.ts): a 7-minute lunch cannot be laid on it, so it
   * would save, look reasonable, and fail on every generation.
   */
  @IsOptional()
  @IsInt({ message: 'Lunchens längd anges i hela minuter.' })
  @Min(5, { message: 'En lunch kortare än 5 minuter går inte att lägga ut.' })
  @Max(240, { message: 'En lunch längre än 240 minuter är inte en lunchrast.' })
  @IsDivisibleBy(5, {
    message:
      'Lunchens längd måste vara ett helt antal 5-minutersintervall — schemaläggaren räknar i femminuterssteg.',
  })
  lunchMinutes?: number | null;

  /**
   * The window the lunch has to fall inside. Both, or neither, together with
   * `lunchMinutes` — the service refuses a half-written trio, because this is a
   * rule about three fields and no per-field decorator can see the other two.
   */
  @IsOptional()
  @Matches(TIME, { message: 'lunchStartTime must be HH:MM.' })
  lunchStartTime?: string | null;

  @IsOptional()
  @Matches(TIME, { message: 'lunchEndTime must be HH:MM.' })
  lunchEndTime?: string | null;

  /**
   * Minutes between the end of the teacher's last lesson one day and the start
   * of their first the next.
   *
   * 1320 at the top — twenty-two hours — is what keeps a typo from becoming a
   * proof: at 1440 the teacher can never work two days running, and the engine's
   * only way to say so is to refuse the whole week.
   */
  @IsOptional()
  @IsInt({ message: 'Dygnsvilan anges i hela minuter.' })
  @Min(60, { message: 'En dygnsvila under 60 minuter är ingen vila.' })
  @Max(1320, {
    message:
      'Dygnsvilan kan vara högst 1320 minuter (22 timmar) — längre än så går inga två arbetsdagar efter varandra.',
  })
  minDailyRestMinutes?: number | null;

  /**
   * Lärarens dag (20261123090000): the most minutes of teaching the teacher
   * has on one day, every lesson they are on counted start to end
   * (src/common/teacher-day.ts). HARD, like the rules above.
   *
   * ABSENT KEEPS WHAT THE ROW HOLDS, null clears it, a value writes it —
   * unlike the four above, which a PUT replaces. It came after them, and a
   * web from before it, open in a tab over the release, would otherwise
   * clear an administrator's cap on its next lunch save; so would a
   * teacher's own PUT of their lunch, who may not touch it at all (the
   * service refuses that, and the table's trigger again).
   *
   * 30..720 on the five-minute grid, the table's CHECK and the engine's: a
   * cap below half an hour is a day nobody teaches, one above twelve hours
   * is no cap, and a 7-minute step is one the solver's grid cannot meet.
   */
  @IsOptional()
  @IsInt({ message: 'Dagstaket anges i hela minuter.' })
  @Min(MAX_TEACHING_MINUTES_PER_DAY_MIN, {
    message: `Ett dagstak under ${MAX_TEACHING_MINUTES_PER_DAY_MIN} minuter undervisning är en dag utan lektioner — lämna fältet tomt för ingen gräns.`,
  })
  @Max(MAX_TEACHING_MINUTES_PER_DAY_MAX, {
    message: `Ett dagstak kan vara högst ${MAX_TEACHING_MINUTES_PER_DAY_MAX} minuter (12 timmar) undervisning.`,
  })
  @IsDivisibleBy(MAX_TEACHING_MINUTES_PER_DAY_STEP, {
    message: `Dagstaket måste vara ett helt antal ${MAX_TEACHING_MINUTES_PER_DAY_STEP}-minutersintervall — schemaläggaren räknar i femminuterssteg.`,
  })
  maxTeachingMinutesPerDay?: number | null;

  /**
   * The weekday the teacher would rather have free, ISO 1 (måndag) .. 7.
   * SOFT: the generator pays for a lesson on it and refuses no week over it.
   * Absent keeps, null clears, as for the cap.
   */
  @IsOptional()
  @IsInt({ message: 'Den önskade lediga dagen anges som en veckodag, 1 (måndag) till 7 (söndag).' })
  @Min(PREFERRED_FREE_DAY_MIN, {
    message: 'Den önskade lediga dagen anges som en veckodag, 1 (måndag) till 7 (söndag).',
  })
  @Max(PREFERRED_FREE_DAY_MAX, {
    message: 'Den önskade lediga dagen anges som en veckodag, 1 (måndag) till 7 (söndag).',
  })
  preferredFreeDayOfWeek?: number | null;
}

/** A query flag as a URL carries it: "true" or "false", nothing else (print.dto.ts's reading). */
const flag = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

/**
 * DELETE /teacher-work-rules/:userId's query.
 *
 * `includeDay=true` says the delete means the administrator's two fields
 * too, the cap and the wished free day, and lets a writer who plans delete
 * the row with them. Without it a DELETE takes the lunch and the rest and
 * keeps those two, from every writer: a web from before Lärarens dag knows
 * only the lunch and the rest, reads a row that holds only a cap as "Ingen
 * arbetstidsregel", and sends a bare DELETE when its form is empty — so an
 * administrator in a tab left open over the release would otherwise delete
 * a cap or a wish a colleague set since, with nothing on screen to say so,
 * as the absent-keeps rule on the PUT's two fields exists to prevent. The
 * web of this release sends it, because its form holds both fields and an
 * empty form there means they were cleared too. A teacher's DELETE ignores
 * it: the two are not theirs to remove (TeacherWorkRulesService.remove).
 */
export class RemoveTeacherWorkRuleQueryDto {
  @IsOptional()
  @Transform(flag)
  @IsBoolean({ message: "includeDay: 'true' eller 'false'." })
  includeDay?: boolean;
}
