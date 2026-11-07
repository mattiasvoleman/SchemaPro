import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateIf } from 'class-validator';
import type { AckRule } from '@prisma/client';
import { ACK_RULES, BODY_MAX, PAGE_MAX, PUPILS_MAX, REMIND_DAYS_MAX, REMIND_DAYS_MIN, TITLE_MAX } from '../ack';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Every field optional: a save names what changed. A null remindAfterDays is "no reminder". */
export class AckSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(REMIND_DAYS_MIN)
  @Max(REMIND_DAYS_MAX)
  remindAfterDays?: number | null;
}

/** A message about pupils, and whether one guardian is enough or each must confirm. */
export class CreateAckRequestDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, TITLE_MAX)
  title!: string;

  @Transform(trimmed)
  @IsString()
  @Length(1, BODY_MAX)
  body!: string;

  @IsIn(ACK_RULES)
  rule!: AckRule;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PUPILS_MAX)
  @IsUUID('all', { each: true })
  studentIds!: string[];
}

/** A page of the staff's list or the guardian's own: after the request with this id, at most `limit`. */
export class AckPageQueryDto {
  @IsOptional()
  @IsUUID('4')
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGE_MAX)
  limit?: number;
}
