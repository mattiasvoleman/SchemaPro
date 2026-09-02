import type { GradeSpan } from "@/lib/grade-span";
import { timeToMinutes } from "@/lib/utils";

/**
 * A rast: minutes of a day one stage of the school is not taught.
 *
 * Mirrors the row in Rasts and the engine's `Rast`. Clock strings are HH:MM:SS
 * as PostgREST returns them.
 */
export interface Rast {
  id: string;
  name: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  /** ISO weekday 1-7, or null for every teaching day. */
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
}

/** A rast resolved onto a clock, in minutes from midnight. */
export interface RastWindow {
  id: string;
  name: string;
  startMinutes: number;
  endMinutes: number;
}

/**
 * The rasts that bind one stage on one weekday.
 *
 * TWO RULES, and both are the engine's — see
 * optimization-engine/app/solver/rasts.py, which owns them. A second
 * implementation here is a deliberate cost, the same one lib/lunch-servings.ts
 * pays: the admin page's whole value is showing a school what its rows ADD UP
 * TO, and a preview computed by a different rule than the solver's is worse
 * than no preview.
 *
 *   MATCHING IS OVERLAP, not containment. A 6-7 group has year-6 children in
 *   it, so a 4-6 rast reaches them and the group is bound by it — the same test
 *   frames and servings make, for the same reason.
 *
 *   A DAY-SPECIFIC ROW SHADOWS ONLY THE EVERY-DAY ROWS IT OVERLAPS. This is
 *   where a rast parts company with a sitting, and it is not a detail.
 *   servings.py replaces every every-day row for a day that has a day-specific
 *   one, which is safe where one sitting per stage is the norm. Several rasts a
 *   day is the norm HERE: a school with a morning, a lunch-adjacent and an
 *   afternoon rast that adds "fredag 09:20-09:40" would, under the serving
 *   rule, silently lose the other two every Friday — and the engine would
 *   schedule straight through them, and publish would write a Friday with one
 *   rast to every pupil in the stage. Overlap is the narrowest rule that still
 *   lets a school say "on Friday the morning rast is different".
 *
 * An empty result means no rast speaks about this stage that day, which is a
 * school that has declared none — not an error, and not something to warn about.
 */
export function rastsFor(
  rasts: Rast[],
  span: GradeSpan | undefined,
  dayOfWeek: number,
): Rast[] {
  if (!span) return [];

  const matching = rasts.filter(
    (rast) => span.max >= rast.minGradeLevel && span.min <= rast.maxGradeLevel,
  );
  const today = matching.filter((rast) => rast.dayOfWeek === dayOfWeek);
  const everyDay = matching.filter((rast) => rast.dayOfWeek === null);

  const survivors = everyDay.filter(
    (rast) => !today.some((specific) => overlaps(rast, specific)),
  );
  return [...today, ...survivors].sort(
    (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime),
  );
}

function overlaps(a: Rast, b: Rast): boolean {
  return (
    timeToMinutes(a.startTime) < timeToMinutes(b.endTime) &&
    timeToMinutes(b.startTime) < timeToMinutes(a.endTime)
  );
}

/**
 * The same rasts as windows on a clock, merged where they touch or overlap.
 *
 * Merged because two rows that meet are one break to a reader, and drawing them
 * as two abutting stripes says the school has two rasts where it has one long
 * one. The merged window keeps the earlier row's name, which is the one a
 * school reads first.
 */
export function rastWindows(
  rasts: Rast[],
  span: GradeSpan | undefined,
  dayOfWeek: number,
): RastWindow[] {
  const ordered = rastsFor(rasts, span, dayOfWeek).map((rast) => ({
    id: rast.id,
    name: rast.name,
    startMinutes: timeToMinutes(rast.startTime),
    endMinutes: timeToMinutes(rast.endTime),
  }));

  const merged: RastWindow[] = [];
  for (const window of ordered) {
    const last = merged[merged.length - 1];
    if (last && window.startMinutes <= last.endMinutes) {
      last.endMinutes = Math.max(last.endMinutes, window.endMinutes);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

/**
 * Whether a lesson lies across a rast the same stage must observe.
 *
 * The question the timetable asks of a hand-placed lesson. Half-open on both
 * sides: a lesson ending exactly when the rast begins is not across it, which
 * is the same rule every other clash in lib/conflicts.ts uses.
 */
export function crossesARast(
  windows: RastWindow[],
  startMinutes: number,
  endMinutes: number,
): RastWindow | null {
  return (
    windows.find(
      (window) => startMinutes < window.endMinutes && window.startMinutes < endMinutes,
    ) ?? null
  );
}

/**
 * The rasts a teacher observes, one band per distinct window.
 *
 * A teacher is not in a stage; they cross several. Drawing a band only where
 * every stage they teach agrees would give the teacher who takes åk 3 in the
 * morning and åk 8 in the afternoon NO band at all — precisely the person who
 * most needs to see two different breaks. So every window is drawn.
 *
 * Windows that coincide are ONE band: three classes of åk 4-6 published the
 * same 09:40-10:00 rast, and three identical stripes on one column would read
 * as three breaks. Where two windows share a NAME on the same day, the classes
 * are appended so the pair can be told apart — a bare "Förmiddagsrast" twice on
 * one column says less than nothing.
 *
 * `published` are CalendarRast rows narrowed to the classes this teacher
 * actually teaches that week; the caller does that narrowing, because only it
 * knows the week's lessons.
 */
export function teacherRastBands(
  published: Array<{
    id: string;
    studentGroupId: string;
    name: string;
    date: string;
    startsAt: string;
    endsAt: string;
  }>,
  groupNameOf: Map<string, string>,
  toBand: (row: {
    id: string;
    studentGroupId: string;
    name: string;
    date: string;
    startsAt: string;
    endsAt: string;
  }) => {
    id: string;
    dayOfWeek: number;
    startMinutes: number;
    endMinutes: number;
    label: string;
  },
): Array<{
  id: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  label: string;
}> {
  const byWindow = new Map<
    string,
    { band: ReturnType<typeof toBand>; groups: Set<string> }
  >();
  for (const row of published) {
    const band = toBand(row);
    const key = `${band.dayOfWeek}:${band.startMinutes}:${band.endMinutes}:${row.name}`;
    const seen = byWindow.get(key);
    if (seen) seen.groups.add(row.studentGroupId);
    else byWindow.set(key, { band, groups: new Set([row.studentGroupId]) });
  }

  const namesPerDay = new Map<string, number>();
  for (const { band } of byWindow.values()) {
    const key = `${band.dayOfWeek}:${band.label}`;
    namesPerDay.set(key, (namesPerDay.get(key) ?? 0) + 1);
  }

  return [...byWindow.values()].map(({ band, groups }) => {
    const ambiguous = (namesPerDay.get(`${band.dayOfWeek}:${band.label}`) ?? 0) > 1;
    if (!ambiguous) return band;
    const names = [...groups]
      .map((id) => groupNameOf.get(id))
      .filter((name): name is string => Boolean(name))
      .sort();
    return names.length > 0 ? { ...band, label: `${band.label} · ${names.join(", ")}` } : band;
  });
}
