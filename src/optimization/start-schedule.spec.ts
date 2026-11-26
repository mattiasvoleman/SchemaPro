import {
  START_DROP_REASONS,
  startedFromOf,
  startLessonsOf,
  startOutcomeOf,
  type SourceLesson,
  type StartPost,
} from './start-schedule';

/*
 * Ett schema som start (M9): the two pure halves. A lesson of a schedule is matched to a post of THIS week by its group,
 * its subject and the weeks it ran, and the engine's answer is set against what it was given.
 */

const G7A = 'g-7a';
const G7B = 'g-7b';
const MATH = 's-math';
const SWE = 's-swe';

const post = (id: string, group: string, subject: string, over: Partial<StartPost> = {}): StartPost => ({
  id,
  studentGroupId: group,
  subjectId: subject,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...over,
});

const lesson = (group: string, subject: string, day: number, start: string, end: string, over: Partial<SourceLesson> = {}): SourceLesson => ({
  studentGroupId: group,
  subjectId: subject,
  dayOfWeek: day,
  startTime: start,
  endTime: end,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...over,
});

const sent = (id: string, lessonsPerWeek: number, over: object = {}) => ({ id, lessonsPerWeek, ...over });

const POSTS = [post('p-math', G7A, MATH), post('p-swe', G7A, SWE), post('p-math-b', G7B, MATH)];
const ANON = new Map([
  ['p-math', 'a-math'],
  ['p-swe', 'a-swe'],
  ['p-math-b', 'a-math-b'],
]);
const WEEK = [sent('a-math', 3), sent('a-swe', 2), sent('a-math-b', 3)];

