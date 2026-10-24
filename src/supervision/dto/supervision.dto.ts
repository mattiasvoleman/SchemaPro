import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { MaxCodePoints } from '../../common/utils/max-code-points';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

/** HH:MM, or HH:MM:SS as PostgREST writes a time. Seconds are refused by the service. */
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * Ett rastvaktsområde, as the admin writes it (migration 20261207090000). The
 * bounds mirror the table's CHECKs, so a value the database would refuse is
 * refused here with the field named; the name is trimmed by the service
 * (SupervisionAreas_name_named), and a span is both ends or neither, which
 * only the service can say of a PATCH carrying one end.
 */
export class CreateSupervisionAreaDto {
  @IsString({ message: 'name: anges som text.' })
  @MinLength(1, { message: 'name: området behöver ett namn.' })
  @MaxCodePoints(60, { message: 'name: högst 60 tecken.' })
  name!: string;

  /** The skolområde it is on; null or absent: not said. */
  @IsOptional()
  @IsUUID('4', { message: 'siteId: anges som skolområdets id.' })
  siteId?: string | null;

  /** Inclusive 0..12, with maxGradeLevel; both null or absent: every stage. */
  @IsOptional()
  @IsInt({ message: 'minGradeLevel: anges som årskurs 0 till 12.' })
  @Min(0, { message: 'minGradeLevel: anges som årskurs 0 till 12.' })
  @Max(12, { message: 'minGradeLevel: anges som årskurs 0 till 12.' })
  minGradeLevel?: number | null;

  @IsOptional()
  @IsInt({ message: 'maxGradeLevel: anges som årskurs 0 till 12.' })
  @Min(0, { message: 'maxGradeLevel: anges som årskurs 0 till 12.' })
  @Max(12, { message: 'maxGradeLevel: anges som årskurs 0 till 12.' })
  maxGradeLevel?: number | null;

  /** Default true; null refused. */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: 'duringRasts: anges med true eller false.' })
  duringRasts?: boolean;

  /** Default false; null refused. */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: 'duringLunch: anges med true eller false.' })
  duringLunch?: boolean;

  /** 0..10, default 1. */
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: 'guardsNeeded: anges som ett antal rastvakter, 0 till 10.' })
  @Min(0, { message: 'guardsNeeded: anges som ett antal rastvakter, 0 till 10.' })
  @Max(10, { message: 'guardsNeeded: anges som ett antal rastvakter, 0 till 10.' })
  guardsNeeded?: number;

  /** Default false; null refused. */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: 'countsAsTeaching: anges med true eller false.' })
  countsAsTeaching?: boolean;
}

/**
 * A PATCH: every field optional, the same bounds. A field the table holds
 * NOT NULL is refused as null (ValidateIf, not IsOptional, which would let
 * null through to the service): a PATCH that names a field says what it is.
 */
export class UpdateSupervisionAreaDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: 'name: anges som text.' })
  @MinLength(1, { message: 'name: området behöver ett namn.' })
  @MaxCodePoints(60, { message: 'name: högst 60 tecken.' })
  name?: string;

  @IsOptional()
  @IsUUID('4', { message: 'siteId: anges som skolområdets id.' })
  siteId?: string | null;

  @IsOptional()
  @IsInt({ message: 'minGradeLevel: anges som årskurs 0 till 12.' })
  @Min(0, { message: 'minGradeLevel: anges som årskurs 0 till 12.' })
  @Max(12, { message: 'minGradeLevel: anges som årskurs 0 till 12.' })
  minGradeLevel?: number | null;

  @IsOptional()
  @IsInt({ message: 'maxGradeLevel: anges som årskurs 0 till 12.' })
  @Min(0, { message: 'maxGradeLevel: anges som årskurs 0 till 12.' })
  @Max(12, { message: 'maxGradeLevel: anges som årskurs 0 till 12.' })
  maxGradeLevel?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: 'duringRasts: anges med true eller false.' })
  duringRasts?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: 'duringLunch: anges med true eller false.' })
  duringLunch?: boolean;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: 'guardsNeeded: anges som ett antal rastvakter, 0 till 10.' })
  @Min(0, { message: 'guardsNeeded: anges som ett antal rastvakter, 0 till 10.' })
  @Max(10, { message: 'guardsNeeded: anges som ett antal rastvakter, 0 till 10.' })
  guardsNeeded?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: 'countsAsTeaching: anges med true eller false.' })
  countsAsTeaching?: boolean;
}

