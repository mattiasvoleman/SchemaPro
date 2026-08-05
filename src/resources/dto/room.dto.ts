import { RoomType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
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
  @IsEnum(RoomType)
  type?: RoomType;

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
  @IsEnum(RoomType)
  type?: RoomType;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
}
