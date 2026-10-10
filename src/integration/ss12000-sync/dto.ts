import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Ss12000AuthKind, Ss12000TokenAuthStyle } from '@prisma/client';

/*
 * The admin API's bodies. Every bound mirrors a CHECK of migrations
 * 20261014090000–20261014110000, so a value the DTO lets through is one the
 * table takes. The URL rule itself (https, no userinfo, no query or
 * fragment) is checked by the service with vetSourceUrl, which answers a
 * code; a validation message never echoes a value.
 */

export class Ss12000SourceDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsString()
  @MaxLength(2048)
  baseUrl!: string;

  @IsEnum(Ss12000AuthKind)
  authKind!: Ss12000AuthKind;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  tokenUrl?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 256)
  clientId?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 512)
  tokenScope?: string | null;

  @IsOptional()
  @IsEnum(Ss12000TokenAuthStyle)
  tokenAuthStyle?: Ss12000TokenAuthStyle;

  /** The source's skolenhet ids this school is, chosen after "Testa anslutning". Any RFC 4122 version. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  organisationIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(2000)
  pageSize?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * Changing the organisations or the base URL's host while people or
   * classes are linked answers 409 SS12000_SOURCE_RELINK_REQUIRED unless
   * this is true; then the cursors reset and the next run is FULL.
   */
  @IsOptional()
  @IsBoolean()
  confirmRelink?: boolean;
}

export class Ss12000SecretDto {
  /** Write-only. Never echoed: not in a response, not in a validation message. */
  @IsString()
  @MaxLength(16_384)
  value!: string;
}

export class Ss12000ScheduleDto {
  @IsOptional()
  @IsBoolean()
  scheduleEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  scheduleAutoApply?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  scheduleHourLocal?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  fullEveryDays?: number;
}

export class StartRunDto {
  @IsIn(['FULL', 'INCREMENTAL'])
  mode!: 'FULL' | 'INCREMENTAL';
}

export class ApplyRunDto {
  /** The run's basisHash as the admin saw it: the diff applied is the diff reviewed. */
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  basisHash!: string;

  /** Changes to apply beyond the defaults. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20_000)
  @IsUUID('4', { each: true })
  select?: string[];

  /** Default-selected changes to leave out. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20_000)
  @IsUUID('4', { each: true })
  deselect?: string[];

  /** Required when the deactivations exceed max(5, 10 %) of the linked active people. */
  @IsOptional()
  @IsBoolean()
  confirmMassDeactivation?: boolean;
}

export class ListRunsQueryDto {
  @IsOptional()
  @Matches(/^([1-9]|[1-9]\d|100)$/)
  limit?: string;

  /** Runs started before this instant (ISO 8601), for the next page. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/)
  before?: string;
}

export const CHANGE_ENTITIES = ['PERSON', 'GROUP', 'CLASS_MEMBERSHIP', 'GROUP_MEMBERSHIP', 'RESPONSIBLE', 'DUTY_LINK', 'ORGANISATION'] as const;
export const CHANGE_OPS = ['CREATE', 'LINK', 'RELINK', 'UPDATE', 'MOVE', 'DEACTIVATE', 'REACTIVATE', 'ADD', 'END', 'CONFLICT', 'INFO'] as const;

export class ListChangesQueryDto {
  @IsOptional()
  @IsIn(CHANGE_ENTITIES)
  entity?: (typeof CHANGE_ENTITIES)[number];

  @IsOptional()
  @IsIn(CHANGE_OPS)
  op?: (typeof CHANGE_OPS)[number];

  /** "true": only rows with a conflict or info code. */
  @IsOptional()
  @IsIn(['true', 'false'])
  conflicts?: string;

  /** The last seq of the previous page. */
  @IsOptional()
  @Matches(/^\d{1,9}$/)
  cursor?: string;

  @IsOptional()
  @Matches(/^([1-9]|[1-9]\d|[1-4]\d\d|500)$/)
  limit?: string;
}
