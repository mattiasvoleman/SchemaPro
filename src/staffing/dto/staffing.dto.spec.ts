// `@Type(() => …)` on the qualification items reads design-time metadata;
// without this the module cannot even be loaded.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpsertStaffingPolicyDto } from './staffing-policy.dto';
import { UpsertTeacherEmploymentDto } from './teacher-employment.dto';
import { ReplaceTeacherQualificationsDto } from './teacher-qualification.dto';

const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';

/** The properties that failed validation, nested ones as `items.N.field`. */
const failing = async (
  cls: new () => object,
  body: object,
): Promise<string[]> => {
  const errors = await validate(plainToInstance(cls, body));
  const flatten = (
    list: { property: string; children?: unknown[]; constraints?: unknown }[],
    prefix: string,
  ): string[] =>
    list.flatMap((error) => {
      const name = `${prefix}${error.property}`;
      const nested = (error.children ?? []) as typeof list;
      return nested.length > 0 && !error.constraints
        ? flatten(nested, `${name}.`)
        : [name];
    });
  return flatten(errors as never, '');
};

const messagesOf = async (cls: new () => object, body: object): Promise<string> =>
  JSON.stringify(await validate(plainToInstance(cls, body)));

describe('UpsertStaffingPolicyDto mirrors the table CHECKs, bound for bound', () => {
  it('accepts an empty body — every field has a default except the riktmärke', async () => {
    await expect(failing(UpsertStaffingPolicyDto, {})).resolves.toEqual([]);
  });

  it('accepts the Bilaga M frame and the Vimmerby riktmärke', async () => {
    await expect(
      failing(UpsertStaffingPolicyDto, {
        fullTimeTeachingMinutesPerWeek: 1080,
        fullTimeRegulatedHoursPerYear: 1360,
        fullTimeAnnualHours: 1767,
        workDaysPerYear: 194,
        semesterHoursPerWeek: 40.0,
        qualificationMode: 'WARN',
        overAllocationMode: 'REFUSE',
        overAllocationTolerancePercent: 10,
        loadModel: 'MINUTES',
      }),
    ).resolves.toEqual([]);
  });

  it('reads a null riktmärke as no comparison', async () => {
    await expect(
      failing(UpsertStaffingPolicyDto, { fullTimeTeachingMinutesPerWeek: null }),
    ).resolves.toEqual([]);
  });

  it.each([
    ['fullTimeTeachingMinutesPerWeek', 1, 2400],
    ['fullTimeRegulatedHoursPerYear', 1, 2500],
    ['fullTimeAnnualHours', 1, 2500],
    ['workDaysPerYear', 1, 260],
    ['overAllocationTolerancePercent', 0, 50],
  ] as const)('%s accepts %i..%i and refuses the numbers next to them', async (field, min, max) => {
    await expect(failing(UpsertStaffingPolicyDto, { [field]: min })).resolves.toEqual([]);
    await expect(failing(UpsertStaffingPolicyDto, { [field]: max })).resolves.toEqual([]);
    await expect(failing(UpsertStaffingPolicyDto, { [field]: min - 1 })).resolves.toEqual([field]);
    await expect(failing(UpsertStaffingPolicyDto, { [field]: max + 1 })).resolves.toEqual([field]);
    await expect(failing(UpsertStaffingPolicyDto, { [field]: min + 0.5 })).resolves.toEqual([field]);
  });

  it('holds semesterHoursPerWeek to (0, 60] with one decimal', async () => {
    await expect(failing(UpsertStaffingPolicyDto, { semesterHoursPerWeek: 0.1 })).resolves.toEqual([]);
    await expect(failing(UpsertStaffingPolicyDto, { semesterHoursPerWeek: 60 })).resolves.toEqual([]);
    await expect(failing(UpsertStaffingPolicyDto, { semesterHoursPerWeek: 0 })).resolves.toEqual([
      'semesterHoursPerWeek',
    ]);
    await expect(failing(UpsertStaffingPolicyDto, { semesterHoursPerWeek: 60.1 })).resolves.toEqual([
      'semesterHoursPerWeek',
    ]);
    await expect(failing(UpsertStaffingPolicyDto, { semesterHoursPerWeek: 37.75 })).resolves.toEqual([
      'semesterHoursPerWeek',
    ]);
  });

  it('refuses a mode that is not one of the three, and a model that is not one of the two', async () => {
    await expect(failing(UpsertStaffingPolicyDto, { qualificationMode: 'VARNA' })).resolves.toEqual([
      'qualificationMode',
    ]);
    await expect(failing(UpsertStaffingPolicyDto, { overAllocationMode: 'ON' })).resolves.toEqual([
      'overAllocationMode',
    ]);
    await expect(failing(UpsertStaffingPolicyDto, { loadModel: 'HOURS' })).resolves.toEqual([
      'loadModel',
    ]);
  });

  it('says why in Swedish, because an admin reads these in the settings card', async () => {
    await expect(
      messagesOf(UpsertStaffingPolicyDto, { fullTimeTeachingMinutesPerWeek: 2401 }),
    ).resolves.toContain('40 timmar');
  });
});

