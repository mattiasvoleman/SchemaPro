import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { pairKey } from '../common/site-travel';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import type { CreateSiteDto, PutSiteTravelTimesDto, UpdateSiteDto } from './dto/site.dto';

/**
 * The school's skolområden and the minutes between them (migration
 * 20261124090000), read by its administrators and written by the one who
 * writes planering. What they mean to a day of lessons is
 * src/common/site-travel.ts.
 *
 * Sites are no personal data, so no read is written to the läslogg.
 */
export interface SiteView {
  id: string;
  name: string;
  /** Rooms standing on the site. */
  roomCount: number;
}

export interface SiteTravelTimeView {
  /** The pair in id order, as the table stores it. */
  siteAId: string;
  siteBId: string;
  minutes: number;
}

export interface SitesView {
  sites: SiteView[];
  travelTimes: SiteTravelTimeView[];
  /** Rooms of the school that stand on no site: no travel is counted to or from them. */
  roomsWithoutSite: number;
}

export const SITE_NAME_TAKEN = 'SITE_NAME_TAKEN';
export const SITE_LIMIT = 'SITE_LIMIT';
export const SITE_TRAVEL_STALE = 'SITE_TRAVEL_STALE';

/**
 * At most fifty sites a school: no school has more campuses, and a full set
 * of figures between fifty is 1 225 pairs, what one save carries
 * (PutSiteTravelTimesDto).
 */
export const MAX_SITES = 50;

/**
 * The school's figures as one string, the pairs in id order: what the card
 * sends back as `basis` to say which figures it was looking at. The web
 * builds the same string from what it read (use-sites.ts travelBasis).
 */
export function travelBasis(times: readonly { siteAId: string; siteBId: string; minutes: number }[]): string {
  return times
    .map((time) => `${pairKey(time.siteAId, time.siteBId)}:${time.minutes}`)
    .sort()
    .join(',');
}
export const SITE_NAME_EMPTY = 'SITE_NAME_EMPTY';
export const SITE_TRAVEL_PAIR_INVALID = 'SITE_TRAVEL_PAIR_INVALID';
export const SITE_NOT_FOUND = 'SITE_NOT_FOUND';

const nameTaken = () =>
  new ConflictException({ message: 'Skolan har redan ett skolområde med det namnet.', code: SITE_NAME_TAKEN });

function normaliseName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new BadRequestException({ message: 'name: skolområdet behöver ett namn.', code: SITE_NAME_EMPTY });
  }
  return trimmed;
}

/**
 * One writer of a school's sites at a time. The travel times are saved
 * whole — the pairs listed written, every other removed — so two saves side
 * by side would otherwise each remove what the other wrote, or meet each
 * other's new pair as a duplicate key.
 */
