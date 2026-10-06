import { TeacherDutyKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmptyObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MaxCodePoints } from '../../common/utils/max-code-points';

/** HH:MM, or HH:MM:SS as PostgREST writes a time — the AvailabilityConstraints shape. */
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * The fixed weekly time an uppdrag takes — rastvakt Tuesdays 10:00-10:20, APT
 * Wednesdays 15:00-16:30 — as the solver must see it: one UNAVAILABLE TEACHER
 * AvailabilityConstraint on that weekday, written by the service in the
 * duty's own transaction. The client says WHEN, never which constraint row:
 * a constraint id in the body would be a second answer to "whose time is
 * this", and the table's trigger would refuse most of them anyway.
 *
 * Weekly only (a weekday, no date): the link trigger requires exactly that,
 * because a dated block cannot be read back as this shape.
 *
 * The shape here; the grid (whole minutes on the five-minute grid, start
 * before end) is the service's, where the message can name both ends.
 */
export class TeacherDutySlotDto {
  @IsInt({ message: 'blockedSlot.dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  @Min(1, { message: 'blockedSlot.dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  @Max(7, { message: 'blockedSlot.dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  dayOfWeek!: number;

  @Matches(TIME, { message: 'blockedSlot.startTime: anges som HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'blockedSlot.endTime: anges som HH:MM.' })
  endTime!: string;
}

/**
 * Ett uppdrag i en lärares tjänst för ett läsår: mentorskap, ämnesansvar,
 * rastvakt, APT. HR data like the post it belongs to — an admin writes it, the
 * teacher reads their own.
 *
 * The bounds mirror the table's CHECKs (migration 20261007090000) so a value
 * the database would refuse is refused here with the field named; the label's
 * /\S/ is the same non-blank rule the lokal timplan's review settled on, and
 * it counts code points as char_length does (MaxCodePoints).
 */
export class CreateTeacherDutyDto {
  @IsUUID('4', { message: 'userId: anges som lärarens id.' })
  userId!: string;

  @IsUUID('4', { message: 'academicYearId: anges som läsårets id.' })
  academicYearId!: string;

  @IsEnum(TeacherDutyKind, {
    message:
      'kind: MENTORSKAP, AMNESANSVAR, FORSTELARARE, RASTVAKT, PEDAGOGISK_LUNCH, APT_KONFERENS, VFU_HANDLEDNING, APL eller ANNAT.',
  })
  kind!: TeacherDutyKind;

  @IsString({ message: 'label: anges som text.' })
  @MinLength(1, { message: 'label: får inte vara tom.' })
  @MaxCodePoints(80, { message: 'label: högst 80 tecken.' })
  @Matches(/\S/, { message: 'label: kan inte bestå av bara mellanslag.' })
  label!: string;

  @IsInt({ message: 'minutesPerWeek: anges i hela minuter per vecka.' })
  @Min(1, { message: 'minutesPerWeek: minst 1 minut per vecka.' })
  @Max(2400, { message: 'minutesPerWeek: högst 2400 minuter (40 timmar) per vecka.' })
  minutesPerWeek!: number;

  /** Whether the minutes consume the teaching target. Default false; null refused. */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: 'countsAsTeaching: anges med true eller false.' })
  countsAsTeaching?: boolean;

  /** Ämnesansvar's subject. */
  @IsOptional()
  @IsUUID('4', { message: 'subjectId: anges som ämnets id.' })
  subjectId?: string | null;

  /** Mentorskap's class. */
  @IsOptional()
  @IsUUID('4', { message: 'studentGroupId: anges som gruppens id.' })
  studentGroupId?: string | null;

  /** A fixed weekly time to block in the timetable; null or absent: none. */
  @IsOptional()
  @IsNotEmptyObject({}, { message: 'blockedSlot: anges med dayOfWeek, startTime och endTime.' })
  @ValidateNested()
  @Type(() => TeacherDutySlotDto)
  blockedSlot?: TeacherDutySlotDto | null;

  @IsOptional()
  @IsString({ message: 'note: anges som text.' })
  @MaxCodePoints(500, { message: 'note: högst 500 tecken.' })
  note?: string | null;
}

/**
 * A PATCH of one uppdrag. Whose and which year are not in it: an uppdrag that
 * moves to another teacher is a different uppdrag, and the old one's blocked
 * time would otherwise have to change owner under the trigger that exists to
 * keep a slot its teacher's own. Delete and create instead.
 *
 * `blockedSlot`: absent leaves the time as it is; null removes it (and its
 * constraint); an object creates or moves it. `subjectId`, `studentGroupId`
 * and `note` read null the same way. The four NOT NULL fields refuse null
 * (ValidateIf on `!== undefined`, as the lokal timplan's DTOs do) rather than
 * letting @IsOptional wave it through to a Prisma error and a 500.
 */
export class UpdateTeacherDutyDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsEnum(TeacherDutyKind, {
    message:
      'kind: MENTORSKAP, AMNESANSVAR, FORSTELARARE, RASTVAKT, PEDAGOGISK_LUNCH, APT_KONFERENS, VFU_HANDLEDNING, APL eller ANNAT.',
  })
  kind?: TeacherDutyKind;

  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: 'label: anges som text.' })
  @MinLength(1, { message: 'label: får inte vara tom.' })
  @MaxCodePoints(80, { message: 'label: högst 80 tecken.' })
  @Matches(/\S/, { message: 'label: kan inte bestå av bara mellanslag.' })
  label?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: 'minutesPerWeek: anges i hela minuter per vecka.' })
  @Min(1, { message: 'minutesPerWeek: minst 1 minut per vecka.' })
  @Max(2400, { message: 'minutesPerWeek: högst 2400 minuter (40 timmar) per vecka.' })
  minutesPerWeek?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: 'countsAsTeaching: anges med true eller false.' })
  countsAsTeaching?: boolean;

  @IsOptional()
  @IsUUID('4', { message: 'subjectId: anges som ämnets id.' })
  subjectId?: string | null;

  @IsOptional()
  @IsUUID('4', { message: 'studentGroupId: anges som gruppens id.' })
  studentGroupId?: string | null;

  @IsOptional()
  @IsNotEmptyObject({}, { message: 'blockedSlot: anges med dayOfWeek, startTime och endTime.' })
  @ValidateNested()
  @Type(() => TeacherDutySlotDto)
  blockedSlot?: TeacherDutySlotDto | null;

  @IsOptional()
  @IsString({ message: 'note: anges som text.' })
  @MaxCodePoints(500, { message: 'note: högst 500 tecken.' })
  note?: string | null;
}
