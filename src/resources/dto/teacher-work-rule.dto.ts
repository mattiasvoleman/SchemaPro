import { IsDivisibleBy, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

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
}
