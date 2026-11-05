import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';

/*
 * SKYDDAD IDENTITET (20270107090000). A school's mark that a person has a
 * protected identity, and where Rastra learnt it: the SS12000 sync (source
 * SS12000) or an administrator (MANUAL). Never which protection.
 *
 * The mark keeps the person out of every file Rastra writes about people
 * (src/common/people-exports.ts is the list, and says file by file what
 * happens). Exports built here filter in SQL with `unmarked`; exports the
 * web builds read `list` when the file is asked for, and leave the marked
 * persons out there.
 *
 * Read by every administrator, written by those who write Personal; the
 * database holds the same (person_protections_admin_*). The list is
 * recorded in the läslogg as PEOPLE: which persons are protected is a fact
 * about each of them, as which teachers are never shown in public is
 * (PublicLinksService.hiddenTeachers).
 */

export type ProtectionSource = 'SS12000' | 'MANUAL';

export interface ProtectionView {
  userId: string;
  /** null once removed. */
  source: ProtectionSource | null;
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

@Injectable()
export class PersonProtectionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The school's marks. Recorded in the läslogg (PEOPLE). */
  async list(user: AuthenticatedUser): Promise<ProtectionView[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.personProtection.findMany({
        where: { schoolId },
        select: { userId: true, source: true },
        orderBy: { userId: 'asc' },
      });
      await recordRead(tx, 'PEOPLE', rows.map((row) => row.userId), user.channel);
      return rows;
    });
  }

  /**
   * Marks a person by hand. A person already marked keeps the mark they have:
   * one the sync wrote stays the sync's, so the register lifts it as before.
   */
  async set(userId: string, user: AuthenticatedUser): Promise<ProtectionView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const person = await tx.user.findFirst({ where: { id: userId, schoolId }, select: { id: true } });
      if (!person) throw new NotFoundException({ message: 'Personen finns inte.', code: 'PERSON_NOT_FOUND' });
      await tx.personProtection.createMany({ data: [{ userId, schoolId, source: 'MANUAL' }], skipDuplicates: true });
      const mark = await tx.personProtection.findFirst({ where: { userId, schoolId }, select: { userId: true, source: true } });
      return mark ?? { userId, source: null };
    });
  }

  /**
   * Removes a person's mark, whichever wrote it. One the sync wrote comes
   * back with the next sync while the register still protects the person.
   */
  async remove(userId: string, user: AuthenticatedUser): Promise<ProtectionView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const person = await tx.user.findFirst({ where: { id: userId, schoolId }, select: { id: true } });
      if (!person) throw new NotFoundException({ message: 'Personen finns inte.', code: 'PERSON_NOT_FOUND' });
      await tx.personProtection.deleteMany({ where: { userId, schoolId } });
      return { userId, source: null };
    });
  }
}
