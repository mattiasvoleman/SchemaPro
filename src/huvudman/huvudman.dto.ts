import { HuvudmanRole } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { HUVUDMAN_SCOPES } from '../integration/ss12000-v2/scopes';

export class InviteMemberDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @Matches(/\S/, { message: 'firstName must not be blank' })
  @MaxLength(100)
  firstName!: string;

  @IsString()
  @Matches(/\S/, { message: 'lastName must not be blank' })
  @MaxLength(100)
  lastName!: string;

  @IsEnum(HuvudmanRole)
  role!: HuvudmanRole;
}

export class UpdateMemberDto {
  @IsOptional()
  @IsEnum(HuvudmanRole)
  role?: HuvudmanRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class RequestSchoolDto {
  /** The school's slug, as its public addresses carry it. */
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{0,99}$/)
  slug!: string;
}

export class CreateHuvudmanKeyDto {
  @IsString()
  @Matches(/\S/, { message: 'name must not be blank' })
  @MaxLength(100)
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(HUVUDMAN_SCOPES.length)
  @IsIn([...HUVUDMAN_SCOPES], { each: true })
  scopes!: string[];
}
