import fixture from './__fixtures__/timplan-stage-cases.json';
import { cohortStartYear, htOf, pupilRegime, stageVersionFor, versionGradeOf } from './timplan-cohorts';
import { cohortStartYear as rolloverCohortStartYear } from '../year-rollover/rollover-timplans';
import { computePupilStages, type StageCoverage, type StageInput, type StagePupil } from './timplan-stage';

/**
 * What each fixture case MEANS, asserted on its own: the contract spec only
 * replays the generated numbers, and a generator can be wrong.
 */
const { cases } = fixture as unknown as { cases: { name: string; input: StageInput; coverage: StageCoverage }[] };
const run = (n: number): StagePupil[] => computePupilStages(cases.find((entry) => entry.name.startsWith(`${n}.`))!.input).pupils;
const stage = (pupil: StagePupil, name: string) => pupil.stages.find((entry) => entry.stage === name)!;
const cell = (pupil: StagePupil, name: string, code: string) => stage(pupil, name).cells.find((entry) => entry.code === code)!;
const codes = (pupil: StagePupil) => pupil.verdicts.map((verdict) => verdict.code);

describe('årskullar: the regime, the version grade and the version', () => {
  it('keeps cohortStartYear where the rollover imported it from', () => {
    expect(rolloverCohortStartYear).toBe(cohortStartYear);
    expect([cohortStartYear(0, 2027), cohortStartYear(1, 2028), cohortStartYear(9, 2026)]).toEqual([2028, 2028, 2018]);
  });

  it('reads a läsår’s HT off its start date', () => {
    expect([htOf('2026-08-17'), htOf('2027-06-14'), htOf('2028-07-01')]).toEqual([2026, 2026, 2028]);
  });

  it('decides the regime in the header’s order: before 2028, then the grade in 2028, then arithmetic', () => {
    expect(pupilRegime([{ ht: 2027, gradeLevel: 0 }, { ht: 2028, gradeLevel: 2 }])).toBe('PRE_2028');
    expect(pupilRegime([{ ht: 2028, gradeLevel: 1 }])).toBe('REFORMED_2028');
    expect(pupilRegime([{ ht: 2028, gradeLevel: 2 }])).toBe('PRE_2028');
    expect(pupilRegime([{ ht: 2030, gradeLevel: 3 }])).toBe('REFORMED_2028');
    expect(pupilRegime([{ ht: 2030, gradeLevel: 5 }])).toBe('PRE_2028');
    // An old-cohort pupil repeating new åk 2 in 2029/30 stays PRE: 2 − 1 = 1
    // would call them reformed, rule 1 does not.
    expect(pupilRegime([{ ht: 2028, gradeLevel: 2 }, { ht: 2029, gradeLevel: 2 }])).toBe('PRE_2028');
    expect(pupilRegime([{ ht: 2029, gradeLevel: 2 }])).toBe('REFORMED_2028');
    expect(pupilRegime([])).toBe('PRE_2028');
  });

  it('reads an old-cohort pupil one grade down from HT 2028, and förskoleklass after 2028 as no grade', () => {
    expect(versionGradeOf('PRE_2028', 2028, 10)).toBe(9);
    expect(versionGradeOf('PRE_2028', 2027, 9)).toBe(9);
    expect(versionGradeOf('REFORMED_2028', 2030, 3)).toBe(3);
    expect(versionGradeOf('REFORMED_2028', 2028, 0)).toBeNull();
    expect(versionGradeOf('PRE_2028', 2026, null)).toBeNull();
  });

  it('filters by regime before the cohort term: a PRE pupil starting 2028 never gets SFS 2025:729', () => {
    const versions = (cases[0]!.input.versions);
    expect(stageVersionFor(versions, 'GRUNDSKOLA', 'PRE_2028', 2028, 2030)?.code).toBe('SFS2023:945/B1');
    expect(stageVersionFor(versions, 'GRUNDSKOLA', 'REFORMED_2028', 2028, 2031)?.code).toBe('SFS2025:729');
    expect(stageVersionFor(versions, 'GRUNDSKOLA', 'REFORMED_2028', 2027, 2031)).toBeNull();
    // A stage finished in June 2024 was finished before SFS 2023:945 came into force.
    expect(stageVersionFor(versions, 'GRUNDSKOLA', 'PRE_2028', 2015, 2023)).toBeNull();
    expect(stageVersionFor(versions, 'GRUNDSKOLA', 'PRE_2028', 2016, 2024)?.code).toBe('SFS2023:945/B1');
  });
});

