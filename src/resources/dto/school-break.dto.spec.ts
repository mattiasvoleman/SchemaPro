// ApplySchoolCalendarDto's rows use class-transformer's @Type, which reads design metadata.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplySchoolCalendarDto, CreateSchoolBreakDto, UpdateSchoolBreakDto } from './school-break.dto';

const YEAR_ID = '99999999-9999-4999-8999-999999999999';

/** The properties that failed validation. */
const failing = async (
  cls: typeof CreateSchoolBreakDto | typeof UpdateSchoolBreakDto,
  body: object,
) => (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  [
    'CreateSchoolBreakDto',
    CreateSchoolBreakDto,
    {
      academicYearId: YEAR_ID,
      name: 'Sportlov',
      startDate: '2027-02-22',
      endDate: '2027-02-26',
    },
  ],
  ['UpdateSchoolBreakDto', UpdateSchoolBreakDto, {}],
] as const)('%s grade span', (_name, cls, base) => {
  it('reads an explicit null on both bounds as the whole school being off', async () => {
    await expect(
      failing(cls, { ...base, minGradeLevel: null, maxGradeLevel: null }),
    ).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts a break narrowed to a span, a prao week for åk 9 among them', async () => {
    await expect(
      failing(cls, { ...base, minGradeLevel: 9, maxGradeLevel: 9 }),
    ).resolves.toEqual([]);
    await expect(
      failing(cls, { ...base, minGradeLevel: 0, maxGradeLevel: 12 }),
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
    await expect(failing(cls, { ...base, minGradeLevel: '9' })).resolves.toEqual([
      'minGradeLevel',
    ]);
    await expect(failing(cls, { ...base, maxGradeLevel: 9.5 })).resolves.toEqual([
      'maxGradeLevel',
    ]);
  });
});

describe('ApplySchoolCalendarDto (Skolans kalender)', () => {
  const row = { name: 'Sportlov', startDate: '2027-02-22', endDate: '2027-02-26' };
  const problems = async (body: object) => {
    const errors = await validate(plainToInstance(ApplySchoolCalendarDto, body));
    // A nested error is named by the list and the row's index, then its property.
    return errors.flatMap((error) =>
      error.children?.length
        ? error.children.flatMap((child) => (child.children ?? []).map((leaf) => `${error.property}[${child.property}].${leaf.property}`))
        : [error.property],
    );
  };

  it('takes a list of rows, with or without an id, and a dry run', async () => {
    await expect(problems({ academicYearId: YEAR_ID, breaks: [row, { ...row, id: '11111111-1111-4111-8111-111111111111' }], dryRun: true })).resolves.toEqual([]);
    await expect(problems({ academicYearId: YEAR_ID, breaks: [] })).resolves.toEqual([]);
  });

  it('judges every row by the rules of a lov made one at a time', async () => {
    await expect(problems({ academicYearId: YEAR_ID, breaks: [row, { ...row, startDate: '2027-02-30' }] })).resolves.toEqual(['breaks[1].startDate']);
    await expect(problems({ academicYearId: YEAR_ID, breaks: [{ ...row, name: '' }] })).resolves.toEqual(['breaks[0].name']);
    await expect(problems({ academicYearId: YEAR_ID, breaks: [{ ...row, minGradeLevel: 13, maxGradeLevel: 9 }] })).resolves.toEqual(['breaks[0].minGradeLevel']);
    await expect(problems({ academicYearId: YEAR_ID, breaks: [{ ...row, id: 'x' }] })).resolves.toEqual(['breaks[0].id']);
  });

  it('refuses a list of more than 200 rows, a missing list and a year that is not an id', async () => {
    await expect(problems({ academicYearId: YEAR_ID, breaks: Array.from({ length: 201 }, () => row) })).resolves.toEqual(['breaks']);
    await expect(problems({ academicYearId: YEAR_ID })).resolves.toContain('breaks');
    await expect(problems({ academicYearId: 'not-an-id', breaks: [] })).resolves.toEqual(['academicYearId']);
  });
});