describe('startLessonsOf', () => {
  it('gives each lesson as an entry of its post, with seconds on the clock and the end that says its length', () => {
    const mapping = startLessonsOf(POSTS, ANON, WEEK, [
      lesson(G7A, MATH, 1, '08:00', '08:50'),
      lesson(G7A, SWE, 2, '09:00:00', '09:50:00'),
    ]);

    expect(mapping.entries).toEqual([
      { requirementId: 'a-math', dayOfWeek: 1, startTime: '08:00:00', endTime: '08:50:00' },
      { requirementId: 'a-swe', dayOfWeek: 2, startTime: '09:00:00', endTime: '09:50:00' },
    ]);
    expect(mapping.offered).toBe(2);
    expect(mapping.dropped).toEqual({});
  });

  it('leaves out, and counts, a lesson whose group and subject have no post this year', () => {
    const mapping = startLessonsOf(POSTS, ANON, WEEK, [lesson('g-gone', MATH, 1, '08:00', '08:50'), lesson(G7A, 's-art', 1, '09:00', '09:50')]);

    expect(mapping.entries).toEqual([]);
    expect(mapping.dropped).toEqual({ NO_POST: 2 });
    expect(mapping.offered).toBe(2);
  });

  it('says OTHER_WEEKS when the post runs in other weeks than the lesson did, and matches the post whose weeks they were', () => {
    const posts = [
      post('p-odd', G7A, MATH, { recurrence: 'ODD_WEEKS' }),
      post('p-even', G7A, MATH, { recurrence: 'EVEN_WEEKS' }),
    ];
    const anon = new Map([
      ['p-odd', 'a-odd'],
      ['p-even', 'a-even'],
    ]);
    const week = [sent('a-odd', 1), sent('a-even', 1)];

    const mapping = startLessonsOf(posts, anon, week, [
      lesson(G7A, MATH, 1, '08:00', '08:50', { recurrence: 'EVEN_WEEKS' }),
      lesson(G7A, MATH, 2, '08:00', '08:50', { recurrence: 'ALL_WEEKS' }),
    ]);

    expect(mapping.entries.map((entry) => entry.requirementId)).toEqual(['a-even']);
    expect(mapping.dropped).toEqual({ OTHER_WEEKS: 1 });
  });

  it('reads a snapshot lesson with no recurrence as every week', () => {
    const mapping = startLessonsOf(POSTS, ANON, WEEK, [lesson(G7A, MATH, 1, '08:00', '08:50', { recurrence: null })]);

    expect(mapping.entries).toHaveLength(1);
  });

  it('holds a dated post to the dates of the lesson: a lesson of the autumn does not start the spring post', () => {
    const posts = [
      post('p-aut', G7A, MATH, { startDate: '2026-08-17', endDate: '2026-12-18' }),
      post('p-spr', G7A, MATH, { startDate: '2027-01-11', endDate: '2027-06-11' }),
    ];
    const anon = new Map([
      ['p-aut', 'a-aut'],
      ['p-spr', 'a-spr'],
    ]);

    const mapping = startLessonsOf(posts, anon, [sent('a-aut', 1), sent('a-spr', 1)], [
      lesson(G7A, MATH, 3, '10:00', '10:50', { startDate: '2027-01-11', endDate: '2027-06-11' }),
    ]);

    expect(mapping.entries).toEqual([{ requirementId: 'a-spr', dayOfWeek: 3, startTime: '10:00:00', endTime: '10:50:00' }]);
  });

  it('refuses to guess between two posts of the same group, subject and weeks: AMBIGUOUS', () => {
    const posts = [post('p-1', G7A, MATH), post('p-2', G7A, MATH)];
    const anon = new Map([
      ['p-1', 'a-1'],
      ['p-2', 'a-2'],
    ]);

    const mapping = startLessonsOf(posts, anon, [sent('a-1', 2), sent('a-2', 2)], [lesson(G7A, MATH, 1, '08:00', '08:50')]);

    expect(mapping.entries).toEqual([]);
    expect(mapping.dropped).toEqual({ AMBIGUOUS: 1 });
  });

  it('says NOT_IN_WEEK for a post the payload does not send (every lesson of it is locked) and for one with no anonymous id', () => {
    const mapping = startLessonsOf(POSTS, ANON, [sent('a-swe', 2)], [lesson(G7A, MATH, 1, '08:00', '08:50'), lesson(G7A, SWE, 1, '09:00', '09:50')]);
    expect(mapping.entries.map((entry) => entry.requirementId)).toEqual(['a-swe']);
    expect(mapping.dropped).toEqual({ NOT_IN_WEEK: 1 });

    const unmapped = startLessonsOf(POSTS, new Map(), WEEK, [lesson(G7A, MATH, 1, '08:00', '08:50')]);
    expect(unmapped.dropped).toEqual({ NOT_IN_WEEK: 1 });
  });

  it('does not start a post the engine would not: split lessons and pinned lessons', () => {
    const week = [sent('a-math', 3, { lessonTeacherIds: ['t-1', null, 't-2'] }), sent('a-swe', 2, { pinnedLessons: [null, null] }), sent('a-math-b', 3)];

    const mapping = startLessonsOf(POSTS, ANON, week, [
      lesson(G7A, MATH, 1, '08:00', '08:50'),
      lesson(G7A, SWE, 1, '09:00', '09:50'),
      lesson(G7B, MATH, 1, '08:00', '08:50'),
    ]);

    expect(mapping.entries.map((entry) => entry.requirementId)).toEqual(['a-math-b']);
    expect(mapping.dropped).toEqual({ NOT_STARTABLE: 2 });
  });

  it('gives no more entries for a post than the week asks of it, the same ones whatever order the source listed them in', () => {
    const week = [sent('a-math', 2), sent('a-swe', 2), sent('a-math-b', 3)];
    const lessons = [
      lesson(G7A, MATH, 4, '08:00', '08:50'),
      lesson(G7A, MATH, 1, '08:00', '08:50'),
      lesson(G7A, MATH, 3, '08:00', '08:50'),
    ];

    const forward = startLessonsOf(POSTS, ANON, week, lessons);
    const backward = startLessonsOf(POSTS, ANON, week, [...lessons].reverse());

    expect(forward.entries.map((entry) => entry.dayOfWeek)).toEqual([1, 3]);
    expect(backward.entries).toEqual(forward.entries);
    expect(forward.dropped).toEqual({ MORE_THAN_ASKED: 1 });
  });

  it('counts what the source could not map into the same totals', () => {
    const mapping = startLessonsOf(POSTS, ANON, WEEK, [lesson(G7A, MATH, 1, '08:00', '08:50')], {
      offered: 3,
      dropped: { NO_SUCCESSOR: 3 },
    });

    expect(mapping.offered).toBe(4);
    expect(mapping.dropped).toEqual({ NO_SUCCESSOR: 3 });
    expect(mapping.entries).toHaveLength(1);
  });

  it('never changes what it was given', () => {
    const lessons = [lesson(G7A, MATH, 4, '08:00', '08:50'), lesson(G7A, MATH, 1, '08:00', '08:50')];
    const before = JSON.stringify(lessons);
    startLessonsOf(POSTS, ANON, WEEK, lessons, { offered: 0, dropped: {} });
    expect(JSON.stringify(lessons)).toBe(before);
  });
});

