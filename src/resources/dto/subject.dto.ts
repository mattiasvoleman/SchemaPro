import {
  IsHexColor,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreateSubjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsHexColor()
  color?: string | null;

  /** When set, the optimizer only places this subject in rooms of this type. */
  @ValidateIf((dto) => dto.requiredRoomTypeId !== null)
  @IsOptional()
  @IsUUID('4')
  requiredRoomTypeId?: string | null;
}

export class UpdateSubjectDto {
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
  @IsHexColor()
  color?: string | null;

  @ValidateIf((dto) => dto.requiredRoomTypeId !== null)
  @IsOptional()
  @IsUUID('4')
  requiredRoomTypeId?: string | null;
}
