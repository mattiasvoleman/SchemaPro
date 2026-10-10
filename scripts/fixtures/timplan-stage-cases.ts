/**
 * Regenerates src/common/__fixtures__/timplan-stage-cases.json from the
 * gateway's stage module — the fixture web/lib/timplan-stage.ts replays too.
 *
 *   npx ts-node --transpile-only scripts/fixtures/timplan-stage-cases.ts
 *
 * Run it when the module changes on purpose; the meaning of every case is
 * asserted separately in src/common/timplan-stage.spec.ts, so a generator
 * that writes the wrong numbers fails there, not silently. The national
 * cells below are bilaga 1's (SFS 2023:945) and bilaga 2's (SFS 2022:1619)
 * printed hours, as seeded by 20261006090000; SFS 2025:729 carries its total
 * and no cell (20261010130000).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cohortNotice, type CohortClass } from '../../src/common/timplan-cohorts';
import {
  computePupilStages,
  summarizeClassStages,
  type StageInput,
  type StageLine,
  type StagePupilInput,
  type StageVersion,
  type StageYearCells,
} from '../../src/common/timplan-stage';

const e = (subjectCode: string, stage: 'LAG' | 'MELLAN' | 'HOG' | 'LAG_MELLAN', hours: number, prot = false, min: number | null = null) => ({
  subjectCode, stage, hours, minimumHoursPerChild: min, protectedFromReduction: prot,
});
// Bilaga 1 (SFS 2023:945), the cells the cases touch, at their printed hours.
const B1: StageVersion = {
  code: 'SFS2023:945/B1', schoolForm: 'GRUNDSKOLA', totalHours: 6890, reductionCapPercent: 20,
  appliesFromCohortTerm: 'HT2024', appliesBy: 'STAGES_NOT_COMPLETED',
  entries: [
    e('BL', 'LAG', 60), e('BL', 'MELLAN', 80), e('BL', 'HOG', 100),
    e('EN', 'LAG', 60, true), e('EN', 'MELLAN', 220, true), e('EN', 'HOG', 200, true),
    e('HKK', 'LAG_MELLAN', 40), e('HKK', 'HOG', 90),
    e('MA', 'LAG', 420, true), e('MA', 'MELLAN', 410, true), e('MA', 'HOG', 400, true),
    e('NO', 'LAG', 145), e('NO', 'MELLAN', 216, false, 60), e('NO', 'HOG', 289, false, 80),
    e('BI', 'MELLAN', 60), e('FY', 'MELLAN', 60), e('KE', 'MELLAN', 60),
    e('BI', 'HOG', 80), e('FY', 'HOG', 80), e('KE', 'HOG', 80),
    e('SV_SVA', 'LAG', 680, true), e('SV_SVA', 'MELLAN', 520, true), e('SV_SVA', 'HOG', 290, true),
  ],
};
const SFS2025: StageVersion = {
  code: 'SFS2025:729', schoolForm: 'GRUNDSKOLA', totalHours: 7424, reductionCapPercent: null,
  appliesFromCohortTerm: 'HT2028', appliesBy: 'COHORTS_STARTING', entries: [],
};
const B2A: StageVersion = {
  code: 'SFS2022:1619/B2A', schoolForm: 'ANPASSAD_GRUNDSKOLA_AMNEN', totalHours: 6890, reductionCapPercent: null,
  appliesFromCohortTerm: 'HT2023', appliesBy: 'STAGES_NOT_COMPLETED',
  entries: [e('MA', 'LAG', 400), e('MA', 'MELLAN', 400), e('MA', 'HOG', 415), e('SV_SVA', 'HOG', 400), e('HKK', 'LAG_MELLAN', 230), e('HKK', 'HOG', 295)],
};
const versions = [B1, SFS2025, B2A];
const nationalSubjects = [
  { code: 'BI', name: 'Biologi', parentCode: 'NO' }, { code: 'BL', name: 'Bild', parentCode: null },
  { code: 'EN', name: 'Engelska', parentCode: null }, { code: 'FY', name: 'Fysik', parentCode: 'NO' },
  { code: 'HKK', name: 'Hem- och konsumentkunskap', parentCode: null }, { code: 'KE', name: 'Kemi', parentCode: 'NO' },
  { code: 'MA', name: 'Matematik', parentCode: null }, { code: 'NO', name: 'Naturorienterande ämnen', parentCode: null },
  { code: 'SV_SVA', name: 'Svenska eller svenska som andraspråk', parentCode: null },
];

const H = 60;
/** A line: planned hours; delivered share of it; at-plan share; credited hours; ahead hours. */
const line = (code: string | null, plannedH: number, o: { delivered?: number; atPlan?: number; credited?: number; ahead?: number } = {}): StageLine => {
  const planned = Math.round(plannedH * H);
  const atPlan = Math.round(planned * (o.atPlan ?? 0));
  return {
    code,
    plannedMinutes: planned,
    deliveredMinutes: Math.round(planned * (o.delivered ?? 1)) - atPlan,
    creditedMinutes: Math.round((o.credited ?? 0) * H),
    atPlanMinutes: atPlan,
    aheadMinutes: Math.round((o.ahead ?? 0) * H),
  };
};
const year = (id: string, ht: number, grade: number | null, lines: StageLine[], o: Partial<StageYearCells> = {}): StageYearCells => ({
  academicYearId: id, yearStartHT: ht, gradeLevel: grade, schoolForm: 'GRUNDSKOLA', basis: 'RECORDED',
  recordedPermille: 1000, recordedFrom: `${ht}-08-17`, backfilled: false, classDeleted: false, lines, ...o,
});
const future = (ht: number, grade: number, lines: StageLine[], carried = true, schoolForm: StageYearCells['schoolForm'] = 'GRUNDSKOLA'): StageYearCells => ({
  academicYearId: null, yearStartHT: ht, gradeLevel: grade, schoolForm, basis: 'FUTURE',
  recordedPermille: carried ? 1000 : 0, recordedFrom: null, backfilled: false, classDeleted: false,
  lines: lines.map((l) => ({ ...l, deliveredMinutes: 0, atPlanMinutes: 0, creditedMinutes: 0, aheadMinutes: l.plannedMinutes })),
});
// The current year's block: so far delivered, the rest ahead.
const current = (id: string, ht: number, grade: number, lines: StageLine[], o: Partial<StageYearCells> = {}) =>
  year(id, ht, grade, lines.map((l) => ({ ...l, deliveredMinutes: Math.round(l.plannedMinutes * 0.2), atPlanMinutes: 0, aheadMinutes: l.plannedMinutes - Math.round(l.plannedMinutes * 0.2) })), o);

