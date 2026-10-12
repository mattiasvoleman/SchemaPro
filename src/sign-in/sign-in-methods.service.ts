import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type SchoolSignInMethod, type SignInProvider } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { SchoolAccountSession } from '../auth/school-account';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { HOSTNAME, type SignInMethodDto } from './dto';

/** The row as the admin card shows it. */
export interface SignInMethodView {
  provider: SignInProvider;
  domains: string[];
  entraTenantId: string | null;
  googleHostedDomain: string | null;
  ssoOnlyForStaff: boolean;
  updatedAt: Date;
}

/** What GET answers: the school's row, and how the asking admin signed in. */
export interface SignInSettings {
  method: SignInMethodView | null;
  /** The school account this admin's session signed in with, or null. */
  session: { schoolAccount: SchoolAccountSession | null };
}

function viewOf(row: SchoolSignInMethod): SignInMethodView {
  return {
    provider: row.provider,
    domains: row.domains,
    entraTenantId: row.entraTenantId,
    googleHostedDomain: row.googleHostedDomain,
    ssoOnlyForStaff: row.ssoOnlyForStaff,
    updatedAt: row.updatedAt,
  };
}

/** Whether a session's school account is one this row would let sign in. */
export function accountFits(
  account: SchoolAccountSession | undefined,
  method: { provider: SignInProvider; entraTenantId: string | null; googleHostedDomain: string | null },
): boolean {
  if (!account || account.provider !== method.provider) return false;
  return method.provider === 'azure'
    ? account.entraTenantId !== undefined && account.entraTenantId === method.entraTenantId
    : account.googleHostedDomain !== undefined && account.googleHostedDomain === method.googleHostedDomain;
}

/**
 * "Logga in med skolkonto" for one school (migration 20261020090000): the
 * admin's row, and /login's lookup.
 *
 * Who may sign in is not decided here. The access-token hook
 * (app.custom_access_token_hook) reads the row Supabase Auth asks about at
 * every sign-in and refresh; this service only writes it, under the admin's
 * own RLS arms.
 *
 * One refusal is the service's own: "Kräv skolkonto för personal" is turned
 * on, or kept on while the provider or its pin changes, only from a session
 * that signed in with a school account this very row would let through. A
 * wrong tenant id with the switch on would refuse every member of staff at
 * their next refresh, the admin saving it included, and the only way back
 * would be an operator. Signing in with it first proves the provider, the
 * pin and the admin's own account work together before anyone depends on it.
 */
@Injectable()
export class SignInMethodsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(user: AuthenticatedUser): Promise<SignInSettings> {
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.withRls(user, (tx) =>
      tx.schoolSignInMethod.findUnique({ where: { schoolId } }),
    );
    return { method: row ? viewOf(row) : null, session: { schoolAccount: user.schoolAccount ?? null } };
  }

  async put(user: AuthenticatedUser, dto: SignInMethodDto): Promise<SignInSettings> {
    const schoolId = requireSchoolId(user);
    const entraTenantId = dto.provider === 'azure' ? (dto.entraTenantId ?? null) : null;
    const googleHostedDomain = dto.provider === 'google' ? (dto.googleHostedDomain ?? null) : null;
    if (dto.provider === 'azure' && entraTenantId === null) {
      throw new BadRequestException({
        message: 'Entra ID behöver organisationens klient-id (tenant id).',
        code: 'SIGN_IN_TENANT_REQUIRED',
      });
    }
    if (dto.provider === 'google' && googleHostedDomain === null) {
      throw new BadRequestException({
        message: 'Google Workspace behöver organisationens domän (hd).',
        code: 'SIGN_IN_HOSTED_DOMAIN_REQUIRED',
      });
    }
    const config = {
      provider: dto.provider,
      domains: dto.domains,
      entraTenantId,
      googleHostedDomain,
      ssoOnlyForStaff: dto.ssoOnlyForStaff ?? false,
    };
    if (config.ssoOnlyForStaff && !accountFits(user.schoolAccount, config)) {
      throw new ConflictException({
        message:
          'Logga in med ett skolkonto från den här organisationen innan du kräver skolkonto för personalen, så att ingen låses ute.',
        code: 'SIGN_IN_SSO_ONLY_NEEDS_OWN_SCHOOL_ACCOUNT',
      });
    }

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const existing = await tx.schoolSignInMethod.findUnique({ where: { schoolId } });
        return existing
          ? tx.schoolSignInMethod.update({ where: { schoolId }, data: config })
          : tx.schoolSignInMethod.create({ data: { schoolId, ...config } });
      });
      return { method: viewOf(row), session: { schoolAccount: user.schoolAccount ?? null } };
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /** Turns school accounts off for the school: passwords only from the next refresh. */
  async remove(user: AuthenticatedUser): Promise<{ removed: boolean }> {
    const schoolId = requireSchoolId(user);
    const { count } = await this.prisma.withRls(user, (tx) =>
      tx.schoolSignInMethod.deleteMany({ where: { schoolId } }),
    );
    return { removed: count > 0 };
  }

  /**
   * /login's lookup: the provider an e-mail domain signs in with, or null.
   * Without a principal, through the SECURITY DEFINER function that answers
   * the provider and nothing else; a string that is no host name is not
   * asked about at all.
   */
  async providerFor(domain: string): Promise<SignInProvider | null> {
    const normalised = domain.trim().toLowerCase();
    if (!HOSTNAME.test(normalised)) return null;
    const rows = await this.prisma.withPublicViewer((tx) =>
      tx.$queryRaw<Array<{ provider: SignInProvider | null }>>(
        Prisma.sql`SELECT app.sign_in_provider_for_domain(${normalised})::text AS "provider"`,
      ),
    );
    return rows?.[0]?.provider ?? null;
  }
}
