import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PrismaClient, type SchoolSignInMethod, type SignInProvider } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { SchoolAccountSession } from '../auth/school-account';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { SignInConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { sqlStateOf } from '../integration/ss12000-sync/errors';
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
  /** False until the deployment turns school accounts on (SCHOOL_ACCOUNTS=on). */
  available: boolean;
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

/**
 * The domain trigger's refusal (SQLSTATE SI409, app.sign_in_domain_keeps_its_provider):
 * the saving school's own domains that another school names with another
 * provider, read from DETAIL domains=a,b. Null for any other error.
 */
export function domainTakenRefusal(error: unknown): string[] | null {
  if (sqlStateOf(error) !== 'SI409') return null;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { detail?: unknown } } } }).meta;
  const detail = meta?.driverAdapterError?.cause?.detail;
  const listed = typeof detail === 'string' ? /^domains=(.+)$/.exec(detail)?.[1] : undefined;
  return listed ? listed.split(',').filter((domain) => HOSTNAME.test(domain)) : [];
}

/** How many of the school's staff who can sign in have an address on one e-mail domain. */
export interface DomainUse {
  domain: string;
  staff: number;
}

/** "kommun.se (12), skola.se (1)": domains with how many people they name. */
const counted = (rows: Array<{ domain: string; count: number }>) =>
  rows.map((row) => `${row.domain} (${row.count})`).join(', ');

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
 * (sign_in.custom_access_token_hook) reads the row Supabase Auth asks about at
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
 *
 * Two more refusals come from the deployment and the database:
 *   - SCHOOL_ACCOUNTS=off (the default): nothing is saved
 *     (409 SIGN_IN_NOT_AVAILABLE), so before the operator has set up the
 *     hook and the providers no school has a row and no address is sent
 *     anywhere. Removing a row is always allowed. The lookup does not read
 *     the flag: turned off after a school requires the school account, it
 *     would leave that school's staff with no way in.
 *   - A domain another school names with another provider: the trigger
 *     refuses it (SQLSTATE SI409), answered as 409 SIGN_IN_DOMAIN_TAKEN
 *     naming the saving school's own domains and nothing about the other
 *     school. Otherwise one school could leave another's domain with no
 *     answer at /login. The collision is logged for the operator, who
 *     decides whose domain it is.
 *
 * And two from the school's own staff, read under the admin's RLS in the
 * transaction that saves. Both count the same people: active teachers and
 * admins who can sign in, which is those SchemaPro has invited ("invitedAt"
 * set; until then authId matches no login) and the admin saving, who is
 * signed in. A catalogue entry nobody invited has no login to lose and
 * proves nothing about a domain, so it neither claims a domain nor holds
 * the switch off. Pupils and guardians are not counted: the switch does not
 * apply to them, and a domain only they use is no staff domain to offer.
 *   - Every domain the save adds must have at least one of them on it
 *     (409 SIGN_IN_DOMAIN_UNUSED). A school cannot claim a domain its staff
 *     do not use, first come, ahead of the schools whose staff do. A domain
 *     already on the row with the same provider is not asked again, so
 *     turning the switch off, or any other change that keeps the provider,
 *     never waits on a domain whose last teacher has left. A change of
 *     provider asks about every domain again: keeping a domain nobody uses
 *     would otherwise hold it for the new provider against the schools whose
 *     staff use it with the old one.
 *   - With "Kräv skolkonto för personal" on, every one of them must have an
 *     address on one of the row's own domains (409
 *     SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT, naming the domains left out and how
 *     many staff are on each). Only the row's own: the saving school's old
 *     row and other schools' rows are not asked, since the old row is about
 *     to be replaced and another school may drop, narrow or switch its own
 *     row at any time with nothing to check this school. Naming a domain
 *     another school also names, with the same provider, is what the domain
 *     trigger allows, and from then on no other school can switch it. A
 *     personal address (gmail.com and the like) can never be listed (the
 *     DTO and the table's CHECK), so staff on one need a school address
 *     before the switch goes on. Otherwise staff on a missing, dropped or
 *     personal domain would find no school-account sign-in and have their
 *     password refused, with no way in.
 */
@Injectable()
export class SignInMethodsService {
  private readonly logger = new Logger(SignInMethodsService.name);
  private readonly schoolAccounts: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.schoolAccounts = config.get<SignInConfig>('signIn')?.schoolAccounts === true;
  }

  async get(user: AuthenticatedUser): Promise<SignInSettings> {
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.withRls(user, (tx) =>
      tx.schoolSignInMethod.findUnique({ where: { schoolId } }),
    );
    return {
      available: this.schoolAccounts,
      method: row ? viewOf(row) : null,
      session: { schoolAccount: user.schoolAccount ?? null },
    };
  }

  async put(user: AuthenticatedUser, dto: SignInMethodDto): Promise<SignInSettings> {
    const schoolId = requireSchoolId(user);
    if (!this.schoolAccounts) {
      throw new ConflictException({
        message: 'Inloggning med skolkonto är inte påslagen för SchemaPro ännu.',
        code: 'SIGN_IN_NOT_AVAILABLE',
      });
    }
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
        // The stored row is what the save is judged against, so it is locked
        // before it is read: a second save by the same school waits, and its
        // read (a new snapshot under READ COMMITTED) sees what the first one
        // committed. FOR NO KEY UPDATE and raw SQL as in UsersService.update.
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 FROM "SchoolSignInMethods" WHERE "schoolId" = ${schoolId}::uuid FOR NO KEY UPDATE`,
        );
        const existing = await tx.schoolSignInMethod.findUnique({ where: { schoolId } });
        const uses = await this.staffDomains(tx, schoolId, user.userId ?? null);
        const used = new Set(uses.map((use) => use.domain));
        const kept = (domain: string) => existing?.provider === config.provider && existing.domains.includes(domain);
        const unused = config.domains.filter((domain) => !kept(domain) && !used.has(domain));
        if (unused.length > 0) {
          throw new ConflictException({
            message: 'Ingen inbjuden lärare eller administratör på skolan har en adress på domänen.',
            code: 'SIGN_IN_DOMAIN_UNUSED',
            params: { domains: unused.join(', ') },
          });
        }
        if (config.ssoOnlyForStaff) {
          const left = uses
            .filter((use) => !config.domains.includes(use.domain))
            .map((use) => ({ domain: use.domain, count: use.staff }));
          if (left.length > 0) {
            throw new ConflictException({
              message: 'Personal med adresser på andra domäner skulle inte kunna logga in.',
              code: 'SIGN_IN_SSO_ONLY_LEAVES_STAFF_OUT',
              params: { domains: counted(left) },
            });
          }
        }
        return existing
          ? tx.schoolSignInMethod.update({ where: { schoolId }, data: config })
          : tx.schoolSignInMethod.create({ data: { schoolId, ...config } });
      });
      return {
        available: this.schoolAccounts,
        method: viewOf(row),
        session: { schoolAccount: user.schoolAccount ?? null },
      };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      const taken = domainTakenRefusal(error);
      if (taken) {
        this.logger.warn(
          `A school-account domain is named by another school with another provider [school=${schoolId}] [domains=${taken.join(',')}]`,
        );
        throw new ConflictException({
          message: 'En annan skola använder domänen med en annan inloggning.',
          code: 'SIGN_IN_DOMAIN_TAKEN',
          params: { domains: taken.join(', ') },
        });
      }
      rethrowPrismaError(error);
    }
  }

  /**
   * The e-mail domains of the school's staff who can sign in (active
   * SCHOOL_ADMIN and TEACHER rows that were invited, and the saving admin),
   * with how many are on each. Read under the admin's own RLS, which shows
   * them every person of their school.
   */
  private async staffDomains(tx: PrismaClient, schoolId: string, savingUserId: string | null): Promise<DomainUse[]> {
    const rows = await tx.$queryRaw<Array<{ domain: string; staff: bigint | number }>>(
      Prisma.sql`SELECT lower(split_part(btrim("email"), '@', 2)) AS "domain", count(*) AS "staff"
                   FROM "Users"
                  WHERE "schoolId" = ${schoolId}::uuid AND "isActive"
                    AND "role" IN ('SCHOOL_ADMIN', 'TEACHER')
                    AND ("invitedAt" IS NOT NULL OR "id" = ${savingUserId}::uuid)
                  GROUP BY 1`,
    );
    return (rows ?? []).map((row) => ({ domain: row.domain, staff: Number(row.staff) }));
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
