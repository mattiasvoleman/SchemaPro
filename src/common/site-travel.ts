import type { PrismaClient } from '@prisma/client';

/**
 * SKOLOMRÅDEN OCH RESTID: what a school's sites mean to a day of lessons
 * (migration 20261124090000 holds the data and argues its shape).
 *
 * One rule, read three ways:
 *
 *   - a hand edit in the grundschema is WARNED when it leaves a teacher, or
 *     the pupils of a lesson, less time between two lessons at different
 *     sites than the walk between them (master-lessons.service.ts,
 *     TRAVEL_TIME_SHORT, a warning beside the saved lesson, never a refusal);
 *   - a vikarie suggestion says the same of the candidate's day
 *     (cover-rank.ts, TRAVEL_TOO_SHORT, a reason that costs points);
 *   - a teacher's load counts the walks of their grundschema as restid:
 *     arbetstid beside the undervisning, never against the riktmärke
 *     (staffing/travel-load.ts).
 *
 * WHAT IS KNOWN, AND WHAT IS NOT. Travel is counted between two lessons only
 * when both rooms stand on a site, the sites differ and the school has given
 * the pair a figure. Anything less is unknown, and an unknown walk is neither
 * warned about nor charged: a room without a site is not "the same site as
 * the lesson before" (that would hide the walk) and not "another site" (that
 * would charge one the school never described), as Room.floor's null is
 * never counted as a floor change. A school with no site, or one, therefore
 * meets none of this. What is missing is said where it can be fixed instead:
 * the sites card lists the pairs without a figure and counts the rooms
 * without a site.
 *
 * ONE FIGURE PER PAIR. The same minutes both ways (the migration says why);
 * the map is keyed by the pair in id order, the order the table stores it in.
 */

/** A school's sites as one request reads them: rooms to sites, and the minutes between sites. */
export interface SiteMap {
  /** The site of every room that stands on one. */
  readonly siteOfRoom: ReadonlyMap<string, string>;
  /** Every site's name, for a sentence. */
  readonly nameOf: ReadonlyMap<string, string>;
  /** Minutes between two different sites, by pairKey; a pair with no figure is absent. */
  readonly minutes: ReadonlyMap<string, number>;
}

export const EMPTY_SITE_MAP: SiteMap = { siteOfRoom: new Map(), nameOf: new Map(), minutes: new Map() };

