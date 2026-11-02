import { TeacherContractKind, TeacherEmploymentForm } from '@prisma/client';
import {
  IsDivisibleBy,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';
import {
  CONSECUTIVE_BREAK_MINUTES_MAX,
  CONSECUTIVE_BREAK_MINUTES_MIN,
  CONSECUTIVE_STEP,
  MAX_CONSECUTIVE_TEACHING_MINUTES_MAX,
  MAX_CONSECUTIVE_TEACHING_MINUTES_MIN,
} from '../../common/stretch';
import { MAX_TEACHING_DAYS_PER_WEEK_MAX, MAX_TEACHING_DAYS_PER_WEEK_MIN } from '../../common/teacher-day';

/**
 * En lärares tjänst för ett läsår: tjänstgöringsgrad, nedsättning, avtal.
 *
 * KEYED ON THE TEACHER AND THE YEAR, both in the URL and neither in the body.
 * There is one row per (teacher, year), so PUT /:userId?academicYearId= is the
 * whole write surface; a body that could name another person or another year
 * would be a second answer to "whose post is this".
 *
 * THE WHOLE ROW IS REPLACED, every time, but for SCB's three. What is absent
 * from the payload is the column's default — no nedsättning, ferietjänst, no
 * own target, no signature, no note — which is the same reading the table
 * gives a row created with nothing stated. A PUT that mentions only
 * employmentPercent therefore takes a nedsättning away; a form sends
 * everything it shows.
 *
 * SCB'S THREE (employmentForm, firstTeacherPercent, lecturerPercent,
 * 20261111090000) are the exception: absent KEEPS what the row holds, null
 * clears it, a value writes it. They came after the rest, and a web from
 * before them, open in a tab over the release, would otherwise clear them on
 * its next save. A new post without them has none. Deltid in days
 * (maxTeachingDaysPerWeek, 20261123090000) came later still, and is read the
 * same way for the same reason; so is the limit on teaching in a row
 * (maxConsecutiveTeachingMinutes and consecutiveBreakMinutes, 20261218090000),
 * which is sent as a pair or not at all (see the field).
 *
 * THREE DECIMALS on the two percentages, because SCB and IST report a share of
 * a post "upp till tre decimaler" and 66,667 is how a two-thirds post is
 * written. Not an integer: refusing 66,667 would force the school to lie by
 * 0,3 percentage points on every export.
 *
 * The bounds mirror the table's CHECK constraints exactly. A CHECK violation
 * leaves the gateway as a bare 500, so the DTO is where a bound names its
 * field in Swedish. The one cross-field rule — nedsättning inside tjänsten — is
 * the service's; no per-field decorator can see the other field.
 */
export class UpsertTeacherEmploymentDto {
  /** Tjänstgöringsgrad, (0, 100]. Required: a post with no percentage is no post. */
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Tjänstgöringsgraden anges i procent med högst tre decimaler.' },
  )
  @IsPositive({ message: 'En tjänstgöringsgrad på 0 % är ingen tjänst — ta bort raden i stället.' })
  @Max(100, { message: 'En tjänstgöringsgrad över 100 % är inte en tjänst.' })
  employmentPercent!: number;

  /** Nedsättning (partial leave), [0, employmentPercent]. Default 0. */
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Nedsättningen anges i procent med högst tre decimaler.' },
  )
  @Min(0, { message: 'Nedsättningen kan inte vara negativ.' })
  @Max(100, { message: 'En nedsättning över 100 % är mer än hela tjänsten.' })
  reductionPercent?: number;

  @IsOptional()
  @IsEnum(TeacherContractKind, { message: 'Avtalsformen är FERIE eller SEMESTER.' })
  contractKind?: TeacherContractKind;

  /**
   * The teacher's own riktmärke, minutes per week, overriding the policy's
   * derivation. Null: derive. 0 is legal — a post with no teaching in it
   * (a rektor's, say) has a target of nothing.
   */
  @IsOptional()
  @IsInt({ message: 'Riktmärket anges i hela minuter per vecka.' })
  @Min(0, { message: 'Riktmärket kan inte vara negativt.' })
  @Max(2400, { message: 'Ett riktmärke över 2400 minuter per vecka (40 timmar) är inte undervisning.' })
  teachingTargetMinutesPerWeek?: number | null;

  /**
   * Lärarsignatur, 1..8 characters, unique per school and year where set.
   * Not blank: a signature of spaces would pass the length check and collide
   * with nothing visibly.
   */
  @IsOptional()
  @IsString({ message: 'Signaturen anges som text.' })
  @MinLength(1, { message: 'Signaturen måste vara minst ett tecken.' })
  @MaxLength(8, { message: 'Signaturen kan vara högst åtta tecken.' })
  @Matches(/\S/, { message: 'Signaturen kan inte bestå av bara mellanslag.' })
  signature?: string | null;

  @IsOptional()
  @IsString({ message: 'Anteckningen anges som text.' })
  @MaxLength(500, { message: 'Anteckningen kan vara högst 500 tecken.' })
  note?: string | null;

  /**
   * Anställningsform, as SCB's Pedagogisk personal asks it: tillsvidare or
   * visstid. Null: not said (the SCB file names the row). Absent: as stored
   * (see the class comment).
   */
  @IsOptional()
  @IsEnum(TeacherEmploymentForm, { message: 'Anställningsformen är TILLSVIDARE eller VISSTID.' })
  employmentForm?: TeacherEmploymentForm | null;

  /**
   * How large a share of the post the förstelärare karriärtjänst takes,
   * whole per cent as SCB counts it (ForsteLarare). Null: no förstelärare.
   * Absent: as stored.
   */
  @IsOptional()
  @IsInt({ message: 'Försteläraruppdragets andel anges i hela procent.' })
  @Min(1, { message: 'Försteläraruppdragets andel är minst 1 % — lämna fältet tomt för en lärare som inte är förstelärare.' })
  @Max(100, { message: 'Försteläraruppdragets andel kan vara högst hela tjänsten.' })
  firstTeacherPercent?: number | null;

  /** The same for lektor (SCB's Lektor): null none, absent as stored. */
  @IsOptional()
  @IsInt({ message: 'Lektorsuppdragets andel anges i hela procent.' })
  @Min(1, { message: 'Lektorsuppdragets andel är minst 1 % — lämna fältet tomt för en lärare som inte är lektor.' })
  @Max(100, { message: 'Lektorsuppdragets andel kan vara högst hela tjänsten.' })
  lecturerPercent?: number | null;

  /**
   * Deltid in days (Lärarens dag, 20261123090000): the most weekdays with
   * teaching the post allows, 1..6 as the table's CHECK says. Hard where it
   * is set: the generator refuses a week that cannot keep it. HR data, like
   * the tjänst %. Null: no limit. Absent: as stored (see the class comment).
   * On the post only — a period of the post does not state it.
   */
  @IsOptional()
  @IsInt({ message: 'Undervisningsdagarna per vecka anges som ett helt antal dagar.' })
  @Min(MAX_TEACHING_DAYS_PER_WEEK_MIN, {
    message: `Undervisningsdagarna per vecka är minst ${MAX_TEACHING_DAYS_PER_WEEK_MIN} — lämna fältet tomt för ingen gräns.`,
  })
  @Max(MAX_TEACHING_DAYS_PER_WEEK_MAX, {
    message: `Undervisningsdagarna per vecka kan vara högst ${MAX_TEACHING_DAYS_PER_WEEK_MAX}.`,
  })
  maxTeachingDaysPerWeek?: number | null;

  /**
   * Sammanhängande undervisning (20261218090000): the most minutes of
   * teaching in a row (src/common/stretch.ts), on the post beside the days and
   * HR data as they are — a limit may be an arbetsanpassning after sick
   * leave. Sent together with `consecutiveBreakMinutes`, or not at all — the
   * service refuses a half pair, because no per-field decorator can see the
   * other field. SOFT in the generator (it tries, where the school has turned
   * that on), warned on a hand edit, hard in the Vikarietavla. Null on both:
   * no limit. Absent on both: as stored (see the class comment). On the post
   * only — a period of the post does not state it.
   *
   * 30..480 on the five-minute grid, the table's CHECK and the engine's:
   * under half an hour is a day nobody teaches, and over eight hours is no
   * limit.
   */
  @IsOptional()
  @IsInt({ message: 'Gränsen för undervisning i följd anges i hela minuter.' })
  @Min(MAX_CONSECUTIVE_TEACHING_MINUTES_MIN, {
    message: `Gränsen för undervisning i följd kan vara lägst ${MAX_CONSECUTIVE_TEACHING_MINUTES_MIN} minuter — lämna fältet tomt för ingen gräns.`,
  })
  @Max(MAX_CONSECUTIVE_TEACHING_MINUTES_MAX, {
    message: `Gränsen för undervisning i följd kan vara högst ${MAX_CONSECUTIVE_TEACHING_MINUTES_MAX} minuter (8 timmar).`,
  })
  @IsDivisibleBy(CONSECUTIVE_STEP, {
    message: `Gränsen för undervisning i följd måste vara ett helt antal ${CONSECUTIVE_STEP}-minutersintervall — schemaläggaren räknar i femminuterssteg.`,
  })
  maxConsecutiveTeachingMinutes?: number | null;

  /**
   * The free time that ends a stretch: a gap of at least this long between two
   * of the teacher's lessons is a break. 5..120 on the same grid. Absent keeps,
   * null clears, with `maxConsecutiveTeachingMinutes`.
   */
  @IsOptional()
  @IsInt({ message: 'Pausen som avslutar en följd anges i hela minuter.' })
  @Min(CONSECUTIVE_BREAK_MINUTES_MIN, {
    message: `Pausen som avslutar en följd kan vara lägst ${CONSECUTIVE_BREAK_MINUTES_MIN} minuter — lämna fältet tomt för ingen gräns.`,
  })
  @Max(CONSECUTIVE_BREAK_MINUTES_MAX, {
    message: `Pausen som avslutar en följd kan vara högst ${CONSECUTIVE_BREAK_MINUTES_MAX} minuter (2 timmar).`,
  })
  @IsDivisibleBy(CONSECUTIVE_STEP, {
    message: `Pausen måste vara ett helt antal ${CONSECUTIVE_STEP}-minutersintervall — schemaläggaren räknar i femminuterssteg.`,
  })
  consecutiveBreakMinutes?: number | null;
}

