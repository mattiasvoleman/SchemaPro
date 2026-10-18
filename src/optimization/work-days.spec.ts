import {
  DAYS_BEARING_CODES,
  TEACHER_WORK_DAYS_HIDDEN,
  WORK_DAYS_HIDDEN_MESSAGE,
  WorkDaysRefusal,
  forReader,
  isDaysBearing,
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
        forReader(stored({ params: { limit: POST, weekMinutes: 1500 } }), posts([[EVA, { days: 3, name: 'Eva Ek' }]])),
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
      const shown = forReader(stored({ params: { limit: POST, days: 5 } }), posts([[EVA, { days: 3, name: 'Eva Ek' }]]));

      expect(shown.params).toEqual({ limit: POST, days: 3 });
    });

    it('builds the params from nothing when the stored sentence kept none', () => {
      expect(forReader(stored({ params: null }), posts([[EVA, { days: 4, name: 'Eva Ek' }]])).params).toEqual({ days: 4 });
    });

    it('keeps the hidden form for a reader with HR-läs when the post has no limit now, or is gone', () => {
      const hidden = forReader(stored(), posts([[OLLE, { days: 2, name: 'Olle Ås' }]]));

      expect(hidden).toEqual({
        code: TEACHER_WORK_DAYS_HIDDEN,
        params: {},
        message: WORK_DAYS_HIDDEN_MESSAGE,
        names: [],
        revealed: [],
      });
    });

    it('keeps the hidden form when the sentence names nobody the run could resolve', () => {
      expect(forReader(stored({ subjectIds: [] }), posts([[EVA, { days: 3, name: 'Eva Ek' }]])).code).toBe(
        TEACHER_WORK_DAYS_HIDDEN,
      );
    });

    it('shows a sentence about two teachers only when both posts can be read back', () => {
      const both = stored({ subjectIds: [EVA, OLLE] });

      expect(forReader(both, posts([[EVA, { days: 3, name: 'Eva Ek' }]])).code).toBe(TEACHER_WORK_DAYS_HIDDEN);
      expect(
        forReader(
          both,
          posts([
            [EVA, { days: 3, name: 'Eva Ek' }],
            [OLLE, { days: 2, name: 'Olle Ås' }],
          ]),
        ),
      ).toMatchObject({ params: { limit: POST, days: 3 }, names: ['Eva Ek', 'Olle Ås'], revealed: [EVA, OLLE] });
    });
  });
});
