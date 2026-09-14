import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpsertLunchSettingsDto } from './lunch-settings.dto';

/** A valid lunch window with neither limit set. */
const base = {
  lunchEnabled: true,
  lunchStartTime: '10:45',
  lunchEndTime: '12:30',
  lunchMinutes: 30,
};

/** The properties that failed validation. */
const failing = async (body: object) =>
  (await validate(plainToInstance(UpsertLunchSettingsDto, body))).map(
    (error) => error.property,
  );

describe('UpsertLunchSettingsDto limits', () => {
  it('reads a null seat count as a hall with no limit worth modelling', async () => {
    await expect(failing({ ...base, diningSeats: null })).resolves.toEqual([]);
    await expect(failing(base)).resolves.toEqual([]);
    await expect(failing({ ...base, diningSeats: 180 })).resolves.toEqual([]);
  });

  it('refuses a hall with chairs for nobody, and a seat count that is not a number', async () => {
    await expect(failing({ ...base, diningSeats: 0 })).resolves.toEqual(['diningSeats']);
    await expect(failing({ ...base, diningSeats: 'alla' })).resolves.toEqual(['diningSeats']);
  });

  it('reads a null lesson cap as no cap on a class day', async () => {
    await expect(failing({ ...base, maxLessonsPerDayPerGroup: null })).resolves.toEqual([]);
    await expect(failing({ ...base, maxLessonsPerDayPerGroup: 6 })).resolves.toEqual([]);
  });

  it('refuses a lesson cap outside 1-20 or not a whole number, so null is the only special value', async () => {
    await expect(failing({ ...base, maxLessonsPerDayPerGroup: 0 })).resolves.toEqual([
      'maxLessonsPerDayPerGroup',
    ]);
    await expect(failing({ ...base, maxLessonsPerDayPerGroup: 21 })).resolves.toEqual([
      'maxLessonsPerDayPerGroup',
    ]);
    await expect(failing({ ...base, maxLessonsPerDayPerGroup: 'sex' })).resolves.toEqual([
      'maxLessonsPerDayPerGroup',
    ]);
  });
});
