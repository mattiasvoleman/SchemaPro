import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyStaffingDto, StaffingProposalDto } from './staffing-proposal.dto';

const YEAR = '44444444-4444-4444-8444-444444444444';
const ROW = '55555555-5555-4555-8555-555555555555';
const ANNA = '66666666-6666-4666-8666-666666666666';
const BO = '77777777-7777-4777-8777-777777777777';
const BASIS = 'ab'.repeat(32);

/** The fields that failed, as the global ValidationPipe would see them. */
const failures = async <T extends object>(cls: new () => T, body: unknown) => {
  const errors = await validate(plainToInstance(cls, body) as object, { whitelist: true, forbidNonWhitelisted: true });
  const flatten = (list: typeof errors, prefix = ''): string[] =>
    list.flatMap((error) => [
      ...(error.constraints ? [`${prefix}${error.property}`] : []),
      ...flatten(error.children ?? [], `${prefix}${error.property}.`),
    ]);
  return flatten(errors);
};

describe('StaffingProposalDto', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    academicYearId: YEAR,
    onlyUnstaffed: true,
    respectQualifications: false,
    ...overrides,
  });

  it('accepts the two options alone, and with pins and every weight', async () => {
    await expect(failures(StaffingProposalDto, body())).resolves.toEqual([]);
    await expect(
      failures(
        StaffingProposalDto,
        body({
          pinnedRequirementIds: [ROW],
          weights: { balance: 0, classTeachers: 100, continuity: 4, keepCurrent: 5, unqualified: 6 },
        }),
      ),
    ).resolves.toEqual([]);
  });

  it('requires both options as booleans', async () => {
    await expect(
      failures(StaffingProposalDto, { academicYearId: YEAR, onlyUnstaffed: 'yes' }),
    ).resolves.toEqual(['onlyUnstaffed', 'respectQualifications']);
  });

  it('refuses a weight outside 0..100, a fraction, and a weight the engine has never heard of', async () => {
    await expect(failures(StaffingProposalDto, body({ weights: { balance: 101 } }))).resolves.toEqual(['weights.balance']);
    await expect(failures(StaffingProposalDto, body({ weights: { keepCurrent: -1 } }))).resolves.toEqual([
      'weights.keepCurrent',
    ]);
    await expect(failures(StaffingProposalDto, body({ weights: { continuity: 1.5 } }))).resolves.toEqual([
      'weights.continuity',
    ]);
    // Staffing as many rows as possible is not a weight.
    await expect(failures(StaffingProposalDto, body({ weights: { unstaffed: 100 } }))).resolves.toEqual([
      'weights.unstaffed',
    ]);
  });

  it('refuses a pin that is not a v4 uuid, the same pin twice, and more pins than the engine takes rows', async () => {
    await expect(failures(StaffingProposalDto, body({ pinnedRequirementIds: ['r1'] }))).resolves.toEqual([
      'pinnedRequirementIds',
    ]);
    await expect(failures(StaffingProposalDto, body({ pinnedRequirementIds: [ROW, ROW] }))).resolves.toEqual([
      'pinnedRequirementIds',
    ]);
    const many = Array.from({ length: 5001 }, (_, i) => `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`);
    await expect(failures(StaffingProposalDto, body({ pinnedRequirementIds: many }))).resolves.toEqual([
      'pinnedRequirementIds',
    ]);
  });
});

describe('ApplyStaffingDto', () => {
  const change = (overrides: Record<string, unknown> = {}) => ({
    requirementId: ROW,
    fromTeacherId: ANNA,
    toTeacherId: BO,
    ...overrides,
  });
  const body = (overrides: Record<string, unknown> = {}) => ({
    academicYearId: YEAR,
    basisSha256: BASIS,
    changes: [change()],
    ...overrides,
  });

  it('accepts a proposal’s changes, an open row’s (from null) and an undo’s (to null)', async () => {
    await expect(failures(ApplyStaffingDto, body())).resolves.toEqual([]);
    await expect(failures(ApplyStaffingDto, body({ changes: [change({ fromTeacherId: null })] }))).resolves.toEqual([]);
    await expect(
      failures(ApplyStaffingDto, body({ undo: true, changes: [change({ toTeacherId: null })] })),
    ).resolves.toEqual([]);
  });

  it('requires both leads to be named — null, not absent — and as v4 uuids', async () => {
    await expect(
      failures(ApplyStaffingDto, body({ changes: [{ requirementId: ROW, toTeacherId: BO }] })),
    ).resolves.toEqual(['changes.0.fromTeacherId']);
    await expect(failures(ApplyStaffingDto, body({ changes: [change({ toTeacherId: 'bo' })] }))).resolves.toEqual([
      'changes.0.toTeacherId',
    ]);
  });

  it('refuses a basis that is not a sha256 digest, an empty batch and one past the cap', async () => {
    await expect(failures(ApplyStaffingDto, body({ basisSha256: 'abc' }))).resolves.toEqual(['basisSha256']);
    await expect(failures(ApplyStaffingDto, body({ changes: [] }))).resolves.toEqual(['changes']);
    await expect(
      failures(ApplyStaffingDto, body({ changes: Array.from({ length: 5001 }, () => change()) })),
    ).resolves.toEqual(['changes']);
  });

  it('refuses the room apply’s field name, so a page cannot send the wrong basis by accident', async () => {
    await expect(failures(ApplyStaffingDto, { academicYearId: YEAR, basis: BASIS, changes: [change()] })).resolves.toEqual(
      expect.arrayContaining(['basisSha256', 'basis']),
    );
  });
});
