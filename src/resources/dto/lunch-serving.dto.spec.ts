import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLunchServingDto, UpdateLunchServingDto } from './lunch-serving.dto';

/** The properties that failed validation. */
const failing = async (
  cls: typeof CreateLunchServingDto | typeof UpdateLunchServingDto,
  body: object,
) => (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  [
    'CreateLunchServingDto',
    CreateLunchServingDto,
    { minGradeLevel: 0, maxGradeLevel: 3, startTime: '11:00', endTime: '11:30' },
  ],
  ['UpdateLunchServingDto', UpdateLunchServingDto, {}],
] as const)('%s', (_name, cls, base) => {
  it('reads an explicit null weekday as the every-day sitting, not as not-an-integer', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: null })).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts the ISO weekdays and refuses a day the week does not have', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: 1 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, dayOfWeek: 7 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, dayOfWeek: 0 })).resolves.toEqual(['dayOfWeek']);
    await expect(failing(cls, { ...base, dayOfWeek: 'fredag' })).resolves.toEqual([
      'dayOfWeek',
    ]);
  });

  it('reads a null seat count as the hall taking its own limit', async () => {
    await expect(failing(cls, { ...base, seats: null })).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, seats: 120 })).resolves.toEqual([]);
  });

  it('refuses a sitting with chairs for nobody, and a seat count that is not a number', async () => {
    await expect(failing(cls, { ...base, seats: 0 })).resolves.toEqual(['seats']);
    await expect(failing(cls, { ...base, seats: '120' })).resolves.toEqual(['seats']);
  });
});
