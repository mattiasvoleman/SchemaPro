import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotIn,
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

/**
 * Consumer mail domains, which no school may list or pin: an address there
 * is a personal account, not one of an organisation. A personal Google
 * account carries no hd and a personal Microsoft account is no tenant's, so
 * the hook could never let one in, and listing such a domain would send
 * every address on it, other schools' guardians included, to that provider
 * at /login. The table's CHECK SchoolSignInMethods_no_personal_mail_domains
 * and the admin card (sign-in-types.ts) hold the same list; dto.spec.ts keeps
 * the three equal.
 */
export const PERSONAL_MAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'outlook.se',
  'hotmail.com',
  'hotmail.se',
  'live.com',
  'live.se',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'yahoo.se',
  'protonmail.com',
  'proton.me',
] as const;

const PERSONAL = { message: 'A personal mail domain cannot sign in with a school account.' };

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
  @IsNotIn(PERSONAL_MAIL_DOMAINS, { each: true, ...PERSONAL })
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
  @IsNotIn(PERSONAL_MAIL_DOMAINS, PERSONAL)
  googleHostedDomain?: string | null;

  /** Staff may then sign in with the school account only. */
  @IsOptional()
  @IsBoolean()
  ssoOnlyForStaff?: boolean;
}
