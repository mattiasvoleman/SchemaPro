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
});
