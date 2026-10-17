import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** A skolområde as the admin names it; trimmed by the service (Sites_name_named). */
export class CreateSiteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;
}

export class UpdateSiteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;
}

/** One pair's minutes, the two sites in either order. */
export class SiteTravelTimeDto {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsUUID('all', { each: true })
  siteIds!: string[];

  @IsInt()
  @Min(0)
  @Max(240)
  minutes!: number;
}

/**
 * Every travel time the school has, as the card saves it: the pairs listed
 * are written, every other pair's figure is removed. A school with n sites
 * has n(n−1)/2 pairs; 1 225 covers 50 sites, more than any school has.
 */
export class PutSiteTravelTimesDto {
  @IsArray()
  @ArrayMaxSize(1225)
  @ValidateNested({ each: true })
  @Type(() => SiteTravelTimeDto)
  times!: SiteTravelTimeDto[];

  /**
   * The figures the card was looking at (travelBasis in sites.service.ts).
   * When the school's figures are no longer those, the save is refused
   * (SITE_TRAVEL_STALE) rather than silently undoing what someone else
   * saved meanwhile. Left out, the save is taken as it comes.
   */
  @IsOptional()
  @IsString()
  @MaxLength(100_000)
  basis?: string;
}
