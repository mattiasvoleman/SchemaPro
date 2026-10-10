/**
 * WHICH PUBLICATION IS VALID WHEN.
 *
 * A publication is a log row with a validity range [validFrom, validTo]
 * (migration 20261011090000). Ranges may overlap: an HT publication covering
 * the whole year and a VT one published in December from 15 January. The
 * rule is the one Skola24's "Giltig fr.o.m." gives an admin to read: for a
 * date, the LATEST publication — by (publishedAt, id), so two in the same
 * millisecond still have an order — whose range contains the date. Painting
 * the publications onto the calendar in that order gives the segments.
 *
 * PURE. Dates are 'YYYY-MM-DD' strings, compared as strings; instants are
 * Date or ISO strings. Nothing here reads a clock — "today" is an argument.
 */

export interface PublicationRange {
  id: string;
  publishedAt: Date | string;
  validFrom: string;
  validTo: string;
}

/** A run of consecutive dates that one publication is valid for. */
export interface ValiditySegment {
  publicationId: string;
  from: string;
  to: string;
}

/** The day after / before a 'YYYY-MM-DD', in UTC calendar arithmetic. */
export function nextDay(date: string, delta = 1): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const instant = (value: Date | string): number =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

/** (publishedAt, id) ascending: the order the publications were laid down in. */
export function publicationOrder(a: PublicationRange, b: PublicationRange): number {
  return instant(a.publishedAt) - instant(b.publishedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The segments, earliest first: each later publication is painted over the
 * earlier ones on the dates its range covers. Adjacent pieces of one
 * publication are merged, so a range that a later one only bit the middle
 * out of reads as two segments, not three.
 */
export function effectiveSegments(publications: readonly PublicationRange[]): ValiditySegment[] {
  let segments: ValiditySegment[] = [];
  for (const publication of [...publications].sort(publicationOrder)) {
    const { validFrom: from, validTo: to } = publication;
    if (from > to) continue;
    const next: ValiditySegment[] = [];
    for (const segment of segments) {
      if (segment.to < from || segment.from > to) {
        next.push(segment);
        continue;
      }
      if (segment.from < from) next.push({ ...segment, to: nextDay(from, -1) });
      if (segment.to > to) next.push({ ...segment, from: nextDay(to) });
    }
    next.push({ publicationId: publication.id, from, to });
    segments = next.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }
  const merged: ValiditySegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.publicationId === segment.publicationId && nextDay(last.to) === segment.from) {
      last.to = segment.to;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/** The publication valid on `date`, or null when nothing published covers it. */
export function validOn(publications: readonly PublicationRange[], date: string): string | null {
  for (const segment of effectiveSegments(publications)) {
    if (segment.from <= date && date <= segment.to) return segment.publicationId;
  }
  return null;
}

/**
 * How a new range [from, to] meets one existing segment, judged on the
 * FUTURE part of the segment only (from `today`): a range that replaced the
 * past would replace nothing, because the past is never rewritten.
 *
 *   FULL   the new range covers the segment's future part entirely;
 *   TAIL   it covers the end, leaving the segment valid before it;
 *   HEAD   it covers the start, leaving the segment valid after it;
 *   SPLIT  it lies inside, leaving the segment valid on both sides — two
 *          publications alternating, which is the case an admin rarely means.
 */
export type OverlapKind = 'FULL' | 'TAIL' | 'HEAD' | 'SPLIT';

export interface SegmentOverlap {
  publicationId: string;
  /** The segment's future part, as judged. */
  from: string;
  to: string;
  kind: OverlapKind;
}

export function classifyOverlap(
  segments: readonly ValiditySegment[],
  from: string,
  to: string,
  today: string,
): SegmentOverlap[] {
  const found: SegmentOverlap[] = [];
  for (const segment of segments) {
    const futureFrom = segment.from < today ? today : segment.from;
    if (futureFrom > segment.to) continue; // wholly past
    if (segment.to < from || futureFrom > to) continue; // no overlap
    const keepsBefore = futureFrom < from;
    const keepsAfter = segment.to > to;
    const kind: OverlapKind = keepsBefore && keepsAfter ? 'SPLIT' : keepsBefore ? 'TAIL' : keepsAfter ? 'HEAD' : 'FULL';
    found.push({ publicationId: segment.publicationId, from: futureFrom, to: segment.to, kind });
  }
  return found;
}

/**
 * The dates in [from, to] that no segment covers, as ranges, earliest first —
 * the "gap" an admin leaves when a VT publication starts a week after HT
 * ends. The caller decides which of those dates are school days.
 */
export function uncoveredRanges(
  segments: readonly ValiditySegment[],
  from: string,
  to: string,
): Array<{ from: string; to: string }> {
  const gaps: Array<{ from: string; to: string }> = [];
  let cursor = from;
  for (const segment of [...segments].sort((a, b) => (a.from < b.from ? -1 : 1))) {
    if (segment.to < cursor) continue;
    if (segment.from > to) break;
    if (segment.from > cursor) gaps.push({ from: cursor, to: nextDay(segment.from, -1) < to ? nextDay(segment.from, -1) : to });
    cursor = nextDay(segment.to);
    if (cursor > to) return gaps;
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return gaps;
}
