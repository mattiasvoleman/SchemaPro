import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyCandidateDto, StartCandidatesDto } from './schedule-candidates.dto';

const YEAR = '44444444-4444-4444-8444-444444444444';
const OLD_RUN = '57575757-5757-4575-8575-575757575757';

/** The fields that failed, as the global ValidationPipe would see them. */
const failures = async <T extends object>(cls: new () => T, body: unknown) => {
  const errors = await validate(plainToInstance(cls, body) as object);
  return errors.filter((error) => error.constraints).map((error) => error.property);
};

describe('StartCandidatesDto: Bästa möjliga schema', () => {
  it('takes the mode BEST_EFFORT, and a request without a mode as it always did', async () => {
    await expect(failures(StartCandidatesDto, { academicYearId: YEAR, mode: 'BEST_EFFORT' })).resolves.toEqual([]);
    await expect(failures(StartCandidatesDto, { academicYearId: YEAR })).resolves.toEqual([]);
    await expect(failures(StartCandidatesDto, { academicYearId: YEAR, count: 3, weights: { spread: 4 }, refreshOf: OLD_RUN })).resolves.toEqual([]);
  });

  it.each([['KEEP'], ['best_effort'], ['BEST_EFFORT '], [''], [1], [true], [['BEST_EFFORT']]])('refuses the mode %p', async (mode) => {
    await expect(failures(StartCandidatesDto, { academicYearId: YEAR, mode })).resolves.toEqual(['mode']);
  });

  it('reads a null mode as none, as it reads a null count and a null refresh: the run is the ordinary one', async () => {
    await expect(failures(StartCandidatesDto, { academicYearId: YEAR, mode: null })).resolves.toEqual([]);
  });

  it('leaves the other fields to their own rules beside the mode', async () => {
    await expect(failures(StartCandidatesDto, { academicYearId: YEAR, mode: 'BEST_EFFORT', count: 9 })).resolves.toEqual(['count']);
  });
});

describe('ApplyCandidateDto: the acceptance', () => {
  it('takes a digest, or none', async () => {
    await expect(failures(ApplyCandidateDto, { expectedMode: 'DRAFT' })).resolves.toEqual([]);
    await expect(failures(ApplyCandidateDto, { expectedMode: 'DIRECT', acceptedDeviations: 'ab'.repeat(32) })).resolves.toEqual([]);
  });

  it('takes any string up to a digest’s length and more, so a wrong value is the 409 and not a 400', async () => {
    for (const wrong of ['', 'yes', 'AB'.repeat(32), 'x'.repeat(128)]) {
      await expect(failures(ApplyCandidateDto, { expectedMode: 'DRAFT', acceptedDeviations: wrong })).resolves.toEqual([]);
    }
  });

  it.each([[5], [true], [{}], [['ab']], ['x'.repeat(129)]])('refuses %p', async (value) => {
    await expect(failures(ApplyCandidateDto, { expectedMode: 'DRAFT', acceptedDeviations: value })).resolves.toEqual(['acceptedDeviations']);
  });

  it('still needs the mode the dialog was confirmed in', async () => {
    await expect(failures(ApplyCandidateDto, { acceptedDeviations: 'ab'.repeat(32) })).resolves.toEqual(['expectedMode']);
  });
});