const y = (ht: number) => `00000000-0000-4000-8000-0000000${ht}0`;
const pupil = (n: number, homeGroupId: string | null, years: StageYearCells[]): StagePupilInput => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, homeGroupId, years,
});
const c7a = '00000000-0000-4000-8000-0000000c07a0';
const c6a = '00000000-0000-4000-8000-0000000c06a0';

// A mellanstadium planned at a third of each cell a year.
const mellan = (scale = 1, extra: StageLine[] = []) => [
  line('MA', (410 / 3 + 1) * scale), line('SV_SVA', 520 / 3 + 1), line('EN', 220 / 3 + 1), line('BL', 80 / 3 + 1),
  line('NO', 9.1), line('BI', 21), line('FY', 21), line('KE', 21), line('HKK', 8), ...extra,
];
/** Three years of mellanstadiet whose matematik sums to `total` minutes exactly. */
const mellanWithMa = (total: number): StageYearCells[] => {
  const per = Math.floor(total / 3);
  const ma = (minutes: number) => [line('MA', minutes / H), ...mellan().filter((l) => l.code !== 'MA')];
  return [year(y(2024), 2024, 4, ma(per)), year(y(2025), 2025, 5, ma(per)), current(y(2026), 2026, 6, ma(total - 2 * per))];
};
const hog = (o: { ma?: number; bl?: number; bi?: number } = {}) => [
  line('MA', o.ma ?? 400 / 3 + 1), line('SV_SVA', 290 / 3 + 1), line('EN', 200 / 3 + 1), line('BL', o.bl ?? 100 / 3 + 1),
  line('NO', 15.5), line('BI', o.bi ?? 27), line('FY', 27), line('KE', 27), line('HKK', 30.5),
];

