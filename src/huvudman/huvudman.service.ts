import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type HuvudmanRole, type HuvudmanSchoolEventKind, type PrismaClient } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { areaRefusal } from '../common/utils/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { HUVUDMAN_SCOPES } from '../integration/ss12000-v2/scopes';
import { SupabaseAdminService } from '../users/supabase-admin.service';
import type { CreateHuvudmanKeyDto, InviteMemberDto, UpdateMemberDto } from './huvudman.dto';
import { huvudmanRefusal, sqlStateOf } from './huvudman-errors';

/** A member already has the address, or the login is a member already. */
export const HUVUDMAN_MEMBER_EXISTS = 'HUVUDMAN_MEMBER_EXISTS';
/** The change would leave the huvudman without an active kommunadministratör. */
export const HUVUDMAN_KEEPS_AN_ADMIN = 'HUVUDMAN_KEEPS_AN_ADMIN';
/** Not a huvudman this login is an active member of. */
export const HUVUDMAN_NOT_FOUND = 'HUVUDMAN_NOT_FOUND';

/** `sh_` and 48 hex digits: a huvudman's key, told from a school's `sp_` by its prefix. */
export const HUVUDMAN_KEY_SHAPE = /^sh_[0-9a-f]{48}$/;

export interface MyHuvudman {
  id: string;
  name: string;
  organisationNumber: string | null;
  municipalityCode: string | null;
  role: HuvudmanRole;
  memberId: string;
}

export interface HuvudmanView extends MyHuvudman {
  schools: Array<{ id: string; name: string; slug: string; state: 'OWNED' | 'REQUESTED'; since: string; requestedBy: string | null }>;
  members: Array<{
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: HuvudmanRole;
    isActive: boolean;
    /** Whether the member has a login (an invitation was accepted or sent). */
    invited: boolean;
  }>;
  /** The huvudman's SS12000 keys, for a kommunadministratör; null for a planner. Never a key or a hash. */
  keys: Array<{ id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> | null;
  history: Array<{ at: string; kind: HuvudmanSchoolEventKind; schoolId: string; schoolName: string; byMember: string | null; bySchool: boolean }>;
}

/**
 * The huvudman's own pages (Huvudman, 20261212090000): its members, the
 * schools it owns and asks for, and its SS12000 keys. Every read and write
 * is held to the caller's membership by the database (the huvudman tables'
 * arms and the app.huvudman_* functions), whichever school, if any, the
 * request names: a member may be a teacher at one school and the huvudman's
 * reader at another.
 *
 * The members are the huvudman's people, not a school's: their reads are no
 * school's läslogg, which records reads about a school's own people.
 */
@Injectable()
export class HuvudmanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  /** The huvudmän the login is an active member of, with its role in each. */
  async mine(user: AuthenticatedUser): Promise<MyHuvudman[]> {
    const rows = await this.prisma.queryWithRls(user, (db) =>
      db.huvudmanMember.findMany({
        where: { authId: user.authId, isActive: true },
        orderBy: [{ huvudman: { name: 'asc' } }, { huvudmanId: 'asc' }],
        select: {
          id: true,
          role: true,
          huvudman: { select: { id: true, name: true, organisationNumber: true, municipalityCode: true } },
        },
      }),
    );
    // A member whose token lacks the mark (markHuvudman is best effort, and
    // a bootstrapped kommunadministratör was never invited) is marked here,
    // so that the web shows the huvudman's pages from the next token on.
    if (user.role === Role.HUVUDMAN && user.huvudmanMarked === false && rows.length > 0) {
      await this.supabaseAdmin.markHuvudman(user.authId);
    }
    return rows.map((row) => ({
      id: row.huvudman.id,
      name: row.huvudman.name,
      organisationNumber: row.huvudman.organisationNumber,
      municipalityCode: row.huvudman.municipalityCode,
      role: row.role,
      memberId: row.id,
    }));
  }

