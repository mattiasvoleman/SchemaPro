import fixture from './__fixtures__/timplan-stage-cases.json';
import { cohortNotice, type CohortClass, type CohortNoticeRow } from './timplan-cohorts';
import type { SchoolForm } from './timplan-coverage';
import {
  computePupilStages,
  summarizeClassStages,
  type ClassStageSummary,
  type StageCoverage,
  type StageInput,
} from './timplan-stage';

/**
 * Stadiesummor per elev, implemented twice, checked against one list of cases.
 *
 * web/lib/timplan-stage.ts and web/lib/timplan-cohorts.ts mirror these
 * modules: the Stadium tab repaints a class from the drill-down it holds, and
 * /admin/timplan's "Timplaner per årskull" is computed in the browser without
 * a request. If the two drift, a pupil reads "uppfyllt" on one side and
 * "under timplanen" on the other. Both replay
 * src/common/__fixtures__/timplan-stage-cases.json.
 *
 * The fixture was GENERATED from this implementation by
 * scripts/fixtures/timplan-stage-cases.ts; every case's meaning is asserted
 * separately in timplan-stage.spec.ts. Fix the code and regenerate when a
 * change is intended; never edit the JSON by hand.
 */

interface FixtureCase {
  name: string;
  input: StageInput;
  coverage: StageCoverage;
  classes: ClassStageSummary[];
}

interface CohortCase {
  name: string;
  schoolForm: SchoolForm;
  classes: CohortClass[];
  versions: Parameters<typeof cohortNotice>[1];
  notice: CohortNoticeRow[];
}

const { cases, cohortCases } = fixture as unknown as { cases: FixtureCase[]; cohortCases: CohortCase[] };

describe('stadiesummor agree with the shared fixture', () => {
  it('has the 21 cases of the spec, the two boundary cases and the review’s cases, and reaches every verdict code and every cell status', () => {
    expect(cases.map((entry) => Number(entry.name.split('.')[0]))).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    const codes = new Set(cases.flatMap((entry) => entry.coverage.pupils.flatMap((pupil) => pupil.verdicts.map((verdict) => verdict.code))));
    expect([...codes].sort()).toEqual([
      'TIMPLAN_PUPIL_STAGE_BACKFILLED',
      'TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL',
      'TIMPLAN_PUPIL_STAGE_FORM_CHANGED',
      'TIMPLAN_PUPIL_STAGE_GRADE_REPEATED',
      'TIMPLAN_PUPIL_STAGE_GRADE_UNKNOWN',
      'TIMPLAN_PUPIL_STAGE_GROUP_MINIMUM_UNMET',
      'TIMPLAN_PUPIL_STAGE_HOME_NOT_A_CLASS',
      'TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED',
      'TIMPLAN_PUPIL_STAGE_PROJECTED_BELOW_NATIONAL',
      'TIMPLAN_PUPIL_STAGE_SUBJECTS_UNMAPPED',
      'TIMPLAN_STAGE_DISTRIBUTION_UNPUBLISHED',
      'TIMPLAN_STAGE_OLD_COHORT_DISTRIBUTION_ASSUMED',
      'TIMPLAN_STAGE_VERSION_NOT_IN_REFERENCE',
    ]);
    const statuses = new Set(
      cases.flatMap((entry) => entry.coverage.pupils.flatMap((pupil) => pupil.stages.flatMap((stage) => stage.cells.map((cell) => cell.status)))),
    );
    expect([...statuses].sort()).toEqual(['BELOW', 'BELOW_WITHIN_CAP', 'MET', 'NO_NATIONAL', 'UNRECORDED']);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const coverage = computePupilStages(entry.input);
    expect(coverage).toEqual(entry.coverage);
    expect(summarizeClassStages(coverage)).toEqual(entry.classes);
  });

  it.each(cohortCases.map((entry) => [entry.name, entry] as const))('the cohort notice: %s', (_name, entry) => {
    expect(cohortNotice(entry.classes, entry.versions, entry.schoolForm)).toEqual(entry.notice);
  });
});