describe('UpsertTeacherEmploymentDto mirrors the table CHECKs, bound for bound', () => {
  it('accepts a full-time post with nothing else said', async () => {
    await expect(
      failing(UpsertTeacherEmploymentDto, { employmentPercent: 100 }),
    ).resolves.toEqual([]);
  });

  it('accepts three decimals and refuses a fourth', async () => {
    await expect(
      failing(UpsertTeacherEmploymentDto, { employmentPercent: 66.667, reductionPercent: 16.667 }),
    ).resolves.toEqual([]);
    await expect(
      failing(UpsertTeacherEmploymentDto, { employmentPercent: 66.6667 }),
    ).resolves.toEqual(['employmentPercent']);
  });

  it('refuses 0 % and over 100 %, and requires the percentage at all', async () => {
    await expect(failing(UpsertTeacherEmploymentDto, { employmentPercent: 0 })).resolves.toEqual([
      'employmentPercent',
    ]);
    await expect(failing(UpsertTeacherEmploymentDto, { employmentPercent: 100.001 })).resolves.toEqual([
      'employmentPercent',
    ]);
    await expect(failing(UpsertTeacherEmploymentDto, {})).resolves.toEqual(['employmentPercent']);
    await expect(failing(UpsertTeacherEmploymentDto, { employmentPercent: '80' })).resolves.toEqual([
      'employmentPercent',
    ]);
  });

  it('holds the nedsättning to [0, 100] here; inside the post is the service’s rule', async () => {
    await expect(
      failing(UpsertTeacherEmploymentDto, { employmentPercent: 80, reductionPercent: 0 }),
    ).resolves.toEqual([]);
    await expect(
      failing(UpsertTeacherEmploymentDto, { employmentPercent: 80, reductionPercent: -0.001 }),
    ).resolves.toEqual(['reductionPercent']);
    // 90 > 80 passes the DTO on purpose: the cross-field refusal names both
    // numbers, and lives where it can see both.
    await expect(
      failing(UpsertTeacherEmploymentDto, { employmentPercent: 80, reductionPercent: 90 }),
    ).resolves.toEqual([]);
  });

  it('holds the own riktmärke to 0..2400 and the signature to 1..8 visible characters', async () => {
    const base = { employmentPercent: 100 };
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, teachingTargetMinutesPerWeek: 0 }),
    ).resolves.toEqual([]);
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, teachingTargetMinutesPerWeek: 2401 }),
    ).resolves.toEqual(['teachingTargetMinutesPerWeek']);
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, teachingTargetMinutesPerWeek: null }),
    ).resolves.toEqual([]);
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, signature: 'ÅÄÖÅÄÖÅÄ' }),
    ).resolves.toEqual([]);
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, signature: 'ABCDEFGHI' }),
    ).resolves.toEqual(['signature']);
    await expect(failing(UpsertTeacherEmploymentDto, { ...base, signature: '' })).resolves.toEqual([
      'signature',
    ]);
    await expect(failing(UpsertTeacherEmploymentDto, { ...base, signature: '   ' })).resolves.toEqual([
      'signature',
    ]);
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, signature: null, note: null }),
    ).resolves.toEqual([]);
  });

  it('caps the note at 500 characters and refuses an unknown contract kind', async () => {
    const base = { employmentPercent: 100 };
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, note: 'x'.repeat(500) }),
    ).resolves.toEqual([]);
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, note: 'x'.repeat(501) }),
    ).resolves.toEqual(['note']);
    await expect(
      failing(UpsertTeacherEmploymentDto, { ...base, contractKind: 'TIMLÄRARE' }),
    ).resolves.toEqual(['contractKind']);
  });

  it('says why in Swedish, because an admin reads these in the drawer', async () => {
    await expect(
      messagesOf(UpsertTeacherEmploymentDto, { employmentPercent: 110 }),
    ).resolves.toContain('över 100 %');
  });
});