/**
 * En period av tjänsten: tjänstgöringsgrad, nedsättning and own riktmärke
 * from a date (migration 20261022120000). "80 % från 1 november."
 *
 * ON THE POST, NEVER ACROSS POSTS. A new period names its teacher and year in
 * the URL, as the post does; an existing one is addressed by its id and never
 * moves to another post or year, so neither is in the body.
 *
 * THE WHOLE PERIOD IS REPLACED, as the post is: what is absent is the
 * column's default — no nedsättning, the derived riktmärke, open to the end of
 * the year. A period states all three figures for its dates, not the ones it
 * changes, so the period does not depend on what the post says when it is read.
 *
 * The bounds are the post's own, mirrored by the table's CHECKs. Från is
 * required: a period without a start is the post itself, which the post's
 * own PUT writes. That the dates lie inside the läsår, hold at least one
 * whole week and overlap no other period of the post is the service's: each
 * needs another row.
 */
export class UpsertTeacherEmploymentPeriodDto {
  /** Från, YYYY-MM-DD, inclusive. */
  @IsCalendarDate({ message: 'validFrom: anges som ett datum som finns, ÅÅÅÅ-MM-DD.' })
  validFrom!: string;

  /** Till, YYYY-MM-DD, inclusive; null or absent: the läsår's last day. */
  @IsOptional()
  @IsCalendarDate({ message: 'validTo: anges som ett datum som finns, ÅÅÅÅ-MM-DD.' })
  validTo?: string | null;