/**
 * Ett rastvaktspass: a teacher on an area, a weekday, a time, between two
 * dates of a läsår. The time is the pass's own (the migration says why it
 * names no rast). Whole minutes, start before end, the dates inside the
 * läsår and one place at a time are the service's, where the message can
 * name both passes.
 */
export class CreateSupervisionShiftDto {
  @IsUUID('4', { message: 'academicYearId: anges som läsårets id.' })
  academicYearId!: string;

  @IsUUID('4', { message: 'areaId: anges som rastvaktsområdets id.' })
  areaId!: string;

  @IsUUID('4', { message: 'userId: anges som lärarens id.' })
  userId!: string;

  @IsInt({ message: 'dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  @Min(1, { message: 'dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  @Max(7, { message: 'dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime: anges som HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime: anges som HH:MM.' })
  endTime!: string;

  /** Från, YYYY-MM-DD, inclusive; null or absent: the läsår's first day. */
  @IsOptional()
  @IsCalendarDate({ message: 'validFrom: anges som ett datum som finns, ÅÅÅÅ-MM-DD.' })
  validFrom?: string | null;

  /** Till, YYYY-MM-DD, inclusive; null or absent: the läsår's last day. */
  @IsOptional()
  @IsCalendarDate({ message: 'validTo: anges som ett datum som finns, ÅÅÅÅ-MM-DD.' })
  validTo?: string | null;

  @IsOptional()
  @IsString({ message: 'note: anges som text.' })
  @MaxLength(400, { message: 'note: högst 200 tecken.' })
  @MaxCodePoints(200, { message: 'note: högst 200 tecken.' })
  note?: string | null;
}

/**
 * A PATCH: the year is the pass's for good; everything else may move. Null is
 * refused where the table holds NOT NULL, as on the areas' PATCH.
 */
export class UpdateSupervisionShiftDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsUUID('4', { message: 'areaId: anges som rastvaktsområdets id.' })
  areaId?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsUUID('4', { message: 'userId: anges som lärarens id.' })
  userId?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: 'dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  @Min(1, { message: 'dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  @Max(7, { message: 'dayOfWeek: anges som veckodag 1 (måndag) till 7 (söndag).' })
  dayOfWeek?: number;

  @ValidateIf((_, value) => value !== undefined)
  @Matches(TIME, { message: 'startTime: anges som HH:MM.' })
  startTime?: string;

  @ValidateIf((_, value) => value !== undefined)
  @Matches(TIME, { message: 'endTime: anges som HH:MM.' })
  endTime?: string;

  @IsOptional()
  @IsCalendarDate({ message: 'validFrom: anges som ett datum som finns, ÅÅÅÅ-MM-DD.' })
  validFrom?: string | null;

  @IsOptional()
  @IsCalendarDate({ message: 'validTo: anges som ett datum som finns, ÅÅÅÅ-MM-DD.' })
  validTo?: string | null;

  @IsOptional()
  @IsString({ message: 'note: anges som text.' })
  @MaxLength(400, { message: 'note: högst 200 tecken.' })
  @MaxCodePoints(200, { message: 'note: högst 200 tecken.' })
  note?: string | null;
}

/** GET /supervision-rota?academicYearId= */
export class SupervisionRotaQueryDto {
  @IsUUID('4', { message: 'academicYearId: anges som läsårets id.' })
  academicYearId!: string;
}
