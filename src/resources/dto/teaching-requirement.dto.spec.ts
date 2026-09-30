import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CreateTeachingRequirementDto,
  UpdateTeachingRequirementDto,
} from './teaching-requirement.dto';

const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const SUBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';
const TEACHER_ID = '11111111-1111-4111-8111-111111111111';
const CO_TEACHER_ID = '22222222-2222-4222-8222-222222222222';

/** The properties that failed validation. */
const failing = async (
  cls: typeof CreateTeachingRequirementDto | typeof UpdateTeachingRequirementDto,
  body: object,
) => (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  [
    'CreateTeachingRequirementDto',
    CreateTeachingRequirementDto,
    { academicYearId: YEAR_ID, subjectId: SUBJECT_ID, studentGroupId: GROUP_ID },
  ],
  ['UpdateTeachingRequirementDto', UpdateTeachingRequirementDto, {}],
] as const)('%s', (_name, cls, base) => {
  it('reads an explicit null teacher as the requirement waiting for one', async () => {
    await expect(
      failing(cls, { ...base, teacherId: null, coTeacherId: null }),
    ).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts a lead and a second teacher for a co-taught subject', async () => {
    await expect(
      failing(cls, { ...base, teacherId: TEACHER_ID, coTeacherId: CO_TEACHER_ID }),
    ).resolves.toEqual([]);
  });

  it('refuses a teacher id that is not a v4 uuid, so a typo cannot read as clearing it', async () => {
    await expect(failing(cls, { ...base, teacherId: 'anna.ek' })).resolves.toEqual([
      'teacherId',
    ]);
    await expect(failing(cls, { ...base, coTeacherId: 42 })).resolves.toEqual([
      'coTeacherId',
    ]);
  });

  it('reads a null period bound as the academic year carrying that end itself', async () => {
    await expect(
      failing(cls, { ...base, startDate: null, endDate: null }),
    ).resolves.toEqual([]);
    await expect(
      failing(cls, { ...base, startDate: '2027-01-11', endDate: '2027-06-11' }),
    ).resolves.toEqual([]);
  });

  it('refuses a period bound that looks like a date but is not one', async () => {
    await expect(failing(cls, { ...base, startDate: '2026-02-30' })).resolves.toEqual([
      'startDate',
    ]);
    await expect(failing(cls, { ...base, endDate: '2026-06-11T13:00:00Z' })).resolves.toEqual(
      ['endDate'],
    );
  });

  it('accepts an omkläd-and-dusch buffer on either side of the lesson', async () => {
    await expect(
      failing(cls, { ...base, minutesBefore: 10, minutesAfter: 20 }),
    ).resolves.toEqual([]);
    // Omitting them is the school that has never asked for one; the columns
    // default to 0 and the requirement occupies exactly its lesson.
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it.each([0, 60])('accepts %s minutes, the bounds the CHECK allows', async (minutes) => {
    await expect(
      failing(cls, { ...base, minutesBefore: minutes, minutesAfter: minutes }),
    ).resolves.toEqual([]);
  });

  it.each<[string, object, string[]]>([
    ['past the hour the CHECK stops at', { minutesAfter: 61 }, ['minutesAfter']],
    ['a negative buffer', { minutesBefore: -1 }, ['minutesBefore']],
    ['half a minute', { minutesBefore: 10.5 }, ['minutesBefore']],
    ['minutes as a string', { minutesAfter: '20' }, ['minutesAfter']],
    // 1200 is the misreading the CHECK exists for — twenty hours entered as if
    // the column took seconds. Refused here so the answer names the field
    // rather than arriving as a raw constraint violation.
    ['an hour of shower time in seconds', { minutesAfter: 1200 }, ['minutesAfter']],
  ])('refuses %s', async (_case, patch, expected) => {
    await expect(failing(cls, { ...base, ...patch })).resolves.toEqual(expected);
  });

  it('lets a null buffer through as @IsOptional reads it: absence', async () => {
    // Not an endorsement, a record. `@IsOptional` skips every validator for
    // null as well as undefined, so null passes the DTO here exactly as it
    // already does on lessonsPerWeek and minutesPerLesson — the two fields
    // these sit beside. The service is where that distinction is spent: it
    // spreads on `!== undefined`, so null would reach a NOT NULL column, and
    // its own spec pins the behaviour against those same neighbours rather
    // than letting this pair drift away from them.
    await expect(failing(cls, { ...base, minutesBefore: null })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, lessonsPerWeek: null })).resolves.toEqual([]);
  });
});
