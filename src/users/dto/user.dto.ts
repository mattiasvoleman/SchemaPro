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
  ValidateIf,
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

  /**
   * The person's address. Left out (or null) for a pupil or a guardian the school adds without one (Personer utan e-postadress,
   * 20270310090000): the person is in lists, attendance and the timetable and has no login until an address is added and the person
   * is invited. A teacher or an administrator needs one (400 ADDRESS_REQUIRED), and so does `sendInvitation`. An empty string is not
   * an address: it is a 400, as it was, so that a form that posts "" for an empty cell says so instead of dropping the field.
   */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

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

  // There is no `teaches` here, on purpose. An administrator who teaches is marked on a person who already has a post
  // (Users.teaches, 20270212090000: the database refuses a mark on a person with none, TE409), so a person is
  // created, given a post, and then marked with PATCH. The validation pipe forbids properties a DTO does not name,
  // so a `teaches` sent with a creation is a 400 and not a silent drop.

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

  /**
   * An address for a person who has none, or a corrected one for a person who was never invited: there is no login to move. Not
   * `null`: an address is not taken away (400). A person who was invited keeps the address their login has (409
   * ADDRESS_OF_AN_INVITED_PERSON), which is changed by the school's source of persons or by removing and adding the person again. The
   * person is then an ordinary uninvited one: the invitation is a separate act (POST :id/invite), as it is for every person.
   */
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEmail()
  @MaxLength(254)
  email?: string;

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

  /**
   * An administrator who also teaches (Users.teaches): rektor's or a full administrator's to set, and a decision as the
   * profile is. 400 with a code for a person who is no administrator (TEACHES_NEEDS_AN_ADMINISTRATOR), a teacher
   * (A_TEACHER_TEACHES_ALREADY) or a läsare (A_READER_DOES_NOT_TEACH); 409 TEACHES_NEEDS_A_POST for a person with no
   * post, which is made first (PUT .../teacher-employments). `false` takes the mark off. Leaving it out changes
   * nothing, and a value the person already has is no change and no decision. A change of role or profile that the
   * mark cannot follow clears it, and the answer is the row as stored afterwards.
   */
  @IsOptional()
  @IsBoolean()
  teaches?: boolean;
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
