import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/*
 * Krisläge's DTOs. A mark names a pupil, a group and a state; it carries no
 * free text, so nothing a person types can reach a lock screen or the
 * protocol's CSV. The one text is the note an administrator writes when they
 * end an alarm (at most 300 characters), which is read in the protocol and
 * nowhere else. forbidNonWhitelisted refuses anything sent beside these.
 */

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const CRISIS_KINDS = ['EVACUATION', 'LOCKDOWN'] as const;
export const CRISIS_MODES = ['LIVE', 'DRILL'] as const;

/** A phone sends what it holds in batches; one call carries at most this many marks. */
export const MAX_MARKS_PER_CALL = 400;
/** The profiles a school may let start an alarm: those that write Drift, and not the läsare. */
export const STARTABLE_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'] as const;

export class StartAlarmDto {
  @IsIn(CRISIS_KINDS, { message: 'kind: EVACUATION (utrymning) eller LOCKDOWN (inrymning).' })
  kind!: (typeof CRISIS_KINDS)[number];

  @IsIn(CRISIS_MODES, { message: 'mode: LIVE (skarpt larm) eller DRILL (övning).' })
  mode!: (typeof CRISIS_MODES)[number];
}

export class EndAlarmDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'note: skriv något eller lämna den ute.' })
  @MaxLength(300, { message: 'note: högst 300 tecken.' })
  note?: string;
}

export class MarkDto {
  /** The phone's own id for the mark: sending it twice stores it once. */
  @Transform(lower)
  @IsUUID('4', { message: 'id: markeringen har ett eget id.' })
  id!: string;

  /** The group, by its call. */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'callId: gruppen anges med sitt id.' })
  callId?: string;

  /**
   * Or by the lesson, for a phone that made the mark from a list it built from
   * its own schedule and has not yet been given the call's id.
   */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'lessonId: lektionen anges med sitt id.' })
  lessonId?: string;

  /**
   * Or by the alarm alone, for a teacher with no group right now who found a pupil: a found mark with no group
   * to find them with. Exactly one of callId, lessonId and alarmId.
   */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'alarmId: larmet anges med sitt id.' })
  alarmId?: string;

  @Transform(lower)
  @IsUUID('4', { message: 'studentId: eleven anges med sitt id.' })
  studentId!: string;

  /**
   * FOUND (finns), MISSING (saknas), AWAY (inte i huset: the administration's alone) or RETRACTED (ta tillbaka:
   * withdraws the sender's own found mark, a teacher's alone). The service refuses the one the sender may not send.
   */
  @IsIn(['FOUND', 'MISSING', 'AWAY', 'RETRACTED'], { message: 'state: FOUND (finns), MISSING (saknas), AWAY (inte i huset) eller RETRACTED (ta tillbaka).' })
  state!: 'FOUND' | 'MISSING' | 'AWAY' | 'RETRACTED';

  /** When the mark was made, by the sender's clock; the database holds it between the alarm's start and now. */
  @IsISO8601({ strict: true }, { message: 'at: en tidpunkt, till exempel 2027-01-12T09:14:03Z.' })
  at!: string;
}

export class MarksDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'marks: minst en markering.' })
  @ArrayMaxSize(MAX_MARKS_PER_CALL, { message: `marks: högst ${MAX_MARKS_PER_CALL} markeringar åt gången.` })
  @ValidateNested({ each: true })
  @Type(() => MarkDto)
  marks!: MarkDto[];
}

export class UpdateCrisisSettingsDto {
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.toUpperCase() : v)) : value))
  @IsArray()
  @ArrayMaxSize(STARTABLE_PROFILES.length, { message: 'startProfiles: högst de fyra profilerna.' })
  @ArrayUnique({ message: 'startProfiles: en profil bara en gång.' })
  @IsIn(STARTABLE_PROFILES, { each: true, message: 'startProfiles: FULL, REKTOR, SCHEMALAGGARE eller EXPEDITION.' })
  startProfiles!: (typeof STARTABLE_PROFILES)[number][];

  @IsBoolean({ message: 'notifyGuardiansAfter: ja eller nej.' })
  notifyGuardiansAfter!: boolean;
}

export class AlarmListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Matches(/^(LIVE|DRILL)$/, { message: 'mode: LIVE eller DRILL.' })
  mode?: 'LIVE' | 'DRILL';
}

/** A teacher's search for a pupil they found who is not on their list. */
export class PupilSearchQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'alarmId: larmet anges med sitt id.' })
  alarmId!: string;

  /** Words of the name or the class; at least two characters so that one letter does not list the school. */
  @Transform(trimmed)
  @IsString()
  @MinLength(2, { message: 'q: minst två tecken.' })
  @MaxLength(60, { message: 'q: högst 60 tecken.' })
  q!: string;
}