describe('ReplaceTeacherQualificationsDto', () => {
  const item = (overrides: Record<string, unknown> = {}) => ({
    subjectId: SUBJECT_ID,
    minGradeLevel: 7,
    maxGradeLevel: 9,
    kind: 'LEGITIMATION',
    ...overrides,
  });

  it('accepts an empty list, and a list of plain items', async () => {
    await expect(failing(ReplaceTeacherQualificationsDto, { items: [] })).resolves.toEqual([]);
    await expect(
      failing(ReplaceTeacherQualificationsDto, {
        items: [item(), item({ kind: 'BEHORIG', validFrom: '2026-08-01', validTo: '2027-06-30' })],
      }),
    ).resolves.toEqual([]);
  });

  it('requires the list itself', async () => {
    await expect(failing(ReplaceTeacherQualificationsDto, {})).resolves.toEqual(['items']);
  });

  it('requires a kind — none is presumed', async () => {
    await expect(
      failing(ReplaceTeacherQualificationsDto, { items: [item({ kind: undefined })] }),
    ).resolves.toEqual(['items.0.kind']);
    await expect(
      failing(ReplaceTeacherQualificationsDto, { items: [item({ kind: 'LEGITIMERAD' })] }),
    ).resolves.toEqual(['items.0.kind']);
  });

  it('holds both grades to 0..12', async () => {
    await expect(
      failing(ReplaceTeacherQualificationsDto, { items: [item({ minGradeLevel: 0, maxGradeLevel: 12 })] }),
    ).resolves.toEqual([]);
    await expect(
      failing(ReplaceTeacherQualificationsDto, { items: [item({ minGradeLevel: -1 })] }),
    ).resolves.toEqual(['items.0.minGradeLevel']);
    await expect(
      failing(ReplaceTeacherQualificationsDto, { items: [item({ maxGradeLevel: 13 })] }),
    ).resolves.toEqual(['items.0.maxGradeLevel']);
    // Reversed spans pass the DTO: the service names the two numbers.
    await expect(
      failing(ReplaceTeacherQualificationsDto, { items: [item({ minGradeLevel: 9, maxGradeLevel: 7 })] }),
    ).resolves.toEqual([]);
  });

  it('refuses a date that is shaped right but does not exist', async () => {
    await expect(
      failing(ReplaceTeacherQualificationsDto, { items: [item({ validTo: '2027-02-30' })] }),
    ).resolves.toEqual(['items.0.validTo']);
  });

  it('refuses a subject that is not a uuid, naming the row', async () => {
    await expect(
      failing(ReplaceTeacherQualificationsDto, { items: [item(), item({ subjectId: 'MA' })] }),
    ).resolves.toEqual(['items.1.subjectId']);
  });
});
