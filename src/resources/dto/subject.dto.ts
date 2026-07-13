import {
  IsHexColor,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const ROOM_TYPES = [
  'CLASSROOM',
  'LABORATORY',
  'GYMNASIUM',
  'AUDITORIUM',
  'WORKSHOP',
  'OTHER',
] as const;
type RoomTypeValue = (typeof ROOM_TYPES)[number];

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
  @ValidateIf((dto: CreateSubjectDto) => dto.requiredRoomType !== null)
  @IsOptional()
  @IsIn(ROOM_TYPES)
  requiredRoomType?: RoomTypeValue | null;
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

  @ValidateIf((dto: UpdateSubjectDto) => dto.requiredRoomType !== null)
  @IsOptional()
  @IsIn(ROOM_TYPES)
  requiredRoomType?: RoomTypeValue | null;
}
