import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRastDto, UpdateRastDto } from './rast.dto';

/** The properties that failed validation. */
const failing = async (cls: typeof CreateRastDto | typeof UpdateRastDto, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  [
    'CreateRastDto',
    CreateRastDto,
    {
      name: 'Förmiddagsrast',
      minGradeLevel: 0,
      maxGradeLevel: 6,
      startTime: '09:40',
      endTime: '10:00',
    },
  ],
  ['UpdateRastDto', UpdateRastDto, {}],
] as const)('%s weekday', (_name, cls, base) => {
  it('reads an explicit null as the rast every teaching day holds, not as not-an-integer', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: null })).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts the ISO weekdays and refuses a day the week does not have', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: 1 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, dayOfWeek: 7 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, dayOfWeek: 8 })).resolves.toEqual(['dayOfWeek']);
  });

  it('still refuses a weekday that is not a whole number, so null is the only special value', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: 'onsdag' })).resolves.toEqual([
      'dayOfWeek',
    ]);
    await expect(failing(cls, { ...base, dayOfWeek: 3.5 })).resolves.toEqual(['dayOfWeek']);
  });
});
