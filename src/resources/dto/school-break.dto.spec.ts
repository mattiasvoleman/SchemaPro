import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSchoolBreakDto, UpdateSchoolBreakDto } from './school-break.dto';

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