  /** Tjänstgöringsgrad for the period, (0, 100]. Required, as on the post. */
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Tjänstgöringsgraden anges i procent med högst tre decimaler.' },
  )
  @IsPositive({ message: 'En tjänstgöringsgrad på 0 % är ingen tjänst — ta bort perioden eller tjänsten i stället.' })
  @Max(100, { message: 'En tjänstgöringsgrad över 100 % är inte en tjänst.' })
  employmentPercent!: number;

  /** Nedsättning for the period, [0, employmentPercent]. Default 0. */
  @ValidateIf((_, value) => value !== undefined)
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Nedsättningen anges i procent med högst tre decimaler.' },
  )
  @Min(0, { message: 'Nedsättningen kan inte vara negativ.' })
  @Max(100, { message: 'En nedsättning över 100 % är mer än hela tjänsten.' })
  reductionPercent?: number;

  /** Own riktmärke for the period, 0..2400; null or absent: derived. */
  @IsOptional()
  @IsInt({ message: 'Riktmärket anges i hela minuter per vecka.' })
  @Min(0, { message: 'Riktmärket kan inte vara negativt.' })
  @Max(2400, { message: 'Ett riktmärke över 2400 minuter per vecka (40 timmar) är inte undervisning.' })
  teachingTargetMinutesPerWeek?: number | null;
}
