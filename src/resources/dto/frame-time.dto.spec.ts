import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateFrameTimeDto, UpdateFrameTimeDto } from './frame-time.dto';

/** The properties that failed validation. */
const failing = async (
  cls: typeof CreateFrameTimeDto | typeof UpdateFrameTimeDto,
  body: object,
) => (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  [
    'CreateFrameTimeDto',
    CreateFrameTimeDto,
    { minGradeLevel: 4, maxGradeLevel: 6, startTime: '08:10', endTime: '15:20' },
  ],
  ['UpdateFrameTimeDto', UpdateFrameTimeDto, {}],
] as const)('%s weekday', (_name, cls, base) => {
  it('reads an explicit null as the every-day frame instead of as not-an-integer', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: null })).resolves.toEqual([]);
  });

  it('reads an omitted weekday the same way, as every teaching day', async () => {
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts the ISO weekdays and refuses a day the week does not have', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: 1 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, dayOfWeek: 7 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, dayOfWeek: 0 })).resolves.toEqual(['dayOfWeek']);
    await expect(failing(cls, { ...base, dayOfWeek: 8 })).resolves.toEqual(['dayOfWeek']);
  });

  it('still refuses a weekday that is not a whole number, so null is the only special value', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: 'måndag' })).resolves.toEqual([
      'dayOfWeek',
    ]);
    await expect(failing(cls, { ...base, dayOfWeek: 2.5 })).resolves.toEqual(['dayOfWeek']);
  });
});
