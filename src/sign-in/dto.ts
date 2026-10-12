import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { SignInProvider } from '@prisma/client';

/*
 * The admin API's body for "Logga in med skolkonto" (migration
 * 20261020090000). Every bound mirrors a CHECK of SchoolSignInMethods, so a
 * value the DTO lets through is one the table takes. Domains and the hd are
 * trimmed and lowered before they are judged: "Skola.se " is the domain the
 * admin meant, and the table and the hook only ever compare lower case.
 */

/** A host name of at least two labels with an alphabetic top label: the table's CHECK. */
export const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

const lower = (value: unknown): unknown => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class SignInMethodDto {
  @IsEnum(SignInProvider)
  provider!: SignInProvider;

  @Transform(({ value }) =>
    Array.isArray(value) ? [...new Set(value.map(lower))] : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(253, { each: true })
  @Matches(HOSTNAME, { each: true })
  domains!: string[];

  /** Entra ID's tenant (tid), for provider "azure". */
  @IsOptional()
  @Transform(({ value }) => lower(value))
  @IsUUID('all')
  entraTenantId?: string | null;

  /** The Workspace domain Google sends as hd, for provider "google". */
  @IsOptional()
  @Transform(({ value }) => lower(value))
  @IsString()
  @MaxLength(253)
  @Matches(HOSTNAME)
  googleHostedDomain?: string | null;

  /** Staff may then sign in with the school account only. */
  @IsOptional()
  @IsBoolean()
  ssoOnlyForStaff?: boolean;
}
