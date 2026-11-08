import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { trimmed } from './trim';

/** A kind of bookable resource the school has named: Surfplattor, Minibuss, Aulan. */
export class CreateResourceTypeDto {
  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(60)
  name!: string;
}

export class UpdateResourceTypeDto {
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(60)
  name?: string;
}

/**
 * Something the school lends out that is not a room: equipment, a vehicle, a
 * space where nobody teaches. `quantity` is how many there are. The limits are
 * the table's CHECKs, repeated so the answer names the field.
 */
export class CreateResourceDto {
  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsUUID('4')
  resourceTypeId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;

  /** The skolområde it is kept on; null or omitted for none. */
  @IsOptional()
  @IsUUID('all')
  siteId?: string | null;

  /** Where it is kept, in words ("Skåp 3 i B-huset"); null or omitted for none. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  place?: string | null;

  /** A booking by staff waits for Drift's decision, as a room that requires approval. */
  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
}

export class UpdateResourceDto {
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsUUID('4')
  resourceTypeId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;

  @IsOptional()
  @IsUUID('all')
  siteId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  place?: string | null;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
}
