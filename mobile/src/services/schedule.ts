import { getSupabase } from './supabase';

/**
 * A pupil's week, lessons and meals together.
 *
 * The meal lives in its own table — CalendarLunches, not CalendarLessons —
 * because everything downstream of a lesson assumes teaching: the SS12000
 * export stamps `activityType: 'Undervisning'` on every row it sends the
 * kommun, and the guardian's unexplained-absence mail interpolates the
 * subject's name, so a lunch filed as a lesson would tell a parent their child
 * was absent from "Lunch". Two tables is the price of that, and the price is
 * paid here: two queries, one list.
 *
 * This module exists at all because the screen could not be tested. The web
 * pupil page grew a lunch band in the same week the feature shipped and mobile
 * got nothing — no query, no type, no component — and nothing failed, because
 * jest.config.js renders no screens by design. The fetching and the merging are
 * the part where a mistake is invisible until a pupil's phone is already wrong,
 * so they live where the runner can reach them.
 */

export interface LessonEntry {
  readonly kind: 'LESSON';
  readonly id: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  readonly subject: { name: string } | null;
  readonly room: { name: string } | null;
}

export interface LunchEntry {
  readonly kind: 'LUNCH';
  readonly id: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export type ScheduleEntry = LessonEntry | LunchEntry;

export interface ScheduleSection {
  readonly date: string;
  readonly data: readonly ScheduleEntry[];
}

/** The window both queries ask about: today and the seven days after it. */
function window(now: Date): { from: string; to: string } {
  const to = new Date(now);
  to.setDate(to.getDate() + 7);
  return { from: now.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * Both tables, in one list, ordered by when they start.
 *
 * Sorted here rather than by the database: two ordered queries do not interleave
 * on their own, and a meal that arrived after the afternoon's lessons would be
 * drawn under them — the one entry a pupil scans the day for, in the wrong
 * place. Ties break lesson-first, so a lesson that ends exactly when the meal
 * starts still reads in the order it is lived.
 */
export async function fetchSchedule(now: Date = new Date()): Promise<ScheduleEntry[]> {
  const { from, to } = window(now);
  const supabase = getSupabase();

  const [lessons, lunches] = await Promise.all([
    supabase
      .from('CalendarLessons')
      .select('id, date, startsAt, endsAt, status, subject:Subjects(name), room:Rooms(name)')
      .gte('date', from)
      .lte('date', to)
      .order('startsAt'),
    supabase
      .from('CalendarLunches')
      .select('id, date, startsAt, endsAt')
      .gte('date', from)
      .lte('date', to)
      .order('startsAt'),
  ]);

  if (lessons.error) throw new Error(lessons.error.message);
  /*
   * A failed MEAL query is not a failed screen.
   *
   * The lessons are the schedule; the meal is one stripe in it. A school that
   * has not published its lunch flow, or a policy that will not let this pupil
   * read it, must not cost them the timetable they came for — which is exactly
   * what a shared `throw` would do.
   */
  const lunchRows = lunches.error ? [] : ((lunches.data ?? []) as LunchEntry[]);

  const entries: ScheduleEntry[] = [
    ...((lessons.data ?? []) as unknown as Omit<LessonEntry, 'kind'>[]).map(
      (row) => ({ ...row, kind: 'LESSON' as const }),
    ),
    ...lunchRows.map((row) => ({
      id: row.id,
      date: row.date,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      kind: 'LUNCH' as const,
    })),
  ];

  entries.sort((a, b) => {
    if (a.startsAt !== b.startsAt) return a.startsAt < b.startsAt ? -1 : 1;
    return a.kind === b.kind ? 0 : a.kind === 'LESSON' ? -1 : 1;
  });
  return entries;
}

/**
 * One section per day, in date order, keeping each day's order intact.
 *
 * Keyed on the date rather than on a formatted title: two days can render the
 * same label under a locale that omits the year, and a SectionList given two
 * sections with one key drops one of them.
 */
export function toSections(entries: readonly ScheduleEntry[]): ScheduleSection[] {
  const byDate = new Map<string, ScheduleEntry[]>();
  for (const entry of entries) {
    const key = entry.date.slice(0, 10);
    const list = byDate.get(key);
    if (list) list.push(entry);
    else byDate.set(key, [entry]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, data]) => ({ date, data }));
}

/**
 * A stable key across both kinds.
 *
 * A lesson id and a meal id are both uuids from different tables, so they can
 * collide only by accident — but a SectionList that meets a duplicate key drops
 * a row silently, and the row it drops is whichever came second.
 */
export function entryKey(entry: ScheduleEntry): string {
  return `${entry.kind}:${entry.id}`;
}
