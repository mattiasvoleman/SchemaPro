import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';

/*
 * SKYDDAD IDENTITET (20270107090000). A school's mark that a person has a
 * protected identity, and where Rastra learnt it: the SS12000 sync (source
 * SS12000) or an administrator (MANUAL), a row each. Never which protection.
 *
 * The mark keeps the person out of every file Rastra writes about people
 * (src/common/people-files.ts and web/lib/people-files.ts list them, file by
 * file). Exports built here filter in SQL with `unmarked`; exports the web
 * builds read `list` when the file is asked for, and leave the marked
 * persons out there.
 *
 * Every administrator reads; those who write Personal set a mark by hand;
 * those who decide (rektor, full) remove one. The database holds the same
 * (person_protections_admin_*). An administrator's mark is a row of its own
 * beside the sync's, so it stands until an administrator removes it, whatever
 * the register later says. Who set or removed a mark, and when, is written by
 * the database (PersonProtectionEvents) and read with the person.
 *
 * The SS12000 provider (v1, v2.0) does not read the mark: the systems the
 * school connected get the person as before, without a marking (people-
 * files.ts, INTEGRATION).
 */

export type ProtectionSource = 'SS12000' | 'MANUAL';

/** One row of the school's marks, as the exports read them. */
export interface ProtectionRow {
  userId: string;
  source: ProtectionSource;
}

export interface ProtectionEventView {
  action: 'ADDED' | 'REMOVED';
  source: ProtectionSource;
  /** Who did it, by name; null for the sync's principal, gallring, or a person since removed. */
  actorName: string | null;
  at: string;
}

/** One person's marks and their history, newest first. */
export interface PersonProtectionView {
  userId: string;
  /** The person is marked while this is not empty. */
  sources: ProtectionSource[];
  events: ProtectionEventView[];
}

/** The SQL condition a server export adds for a person column: no mark on the person. */
export function unmarked(column: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`NOT EXISTS (SELECT 1 FROM "PersonProtections" pp WHERE pp."userId" = ${column})`;
}

/** The marked persons of the school, for an export that filters in memory. Read under the caller's RLS. */
export async function markedIds(tx: PrismaClient, schoolId: string): Promise<Set<string>> {
  const rows = await tx.personProtection.findMany({ where: { schoolId }, select: { userId: true } });
  return new Set(rows.map((row) => row.userId));
}

const HISTORY = 50;

@Injectable()
export class PersonProtectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The school's marks, a row per source. Recorded in the läslogg (PEOPLE): the exports read it. */
  async list(user: AuthenticatedUser): Promise<ProtectionRow[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.personProtection.findMany({
        where: { schoolId },
        select: { userId: true, source: true },
        orderBy: [{ userId: 'asc' }, { source: 'asc' }],
      });
      await recordRead(tx, 'PEOPLE', rows.map((row) => row.userId), user.channel);
      return rows;
    });
  }

  /**
   * One person's marks and who set or removed them: what the person's row
   * shows. Recorded as a read of the person and of those it names (PEOPLE),
   * as the role history is.
   */
  async one(userId: string, user: AuthenticatedUser): Promise<PersonProtectionView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      await this.person(tx, userId, schoolId);
      const view = await this.view(tx, userId, schoolId);
      await recordRead(tx, 'PEOPLE', [userId, ...view.actorIds], user.channel);
      return view.view;
    });
  }

  /**
   * Marks a person by hand: a row of the administrator's own beside any the
   * sync wrote, so the mark stands until an administrator removes it.
   */
  async set(userId: string, user: AuthenticatedUser): Promise<PersonProtectionView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      await this.person(tx, userId, schoolId);
      await tx.personProtection.createMany({ data: [{ userId, schoolId, source: 'MANUAL' }], skipDuplicates: true });
      return (await this.view(tx, userId, schoolId)).view;
    });
  }

  /**
   * Removes the person's marks, the sync's and an administrator's: a
   * decision (rektor, full). One the sync wrote comes back with the next
   * sync while the register still protects the person.
   */
  async remove(userId: string, user: AuthenticatedUser): Promise<PersonProtectionView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      await this.person(tx, userId, schoolId);
      await tx.personProtection.deleteMany({ where: { userId, schoolId } });
      return (await this.view(tx, userId, schoolId)).view;
    });
  }

  private async person(tx: PrismaClient, userId: string, schoolId: string): Promise<void> {
    const person = await tx.user.findFirst({ where: { id: userId, schoolId }, select: { id: true } });
    if (!person) throw new NotFoundException({ message: 'Personen finns inte.', code: 'PERSON_NOT_FOUND' });
  }

  private async view(tx: PrismaClient, userId: string, schoolId: string): Promise<{ view: PersonProtectionView; actorIds: string[] }> {
    const [marks, events] = await Promise.all([
      tx.personProtection.findMany({ where: { userId, schoolId }, select: { source: true }, orderBy: { source: 'asc' } }),
      tx.personProtectionEvent.findMany({
        where: { userId, schoolId },
        select: { action: true, source: true, actorId: true, at: true },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: HISTORY,
      }),
    ]);
    const actorIds = [...new Set(events.map((event) => event.actorId).filter((id): id is string => id !== null))];
    const actors = actorIds.length
      ? await tx.user.findMany({ where: { id: { in: actorIds }, schoolId }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const names = new Map(actors.map((actor) => [actor.id, `${actor.firstName} ${actor.lastName}`]));
    return {
      actorIds,
      view: {
        userId,
        sources: marks.map((mark) => mark.source),
        events: events.map((event) => ({
          action: event.action,
          source: event.source,
          actorName: event.actorId ? (names.get(event.actorId) ?? null) : null,
          at: event.at.toISOString(),
        })),
      },
    };
  }
}
