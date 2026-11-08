import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator';
import { ASK_MAX, DESCRIPTION_MAX, ENTRY_NOTE_MAX, GIVEN_BY_MAX, LIST_BODY_MAX, PROOF_NOTE_MAX, REASON_MAX, TICK_MAX, TITLE_MAX } from '../checklists';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** An empty string is no text: it is left out. */
const blankToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === '' ? undefined : text;
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateTemplateDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, TITLE_MAX)
  title!: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @Length(1, DESCRIPTION_MAX)
  description?: string;

  @IsOptional()
  @IsUUID('all')
  subjectId?: string;
}

/** Every field optional: a save names what changed. A null subjectId or description clears it. */
export class UpdateTemplateDto {
  // Left out is "no change"; a null is not a title, and not a switch (ValidateIf, not IsOptional, which would let it by).
  @ValidateIf((_, value) => value !== undefined)
  @Transform(trimmed)
  @IsString()
  @Length(1, TITLE_MAX)
  title?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Transform(blankToUndefined)
  @IsString()
  @Length(1, DESCRIPTION_MAX)
  description?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('all')
  subjectId?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  active?: boolean;
}

export class TemplatesQueryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  includeRetired?: boolean;
}

export class RosterQueryDto {
  @IsUUID('all')
  groupId!: string;
}

/** The pupils ticked for one instruction, one day, by one person. */
export class TickProofsDto {
  @IsUUID('all')
  templateId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TICK_MAX)
  @IsUUID('all', { each: true })
  studentIds!: string[];

  /** The day the instruction was given; today when left out. */
  @IsOptional()
  @Matches(DAY)
  instructedOn?: string;

  /** Who gave it; the writer when left out. */
  @IsOptional()
  @IsUUID('all')
  instructorId?: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @Length(1, PROOF_NOTE_MAX)
  note?: string;
}

export class VoidProofDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, REASON_MAX)
  reason!: string;
}

export class CreateConsentListDto {
  @IsUUID('all')
  classId!: string;

  @Transform(trimmed)
  @IsString()
  @Length(1, TITLE_MAX)
  title!: string;

  /** What the guardians are asked to consent to, in the words they will see. */
  @Transform(trimmed)
  @IsString()
  @Length(1, LIST_BODY_MAX)
  body!: string;
}

export class ConsentListsQueryDto {
  @IsOptional()
  @IsUUID('all')
  classId?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  includeClosed?: boolean;
}

export const CONSENT_ENTRY_KINDS = ['GRANTED', 'DECLINED', 'WITHDRAWN'] as const;

/** An answer written down for one or more pupils on a list. */
export class RecordConsentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TICK_MAX)
  @IsUUID('all', { each: true })
  studentIds!: string[];

  @IsIn(CONSENT_ENTRY_KINDS)
  kind!: (typeof CONSENT_ENTRY_KINDS)[number];

  /** The day on the paper (or of the call); today when left out. */
  @IsOptional()
  @Matches(DAY)
  givenOn?: string;

  /** Who gave it, in the writer's words. */
  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @Length(1, GIVEN_BY_MAX)
  givenBy?: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsString()
  @Length(1, ENTRY_NOTE_MAX)
  note?: string;
}

/** Ask the guardians through Kvittens. Left out: every pupil of the list with no answer. */
export class AskConsentDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(ASK_MAX)
  @IsUUID('all', { each: true })
  studentIds?: string[];
}

