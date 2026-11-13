import { AdminProfile, UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { BulkIdsDto, lowerCaseId } from '../../common/bulk';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

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

  /**
   * Sista arbetsdag (20270210090000): the person's last working day, the school's date as ÅÅÅÅ-MM-DD, when a
   * person is deactivated (`isActive: false`) or, alone, for a person who is inactive already. Their time counts
   * through the end of that day (Analys och planering's löneunderlag and Frånvarostatistik read it), where
   * without it it counts to the moment of the click; the click is still what gallring counts from. Not a day
   * ahead (a person who leaves tomorrow is deactivated tomorrow), not before the person was last made active
   * again or before the person was added to Rastra, and refused for a person who stays or becomes active. A person
   * made active again carries no date. `null` is no day, the same as leaving the field out.
   */
  @IsOptional()
  @IsCalendarDate({ message: 'leftOn: ett riktigt datum som ÅÅÅÅ-MM-DD.' })
  leftOn?: string | null;

  /** See CreateUserDto.adminProfile. A change is a decision. */
  @IsOptional()
  @IsEnum(AdminProfile)
  adminProfile?: AdminProfile;

  /** See CreateUserDto.hrRead. A change is a decision. */
  @IsOptional()
  @IsBoolean()
  hrRead?: boolean;
}

/**
 * Massåtgärder: what may be set on many pupils at once, each field only when
 * sent: the home class (null: no class) and the status. Validated as
 * UpdateUserDto validates them.
 */
export class BulkStudentChangesDto {
  @lowerCaseId
  @IsOptional()
  @IsUUID('4')
  studentGroupId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Many pupils, and the fields to set on every one of them (src/common/bulk.ts). */
export class BulkUpdateStudentsDto extends BulkIdsDto {
  @IsObject()
  @ValidateNested()
  @Type(() => BulkStudentChangesDto)
  changes!: BulkStudentChangesDto;
}
