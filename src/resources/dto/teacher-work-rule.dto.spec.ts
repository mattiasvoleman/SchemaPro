import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpsertTeacherWorkRuleDto } from './teacher-work-rule.dto';

/** The suggested arbetstid: 30 minutes inside 10:30-13:30, and 11 hours of rest. */
const base = {
  lunchMinutes: 30,
  lunchStartTime: '10:30',
  lunchEndTime: '13:30',
  minDailyRestMinutes: 660,
};

/** The properties that failed validation. */
const failing = async (body: object) =>
  (await validate(plainToInstance(UpsertTeacherWorkRuleDto, body))).map(
    (error) => error.property,
  );

describe('UpsertTeacherWorkRuleDto limits', () => {
  it('accepts the values the form suggests, and an empty body', async () => {
    // An empty body is a teacher with no rules at all, which is every teacher in
    // every school today. It has to validate, or the feature cannot be deployed
    // before somebody has decided what to put in it.
    await expect(failing(base)).resolves.toEqual([]);
    await expect(failing({})).resolves.toEqual([]);
  });

  it('reads an explicit null as the rule not applying', async () => {
    // How a school takes a rule away again. `@IsOptional` skips null as well as
    // undefined, so both spellings mean the same thing — and they have to, since
    // a PUT that replaces the whole row needs a way to say "no lunch rule" out
    // loud rather than by omission.
    await expect(
      failing({
        lunchMinutes: null,
        lunchStartTime: null,
        lunchEndTime: null,
        minDailyRestMinutes: null,
      }),
    ).resolves.toEqual([]);
  });

  describe('lunchMinutes mirrors the table CHECK, bound for bound', () => {
    it('accepts the ends of the range', async () => {
      await expect(failing({ ...base, lunchMinutes: 5 })).resolves.toEqual([]);
      await expect(
        failing({ ...base, lunchMinutes: 240, lunchEndTime: '14:30' }),
      ).resolves.toEqual([]);
    });

    it('refuses a lunch nobody can eat and one that is not a lunch', async () => {
      await expect(failing({ ...base, lunchMinutes: 4 })).resolves.toEqual([
        'lunchMinutes',
      ]);
      await expect(failing({ ...base, lunchMinutes: 241 })).resolves.toEqual([
        'lunchMinutes',
      ]);
    });

    it('refuses a length off the solver grid, so five is the step everywhere', async () => {
      // 7 is inside 5..240 and cannot be laid on a five-minute grid. Without this
      // it would save, look reasonable, and fail on every generation — which is
      // the failure this whole feature is built to avoid producing.
      await expect(failing({ ...base, lunchMinutes: 7 })).resolves.toEqual([
        'lunchMinutes',
      ]);
      await expect(failing({ ...base, lunchMinutes: 32 })).resolves.toEqual([
        'lunchMinutes',
      ]);
    });

    it('refuses a length that is not a whole number of minutes', async () => {
      await expect(failing({ ...base, lunchMinutes: 30.5 })).resolves.toEqual([
        'lunchMinutes',
      ]);
      await expect(failing({ ...base, lunchMinutes: 'en halvtimme' })).resolves.toEqual([
        'lunchMinutes',
      ]);
    });
  });

  describe('the window is a clock, in either precision', () => {
    it('accepts HH:MM and HH:MM:SS', async () => {
      await expect(
        failing({ ...base, lunchStartTime: '10:30:00', lunchEndTime: '13:30:00' }),
      ).resolves.toEqual([]);
    });

    it('refuses anything that is not one', async () => {
      await expect(failing({ ...base, lunchStartTime: '10.30' })).resolves.toEqual([
        'lunchStartTime',
      ]);
      await expect(
        failing({ ...base, lunchEndTime: '1970-01-01T13:30:00.000Z' }),
      ).resolves.toEqual(['lunchEndTime']);
    });
  });

  describe('minDailyRestMinutes mirrors the table CHECK, bound for bound', () => {
    it('accepts the ends of the range', async () => {
      await expect(failing({ ...base, minDailyRestMinutes: 60 })).resolves.toEqual([]);
      await expect(failing({ ...base, minDailyRestMinutes: 1320 })).resolves.toEqual([]);
    });

    it('refuses a rest that is no rest, and one no two days can satisfy', async () => {
      // 1321 rather than 1440 as the upper probe: the bound has to bite at the
      // number next to it, not merely somewhere above.
      await expect(failing({ ...base, minDailyRestMinutes: 59 })).resolves.toEqual([
        'minDailyRestMinutes',
      ]);
      await expect(failing({ ...base, minDailyRestMinutes: 1321 })).resolves.toEqual([
        'minDailyRestMinutes',
      ]);
    });

    it('is not held to the five-minute grid', async () => {
      // Unlike the lunch: a rest is a DURATION the solver compares against, not a
      // block it has to place on the grid, so 661 minutes is a perfectly
      // answerable question and refusing it would be a rule nobody asked for.
      await expect(failing({ ...base, minDailyRestMinutes: 661 })).resolves.toEqual([]);
    });
  });

  it('says why in Swedish, because an admin reads these in the form', async () => {
    const errors = await validate(
      plainToInstance(UpsertTeacherWorkRuleDto, { ...base, lunchMinutes: 7 }),
    );
    expect(Object.values(errors[0]!.constraints ?? {}).join(' ')).toContain(
      'femminuterssteg',
    );
  });
});
