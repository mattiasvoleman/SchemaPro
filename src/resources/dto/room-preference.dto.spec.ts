import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateRoomPreferenceDto,
  UpdateRoomPreferenceDto,
} from './room-preference.dto';

const SUBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** The properties that failed validation. */
const failing = async (
  cls: typeof CreateRoomPreferenceDto | typeof UpdateRoomPreferenceDto,
  body: object,
) => (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  ['CreateRoomPreferenceDto', CreateRoomPreferenceDto, { subjectId: SUBJECT_ID }],
  ['UpdateRoomPreferenceDto', UpdateRoomPreferenceDto, {}],
] as const)('%s grade span', (_name, cls, base) => {
  it('reads an explicit null on both bounds as the rule applying to every year', async () => {
    await expect(
      failing(cls, { ...base, minGradeLevel: null, maxGradeLevel: null }),
    ).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts a span inside the years a school has, from förskoleklass to åk 12', async () => {
    await expect(
      failing(cls, { ...base, minGradeLevel: 0, maxGradeLevel: 12 }),
    ).resolves.toEqual([]);
    await expect(
      failing(cls, { ...base, minGradeLevel: 7, maxGradeLevel: 9 }),
    ).resolves.toEqual([]);
  });

  it('refuses a bound outside the years a school has', async () => {
    await expect(failing(cls, { ...base, minGradeLevel: -1 })).resolves.toEqual([
      'minGradeLevel',
    ]);
    await expect(failing(cls, { ...base, maxGradeLevel: 13 })).resolves.toEqual([
      'maxGradeLevel',
    ]);
  });

  it('still refuses a bound that is not a whole number, so null is the only special value', async () => {
    await expect(failing(cls, { ...base, minGradeLevel: 'åk 7' })).resolves.toEqual([
      'minGradeLevel',
    ]);
    await expect(failing(cls, { ...base, maxGradeLevel: 9.5 })).resolves.toEqual([
      'maxGradeLevel',
    ]);
  });
});