type Case = { name: string; activeHT: number; pupils: StagePupilInput[] };
const cases: Case[] = [
  { name: '1. a mellanstadium pupil, three recorded years, every cell met', activeHT: 2026, pupils: [
    pupil(1, c6a, [year(y(2024), 2024, 4, mellan()), year(y(2025), 2025, 5, mellan()), current(y(2026), 2026, 6, mellan())]),
  ] },
  { name: '2. matematik under the national hours: a protected subject, a warning', activeHT: 2026, pupils: [
    pupil(2, c6a, [year(y(2024), 2024, 4, mellan(0.9)), year(y(2025), 2025, 5, mellan(0.9)), current(y(2026), 2026, 6, mellan(0.9))]),
  ] },
  { name: '3. bild 10 % under: within the 20 % cap, a notice that it may be skolans val', activeHT: 2026, pupils: [
    pupil(3, c7a, [year(y(2024), 2024, 7, hog({ bl: 30 })), year(y(2025), 2025, 8, hog({ bl: 30 })), current(y(2026), 2026, 9, hog({ bl: 30 }))]),
  ] },
  { name: '4. a mid-year move 7A → 7B: the year in two blocks, recorded in full', activeHT: 2026, pupils: [
    pupil(4, c7a, [
      year(y(2026), 2026, 7, hog().map((l) => ({ ...l, plannedMinutes: Math.round(l.plannedMinutes * 0.4), deliveredMinutes: Math.round(l.deliveredMinutes * 0.4) })), { recordedPermille: 400 }),
      current(y(2026), 2026, 7, hog().map((l) => ({ ...l, plannedMinutes: Math.round(l.plannedMinutes * 0.6) })), { recordedPermille: 600, recordedFrom: '2026-11-02' }),
      future(2027, 8, hog()), future(2028, 10, hog()),
    ]),
  ] },
  { name: '5. åk 9 whose åk 7 is before SchemaPro: partly unrecorded, no shortfall verdict', activeHT: 2026, pupils: [
    pupil(5, c7a, [year(y(2025), 2025, 8, hog({ ma: 100 })), current(y(2026), 2026, 9, hog({ ma: 100 }))]),
  ] },
  { name: '6. a backfilled segment is named', activeHT: 2026, pupils: [
    pupil(6, c6a, [year(y(2024), 2024, 4, mellan()), year(y(2025), 2025, 5, mellan()), current(y(2026), 2026, 6, mellan(), { backfilled: true, recordedFrom: '2026-10-10', recordedPermille: 1000 })]),
  ] },
  { name: '7. högstadiet finished June 2024 has no seeded lydelse; finished June 2025 reads bilaga 1', activeHT: 2026, pupils: [
    pupil(71, null, [year(y(2021), 2021, 7, hog()), year(y(2022), 2022, 8, hog()), year(y(2023), 2023, 9, hog())]),
    pupil(72, null, [year(y(2022), 2022, 7, hog()), year(y(2023), 2023, 8, hog()), year(y(2024), 2024, 9, hog())]),
  ] },
  { name: '8. åk 1 in HT 2028: the tioårig grundskola, totals only', activeHT: 2028, pupils: [
    pupil(8, c7a, [current(y(2028), 2028, 1, [line('MA', 140), line('SV_SVA', 230)]), future(2029, 2, [line('MA', 140)]), future(2030, 3, [line('MA', 140)]), future(2031, 4, [line('MA', 140)])]),
  ] },
  { name: '9. förskoleklass 2027/28 begins in åk 2 in 2028/29: the old cohort, version grade 1, bilaga 1 assumed', activeHT: 2028, pupils: [
    pupil(9, c7a, [year(y(2027), 2027, 0, [line('MA', 20)]), current(y(2028), 2028, 2, [line('MA', 140), line('SV_SVA', 227)]), future(2029, 3, [line('MA', 140), line('SV_SVA', 227)]), future(2030, 4, [line('MA', 140), line('SV_SVA', 227)])]),
  ] },
  { name: '10. an old-cohort pupil in new åk 10 in 2029/30 is still in högstadiet', activeHT: 2029, pupils: [
    pupil(10, c7a, [year(y(2027), 2027, 7, hog()), year(y(2028), 2028, 9, hog()), current(y(2029), 2029, 10, hog())]),
  ] },
  { name: '11. hem- och konsumentkunskap over låg- and mellanstadiet in one cell', activeHT: 2026, pupils: [
    pupil(11, c6a, [
      year(y(2021), 2021, 1, [line('HKK', 0)]), year(y(2022), 2022, 2, [line('HKK', 0)]), year(y(2023), 2023, 3, [line('HKK', 6)]),
      year(y(2024), 2024, 4, [line('HKK', 10)]), year(y(2025), 2025, 5, [line('HKK', 10)]), current(y(2026), 2026, 6, [line('HKK', 10)]),
    ]),
  ] },
  { name: '12. biologi under its own minimum in NO', activeHT: 2026, pupils: [
    pupil(12, c7a, [year(y(2024), 2024, 7, hog({ bi: 15 })), year(y(2025), 2025, 8, hog({ bi: 15 })), current(y(2026), 2026, 9, hog({ bi: 15 }))]),
  ] },
  { name: '13. svenska and an SvA group are one cell, summed for the pupil', activeHT: 2026, pupils: [
    pupil(13, c7a, [
      year(y(2024), 2024, 7, [...hog(), line('SV_SVA', 30)]), year(y(2025), 2025, 8, [...hog(), line('SV_SVA', 30)]),
      current(y(2026), 2026, 9, [...hog(), line('SV_SVA', 30)]),
    ]),
  ] },
  { name: '14. future grades: carried by a plan, or by none', activeHT: 2026, pupils: [
    pupil(141, c6a, [current(y(2026), 2026, 4, mellan()), future(2027, 5, mellan()), future(2028, 7, mellan())]),
    pupil(142, c6a, [current(y(2026), 2026, 4, mellan()), future(2027, 5, mellan()), future(2028, 7, [], false)]),
  ] },
  { name: '15. grundskola then anpassade grundskolan: the latest form decides the version', activeHT: 2026, pupils: [
    pupil(15, c7a, [year(y(2024), 2024, 7, [line('MA', 140)]), year(y(2025), 2025, 8, [line('MA', 140)], { schoolForm: 'ANPASSAD_GRUNDSKOLA_AMNEN' }), current(y(2026), 2026, 9, [line('MA', 140)], { schoolForm: 'ANPASSAD_GRUNDSKOLA_AMNEN' })]),
  ] },
  { name: '16. a school with no timplan and no national codes: notices only, nothing breaks', activeHT: 2026, pupils: [
    pupil(16, c7a, [current(y(2026), 2026, 7, [line(null, 900)], { schoolForm: null })]),
  ] },
  { name: '17. a deleted class leaves its period unrecorded, never zero', activeHT: 2026, pupils: [
    pupil(17, c7a, [year(y(2024), 2024, 7, hog()), year(y(2025), 2025, 8, hog().map((l) => ({ ...l, plannedMinutes: Math.round(l.plannedMinutes * 0.6), deliveredMinutes: Math.round(l.deliveredMinutes * 0.6) })), { recordedPermille: 600, classDeleted: true }), current(y(2026), 2026, 9, hog())]),
  ] },
  { name: '18. deactivated and reactivated mid-year: the months away are unrecorded', activeHT: 2026, pupils: [
    pupil(18, c6a, [year(y(2024), 2024, 4, mellan()), year(y(2025), 2025, 5, mellan(), { recordedPermille: 700 }), current(y(2026), 2026, 6, mellan())]),
  ] },
  { name: '19. a repeated årskurs, before 2028 and after it', activeHT: 2029, pupils: [
    pupil(191, c7a, [year(y(2024), 2024, 7, hog()), year(y(2025), 2025, 8, hog()), year(y(2026), 2026, 8, hog()), year(y(2027), 2027, 9, hog())]),
    pupil(192, c7a, [year(y(2027), 2027, 0, [line('MA', 10)]), year(y(2028), 2028, 2, [line('MA', 140)]), current(y(2029), 2029, 2, [line('MA', 140)])]),
  ] },
  { name: '20. an old-cohort pupil at version grade 1 in 2028/29 is not given SFS 2025:729', activeHT: 2028, pupils: [
    pupil(20, c7a, [current(y(2028), 2028, 2, [line('MA', 140)])]),
  ] },
  { name: '21. a home class with no årskurs: the grade is unknown, no stage is guessed', activeHT: 2026, pupils: [
    pupil(21, c7a, [current(y(2026), 2026, null as unknown as number, [line('MA', 140)])]),
  ] },
  // The boundaries the module draws, so a mirror that moves one by a minute
  // or a per mille fails the replay rather than agreeing on every value
  // either side of it.
  { name: '22. matematik 59, 60 and 61 minutes short over the stage: arithmetic, then a finding rounded up', activeHT: 2026, pupils: [
    pupil(221, c6a, mellanWithMa(410 * H - 59)),
    pupil(222, c6a, mellanWithMa(410 * H - 60)),
    pupil(223, c6a, mellanWithMa(410 * H - 61)),
  ] },
  { name: '23. a grade recorded at 995 per mille is recorded in full; at 994 it is partly recorded', activeHT: 2026, pupils: [
    pupil(231, c6a, [year(y(2024), 2024, 4, mellan()), year(y(2025), 2025, 5, mellan(), { recordedPermille: 995 }), current(y(2026), 2026, 6, mellan())]),
    pupil(232, c6a, [year(y(2024), 2024, 4, mellan()), year(y(2025), 2025, 5, mellan(), { recordedPermille: 994 }), current(y(2026), 2026, 6, mellan())]),
  ] },
];

