import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
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
