import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateAvailabilityConstraintDto,
  UpdateAvailabilityConstraintDto,
} from './availability-constraint.dto';

const TEACHER_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';

/** The properties that failed validation. */
const failing = async (
  cls: typeof CreateAvailabilityConstraintDto | typeof UpdateAvailabilityConstraintDto,
  body: object,
) => (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  [
    'CreateAvailabilityConstraintDto',
    CreateAvailabilityConstraintDto,
    { resourceType: 'TEACHER', startTime: '08:00', endTime: '09:00' },
  ],
  ['UpdateAvailabilityConstraintDto', UpdateAvailabilityConstraintDto, {}],
] as const)('%s', (_name, cls, base) => {
  it('lets every resource id be an explicit null, which is what a GRADE_LEVEL rule is', async () => {
    await expect(
      failing(cls, { ...base, userId: null, roomId: null, studentGroupId: null }),
    ).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts a rule pointing at one named resource', async () => {
    await expect(failing(cls, { ...base, userId: TEACHER_ID })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, roomId: ROOM_ID })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, studentGroupId: GROUP_ID })).resolves.toEqual([]);
  });

  it('refuses a resource id that is not a v4 uuid, so a typo cannot read as no resource', async () => {
    await expect(failing(cls, { ...base, userId: 'anna.ek' })).resolves.toEqual(['userId']);
    await expect(failing(cls, { ...base, roomId: 'Sal 1' })).resolves.toEqual(['roomId']);
    await expect(failing(cls, { ...base, studentGroupId: '7A' })).resolves.toEqual([
      'studentGroupId',
    ]);
  });

  it('reads an explicit null on the grade bounds as no year range at all', async () => {
    await expect(
      failing(cls, { ...base, minGradeLevel: null, maxGradeLevel: null }),
    ).resolves.toEqual([]);
    await expect(
      failing(cls, { ...base, minGradeLevel: 4, maxGradeLevel: 6 }),
    ).resolves.toEqual([]);
  });

  it('holds the grade span to the years a school has, and refuses a bound that is not one', async () => {
    await expect(failing(cls, { ...base, minGradeLevel: -1 })).resolves.toEqual([
      'minGradeLevel',
    ]);
    await expect(failing(cls, { ...base, maxGradeLevel: 13 })).resolves.toEqual([
      'maxGradeLevel',
    ]);
    await expect(failing(cls, { ...base, minGradeLevel: 'åk 4' })).resolves.toEqual([
      'minGradeLevel',
    ]);
  });

  it('reads a null weekday as every teaching day and a null date as no single day', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: null, date: null })).resolves.toEqual(
      [],
    );
    await expect(
      failing(cls, { ...base, dayOfWeek: 5, date: '2026-08-17' }),
    ).resolves.toEqual([]);
  });

  it('refuses a weekday or a date that is not one, so null is the only special value', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: 8 })).resolves.toEqual(['dayOfWeek']);
    await expect(failing(cls, { ...base, dayOfWeek: 'fredag' })).resolves.toEqual([
      'dayOfWeek',
    ]);
    await expect(failing(cls, { ...base, date: '17/8/2026' })).resolves.toEqual(['date']);
  });

  it('clears the reason with null, and refuses one longer than the column holds', async () => {
    await expect(failing(cls, { ...base, reason: null })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, reason: 'x'.repeat(300) })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, reason: 'x'.repeat(301) })).resolves.toEqual([
      'reason',
    ]);
    await expect(failing(cls, { ...base, reason: 17 })).resolves.toEqual(['reason']);
  });
});
