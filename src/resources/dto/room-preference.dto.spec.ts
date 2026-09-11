import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRoomPreferenceDto, UpdateRoomPreferenceDto } from './room-preference.dto';

const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const TYPE_ID = '66666666-6666-4666-8666-666666666666';

/** The properties that failed validation. */
const failing = async (
  cls: typeof CreateRoomPreferenceDto | typeof UpdateRoomPreferenceDto,
  body: object,
) => (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  ['CreateRoomPreferenceDto', CreateRoomPreferenceDto, { subjectId: SUBJECT_ID, roomTypeId: TYPE_ID }],
  ['UpdateRoomPreferenceDto', UpdateRoomPreferenceDto, {}],
] as const)('%s year span', (_name, cls, base) => {
  it('accepts null for both bounds, which is a rule for every year', async () => {
    // On a PATCH this is how a stage is taken off a rule: the service writes an
    // explicit null, where an omitted key keeps the span it has.
    await expect(
      failing(cls, { ...base, minGradeLevel: null, maxGradeLevel: null }),
    ).resolves.toEqual([]);
  });

  it('accepts a span inside the Swedish 0-12 range', async () => {
    await expect(failing(cls, { ...base, minGradeLevel: 7, maxGradeLevel: 9 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, minGradeLevel: 0, maxGradeLevel: 12 })).resolves.toEqual([]);
  });

  it('refuses a bound outside 0-12, or between two years', async () => {
    await expect(failing(cls, { ...base, minGradeLevel: -1, maxGradeLevel: 9 })).resolves.toEqual([
      'minGradeLevel',
    ]);
    await expect(failing(cls, { ...base, minGradeLevel: 7, maxGradeLevel: 13 })).resolves.toEqual([
      'maxGradeLevel',
    ]);
    await expect(failing(cls, { ...base, minGradeLevel: 7.5, maxGradeLevel: 9 })).resolves.toEqual([
      'minGradeLevel',
    ]);
  });

  it('refuses a year sent as a string', async () => {
    // The pipe runs without implicit conversion, so "7" is not 7 anywhere.
    await expect(failing(cls, { ...base, minGradeLevel: '7', maxGradeLevel: 9 })).resolves.toEqual([
      'minGradeLevel',
    ]);
  });
});
