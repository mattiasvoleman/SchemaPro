import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { TriggerOptimizationDto } from './trigger-optimization.dto';

const YEAR = '44444444-4444-4444-8444-444444444444';
const VERSION = '9b1c1f64-6d7c-4a52-8f0e-2d2a4b7c5e11';

/** The paths that failed, as the global ValidationPipe would see them ("startFrom.source"). */
const failures = async (body: unknown): Promise<string[]> => {
  const paths = (errors: ValidationError[], prefix = ''): string[] =>
    errors.flatMap((error) => [
      ...(error.constraints ? [`${prefix}${error.property}`] : []),
      ...paths(error.children ?? [], `${prefix}${error.property}.`),
    ]);
  return paths(await validate(plainToInstance(TriggerOptimizationDto, body) as object));
};

describe('TriggerOptimizationDto: startFrom (Ett schema som start, M9)', () => {
  it('takes a request with no start, as it always did', async () => {
    await expect(failures({ academicYearId: YEAR })).resolves.toEqual([]);
    await expect(failures({ academicYearId: YEAR, weights: { spread: 3 }, rules: { lunchMinutes: 30 } })).resolves.toEqual([]);
  });

  it.each([['CURRENT'], ['PREVIOUS_YEAR']])('takes the source %s with no version', async (source) => {
    await expect(failures({ academicYearId: YEAR, startFrom: { source } })).resolves.toEqual([]);
  });

  it('takes VERSION with the version named', async () => {
    await expect(failures({ academicYearId: YEAR, startFrom: { source: 'VERSION', versionId: VERSION } })).resolves.toEqual([]);
  });

  it('refuses VERSION with no version, and a version that is not a UUID', async () => {
    await expect(failures({ academicYearId: YEAR, startFrom: { source: 'VERSION' } })).resolves.toEqual(['startFrom.versionId']);
    await expect(failures({ academicYearId: YEAR, startFrom: { source: 'VERSION', versionId: 'v-1' } })).resolves.toEqual(['startFrom.versionId']);
  });

  it('does not read a version named beside CURRENT: the source is what it is', async () => {
    await expect(failures({ academicYearId: YEAR, startFrom: { source: 'CURRENT', versionId: 'anything' } })).resolves.toEqual([]);
  });

  it.each([['FILE'], ['current'], [''], [1], [null], [undefined]])('refuses the source %p', async (source) => {
    await expect(failures({ academicYearId: YEAR, startFrom: { source } })).resolves.toEqual(['startFrom.source']);
  });
});
