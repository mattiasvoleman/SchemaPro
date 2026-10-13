import { AdminProfile, UserRole } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
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

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsUUID('4')
  studentGroupId?: string | null;

  /**
   * An administrator's profile (Roller i skolan). Only with role
   * SCHOOL_ADMIN; FULL when left out, which is what an administrator was
   * before profiles. Creating an administrator is rektor's or a full
   * administrator's decision.
   */
  @IsOptional()
  @IsEnum(AdminProfile)
  adminProfile?: AdminProfile;

  /** HR-läs for a SCHEMALAGGARE or an EXPEDITION: tjänst % and nedsättning. */
  @IsOptional()
  @IsBoolean()
  hrRead?: boolean;

  /**
   * Send the invitation email as part of creating this person.
   *
   * Defaults to false: a school builds its roster long before term starts, and
   * adding someone to the catalog should not put mail in their inbox. Invite
   * them later via POST /api/v1/users/:id/invite.
   */
  @IsOptional()
  @IsBoolean()
  sendInvitation?: boolean;
}

export class InviteUsersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  userIds!: string[];
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

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsUUID('4')
  studentGroupId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** See CreateUserDto.adminProfile. A change is a decision. */
  @IsOptional()
  @IsEnum(AdminProfile)
  adminProfile?: AdminProfile;

  /** See CreateUserDto.hrRead. A change is a decision. */
  @IsOptional()
  @IsBoolean()
  hrRead?: boolean;
}
