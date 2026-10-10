import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { GATE_POLICY_KEYS } from '../publication-gates';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

/**
 * What POST /publications/preview and POST /publications take. The range is
 * the publication's validity (giltig fr.o.m./t.o.m.), clamped to the läsår.
 * DIRECT: omitted dates mean what the old route's mean — from today to the
 * year's end — so the two publish the same window. DRAFT never publishes a
 * day that has begun (20261011100000).
 */
export class PublicationRangeDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'validFrom: YYYY-MM-DD.' })
  validFrom?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'validTo: YYYY-MM-DD.' })
  validTo?: string;
}

export class PublishTimetableDto extends PublicationRangeDto {
  /** "Publicera ändå": the admin has read the warnings. */
  @IsOptional()
  @IsBoolean()
  acknowledgeWarnings?: boolean;

  /**
   * The preview's digest. When given and the grundschema or the publications
   * have changed since, the publish answers 409 PUBLISH_STALE instead of
   * publishing something the admin did not preview.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'expectedDigest: förhandsgranskningens kontrollsumma.' })
  expectedDigest?: string;
}

export class PublicationListQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}

const GATE_MODES = ['WARN', 'REFUSE'] as const;

/**
 * The school's publish policy, PUT whole or in part: a field left out keeps
 * its value (its default when the school has no row). Every gate is WARN or
 * REFUSE, mirroring the enum the columns are.
 */
export class UpsertPublicationSettingsDto {
  @IsOptional() @IsIn(GATE_MODES) gateClashes?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateParked?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateUnplaced?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateUnstaffed?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateMissingTeacher?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateMissingRoom?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateStaffing?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateTimplan?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateOverlap?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gatePast?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateLunch?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateWeekSplit?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateGap?: 'WARN' | 'REFUSE';
  @IsOptional() @IsIn(GATE_MODES) gateDayOpsLost?: 'WARN' | 'REFUSE';

  // The public viewer (20261011120000). Off by default, every one.
  @IsOptional() @IsBoolean() publicViewerEnabled?: boolean;
  @IsOptional() @IsBoolean() publicGroups?: boolean;
  @IsOptional() @IsBoolean() publicTeachers?: boolean;
  @IsOptional() @IsBoolean() publicRooms?: boolean;
  @IsOptional() @IsIn(['NONE', 'SIGNATURE', 'NAME']) publicTeacherDisplay?: 'NONE' | 'SIGNATURE' | 'NAME';
  @IsOptional() @IsBoolean() publicShowMeals?: boolean;
  @IsOptional() @IsInt() @Min(3) @Max(30) publicMinGroupSize?: number;
}

/** Compile-time: the DTO names exactly the policy's columns. */
type GateKeysOfDto = keyof UpsertPublicationSettingsDto & (typeof GATE_POLICY_KEYS)[number];
const _everyGateHasAField: Record<(typeof GATE_POLICY_KEYS)[number], GateKeysOfDto> = {
  gateClashes: 'gateClashes',
  gateParked: 'gateParked',
  gateUnplaced: 'gateUnplaced',
  gateUnstaffed: 'gateUnstaffed',
  gateMissingTeacher: 'gateMissingTeacher',
  gateMissingRoom: 'gateMissingRoom',
  gateStaffing: 'gateStaffing',
  gateTimplan: 'gateTimplan',
  gateOverlap: 'gateOverlap',
  gatePast: 'gatePast',
  gateLunch: 'gateLunch',
  gateWeekSplit: 'gateWeekSplit',
  gateGap: 'gateGap',
  gateDayOpsLost: 'gateDayOpsLost',
};
void _everyGateHasAField;

/** POST /publication-settings/mode: the switch records a BASELINE (DraftService). */
export class SwitchPublishModeDto {
  @IsIn(['DIRECT', 'DRAFT'], { message: "publishMode: 'DIRECT' eller 'DRAFT'." })
  publishMode!: 'DIRECT' | 'DRAFT';
}

/** POST /publications/refill: a DRAFT school fills the calendar from what is published. */
export class RefillPublicationDto extends PublicationRangeDto {
  @IsOptional()
  @IsBoolean()
  acknowledgeWarnings?: boolean;
}

/** POST /publications/discard. */
export class DiscardDraftDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}

/** POST /public-links: a share link. A TEACHER link names its teacher and takes no free text. */
export class CreatePublicLinkDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  @IsIn(['GROUP', 'TEACHER', 'ROOM'], { message: "kind: 'GROUP', 'TEACHER' eller 'ROOM'." })
  kind!: 'GROUP' | 'TEACHER' | 'ROOM';

  /** The class or group, the teacher or the room; absent = an index (GROUP and ROOM only). */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'targetId: anges med sitt id.' })
  targetId?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1)
  @MaxLength(80)
  label?: string;
}

export class TeacherPublicLabelDto {
  @IsBoolean()
  hidden!: boolean;
}
