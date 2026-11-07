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

  it('takes the travel switch as true or false, and leaves it out as nothing to change', async () => {
    await expect(failing(base)).resolves.toEqual([]);
    await expect(failing({ ...base, generatorKeepsTravelTime: true })).resolves.toEqual([]);
    await expect(failing({ ...base, generatorKeepsTravelTime: false })).resolves.toEqual([]);
  });

  it('takes the pupil-gap switch as true or false, and refuses null and a string', async () => {
    await expect(failing({ ...base, generatorKeepsPupilGapsDown: true })).resolves.toEqual([]);
    await expect(failing({ ...base, generatorKeepsPupilGapsDown: false })).resolves.toEqual([]);
    await expect(failing({ ...base, generatorKeepsPupilGapsDown: null })).resolves.toEqual([
      'generatorKeepsPupilGapsDown',
    ]);
    await expect(failing({ ...base, generatorKeepsPupilGapsDown: 'true' })).resolves.toEqual([
      'generatorKeepsPupilGapsDown',
    ]);
  });

  it('takes the consecutive-teaching switch as true or false, and refuses null and a string', async () => {
    await expect(failing({ ...base, generatorKeepsConsecutiveTeaching: true })).resolves.toEqual([]);
    await expect(failing({ ...base, generatorKeepsConsecutiveTeaching: false })).resolves.toEqual([]);
    await expect(failing({ ...base, generatorKeepsConsecutiveTeaching: null })).resolves.toEqual([
      'generatorKeepsConsecutiveTeaching',
    ]);
    await expect(failing({ ...base, generatorKeepsConsecutiveTeaching: 'true' })).resolves.toEqual([
      'generatorKeepsConsecutiveTeaching',
    ]);
  });

  it('refuses a null travel switch, which the NOT NULL column would answer with a 500', async () => {
    await expect(failing({ ...base, generatorKeepsTravelTime: null })).resolves.toEqual([
      'generatorKeepsTravelTime',
    ]);
    await expect(failing({ ...base, generatorKeepsTravelTime: 'true' })).resolves.toEqual([
      'generatorKeepsTravelTime',
    ]);
  });

  describe('Placeringsregler', () => {
    const MODES = ['placementEdgeMode', 'placementPlacesMode', 'placementSharedMode'] as const;
    const WEIGHTS = ['placementEdgeWeight', 'placementPlacesWeight', 'placementSharedWeight'] as const;
    const LIMITS = [
      'maxClassRoomsPerDay',
      'maxTeacherRoomsPerDay',
      'maxClassBuildingsPerDay',
      'maxTeacherBuildingsPerDay',
    ] as const;

    it('leaves all ten fields out as nothing to change: a Skolregler tab from before them PUTs the row without', async () => {
      await expect(failing(base)).resolves.toEqual([]);
    });

    it.each(MODES)('takes %s as OFF, SOFT or HARD and nothing else', async (field) => {
      for (const mode of ['OFF', 'SOFT', 'HARD']) await expect(failing({ ...base, [field]: mode })).resolves.toEqual([]);
      // Spelled as the enum is, and never null: the column is NOT NULL, so null is the 400 that names the field.
      for (const bad of ['MEDIUM', 'off', 'Soft', '', null, true, 1]) {
        await expect(failing({ ...base, [field]: bad })).resolves.toEqual([field]);
      }
    });

    it('says in Swedish which three words a mode is', async () => {
      const errors = await validate(plainToInstance(UpsertLunchSettingsDto, { ...base, placementEdgeMode: 'MEDIUM' }));
      expect(Object.values(errors[0]!.constraints ?? {})[0]).toMatch(/OFF.*SOFT.*HARD/);
    });

    it.each(WEIGHTS)('takes %s as a whole number 1 to 1000, the CHECK’s own range', async (field) => {
      for (const weight of [1, 250, 1000]) await expect(failing({ ...base, [field]: weight })).resolves.toEqual([]);
      for (const bad of [0, -1, 1001, 99999, 2.5, '250', null]) {
        await expect(failing({ ...base, [field]: bad })).resolves.toEqual([field]);
      }
    });

    it.each(LIMITS)('takes %s as 1 to 20 (1 is a single place a day), with null clearing it, and refuses what the CHECK would answer with a 500', async (field) => {
      for (const limit of [1, 2, 20, null]) await expect(failing({ ...base, [field]: limit })).resolves.toEqual([]);
      // 0 is no day in any room; the old rule's "never change" is 1 now.
      for (const bad of [0, -1, 21, 1.5, '2', true]) {
        await expect(failing({ ...base, [field]: bad })).resolves.toEqual([field]);
      }
    });

    it('names a field and no other for each of several wrong ones', async () => {
      await expect(failing({ ...base, placementEdgeWeight: 0, maxClassRoomsPerDay: 21, placementSharedMode: 'x' })).resolves.toEqual([
        'placementEdgeWeight',
        'maxClassRoomsPerDay',
        'placementSharedMode',
      ]);
    });
  });
});
