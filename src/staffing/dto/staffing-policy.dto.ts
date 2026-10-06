import { StaffingCheckMode, StaffingLoadModel, UnstaffedGenerationMode } from '@prisma/client';
import { IsEnum, IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from 'class-validator';

/**
 * Tjänstefördelningens inställningar: one row per school, PUT replaces it.
 *
 * EVERY FIELD IS OPTIONAL AND ABSENT MEANS THE TABLE'S DEFAULT, not "leave it".
 * The row is replaced whole on every PUT, like the lunch settings, so a form
 * that sends only what it shows cannot half-write a policy; and the defaults
 * are the Bilaga M frame (1 767 h, 1 360 h reglerad, 194 A-dagar, 40 h) with
 * both checks on WARN — the same values the migration writes for a row created
 * with nothing stated, so a PUT of `{}` and a row nobody has edited read alike.
 *
 * The one field with NO default is the riktmärke, fullTimeTeachingMinutesPerWeek.
 * The central agreement fixes no weekly teaching measure and kommuner differ
 * (Vimmerby 1 080, national median 1 090), so absent and null both mean "the
 * school has not chosen one" and every teacher reads NO_TARGET. The form
 * suggests 1 080 and cites its source; this class supplies nothing.
 *
 * The bounds mirror the table's CHECK constraints exactly. A CHECK violation
 * leaves the gateway as a bare 500 (rethrowPrismaError maps no code for it), so
 * the DTO is where a bound becomes a sentence that names the field. The one
 * cross-field rule — reglerad arbetstid inside the annual hours — is the
 * service's, because no per-field decorator can see the other field.
 */
export class UpsertStaffingPolicyDto {
  /** Riktmärke undervisning för heltid, minuter per vecka. Null: no comparison. */
  @IsOptional()
  @IsInt({ message: 'Riktmärket anges i hela minuter per vecka.' })
  @Min(1, { message: 'Riktmärket måste vara minst 1 minut per vecka — lämna det tomt för ingen jämförelse.' })
  @Max(2400, { message: 'Ett riktmärke över 2400 minuter per vecka (40 timmar) är inte undervisning.' })
  fullTimeTeachingMinutesPerWeek?: number | null;

  /** Reglerad arbetstid för en heltid, Bilaga M 6 b. Default 1360. */
  @IsOptional()
  @IsInt({ message: 'Den reglerade arbetstiden anges i hela timmar per år.' })
  @Min(1, { message: 'Den reglerade arbetstiden måste vara minst 1 timme.' })
  @Max(2500, { message: 'Den reglerade arbetstiden kan inte överstiga 2500 timmar — den ryms inte i årsarbetstiden.' })
  fullTimeRegulatedHoursPerYear?: number;

  /** Hela årsarbetstiden för en heltids ferietjänst. Default 1767. */
  @IsOptional()
  @IsInt({ message: 'Årsarbetstiden anges i hela timmar.' })
  @Min(1, { message: 'Årsarbetstiden måste vara minst 1 timme.' })
  @Max(2500, { message: 'En årsarbetstid över 2500 timmar är inte en tjänst.' })
  fullTimeAnnualHours?: number;

  /** A-dagar. Default 194. */
  @IsOptional()
  @IsInt({ message: 'Antalet A-dagar anges i hela dagar.' })
  @Min(1, { message: 'Ett läsår har minst en A-dag.' })
  @Max(260, { message: 'Fler än 260 A-dagar ryms inte på ett år av arbetsdagar.' })
  workDaysPerYear?: number;

  /** Veckoarbetstid för en semestertjänst, en decimal. Default 40.0. */
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 1 },
    { message: 'Semestertjänstens veckoarbetstid anges i timmar med högst en decimal.' },
  )
  @IsPositive({ message: 'Semestertjänstens veckoarbetstid måste vara över 0 timmar.' })
  @Max(60, { message: 'En veckoarbetstid över 60 timmar är inte en semestertjänst.' })
  semesterHoursPerWeek?: number;

  @IsOptional()
  @IsEnum(StaffingCheckMode, {
    message: 'Behörighetskontrollen är OFF, WARN eller REFUSE.',
  })
  qualificationMode?: StaffingCheckMode;

  @IsOptional()
  @IsEnum(StaffingCheckMode, {
    message: 'Överbeläggningskontrollen är OFF, WARN eller REFUSE.',
  })
  overAllocationMode?: StaffingCheckMode;

  /** How far over target a teacher may be before the mode fires. Default 10. */
  @IsOptional()
  @IsInt({ message: 'Toleransen anges i hela procent.' })
  @Min(0, { message: 'Toleransen kan inte vara negativ.' })
  @Max(50, { message: 'En tolerans över 50 % gör riktmärket meningslöst.' })
  overAllocationTolerancePercent?: number;

  @IsOptional()
  @IsEnum(StaffingLoadModel, {
    message: 'Beräkningsmodellen är MINUTES eller FACTOR.',
  })
  loadModel?: StaffingLoadModel;

  /**
   * Whether a schema may be generated while a timplanspost has no teacher.
   * Default ALLOW, today's behaviour. Two values, not the check modes' three:
   * a generation either starts or it does not, and WARN has nothing to warn
   * on that the generate page does not already say.
   */
  @IsOptional()
  @IsEnum(UnstaffedGenerationMode, {
    message: 'Generering utan lärare är ALLOW eller REFUSE.',
  })
  unstaffedGeneration?: UnstaffedGenerationMode;
}
