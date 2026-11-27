import { Injectable } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { mustAsk, readDirectReachFacts } from './direct-reach';
import { publishModeOf, type PublishMode } from './publish-mode';

/**
 * Frågan före en ändring i Direkt som når familjer, som sidan läser den (direct-reach.ts har reglerna).
 *
 * `ask` är den försiktiga frågan, den som sidan ställer före det första draget: skolan är i Direkt, en publicering av läsåret gäller
 * ännu och svaret är inte på eller efter den. Servern (vakten i skrivvägen) frågar bara när en ändring faktiskt nådde en publicerad
 * lektion; sidan frågar före en ändring som kan nå en. `audience` är skolans, inte ändringens: hur många som kan få en notis, räknade
 * som rader (inget namn, ingen adress), och ges bara när frågan ställs.
 */
export interface DirectReachView {
  /** The läsår the question is about: the one asked for, else the active one. */
  academicYearId: string | null;
  mode: PublishMode;
  /** The publication that still holds, as the question names it; null when none does. */
  period: { from: string; to: string } | null;
  /** When the school last answered, whether or not the answer still holds; read through the definer function, as the guard reads it. Null when no publication holds. */
  acknowledgedAt: string | null;
  /** Direkt, a publication of the year that still holds, and no answer at or after it. */
  ask: boolean;
  /** Who can get a notice: the school's pupils and their guardians, counted. Null when nothing is asked. */
  audience: { pupils: number; guardians: number } | null;
}

@Injectable()
export class DirectReachService {
  constructor(private readonly prisma: PrismaService) {}

  async read(user: AuthenticatedUser, academicYearId?: string): Promise<DirectReachView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, (tx) => this.view(tx, schoolId, academicYearId));
  }

  /**
   * "Fortsätt i Direkt". Written at the database's clock (now() is the transaction's start, as publishedAt's default is), so an answer
   * given after a publication is never before it. Needs the area Publicering, as every write of the settings row does (the arm says so); every profile that moves a lesson has it.
   */
  async acknowledge(user: AuthenticatedUser, academicYearId?: string): Promise<DirectReachView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT now() AS "now"`);
      await tx.publicationSettings.upsert({
        where: { schoolId },
        create: { schoolId, directReachAcknowledgedAt: now },
        update: { directReachAcknowledgedAt: now },
      });
      return this.view(tx, schoolId, academicYearId);
    });
  }

  private async view(tx: PrismaClient, schoolId: string, academicYearId?: string): Promise<DirectReachView> {
    const mode = await publishModeOf(tx, schoolId);
    const year = academicYearId
      ? await tx.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true } })
      : await tx.academicYear.findFirst({ where: { isActive: true }, select: { id: true } });
    const facts = year ? await readDirectReachFacts(tx, year.id) : null;
    const ask = mustAsk(mode, facts);
    return {
      academicYearId: year?.id ?? null,
      mode,
      period: facts ? { from: facts.validFrom, to: facts.validTo } : null,
      acknowledgedAt: facts?.acknowledgedAt?.toISOString() ?? null,
      ask,
      audience: ask ? await this.audience(tx) : null,
    };
  }

  /**
   * Counted, never listed. Pupils who are active, and the guardians linked to an active pupil who are active themselves: what the notice
   * (notifications.recipientsForLessons) can reach at most. A change reaches the pupils of the lessons it moves and their guardians.
   */
  private async audience(tx: PrismaClient): Promise<{ pupils: number; guardians: number }> {
    const pupils = await tx.user.count({ where: { role: 'STUDENT', isActive: true } });
    const rows = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(DISTINCT gs."guardianId")::int AS "n"
        FROM "GuardianStudents" gs
        JOIN "Users" s ON s."id" = gs."studentId" AND s."schoolId" = gs."schoolId"
        JOIN "Users" g ON g."id" = gs."guardianId" AND g."schoolId" = gs."schoolId"
       WHERE s."role" = 'STUDENT' AND s."isActive" AND g."isActive"
    `);
    return { pupils, guardians: rows?.[0]?.n ?? 0 };
  }
}