/** The pair's key, the lower id first: the order SiteTravelTimes stores it in (uuid order is text order). */
export function pairKey(a: string, b: string): string {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

/** Whether any walk can be counted at all: a figure between two sites. */
export function hasTravel(map: SiteMap): boolean {
  return map.minutes.size > 0;
}

/** A walk between two rooms: from one site to another, and the minutes it takes. */
export interface Walk {
  fromSite: string;
  toSite: string;
  minutes: number;
}

/**
 * The walk between two rooms, or null when there is none to count: a room
 * that is no room or stands on no site, the same site, or two sites the
 * school has given no figure. A figure of 0 is a walk of 0 minutes, which
 * nothing warns about and nothing charges.
 */
export function walkBetween(map: SiteMap, fromRoom: string | null, toRoom: string | null): Walk | null {
  if (fromRoom === null || toRoom === null) return null;
  const fromSite = map.siteOfRoom.get(fromRoom);
  const toSite = map.siteOfRoom.get(toRoom);
  if (fromSite === undefined || toSite === undefined || fromSite === toSite) return null;
  const minutes = map.minutes.get(pairKey(fromSite, toSite));
  return minutes === undefined ? null : { fromSite, toSite, minutes };
}

/** A lesson as the rule sees it: minutes from midnight, and its room. */
export interface PlacedLesson {
  id: string;
  start: number;
  end: number;
  roomId: string | null;
}

/** Two lessons of one party too close for the walk between them. */
export interface TravelBreach<L extends PlacedLesson = PlacedLesson> {
  /** The earlier lesson, which the party leaves. */
  from: L;
  /** The later lesson, which the party walks to. */
  to: L;
  walk: Walk;
  /** Minutes between the first one's end and the second one's start. */
  gap: number;
}

/**
 * The lessons a party goes to straight before and straight after `target`.
 *
 * `others` are the party's other lessons that day, in weeks that can meet the
 * target's: a teacher's own, or the lessons sharing pupils with it. A lesson
 * O before the target is the one the party comes FROM unless the lessons
 * lying between them HIDE it: everyone who would walk from O to the target
 * goes somewhere in between, every week the two meet. `hidden(o, between)`
 * says so; the default says yes as soon as anything lies between, which is
 * right for one person on one date (a vikarie's day, a teacher's day of the
 * year). On the grundschema the caller says more (travel-warnings.ts): a
 * lesson between hides only weeks it runs in, and for pupils only the pupils
 * it holds. 7A's Spanska at Södra and its Tyska at Norra both end before
 * 7A's next lesson, and the Spanska pupils walk from Södra however late the
 * Tyska ends, since the Tyska holds none of them.
 *
 * Lessons overlapping the target are not before or after it (that is a
 * clash, the conflict check's to refuse), and two lessons on one end are
 * both kept.
 */
export function neighboursOf<L extends PlacedLesson>(
  target: L,
  others: readonly L[],
  hidden: (o: L, between: readonly L[]) => boolean = (_o, between) => between.length > 0,
): { before: L[]; after: L[] } {
  const before = others.filter((o) => o.id !== target.id && o.end <= target.start);
  const after = others.filter((o) => o.id !== target.id && o.start >= target.end);
  return {
    before: before.filter(
      (o) => !hidden(o, before.filter((m) => m !== o && m.start >= o.end && m.end <= target.start)),
    ),
    after: after.filter((o) => !hidden(o, after.filter((m) => m !== o && m.start >= target.end && m.end <= o.start))),
  };
}

/**
 * Every walk the target takes part in that the gap does not hold: from each
 * lesson the party comes from, and to each it goes to next.
 */
export function travelBreaches<L extends PlacedLesson>(
  map: SiteMap,
  target: L,
  others: readonly L[],
  hidden?: (o: L, between: readonly L[]) => boolean,
): TravelBreach<L>[] {
  if (!hasTravel(map)) return [];
  const { before, after } = neighboursOf(target, others, hidden);
  const breaches: TravelBreach<L>[] = [];
  for (const from of before) {
    const walk = walkBetween(map, from.roomId, target.roomId);
    const gap = target.start - from.end;
    if (walk && walk.minutes > gap) breaches.push({ from, to: target, walk, gap });
  }
  for (const to of after) {
    const walk = walkBetween(map, target.roomId, to.roomId);
    const gap = to.start - target.end;
    if (walk && walk.minutes > gap) breaches.push({ from: target, to, walk, gap });
  }
  return breaches;
}

/**
 * A teacher's walks in one day: the minutes between each lesson and the next
 * one they teach, wherever the sites differ and the pair has a figure. The
 * walk is counted whatever the gap — a teacher with an hour between Norra
 * and Södra still walks the fifteen minutes — and a lesson that overlaps the
 * one before it (a clash) starts no walk of its own from that one.
 */
export function walksOfDay(map: SiteMap, lessons: readonly PlacedLesson[]): Walk[] {
  if (!hasTravel(map) || lessons.length < 2) return [];
  const ordered = [...lessons].sort((a, b) => a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : 1));
  const walks: Walk[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const next = ordered[i]!;
    if (next.start < previous.end) continue;
    const walk = walkBetween(map, previous.roomId, next.roomId);
    if (walk && walk.minutes > 0) walks.push(walk);
  }
  return walks;
}

/**
 * The school's sites, under the caller's RLS: an administrator's and a
 * teacher's read (Sites, SiteTravelTimes and Rooms are theirs to read). The
 * figures first: a school with none — one site, or none — asks that one
 * indexed question and nothing more, and every caller then has nothing to
 * say. A caller that already knows the school has no figure (a `_count` on a
 * read it makes anyway) asks nothing at all.
 */
export async function readSiteMap(tx: PrismaClient, schoolId: string): Promise<SiteMap> {
  const pairs = await tx.siteTravelTime.findMany({
    where: { schoolId },
    select: { siteAId: true, siteBId: true, minutes: true },
  });
  if (pairs.length === 0) return EMPTY_SITE_MAP;
  const [sites, rooms] = await Promise.all([
    tx.site.findMany({ where: { schoolId }, select: { id: true, name: true } }),
    tx.room.findMany({ where: { schoolId, siteId: { not: null } }, select: { id: true, siteId: true } }),
  ]);
  return {
    siteOfRoom: new Map(rooms.map((room) => [room.id, room.siteId!])),
    nameOf: new Map(sites.map((s) => [s.id, s.name])),
    minutes: new Map(pairs.map((pair) => [pairKey(pair.siteAId, pair.siteBId), pair.minutes])),
  };
}
