import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** A member of staff reserves some of a resource for a datetime range. */
export class CreateResourceBookingDto {
  @IsUUID('4')
  resourceId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  /** How many it holds, 1..1000; at most the resource's quantity (the database counts). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity?: number;

  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;
}

/** Drift approves or rejects a booking of a resource that requires approval. */
export class DecideResourceBookingDto {
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
