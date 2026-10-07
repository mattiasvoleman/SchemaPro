import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MaxCodePoints } from '../../common/utils/max-code-points';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

/*
 * The rollover's request, preview and execute alike. The bounds mirror the
 * columns they end up in: a läsår's name (AcademicYears, the same 60 the year
 * form allows), a group's name, graduatingGradeLevel's CHECK 0..12. Messages
 * name the field and, where it is a list, which row of it.
 */

export const ROLLOVER_MAX_GROUPS = 500;
export const ROLLOVER_MAX_BREAKS = 200;

export class RolloverGroupChoiceDto {
  @IsUUID('4', { message: 'groups.sourceGroupId: gruppen anges med sitt id.' })
  sourceGroupId!: string;

  @IsOptional()
  @IsIn(['PROMOTE', 'CARRY', 'SKIP', 'INTAKE'], {
    message: 'groups.outcome: PROMOTE, CARRY, SKIP eller INTAKE.',
  })
  outcome?: 'PROMOTE' | 'CARRY' | 'SKIP' | 'INTAKE';

  @IsOptional()
  @IsString({ message: 'groups.name: gruppens nya namn.' })
  @Matches(/\S/, { message: 'groups.name: det nya namnet kan inte vara tomt.' })
  @MaxCodePoints(60, { message: 'groups.name: högst 60 tecken.' })
  name?: string;
}

export class RolloverBreakChoiceDto {
  @IsUUID('4', { message: 'breaks.sourceBreakId: lovet anges med sitt id.' })
  sourceBreakId!: string;

  @IsOptional()
  @IsCalendarDate({ message: 'breaks.startDate: ett datum som finns, YYYY-MM-DD.' })
  startDate?: string;

  @IsOptional()
  @IsCalendarDate({ message: 'breaks.endDate: ett datum som finns, YYYY-MM-DD.' })
  endDate?: string;
}

/** Everything but the graduating grade, which the two requests state differently. */
abstract class RolloverRequestBaseDto {
  @IsString({ message: 'name: det nya läsåret behöver ett namn.' })
  @Matches(/\S/, { message: 'name: det nya läsåret behöver ett namn.' })
  @MaxCodePoints(60, { message: 'name: högst 60 tecken.' })
  name!: string;

  @IsCalendarDate({ message: 'startDate: ett datum som finns, YYYY-MM-DD.' })
  startDate!: string;

  @IsCalendarDate({ message: 'endDate: ett datum som finns, YYYY-MM-DD.' })
  endDate!: string;

  @IsOptional()
  @IsArray({ message: 'groups: grupperna anges som en lista.' })
  @ArrayMaxSize(ROLLOVER_MAX_GROUPS, { message: `groups: högst ${ROLLOVER_MAX_GROUPS} grupper.` })
  @ValidateNested({ each: true })
  @Type(() => RolloverGroupChoiceDto)
  groups?: RolloverGroupChoiceDto[];

  @IsOptional()
  @IsBoolean({ message: 'carryTeachingGroups: true eller false.' })
  carryTeachingGroups?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'carryTeachingGroupMembers: true eller false.' })
  carryTeachingGroupMembers?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'keepTeachers: true eller false.' })
  keepTeachers?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'carryClassRules: true eller false.' })
  carryClassRules?: boolean;

  /**
   * Ta med tjänster och uppdrag (staffing Fas 5). Absent is false: a body
   * from before the field existed is the rollover it always was, hash and
   * all. The wizard sends it, true by default.
   */
  @IsOptional()
  @IsBoolean({ message: 'carryStaffing: true eller false.' })
  carryStaffing?: boolean;

  @IsOptional()
  @IsArray({ message: 'breaks: loven anges som en lista.' })
  @ArrayMaxSize(ROLLOVER_MAX_BREAKS, { message: `breaks: högst ${ROLLOVER_MAX_BREAKS} lov.` })
  @ValidateNested({ each: true })
  @Type(() => RolloverBreakChoiceDto)
  breaks?: RolloverBreakChoiceDto[];
}

const PLAN_HASH = /^[0-9a-f]{64}$/;
const PLAN_HASH_MESSAGE = 'planHash: förhandsvisningens planHash, 64 hexadecimala tecken.';
const GRADE = 'graduatingGradeLevel: årskursen som går ut, 0 till 12.';

/** The preview: G may be left to the default (newest decided timplan, else the classes). */
export class RolloverOptionsDto extends RolloverRequestBaseDto {
  @IsOptional()
  @IsInt({ message: GRADE })
  @Min(0, { message: GRADE })
  @Max(12, { message: GRADE })
  graduatingGradeLevel?: number;
}

export class ExecuteRolloverDto extends RolloverRequestBaseDto {
  /** Required here: the stored G is what activation labels graduates by. */
  @IsInt({ message: 'graduatingGradeLevel: årskursen som går ut, 0 till 12, måste anges.' })
  @Min(0, { message: GRADE })
  @Max(12, { message: GRADE })
  graduatingGradeLevel!: number;

  @IsString({ message: PLAN_HASH_MESSAGE })
  @Matches(PLAN_HASH, { message: PLAN_HASH_MESSAGE })
  planHash!: string;
}

/** The carry of tjänster into an already rolled year takes only its preview's hash back. */
export class ExecuteStaffingRolloverDto {
  @IsString({ message: PLAN_HASH_MESSAGE })
  @Matches(PLAN_HASH, { message: PLAN_HASH_MESSAGE })
  planHash!: string;
}

export class ExecuteActivationDto {
  @IsString({ message: PLAN_HASH_MESSAGE })
  @Matches(PLAN_HASH, { message: PLAN_HASH_MESSAGE })
  planHash!: string;
}
