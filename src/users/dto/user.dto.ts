import { UserRole } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class CreateUserDto {
  @IsEnum(UserRole)
  role!: UserRole;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  lastName!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ValidateIf((dto: CreateUserDto) => dto.phone !== null)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @ValidateIf((dto: CreateUserDto) => dto.studentGroupId !== null)
  @IsOptional()
  @IsUUID('4')
  studentGroupId?: string | null;
}

export class UpdateUserDto {
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  firstName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  lastName?: string;

  @ValidateIf((dto: UpdateUserDto) => dto.phone !== null)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @ValidateIf((dto: UpdateUserDto) => dto.studentGroupId !== null)
  @IsOptional()
  @IsUUID('4')
  studentGroupId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