describe('startOutcomeOf', () => {
  const entry = (requirementId: string, day: number, start: string, end: string) => ({ requirementId, dayOfWeek: day as 1, startTime: start, endTime: end });
  const placed = (requirementId: string, day: number, start: string, end: string) => ({ requirementId, dayOfWeek: day as 1, startTime: start, endTime: end });

  it('holds what stands where the schedule had it, moves what stands elsewhere and lays what had nothing to replace', () => {
    const entries = [entry('a', 1, '08:00:00', '08:50:00'), entry('a', 2, '08:00:00', '08:50:00'), entry('b', 3, '09:00:00', '09:50:00')];
    const answer = [
      placed('a', 1, '08:00:00', '08:50:00'), // held
      placed('a', 4, '10:00:00', '10:50:00'), // moved (a's Tuesday lesson left)
      placed('b', 3, '09:00:00', '09:50:00'), // held
      placed('c', 5, '13:00:00', '13:50:00'), // laid: c had no entry
    ];

    expect(startOutcomeOf(entries, answer)).toEqual({ held: 2, moved: 1, laid: 1 });
  });

  it('counts a lesson the answer has more of than the schedule gave as laid, and one the answer lacks as nothing', () => {
    const entries = [entry('a', 1, '08:00:00', '08:50:00')];
    const answer = [placed('a', 1, '08:00:00', '08:50:00'), placed('a', 2, '08:00:00', '08:50:00'), placed('a', 3, '08:00:00', '08:50:00')];

    expect(startOutcomeOf(entries, answer)).toEqual({ held: 1, moved: 0, laid: 2 });
    expect(startOutcomeOf([entry('a', 1, '08:00:00', '08:50:00'), entry('a', 2, '08:00:00', '08:50:00')], [])).toEqual({ held: 0, moved: 0, laid: 0 });
  });

  it('tells the same time from the same time written with and without seconds', () => {
    expect(startOutcomeOf([entry('a', 1, '08:00:00', '08:50:00')], [placed('a', 1, '08:00', '08:50')])).toEqual({ held: 1, moved: 0, laid: 0 });
  });

  it('does not count a lesson at the same start but another length as held: the end is the lesson', () => {
    expect(startOutcomeOf([entry('a', 1, '08:00:00', '08:50:00')], [placed('a', 1, '08:00:00', '09:00:00')])).toEqual({ held: 0, moved: 1, laid: 0 });
  });

  it('puts every lesson of the answer in exactly one of the three', () => {
    for (let round = 0; round < 40; round += 1) {
      const entries = Array.from({ length: (round * 7) % 9 }, (_, index) => entry(`r${index % 3}`, 1 + ((index + round) % 5), '08:00:00', '08:50:00'));
      const answer = Array.from({ length: (round * 5) % 11 }, (_, index) => placed(`r${index % 4}`, 1 + ((index * 2 + round) % 5), '08:00:00', '08:50:00'));

      const { held, moved, laid } = startOutcomeOf(entries, answer);

      expect(held + moved + laid).toBe(answer.length);
      expect(held).toBeGreaterThanOrEqual(0);
      expect(moved).toBeGreaterThanOrEqual(0);
      expect(laid).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('startedFromOf', () => {
  const stored = {
    source: 'VERSION',
    versionName: 'Före Generera',
    engine: 'USED',
    offered: 120,
    used: 118,
    held: 104,
    moved: 12,
    laid: 2,
    dropped: { NO_POST: 2 },
  };

  it('reads a row as it was stored', () => {
    expect(startedFromOf(stored)).toEqual(stored);
  });

  it('drops every key it does not know, and a reason it does not know', () => {
    const read = startedFromOf({ ...stored, secret: 'x', dropped: { NO_POST: 2, A_NEW_REASON: 5, NOT_IN_WEEK: 0 } });

    expect(read).toEqual({ ...stored, dropped: { NO_POST: 2 } });
    expect(Object.keys(read!)).not.toContain('secret');
  });

  it.each([null, undefined, 'text', 7, [], {}, { ...stored, source: 'FILE' }, { ...stored, engine: 'NEWER' }, { ...stored, offered: -1 }, { ...stored, used: 1.5 }])(
    'is null for a column that is not wholly well formed (%j)',
    (bad) => {
      expect(startedFromOf(bad)).toBeNull();
    },
  );

  it('reads a count it does not trust as null rather than as zero', () => {
    expect(startedFromOf({ ...stored, held: 'many', moved: null })).toMatchObject({ held: null, moved: null, laid: 2 });
  });

  it('cuts a version name that is longer than it keeps', () => {
    expect(startedFromOf({ ...stored, versionName: 'v'.repeat(500) })!.versionName).toHaveLength(120);
  });

  it('cuts a version name between characters, never in the middle of one that takes two UTF-16 units: the cut name is valid JSON for the database', () => {
    const name = `${'a'.repeat(119)}😀${'b'.repeat(20)}`;

    const cut = startedFromOf({ ...stored, versionName: name })!.versionName!;

    expect(Array.from(cut)).toHaveLength(120);
    expect(cut.endsWith('😀')).toBe(true);
    expect(JSON.stringify({ versionName: cut })).not.toMatch(/\\ud[89ab][0-9a-f]{2}"/i);
  });

  it('knows the seven reasons the page has a sentence for', () => {
    expect([...START_DROP_REASONS].sort()).toEqual(
      ['AMBIGUOUS', 'MORE_THAN_ASKED', 'NOT_IN_WEEK', 'NOT_STARTABLE', 'NO_POST', 'NO_SUCCESSOR', 'OTHER_WEEKS'].sort(),
    );
  });
});
