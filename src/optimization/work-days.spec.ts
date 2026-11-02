import {
  CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
  DAYS_BEARING_CODES,
  STRETCH_BEARING_CODES,
  TEACHER_CONSECUTIVE_TEACHING_HIDDEN,
  TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
  TEACHER_WORK_DAYS_HIDDEN,
  WORK_DAYS_HIDDEN_MESSAGE,
  WorkDaysRefusal,
  forReader,
  isDaysBearing,
  isStretchBearing,
  withoutDays,
  type PostShown,
  type StoredSentence,
} from './work-days';

const EVA = '22222222-eeee-4eee-8eee-222222222222';
const OLLE = '33333333-eeee-4eee-8eee-333333333333';
const POST = '44444444-eeee-4eee-8eee-444444444444';

/** A days sentence as the gateway stores it: no figure, the hidden English, its teacher beside it. */
const stored = (overrides: Partial<StoredSentence> = {}): StoredSentence => ({
  code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
  params: { limit: POST },
  message: WORK_DAYS_HIDDEN_MESSAGE,
  subjectIds: [EVA],
  ...overrides,
});

const posts = (entries: Array<[string, PostShown]>): ReadonlyMap<string, PostShown> => new Map(entries);

describe('work-days', () => {
  describe('isDaysBearing', () => {
    it.each(DAYS_BEARING_CODES.map((code) => [code]))('bears the days in %s', (code) => {
      expect(isDaysBearing(code)).toBe(true);
    });

    it.each([
      // The masked sentence says no figure: masking it again would be a loop.
      [TEACHER_WORK_DAYS_HIDDEN],
      // The cap is on the work rule, staff-readable, and stays as it is.
      ['TEACHER_DAILY_CAP_CANNOT_BE_KEPT'],
      // A probe says the limits exist, not whose or how many (amendment A8).
      ['PROBE_SOLVED_WITHOUT_TEACHER_DAY_LIMITS'],
      [''],
      [null],
      [undefined],
    ])('bears none in %p', (code) => {
      expect(isDaysBearing(code)).toBe(false);
    });
  });

  it('drops the days and nothing else', () => {
    expect(withoutDays({ limit: POST, days: 3, weekMinutes: 1500 })).toEqual({ limit: POST, weekMinutes: 1500 });
    expect(withoutDays({})).toEqual({});
  });

  it('keeps a refusal’s teachers off the body Nest answers with', () => {
    const refusal = new WorkDaysRefusal(
      { message: WORK_DAYS_HIDDEN_MESSAGE, code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK', params: { limit: POST } },
      400,
      [EVA],
    );

    expect(refusal.getStatus()).toBe(400);
    expect(refusal.getResponse()).toEqual({
      message: WORK_DAYS_HIDDEN_MESSAGE,
      code: 'TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK',
      params: { limit: POST },
    });
    expect(JSON.stringify(refusal.getResponse())).not.toContain(EVA);
    expect(refusal.subjectIds).toEqual([EVA]);
  });

  describe('forReader', () => {
    it('passes a sentence about anything else through, for every reader', () => {
      const lunch: StoredSentence = {
        code: 'TEACHER_LUNCH_HAS_NOWHERE_TO_GO',
        params: { rule: 'rule-1', minutes: 30, day: 2 },
        message: 'The 30-minute lunch …',
        subjectIds: [],
      };
      const expected = {
        code: 'TEACHER_LUNCH_HAS_NOWHERE_TO_GO',
        params: { rule: 'rule-1', minutes: 30, day: 2 },
        message: 'The 30-minute lunch …',
        names: [],
        revealed: [],
      };

      expect(forReader(lunch, null)).toEqual(expected);
      expect(forReader(lunch, posts([]))).toEqual(expected);
      // A run before the codes: no code, no params, and still its English.
      expect(forReader({ code: null, params: null, message: 'old', subjectIds: [] }, null)).toEqual({
        code: null,
        params: null,
        message: 'old',
        names: [],
        revealed: [],
      });
    });

    it('hides a days sentence from a reader without HR-läs: no figure, no limit, nobody', () => {
      expect(forReader(stored(), null)).toEqual({
        code: TEACHER_WORK_DAYS_HIDDEN,
        params: {},
        message: WORK_DAYS_HIDDEN_MESSAGE,
        names: [],
        revealed: [],
      });
    });

    it('shows a reader with HR-läs the days from the post as it stands, and the teacher', () => {
      expect(
        forReader(stored({ params: { limit: POST, weekMinutes: 1500 } }), posts([[EVA, { days: 3, stretch: null, name: 'Eva Ek' }]])),
      ).toEqual({
        code: 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT',
        params: { limit: POST, weekMinutes: 1500, days: 3 },
        message: WORK_DAYS_HIDDEN_MESSAGE,
        names: ['Eva Ek'],
        revealed: [EVA],
      });
    });

    it('reads the figure from the post, never from a stored one', () => {
      // No row is written with one; a hand-edited row that has one must not be
      // the number shown.
      const shown = forReader(stored({ params: { limit: POST, days: 5 } }), posts([[EVA, { days: 3, stretch: null, name: 'Eva Ek' }]]));

      expect(shown.params).toEqual({ limit: POST, days: 3 });
    });

    it('builds the params from nothing when the stored sentence kept none', () => {
      expect(forReader(stored({ params: null }), posts([[EVA, { days: 4, stretch: null, name: 'Eva Ek' }]])).params).toEqual({ days: 4 });
    });

    it('keeps the hidden form for a reader with HR-läs when the post has no limit now, or is gone', () => {
      const hidden = forReader(stored(), posts([[OLLE, { days: 2, stretch: null, name: 'Olle Ås' }]]));

      expect(hidden).toEqual({
        code: TEACHER_WORK_DAYS_HIDDEN,
        params: {},
        message: WORK_DAYS_HIDDEN_MESSAGE,
        names: [],
        revealed: [],
      });
    });

    it('keeps the hidden form when the sentence names nobody the run could resolve', () => {
      expect(forReader(stored({ subjectIds: [] }), posts([[EVA, { days: 3, stretch: null, name: 'Eva Ek' }]])).code).toBe(
        TEACHER_WORK_DAYS_HIDDEN,
      );
    });

    it('shows a sentence about two teachers only when both posts can be read back', () => {
      const both = stored({ subjectIds: [EVA, OLLE] });

      expect(forReader(both, posts([[EVA, { days: 3, stretch: null, name: 'Eva Ek' }]])).code).toBe(TEACHER_WORK_DAYS_HIDDEN);
      expect(
        forReader(
          both,
          posts([
            [EVA, { days: 3, stretch: null, name: 'Eva Ek' }],
            [OLLE, { days: 2, stretch: null, name: 'Olle Ås' }],
          ]),
        ),
      ).toMatchObject({ params: { limit: POST, days: 3 }, names: ['Eva Ek', 'Olle Ås'], revealed: [EVA, OLLE] });
    });
  });
  describe('the limit on teaching in a row (20261218090000), read by the rule of the days', () => {
    /** A note as the gateway stores it: the weekday and the length, no figure of the limit, Eva beside it. */
    const note = (overrides: Partial<StoredSentence> = {}): StoredSentence => ({
      code: TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
      params: { day: 2, minutes: 250 },
      message: 'A teacher with a limit on teaching in a row has 250 minutes in a row on Tuesdays …',
      subjectIds: [EVA],
      ...overrides,
    });
    const evasLimit: PostShown = { days: null, stretch: { max: 180, breakMinutes: 30 }, name: 'Eva Ek' };

    it('bears the limit in the note, and in nothing else', () => {
      expect(STRETCH_BEARING_CODES).toEqual([TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT]);
      expect(isStretchBearing(TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT)).toBe(true);
      // The masked note says no figure: masking it again would be a loop. And the days are not the limit.
      for (const code of [TEACHER_CONSECUTIVE_TEACHING_HIDDEN, 'TEACHER_WORK_DAYS_CANNOT_BE_KEPT', 'TEACHER_FREE_DAY_WISH_NOT_KEPT', null, undefined]) {
        expect(isStretchBearing(code)).toBe(false);
      }
    });

    it('hides the note from a reader without HR-läs: no teacher, no weekday, no length, no figure', () => {
      expect(forReader(note(), null)).toEqual({
        code: TEACHER_CONSECUTIVE_TEACHING_HIDDEN,
        params: {},
        message: CONSECUTIVE_TEACHING_HIDDEN_MESSAGE,
        names: [],
        revealed: [],
      });
      expect(CONSECUTIVE_TEACHING_HIDDEN_MESSAGE).not.toMatch(/\d/);
    });

    it('shows a reader with HR-läs the limit and the pause from the post as it stands, and the teacher', () => {
      expect(forReader(note(), posts([[EVA, evasLimit]]))).toEqual({
        code: TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
        params: { day: 2, minutes: 250, max: 180, breakMinutes: 30 },
        message: note().message,
        names: ['Eva Ek'],
        revealed: [EVA],
      });
    });

    it('reads the figures from the post, never from a stored one', () => {
      const shown = forReader(
        note({ params: { day: 2, minutes: 250, max: 90, breakMinutes: 5 } }),
        posts([[EVA, evasLimit]]),
      );
      expect(shown.params).toEqual({ day: 2, minutes: 250, max: 180, breakMinutes: 30 });
    });

    it('keeps the hidden form for a reader with HR-läs when the post has no limit now (days alone do not count), or is gone', () => {
      for (const read of [
        posts([[EVA, { days: 3, stretch: null, name: 'Eva Ek' }]]),
        posts([[OLLE, evasLimit]]),
        posts([]),
      ]) {
        expect(forReader(note(), read)).toMatchObject({ code: TEACHER_CONSECUTIVE_TEACHING_HIDDEN, names: [], revealed: [] });
      }
      expect(forReader(note({ subjectIds: [] }), posts([[EVA, evasLimit]])).code).toBe(TEACHER_CONSECUTIVE_TEACHING_HIDDEN);
    });

    it('does not mistake a post with a limit for a days limit, nor the other way round', () => {
      // A post with a limit alone has no days to read back for a days sentence …
      expect(forReader(stored(), posts([[EVA, evasLimit]])).code).toBe(TEACHER_WORK_DAYS_HIDDEN);
      // … and one with days alone has no limit for a note.
      expect(forReader(note(), posts([[EVA, { days: 3, stretch: null, name: 'Eva Ek' }]])).code).toBe(
        TEACHER_CONSECUTIVE_TEACHING_HIDDEN,
      );
      // A post with both is read back for each by its own figure.
      const both: PostShown = { days: 3, stretch: { max: 120, breakMinutes: 15 }, name: 'Eva Ek' };
      expect(forReader(stored(), posts([[EVA, both]])).params).toMatchObject({ days: 3 });
      expect(forReader(note(), posts([[EVA, both]])).params).toMatchObject({ max: 120, breakMinutes: 15 });
    });
  });
});
