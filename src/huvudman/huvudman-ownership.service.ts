import { Injectable } from '@nestjs/common';
import { Prisma, type HuvudmanRole, type HuvudmanSchoolEventKind, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { profileDecides } from '../auth/admin-areas';
import { PrismaService } from '../database/prisma.service';
import { huvudmanRefusal } from './huvudman-errors';

export interface SchoolHuvudmanView {
  /** The huvudman that owns the school, or null. */
  owner: {
    id: string;
    name: string;
    organisationNumber: string | null;
    since: string;
    /** The school's decider who said yes (their name on the school's own decision), when still a person here. */
    acceptedBy: string | null;
  } | null;
  /** Huvudmän asking to own the school. */
  requests: Array<{ huvudmanId: string; name: string; organisationNumber: string | null; requestedAt: string }>;
  /** Who of the owner reads the school: name and role, never an address or a login. */
  readers: Array<{ id: string; firstName: string; lastName: string; role: HuvudmanRole; isActive: boolean; ownRow: 'ACTIVE' | 'INACTIVE' | null }>;
  /** The owner's SS12000 keys, which read the school: never a key or a hash. */
  /**
   * The huvudman's keys, for the school's deciders; null for any other
   * administrator, whom app.school_huvudman_keys() answers nothing: no one
   * of theirs to read, not "no keys".
   */
  keys: Array<{ id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> | null;
  history: Array<{ at: string; kind: HuvudmanSchoolEventKind; huvudmanName: string; byHuvudman: boolean }>;
}

/**
 * The school's side of its huvudman (Huvudman, 20261212090000): who owns
 * the school, who asks to, who of the owner reads it and with which keys,
 * and the decider's answers. Every administrator of the school reads it, the
 * huvudman's reader included; only rektor or a full administrator answers
 * (@Decides, and app.current_user_decides() inside each function).
 *
 * A decider's name on the school's own decision is not recorded as a read
 * (src/access-log/access-log.ts: who signed a decision), and the huvudman's
 * members are no people of the school's register.
 */
@Injectable()
export class HuvudmanOwnershipService {
  constructor(private readonly prisma: PrismaService) {}

  async view(user: AuthenticatedUser): Promise<SchoolHuvudmanView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      // One after another: a transaction is one connection (in-turn.ts).
      const owner = await tx.huvudmanSchool.findUnique({
        where: { schoolId },
        select: { since: true, acceptedById: true, huvudman: { select: { id: true, name: true, organisationNumber: true } } },
      });
      const requests = await tx.huvudmanSchoolRequest.findMany({
        where: { schoolId },
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        select: { requestedAt: true, huvudman: { select: { id: true, name: true, organisationNumber: true } } },
      });
      const readers = await tx.$queryRaw<
        Array<{ member_id: string; first_name: string; last_name: string; role: HuvudmanRole; is_active: boolean; own_row: 'ACTIVE' | 'INACTIVE' | null }>
      >(Prisma.sql`SELECT member_id, first_name, last_name, role, is_active, own_row FROM app.school_huvudman_readers()`);
      const keys = await tx.$queryRaw<Array<{ key_id: string; name: string; scopes: string[]; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>>(
        Prisma.sql`SELECT key_id, name, scopes, created_at, last_used_at, revoked_at FROM app.school_huvudman_keys()`,
      );
      const history = await tx.$queryRaw<Array<{ at: Date; kind: HuvudmanSchoolEventKind; huvudman_name: string; by_huvudman: boolean }>>(
        Prisma.sql`SELECT at, kind, huvudman_name, by_huvudman FROM app.school_huvudman_history(50)`,
      );
      const accepter = owner?.acceptedById ? await this.nameOf(tx, owner.acceptedById) : null;
      return {
        owner: owner
          ? {
              id: owner.huvudman.id,
              name: owner.huvudman.name,
              organisationNumber: owner.huvudman.organisationNumber,
              since: owner.since.toISOString(),
              acceptedBy: accepter,
            }
          : null,
        requests: requests.map((row) => ({
          huvudmanId: row.huvudman.id,
          name: row.huvudman.name,
          organisationNumber: row.huvudman.organisationNumber,
          requestedAt: row.requestedAt.toISOString(),
        })),
        readers: readers.map((row) => ({
          id: row.member_id,
          firstName: row.first_name,
          lastName: row.last_name,
          role: row.role,
          isActive: row.is_active,
          // Whether the login has a row of its own here: ACTIVE, the person
          // there; INACTIVE, the huvudman's reader in place of the row.
          ownRow: row.own_row,
        })),
        keys: !profileDecides(user.adminProfile) ? null : keys.map((row) => ({
          id: row.key_id,
          name: row.name,
          scopes: row.scopes,
          createdAt: row.created_at.toISOString(),
          lastUsedAt: row.last_used_at?.toISOString() ?? null,
          revokedAt: row.revoked_at?.toISOString() ?? null,
        })),
        history: history.map((row) => ({
          at: row.at.toISOString(),
          kind: row.kind,
          huvudmanName: row.huvudman_name,
          byHuvudman: row.by_huvudman,
        })),
      };
    });
  }

  /** The school's decider says yes: the huvudman owns the school from the next statement. */
  async accept(user: AuthenticatedUser, huvudmanId: string): Promise<void> {
    await this.decide(user, Prisma.sql`SELECT app.school_accepts_huvudman(${huvudmanId}::uuid)`);
  }

  async decline(user: AuthenticatedUser, huvudmanId: string): Promise<void> {
    await this.decide(user, Prisma.sql`SELECT app.school_declines_huvudman(${huvudmanId}::uuid)`);
  }

  /** The school leaves its huvudman: its readers and keys read nothing more here. */
  async leave(user: AuthenticatedUser): Promise<void> {
    await this.decide(user, Prisma.sql`SELECT app.school_leaves_huvudman()`);
  }

  private async decide(user: AuthenticatedUser, statement: Prisma.Sql): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, (tx) => tx.$executeRaw(statement));
    } catch (error) {
      throw huvudmanRefusal(error) ?? error;
    }
  }

  private async nameOf(tx: PrismaClient, userId: string): Promise<string | null> {
    const row = await tx.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
    return row ? `${row.firstName} ${row.lastName}`.trim() : null;
  }
}