async function lockSites(tx: PrismaClient, schoolId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`Sites:${schoolId}`}, 0))`);
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'sv');

@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<SitesView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const [sites, times, rooms] = await Promise.all([
        tx.site.findMany({ where: { schoolId }, select: { id: true, name: true } }),
        tx.siteTravelTime.findMany({
          where: { schoolId },
          select: { siteAId: true, siteBId: true, minutes: true },
          orderBy: [{ siteAId: 'asc' }, { siteBId: 'asc' }],
        }),
        tx.room.groupBy({ by: ['siteId'], where: { schoolId }, _count: { _all: true } }),
      ]);
      const count = new Map(rooms.map((row) => [row.siteId, row._count._all]));
      return {
        sites: sites.sort(byName).map((site) => ({ id: site.id, name: site.name, roomCount: count.get(site.id) ?? 0 })),
        travelTimes: times,
        roomsWithoutSite: count.get(null) ?? 0,
      };
    });
  }

  async create(dto: CreateSiteDto, user: AuthenticatedUser): Promise<SiteView> {
    const schoolId = requireSchoolId(user);
    const name = normaliseName(dto.name);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await lockSites(tx, schoolId);
        if ((await tx.site.count({ where: { schoolId } })) >= MAX_SITES) {
          throw new ConflictException({ message: `En skola har högst ${MAX_SITES} skolområden.`, code: SITE_LIMIT });
        }
        const row = await tx.site.create({ data: { schoolId, name }, select: { id: true, name: true } });
        return { ...row, roomCount: 0 };
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  async update(id: string, dto: UpdateSiteDto, user: AuthenticatedUser): Promise<SiteView> {
    const schoolId = requireSchoolId(user);
    const name = normaliseName(dto.name);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await lockSites(tx, schoolId);
        const site = await tx.site.findFirst({ where: { id, schoolId }, select: { id: true } });
        if (!site) throw new NotFoundException({ message: 'Skolområdet finns inte.', code: SITE_NOT_FOUND });
        const row = await tx.site.update({ where: { id }, data: { name }, select: { id: true, name: true } });
        const roomCount = await tx.room.count({ where: { schoolId, siteId: id } });
        return { ...row, roomCount };
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  /** Its travel times go with it; its rooms stay, on no site (ON DELETE SET NULL ("siteId")). */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    const schoolId = requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        await lockSites(tx, schoolId);
        const { count } = await tx.site.deleteMany({ where: { id, schoolId } });
        if (count === 0) throw new NotFoundException({ message: 'Skolområdet finns inte.', code: SITE_NOT_FOUND });
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  /**
   * Every travel time at once: the pairs listed are the school's figures,
   * and a pair left out has none. Each pair in either order, stored in id
   * order; a pair named twice, or a site paired with itself, is refused
   * rather than one of the two figures picked.
   */
  async putTravelTimes(dto: PutSiteTravelTimesDto, user: AuthenticatedUser): Promise<SiteTravelTimeView[]> {
    const schoolId = requireSchoolId(user);
    const wanted = new Map<string, SiteTravelTimeView>();
    for (const time of dto.times) {
      const [a, b] = time.siteIds.map((id) => id.toLowerCase()) as [string, string];
      if (a === b) {
        throw new BadRequestException({ message: 'Ett skolområde har ingen restid till sig självt.', code: SITE_TRAVEL_PAIR_INVALID });
      }
      const key = pairKey(a, b);
      if (wanted.has(key)) {
        throw new BadRequestException({ message: 'Samma par av skolområden står två gånger.', code: SITE_TRAVEL_PAIR_INVALID });
      }
      const [siteAId, siteBId] = key.split('|') as [string, string];
      wanted.set(key, { siteAId, siteBId, minutes: time.minutes });
    }
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await lockSites(tx, schoolId);
        const known = new Set(
          (await tx.site.findMany({ where: { schoolId }, select: { id: true } })).map((site) => site.id.toLowerCase()),
        );
        // A site in the body that is not (or no longer) the school's: the
        // card is behind, as with any reference in a body (409).
        for (const pair of wanted.values()) {
          if (!known.has(pair.siteAId) || !known.has(pair.siteBId)) {
            throw new ConflictException({ message: 'Ett av skolområdena finns inte längre.', code: SITE_NOT_FOUND });
          }
        }
        const existing = await tx.siteTravelTime.findMany({
          where: { schoolId },
          select: { siteAId: true, siteBId: true, minutes: true },
        });
        if (dto.basis !== undefined && dto.basis !== travelBasis(existing)) {
          throw new ConflictException({
            message: 'Restiderna har ändrats sedan du öppnade sidan. Ladda om och spara igen.',
            code: SITE_TRAVEL_STALE,
          });
        }
        const gone = existing.filter((row) => !wanted.has(pairKey(row.siteAId, row.siteBId)));
        for (const row of gone) {
          await tx.siteTravelTime.delete({ where: { siteAId_siteBId: { siteAId: row.siteAId, siteBId: row.siteBId } } });
        }
        const had = new Map(existing.map((row) => [pairKey(row.siteAId, row.siteBId), row.minutes]));
        for (const [key, pair] of wanted) {
          const before = had.get(key);
          if (before === pair.minutes) continue;
          await tx.siteTravelTime.upsert({
            where: { siteAId_siteBId: { siteAId: pair.siteAId, siteBId: pair.siteBId } },
            create: { schoolId, siteAId: pair.siteAId, siteBId: pair.siteBId, minutes: pair.minutes },
            update: { minutes: pair.minutes },
          });
        }
        return [...wanted.values()].sort((x, y) =>
          x.siteAId < y.siteAId ? -1 : x.siteAId > y.siteAId ? 1 : x.siteBId < y.siteBId ? -1 : 1,
        );
      });
    } catch (error) {
      // No name is written here: a duplicate key is not SITE_NAME_TAKEN.
      rethrowPrismaError(error);
    }
  }

  private rethrow(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw nameTaken();
    }
    rethrowPrismaError(error);
  }
}
