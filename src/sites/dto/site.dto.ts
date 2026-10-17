import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
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
 * has n(n−1)/2 pairs; 300 covers 25 sites.
 */
export class PutSiteTravelTimesDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => SiteTravelTimeDto)
  times!: SiteTravelTimeDto[];
}
