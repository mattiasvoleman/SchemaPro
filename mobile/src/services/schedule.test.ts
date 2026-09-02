import { getSupabase } from './supabase';
import { entryKey, fetchSchedule, toSections } from './schedule';

jest.mock('./supabase', () => ({ getSupabase: jest.fn() }));

/**
 * A chainable stub shaped like the PostgREST builder, the same one roster.test
 * uses: every call returns itself until the query is awaited. `errors` lets one
 * table fail while the other answers, which is the case this module is most
 * particular about.
 */
function supabaseStub(
  tables: Record<string, unknown[]>,
  errors: Record<string, string> = {},
) {
  const asked: string[] = [];
  const from = jest.fn((table: string) => {
    asked.push(table);
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'gte', 'lte', 'order']) {
      builder[method] = jest.fn(() => builder);
    }
    builder['then'] = (resolve: (value: unknown) => unknown) =>
      resolve(
        errors[table]
          ? { data: null, error: { message: errors[table] } }
          : { data: tables[table] ?? [], error: null },
      );
    return builder;
  });
  (getSupabase as jest.Mock).mockReturnValue({ from });
  return { asked };
}

const MONDAY = '2026-09-07';
const at = (hhmm: string, date = MONDAY) => `${date}T${hhmm}:00.000Z`;

const lesson = (id: string, hhmm: string, date = MONDAY) => ({
  id,
  date,
  startsAt: at(hhmm, date),
  endsAt: at(hhmm, date),
  status: 'SCHEDULED',
  subject: { name: 'Matematik' },
  room: null,
});

const meal = (id: string, hhmm: string, date = MONDAY) => ({
  id,
  date,
  startsAt: at(hhmm, date),
  endsAt: at(hhmm, date),
});

describe('a pupil’s week on the phone', () => {
  it('asks for the meal at all', async () => {
    // The whole defect: three commits built the pupil-facing half of the lunch
    // feature and none of them touched mobile/. This screen queried
    // CalendarLessons and nothing else, so a pupil with a phone had no meal.
    const stub = supabaseStub({});

    await fetchSchedule(new Date(`${MONDAY}T07:00:00.000Z`));

    expect(stub.asked).toContain('CalendarLunches');
  });

  it('puts the meal where it is eaten, not after the afternoon', async () => {
    // Two ordered queries do not interleave on their own. Concatenating them
    // draws the meal below every lesson of the day — the one entry a pupil
    // scans the day for, in the wrong place.
    supabaseStub({
      CalendarLessons: [lesson('l-1', '08:00'), lesson('l-2', '13:00')],
      CalendarLunches: [meal('m-1', '11:40')],
    });

    const entries = await fetchSchedule(new Date(`${MONDAY}T07:00:00.000Z`));

    expect(entries.map((e) => e.id)).toEqual(['l-1', 'm-1', 'l-2']);
  });

  it('keeps the timetable when the meal cannot be read', async () => {
    // A school that has not published its lunch flow, or a policy that will not
    // let this pupil read it, must not cost them the timetable they came for.
    supabaseStub(
      { CalendarLessons: [lesson('l-1', '08:00')] },
      { CalendarLunches: 'permission denied for table CalendarLunches' },
    );

    const entries = await fetchSchedule(new Date(`${MONDAY}T07:00:00.000Z`));

    expect(entries.map((e) => e.id)).toEqual(['l-1']);
  });

  it('still fails loudly when the lessons cannot be read', async () => {
    supabaseStub({}, { CalendarLessons: 'network' });

    await expect(fetchSchedule(new Date(`${MONDAY}T07:00:00.000Z`))).rejects.toThrow(
      'network',
    );
  });

  it('reads a lesson before a meal that starts the same minute', async () => {
    supabaseStub({
      CalendarLessons: [lesson('l-1', '11:40')],
      CalendarLunches: [meal('m-1', '11:40')],
    });

    const entries = await fetchSchedule(new Date(`${MONDAY}T07:00:00.000Z`));

    expect(entries.map((e) => e.kind)).toEqual(['LESSON', 'LUNCH']);
  });
});

describe('the days', () => {
  it('groups by date and keeps the days in order', async () => {
    supabaseStub({
      CalendarLessons: [lesson('l-2', '08:00', '2026-09-08')],
      CalendarLunches: [meal('m-1', '11:40', MONDAY)],
    });

    const sections = toSections(await fetchSchedule(new Date(`${MONDAY}T07:00:00.000Z`)));

    expect(sections.map((s) => s.date)).toEqual([MONDAY, '2026-09-08']);
    expect(sections[0]?.data.map((e) => e.id)).toEqual(['m-1']);
  });

  it('gives a day whose only entry is a meal a section of its own', () => {
    // The web grid used to replace the whole week with "inga lektioner" before
    // the bands were drawn. The list equivalent is dropping the day entirely.
    const sections = toSections([
      { kind: 'LUNCH', id: 'm-1', date: MONDAY, startsAt: at('11:40'), endsAt: at('12:00') },
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.data).toHaveLength(1);
  });

  it('keys the two kinds apart', () => {
    // A SectionList that meets a duplicate key drops whichever row came second.
    const same = { id: 'x', date: MONDAY, startsAt: at('11:40'), endsAt: at('12:00') };
    expect(entryKey({ ...same, kind: 'LUNCH' })).not.toBe(
      entryKey({ ...same, kind: 'LESSON', status: 'SCHEDULED', subject: null, room: null }),
    );
  });
});
