import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { zonedTimeToUtc } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import { recordRead, type AccessKind } from './access-log';
import type { AccessLogQueryDto } from './dto/access-log.dto';

export const ACCESS_LOG_PERSON_NOT_FOUND = 'ACCESS_LOG_PERSON_NOT_FOUND';
export const ACCESS_LOG_RANGE_INVALID = 'ACCESS_LOG_RANGE_INVALID';

/** The most entries one answer carries; a longer one says it was cut and asks for a shorter period. */
export const ACCESS_LOG_LIMIT = 2000;

export interface AccessLogEntry {
  id: string;
  /** ISO instant of the read. */
  at: string;
  kind: AccessKind;
  channel: 'WEB' | 'APP' | 'INTEGRATION' | 'OTHER';
  /** The reader: a person (their name now; null once their row is gone), or an integration key. */
  reader:
    | { type: 'PERSON'; id: string | null; name: string | null; role: UserRole | null }
    | { type: 'KEY'; id: string | null; name: string | null };
  /** How many other people the same read named (its readSize less this person). */
  others: number;
}

export interface AccessLogAnswer {
  person: { id: string; firstName: string; lastName: string; role: UserRole };
  timezone: string;
  from: string | null;
  to: string | null;
  entries: AccessLogEntry[];
  /** More than ACCESS_LOG_LIMIT entries matched: the newest are shown. */
  truncated: boolean;
}

interface LogRow {
  id: string;
  at: Date;
  kind: AccessKind;
  channel: AccessLogEntry['channel'];
  actorId: string | null;
  actorRole: UserRole | null;
  apiKeyId: string | null;
  readSize: number;
}

const nextDay = (day: string) => {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/**
 * "Vem har läst om eleven?" (/admin/dataskydd): the read log's entries that
 * name one person, newest first, with who read, what, when and through
 * which client. For the school's SCHOOL_ADMIN: the route says so, and the
 * log's one row-security arm (personal_data_access_admin_select, TO
 * app_authenticated) answers nobody else anything.
 *
 * The answer is itself a read about the person, so it is recorded as
 * ACCESS_LOG in the same transaction: a follow-up of the log shows up in it.
 * Only how many other people a read named (its readSize, which the dedupe
 * does not shrink), never who they were.
 */
@Injectable()
export class AccessLogService {
  constructor(private readonly prisma: PrismaService) {}

  async forPerson(query: AccessLogQueryDto, user: AuthenticatedUser): Promise<AccessLogAnswer> {
    const schoolId = requireSchoolId(user);
    if (query.from && query.to && query.from > query.to) {
      throw new BadRequestException({ message: 'Perioden börjar efter att den slutar.', code: ACCESS_LOG_RANGE_INVALID });
    }
    return this.prisma.withRls(user, async (tx) => {
      const [school, person] = await Promise.all([
        tx.school.findUnique({ where: { id: schoolId }, select: { timezone: true } }),
        tx.user.findUnique({
          where: { id: query.personId },
          select: { id: true, firstName: true, lastName: true, role: true },
        }),
      ]);
      if (!person) {
        throw new NotFoundException({ message: 'Personen finns inte i skolan.', code: ACCESS_LOG_PERSON_NOT_FOUND });
      }
      const timezone = school?.timezone ?? 'Europe/Stockholm';
      const after = query.from ? zonedTimeToUtc(query.from, '00:00', timezone) : null;
      const before = query.to ? zonedTimeToUtc(nextDay(query.to), '00:00', timezone) : null;

      // @> on the GIN-indexed array: the log's one way in by person.
      const rows = await tx.$queryRaw<LogRow[]>(Prisma.sql`
        SELECT a."id", a."at", a."kind"::text AS "kind", a."channel"::text AS "channel",
               a."actorId", a."actorRole"::text AS "actorRole", a."apiKeyId",
               a."readSize"
          FROM "PersonalDataAccess" a
         WHERE a."subjectIds" @> ARRAY[${person.id}]::uuid[]
           ${after ? Prisma.sql`AND a."at" >= ${after}` : Prisma.empty}
           ${before ? Prisma.sql`AND a."at" < ${before}` : Prisma.empty}
         ORDER BY a."at" DESC, a."id" DESC
         LIMIT ${ACCESS_LOG_LIMIT + 1}`);
      const shown = rows.slice(0, ACCESS_LOG_LIMIT);

      const actorIds = [...new Set(shown.map((row) => row.actorId).filter((id): id is string => id !== null))];
      const keyIds = [...new Set(shown.map((row) => row.apiKeyId).filter((id): id is string => id !== null))];
      const [actors, keys] = await Promise.all([
        actorIds.length > 0
          ? tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, firstName: true, lastName: true } })
          : Promise.resolve([]),
        keyIds.length > 0
          ? tx.integrationApiKey.findMany({ where: { id: { in: keyIds } }, select: { id: true, name: true } })
          : Promise.resolve([]),
      ]);
      const nameOf = new Map(actors.map((actor) => [actor.id, `${actor.firstName} ${actor.lastName}`.trim()]));
      const keyName = new Map(keys.map((key) => [key.id, key.name]));

      await recordRead(tx, 'ACCESS_LOG', [person.id], user.channel);

      return {
        person,
        timezone,
        from: query.from ?? null,
        to: query.to ?? null,
        truncated: rows.length > ACCESS_LOG_LIMIT,
        entries: shown.map((row) => ({
          id: row.id,
          at: row.at.toISOString(),
          kind: row.kind,
          channel: row.channel,
          reader:
            row.channel === 'INTEGRATION'
              ? { type: 'KEY' as const, id: row.apiKeyId, name: row.apiKeyId ? (keyName.get(row.apiKeyId) ?? null) : null }
              : {
                  type: 'PERSON' as const,
                  id: row.actorId,
                  name: row.actorId ? (nameOf.get(row.actorId) ?? null) : null,
                  role: row.actorRole,
                },
          // The read's size, not the row's: the dedupe may have kept fewer.
          others: Math.max(row.readSize - 1, 0),
        })),
      };
    });
  }
}