  async view(user: AuthenticatedUser, huvudmanId: string): Promise<HuvudmanView> {
    return this.prisma.withRls(user, async (tx) => {
      const me = await this.membership(tx, user, huvudmanId);
      // One after another: a transaction is one connection (in-turn.ts).
      const schools = await tx.$queryRaw<Array<{ school_id: string; school_name: string; slug: string; state: 'OWNED' | 'REQUESTED'; since: Date; requested_by: string | null }>>(
        Prisma.sql`SELECT school_id, school_name, slug, state, since, requested_by FROM app.huvudman_schools(${huvudmanId}::uuid)`,
      );
      const members = await tx.huvudmanMember.findMany({
        where: { huvudmanId },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: { id: true, email: true, firstName: true, lastName: true, role: true, isActive: true, invitedAt: true },
      });
      const keys =
        me.role === 'KOMMUNADMINISTRATOR'
          ? await tx.huvudmanApiKey.findMany({
              where: { huvudmanId },
              orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
              select: { id: true, name: true, scopes: true, createdAt: true, lastUsedAt: true, revokedAt: true },
            })
          : null;
      const history = await tx.$queryRaw<Array<{ at: Date; kind: HuvudmanSchoolEventKind; school_id: string; school_name: string; by_member: string | null; by_school: boolean }>>(
        Prisma.sql`SELECT at, kind, school_id, school_name, by_member, by_school FROM app.huvudman_history(${huvudmanId}::uuid, 100)`,
      );
      return {
        ...me,
        schools: schools.map((row) => ({
          id: row.school_id,
          name: row.school_name,
          slug: row.slug,
          state: row.state,
          since: row.since.toISOString(),
          requestedBy: row.requested_by,
        })),
        members: members.map(({ invitedAt, ...member }) => ({ ...member, invited: invitedAt !== null })),
        keys:
          keys?.map((key) => ({
            ...key,
            createdAt: key.createdAt.toISOString(),
            lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
            revokedAt: key.revokedAt?.toISOString() ?? null,
          })) ?? null,
        history: history.map((row) => ({
          at: row.at.toISOString(),
          kind: row.kind,
          schoolId: row.school_id,
          schoolName: row.school_name,
          byMember: row.by_member,
          bySchool: row.by_school,
        })),
      };
    });
  }