describe('stadiesummor, case by case', () => {
  it('1: three recorded years of mellanstadiet meet every cell, and say nothing', () => {
    const [pupil] = run(1);
    expect(stage(pupil!, 'MELLAN')).toMatchObject({ versionCode: 'SFS2023:945/B1', complete: true, current: true, recordedGrades: [4, 5, 6] });
    expect(stage(pupil!, 'MELLAN').cells.every((entry) => entry.status === 'MET')).toBe(true);
    expect(codes(pupil!)).toEqual([]);
    // HKK's merged cell spans 1–6, and åk 1–3 are unrecorded: shown, never judged.
    expect(cell(pupil!, 'LAG_MELLAN', 'HKK')).toMatchObject({ nationalHours: 40, plannedHours: 24, status: 'UNRECORDED' });
  });

  it('2: matematik is protected, so a shortfall is a warning, rounded up', () => {
    const [pupil] = run(2);
    expect(cell(pupil!, 'MELLAN', 'MA')).toMatchObject({ status: 'BELOW', nationalHours: 410, plannedShortfallHours: 38.3 });
    expect(pupil!.verdicts.find((verdict) => verdict.code === 'TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL')).toMatchObject({ severity: 'warning', subjectCode: 'MA' });
  });

  it('3: bild 10 h short of 100 is within the 20 % cap: a notice', () => {
    const [pupil] = run(3);
    expect(cell(pupil!, 'HOG', 'BL')).toMatchObject({ status: 'BELOW_WITHIN_CAP', plannedShortfallHours: 10 });
    expect(pupil!.verdicts.filter((verdict) => verdict.subjectCode === 'BL').map((verdict) => verdict.severity)).toEqual(['notice', 'notice']);
  });

  it('4: a move mid-year is two blocks of one grade that together record it in full', () => {
    const [pupil] = run(4);
    expect(stage(pupil!, 'HOG')).toMatchObject({ recordedGrades: [7], plannedGrades: [8, 9], complete: true });
    expect(cell(pupil!, 'HOG', 'MA').plannedHours).toBe(403);
  });

  it('5: a grade before SchemaPro is unrecorded, never zero: no shortfall verdict', () => {
    const [pupil] = run(5);
    expect(stage(pupil!, 'HOG')).toMatchObject({ unrecordedGrades: [7], complete: false });
    expect(cell(pupil!, 'HOG', 'MA')).toMatchObject({ plannedHours: 200, status: 'UNRECORDED' });
    expect(codes(pupil!)).toEqual(['TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED']);
  });

  it('6 and 17: a backfilled block and a deleted class are named', () => {
    expect(codes(run(6)[0]!)).toContain('TIMPLAN_PUPIL_STAGE_BACKFILLED');
    const [deleted] = run(17);
    expect(stage(deleted!, 'HOG')).toMatchObject({ partlyRecordedGrades: [8], classDeleted: true, complete: false });
  });

  it('7: högstadiet finished June 2024 has no lydelse in the reference data; June 2025 reads bilaga 1', () => {
    const [before, after] = run(7);
    expect(stage(before!, 'HOG').versionCode).toBeNull();
    expect(cell(before!, 'HOG', 'MA').status).toBe('NO_NATIONAL');
    expect(stage(after!, 'HOG').versionCode).toBe('SFS2023:945/B1');
  });

  it('8: åk 1 in HT 2028 is the tioårig grundskola, totals only, no cell judged', () => {
    const [pupil] = run(8);
    expect(pupil!.regime).toBe('REFORMED_2028');
    expect(stage(pupil!, 'LAG')).toMatchObject({ versionCode: 'SFS2025:729', distributionPublished: false, totalHours: 7424, grades: [1, 2, 3, 4] });
    expect(stage(pupil!, 'LAG').cells.every((entry) => entry.nationalHours === null && entry.status === 'NO_NATIONAL')).toBe(true);
    expect(codes(pupil!)).toEqual(['TIMPLAN_STAGE_DISTRIBUTION_UNPUBLISHED']);
  });

  it('9 and 20: the old cohort in 2028/29 sits at version grade 1 of bilaga 1, as an assumption', () => {
    for (const n of [9, 20]) {
      const [pupil] = run(n);
      expect(pupil!.regime).toBe('PRE_2028');
      expect(stage(pupil!, 'LAG')).toMatchObject({ versionCode: 'SFS2023:945/B1', recordedGrades: [1], distributionAssumed: true });
      expect(codes(pupil!)).toContain('TIMPLAN_STAGE_OLD_COHORT_DISTRIBUTION_ASSUMED');
    }
  });

  it('10: an old-cohort pupil in new åk 10 is still in högstadiet', () => {
    const [pupil] = run(10);
    expect(stage(pupil!, 'HOG')).toMatchObject({ recordedGrades: [7, 8, 9], current: true, complete: true });
  });

  it('11: HKK is one cell over låg- and mellanstadiet', () => {
    const [pupil] = run(11);
    expect(stage(pupil!, 'LAG_MELLAN')).toMatchObject({ grades: [1, 2, 3, 4, 5, 6], complete: true });
    expect(cell(pupil!, 'LAG_MELLAN', 'HKK')).toMatchObject({ nationalHours: 40, plannedHours: 36, status: 'BELOW_WITHIN_CAP' });
    expect(stage(pupil!, 'MELLAN').cells.find((entry) => entry.code === 'HKK')).toBeUndefined();
  });

  it('12: biologi under its own minimum is a warning of its own', () => {
    const [pupil] = run(12);
    expect(pupil!.verdicts.find((verdict) => verdict.code === 'TIMPLAN_PUPIL_STAGE_GROUP_MINIMUM_UNMET')).toMatchObject({
      severity: 'warning',
      params: { childCode: 'BI', minimumHours: 80, plannedHours: 45 },
    });
  });

  it('13: svenska and an SvA group are summed into one cell for the pupil', () => {
    const [pupil] = run(13);
    expect(cell(pupil!, 'HOG', 'SV_SVA').plannedHours).toBe(383);
  });

  it('14: a future grade no plan carries leaves the stage unjudged', () => {
    const [carried, uncarried] = run(14);
    expect(stage(carried!, 'MELLAN')).toMatchObject({ plannedGrades: [5, 6], complete: true });
    expect(stage(uncarried!, 'MELLAN')).toMatchObject({ plannedGrades: [5], unplannedGrades: [6], complete: false });
  });

  it('15: the latest form decides the version, and the change is named', () => {
    const [pupil] = run(15);
    expect(pupil!.schoolForm).toBe('ANPASSAD_GRUNDSKOLA_AMNEN');
    expect(stage(pupil!, 'HOG').versionCode).toBe('SFS2022:1619/B2A');
    expect(codes(pupil!)).toContain('TIMPLAN_PUPIL_STAGE_FORM_CHANGED');
  });

  it('16: a school with no timplan and no national codes gets notices and no cell at all', () => {
    const [pupil] = run(16);
    expect(stage(pupil!, 'HOG').cells).toEqual([]);
    expect(pupil!.verdicts.every((verdict) => verdict.severity === 'notice')).toBe(true);
    expect(codes(pupil!)).toContain('TIMPLAN_PUPIL_STAGE_SUBJECTS_UNMAPPED');
  });

  it('18: months away are unrecorded', () => {
    expect(stage(run(18)[0]!, 'MELLAN')).toMatchObject({ partlyRecordedGrades: [5], complete: false });
  });

  it('19: a repeated grade counts both years and is named, before 2028 and after it', () => {
    const [before, after] = run(19);
    expect(cell(before!, 'HOG', 'MA').plannedHours).toBe(537.3);
    expect(codes(before!)).toContain('TIMPLAN_PUPIL_STAGE_GRADE_REPEATED');
    expect(after!.regime).toBe('PRE_2028');
    expect(after!.cohortStartHT).toBe(2029);
    expect(codes(after!)).toContain('TIMPLAN_PUPIL_STAGE_GRADE_REPEATED');
  });

  it('21: a home class with no årskurs puts the pupil in no stage', () => {
    const [pupil] = run(21);
    expect(pupil!.stages).toEqual([]);
    expect(codes(pupil!)).toEqual(['TIMPLAN_PUPIL_STAGE_GRADE_UNKNOWN']);
  });

  it('22: a shortfall under one hour is arithmetic; one hour is a finding, rounded up to the tenth', () => {
    const [short59, short60, short61] = run(22);
    expect(cell(short59!, 'MELLAN', 'MA')).toMatchObject({ status: 'MET', plannedShortfallHours: 0 });
    expect(cell(short60!, 'MELLAN', 'MA')).toMatchObject({ status: 'BELOW', plannedShortfallHours: 1 });
    // 61 minutes is 1,02 h: rounded UP, so planned + shortfall is never less than the national figure.
    expect(cell(short61!, 'MELLAN', 'MA')).toMatchObject({ status: 'BELOW', plannedShortfallHours: 1.1 });
    expect(codes(short59!)).toEqual([]);
    expect(codes(short60!)).toEqual(['TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL', 'TIMPLAN_PUPIL_STAGE_PROJECTED_BELOW_NATIONAL']);
  });

  it('23: a grade is recorded in full from 995 per mille, a day or two of rounding', () => {
    const [full, partly] = run(23);
    expect(stage(full!, 'MELLAN')).toMatchObject({ complete: true, recordedGrades: [4, 5, 6], partlyRecordedGrades: [] });
    expect(stage(partly!, 'MELLAN')).toMatchObject({ complete: false, recordedGrades: [4, 6], partlyRecordedGrades: [5] });
    expect(codes(partly!)).toEqual(['TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED']);
  });

  it('24: a grade wholly in a class since deleted is unrecorded: the stage is not judged, no 0 h shortfall', () => {
    const [pupil] = run(24);
    expect(stage(pupil!, 'HOG')).toMatchObject({
      recordedGrades: [7, 9],
      partlyRecordedGrades: [],
      unrecordedGrades: [8],
      complete: false,
      classDeleted: true,
    });
    expect(cell(pupil!, 'HOG', 'MA')).toMatchObject({ status: 'UNRECORDED', projectedStatus: 'UNRECORDED', plannedShortfallHours: 0 });
    expect(codes(pupil!)).toEqual(['TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED']);
    expect(pupil!.verdicts[0]!.params).toMatchObject({ unrecordedGrades: '8', classDeleted: 1 });
  });

  it('never refuses: an empty input is an empty answer', () => {
    expect(computePupilStages({ ...cases[0]!.input, pupils: [] })).toEqual({ asOfDate: cases[0]!.input.asOfDate, pupils: [] });
  });
});
