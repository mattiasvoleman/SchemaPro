import {
  IsUUID,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from 'class-validator';

export class CreateRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  capacity?: number | null;

  @IsOptional()
  @IsOptional()
  @IsUUID('4')
  roomTypeId?: string | null;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
}

export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  capacity?: number | null;

  @IsOptional()
  @IsOptional()
  @IsUUID('4')
  roomTypeId?: string | null;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
}