  /** The kommunadministratör asks to own the school with the slug. */
  async requestSchool(user: AuthenticatedUser, huvudmanId: string, slug: string): Promise<{ id: string; name: string }> {
    return this.act(user, async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ school_id: string; school_name: string }>>(
        Prisma.sql`SELECT school_id, school_name FROM app.huvudman_request_school(${huvudmanId}::uuid, ${slug})`,
      );
      return { id: row!.school_id, name: row!.school_name };
    });
  }

  async withdrawRequest(user: AuthenticatedUser, huvudmanId: string, schoolId: string): Promise<void> {
    await this.act(user, (tx) =>
      tx.$executeRaw(Prisma.sql`SELECT app.huvudman_withdraw_request(${huvudmanId}::uuid, ${schoolId}::uuid)`),
    );
  }

  async releaseSchool(user: AuthenticatedUser, huvudmanId: string, schoolId: string): Promise<void> {
    await this.act(user, (tx) =>
      tx.$executeRaw(Prisma.sql`SELECT app.huvudman_release_school(${huvudmanId}::uuid, ${schoolId}::uuid)`),
    );
  }

  /**
   * A new member of the huvudman, invited by address: a login is made for
   * them (or the one their address has is found, which they then share with
   * any school that holds it), and handed to the member row by the one
   * function that may. Without Supabase (local development) the member is
   * made without a login, as a school's catalogue person is.
   *
   * Supabase is asked first, and the row and its login are written in one
   * transaction after: a failed ask (a 429, the network) leaves no member
   * behind, and a login that is already a member of the huvudman (23505)
   * leaves no row without a login. A member an earlier version left without
   * a login is asked for again; one that has a login is a 409, and its login
   * is marked again, in case the mark was lost.
   */
  async invite(
    user: AuthenticatedUser,
    huvudmanId: string,
    dto: InviteMemberDto,
  ): Promise<{ id: string; emailSent: boolean }> {
    const email = dto.email.trim().toLowerCase();
    const data = { huvudmanId, email, firstName: dto.firstName.trim(), lastName: dto.lastName.trim(), role: dto.role };
    const existing = await this.act(user, async (tx) => {
      this.keeps(await this.membership(tx, user, huvudmanId));
      return tx.huvudmanMember.findFirst({ where: { huvudmanId, email }, select: { id: true, authId: true } });
    });
    if (existing?.authId) {
      await this.supabaseAdmin.markHuvudman(existing.authId);
      throw memberExists();
    }
    if (!this.supabaseAdmin.isConfigured) {
      if (existing) throw memberExists();
      const made = await this.act(user, async (tx) => {
        this.keeps(await this.membership(tx, user, huvudmanId));
        return this.create(tx, data);
      });
      return { id: made.id, emailSent: false };
    }

    const invitation = await this.supabaseAdmin.inviteUser(email, existing?.id ?? `huvudman:${huvudmanId}`);
    const member = await this.act(user, async (tx) => {
      this.keeps(await this.membership(tx, user, huvudmanId));
      const row = existing ?? (await this.create(tx, data));
      try {
        await tx.$executeRaw(Prisma.sql`SELECT app.huvudman_member_takes_login(${row.id}::uuid, ${invitation.authId}::uuid)`);
      } catch (error) {
        // The login is already another member of the huvudman's: the whole
        // transaction rolls back, the new row with it.
        if (sqlStateOf(error) === '23505') throw memberExists();
        throw error;
      }
      return row;
    });
    // The web asks for the login's schools, and shows the huvudman's pages,
    // only for a login marked so.
    await this.supabaseAdmin.markHuvudman(invitation.authId);
    return { id: member.id, emailSent: invitation.emailSent };
  }

  /** A member row, 409 when the address is the huvudman's already. */
  private async create(
    tx: PrismaClient,
    data: { huvudmanId: string; email: string; firstName: string; lastName: string; role: HuvudmanRole },
  ): Promise<{ id: string }> {
    try {
      return await tx.huvudmanMember.create({ data, select: { id: true } });
    } catch (error) {
      if (sqlStateOf(error) === '23505') throw memberExists();
      throw error;
    }
  }

  /**
   * A member's role or whether they are active. The huvudman keeps at least
   * one active kommunadministratör: a change that would leave none is
   * refused, under the huvudman's lock so that two such changes at once
   * cannot both pass.
   */
  async updateMember(user: AuthenticatedUser, huvudmanId: string, memberId: string, dto: UpdateMemberDto): Promise<void> {
    await this.act(user, async (tx) => {
      this.keeps(await this.membership(tx, user, huvudmanId));
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('HuvudmanMembers'), hashtext(${huvudmanId}::text))`,
      );
      const target = await tx.huvudmanMember.findFirst({
        where: { id: memberId, huvudmanId },
        select: { role: true, isActive: true },
      });
      if (!target) {
        throw new NotFoundException({ message: 'Medlemmen finns inte hos huvudmannen.', code: 'HUVUDMAN_MEMBER_NOT_FOUND' });
      }
      // Counted before the change, and without the member changed: after it,
      // row security no longer shows a kommunadministratör who has made
      // themself inactive their own huvudman, so a count then would find none.
      const wasAdmin = target.role === 'KOMMUNADMINISTRATOR' && target.isActive;
      const staysAdmin = (dto.role ?? target.role) === 'KOMMUNADMINISTRATOR' && (dto.isActive ?? target.isActive);
      if (wasAdmin && !staysAdmin) {
        const others = await tx.huvudmanMember.count({
          where: { huvudmanId, role: 'KOMMUNADMINISTRATOR', isActive: true, id: { not: memberId } },
        });
        if (others === 0) {
          throw new ConflictException({
            message: 'Huvudmannen behöver minst en aktiv kommunadministratör.',
            code: HUVUDMAN_KEEPS_AN_ADMIN,
          });
        }
      }
      await tx.huvudmanMember.updateMany({
        where: { id: memberId, huvudmanId },
        data: { ...(dto.role ? { role: dto.role } : {}), ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}) },
      });
    });
  }

  /** A new SS12000 key for every school the huvudman owns; the key is shown once. */
  async createKey(
    user: AuthenticatedUser,
    huvudmanId: string,
    dto: CreateHuvudmanKeyDto,
  ): Promise<{ id: string; name: string; scopes: string[]; key: string }> {
    const scopes = HUVUDMAN_SCOPES.filter((scope) => dto.scopes.includes(scope));
    const key = `sh_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(key).digest('hex');
    const created = await this.act(user, async (tx) => {
      const me = this.keeps(await this.membership(tx, user, huvudmanId));
      return tx.huvudmanApiKey.create({
        data: { huvudmanId, name: dto.name.trim(), keyHash, scopes, createdById: me.memberId },
        select: { id: true, name: true, scopes: true },
      });
    });
    return { ...created, key };
  }

  async revokeKey(user: AuthenticatedUser, huvudmanId: string, keyId: string): Promise<void> {
    await this.act(user, async (tx) => {
      this.keeps(await this.membership(tx, user, huvudmanId));
      const revoked = await tx.huvudmanApiKey.updateMany({
        where: { id: keyId, huvudmanId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 0) {
        throw new NotFoundException({ message: 'Nyckeln finns inte, eller är redan återkallad.', code: 'HUVUDMAN_KEY_NOT_FOUND' });
      }
    });
  }

  /** The caller's active membership of the huvudman, or 404 (whether it exists is no answer to give). */
  private async membership(tx: PrismaClient, user: AuthenticatedUser, huvudmanId: string): Promise<MyHuvudman> {
    const row = await tx.huvudmanMember.findFirst({
      where: { huvudmanId, authId: user.authId, isActive: true },
      select: {
        id: true,
        role: true,
        huvudman: { select: { id: true, name: true, organisationNumber: true, municipalityCode: true } },
      },
    });
    if (!row) {
      throw new NotFoundException({ message: 'Huvudmannen finns inte, eller du är inte medlem i den.', code: HUVUDMAN_NOT_FOUND });
    }
    return {
      id: row.huvudman.id,
      name: row.huvudman.name,
      organisationNumber: row.huvudman.organisationNumber,
      municipalityCode: row.huvudman.municipalityCode,
      role: row.role,
      memberId: row.id,
    };
  }

  /** A kommunadministratör's act: a planner is refused before anything is asked. */
  /** The kommunadministratör's membership, or 403 for a planner. */
  private keeps(me: MyHuvudman): MyHuvudman {
    if (me.role !== 'KOMMUNADMINISTRATOR') throw notYours();
    return me;
  }

  /** A write under the caller's claims, with the database's refusals as HTTP. */
  private async act<T>(user: AuthenticatedUser, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.withRls(user, fn);
    } catch (error) {
      const refusal = huvudmanRefusal(error);
      if (refusal) throw refusal;
      // Row security refused a write the checks above let through (an
      // insert's WITH CHECK). Any other 42501 (a column the API role may not
      // write) is a fault of this code, and a 500 says so.
      if (areaRefusal(error)) throw notYours();
      throw error;
    }
  }
}

function memberExists(): ConflictException {
  return new ConflictException({ message: 'Huvudmannen har redan en medlem med den adressen.', code: HUVUDMAN_MEMBER_EXISTS });
}

function notYours(): ForbiddenException {
  return new ForbiddenException({ message: 'Bara huvudmannens kommunadministratör gör det.', code: 'HUVUDMAN_NOT_YOURS' });
}
