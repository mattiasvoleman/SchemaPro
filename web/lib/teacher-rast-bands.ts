/*
 * The teacher page's rast bands: a module of its own, not a function in
 * lib/rasts.ts, for the bundle. lib/rasts.ts is on the timetable's first load
 * through rastWindows, and Turbopack keeps a module whole, so this function
 * was paid for by every route that draws rasts while only /teacher calls it.
 */

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