const out = cases.map((c) => {
  const input: StageInput = { asOfDate: `${c.activeHT}-10-10`, activeYearId: y(c.activeHT), versions, nationalSubjects, pupils: c.pupils };
  const coverage = computePupilStages(input);
  return { name: c.name, input, coverage, classes: summarizeClassStages(coverage) };
});
const cls = (id: string, name: string, gradeLevel: number | null, ht: number): CohortClass => ({ id: `00000000-0000-4000-8000-0000000c${id}`, name, gradeLevel, ht });
const withCount = versions.map((v) => ({ code: v.code, schoolForm: v.schoolForm, appliesFromCohortTerm: v.appliesFromCohortTerm, appliesBy: v.appliesBy, entryCount: v.entries.length }));
const cohortCases = [
  { name: 'a 1–9 school in 2026/27 with its rolled 2027/28', schoolForm: 'GRUNDSKOLA' as const, classes: [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => cls(`2026${g}a0`, `${g}A`, g, 2026)), cls('20270fk0', 'F-klass', 0, 2027), cls('20271a00', '1A', 1, 2027), cls('2026tg00', 'Ma-grupp', null, 2026),
  ] },
  { name: 'a school in 2028/29, renumbered', schoolForm: 'GRUNDSKOLA' as const, classes: [cls('20281a00', '1A', 1, 2028), cls('20282a00', '2A', 2, 2028), cls('202810a0', '10A', 10, 2028)] },
].map((c) => ({ ...c, versions: withCount, notice: cohortNotice(c.classes, withCount, c.schoolForm) }));

writeFileSync(
  join(__dirname, '../../src/common/__fixtures__/timplan-stage-cases.json'),
  JSON.stringify({ cases: out, cohortCases }, null, 1) + '\n',
);
console.log('cases', out.length, 'cohort cases', cohortCases.length);
