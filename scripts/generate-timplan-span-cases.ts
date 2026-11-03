/*
 * Generates the årskurs-span cases of
 * src/common/__fixtures__/timplan-coverage-cases.json.
 *
 * The fixture is GENERATED from the gateway's checkLocalTimplan and never
 * edited by hand (see timplan-coverage.contract.spec.ts): the web replays the
 * same numbers. The first twenty cases predate the span and carry none; this
 * script keeps them exactly as they are, REFUSES to run if the current code no
 * longer gives their stored `check` (a span must change nothing for a plan
 * without one), and replaces every case that has a `gradeSpan` with the
 * scenarios below. The statute is read from the file, not restated.
 *
 *   npx ts-node --transpile-only scripts/generate-timplan-span-cases.ts
 *
 * The file is written in the shape it already has — an object whose values
 * are all plain is one line, everything else is expanded — so a diff shows the
 * new cases and nothing else. The script checks that its formatter reproduces
 * the file it read before it adds a case.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { join } from 'node:path';
import {
  checkLocalTimplan,
  stageGradesFor,
  type CoverageEntry,
  type CoverageNationalSubject,
  type CoverageSubject,
  type CoverageVersion,
  type GradeSpan,
  type TimplanCheck,
} from '../src/common/timplan-coverage';

const FIXTURE = join(__dirname, '../src/common/__fixtures__/timplan-coverage-cases.json');

interface FixtureCase {
  name: string;
  versionCode: string;
  planningWeeksTenths: number;
  gradeSpan?: GradeSpan;
  subjects: CoverageSubject[];
  entries: CoverageEntry[];
  check: TimplanCheck;
}

const prim = (value: unknown): boolean => value === null || typeof value !== 'object';
const primArray = (value: unknown): boolean => Array.isArray(value) && value.every(prim);
const isLeaf = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((x) => prim(x) || primArray(x));
const leafValue = (value: unknown): string =>
  Array.isArray(value) && value.length > 0
    ? value.every((x) => typeof x === 'number')
      ? JSON.stringify(value)
      : `[${value.map((x) => JSON.stringify(x)).join(', ')}]`
    : JSON.stringify(value);

/** The fixture's layout: a leaf object on one line, everything else expanded. */
function format(value: unknown, indent = ''): string {
  if (prim(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((x) => `${indent}  ${format(x, `${indent}  `)}`).join(',\n')}\n${indent}]`;
  }
  if (isLeaf(value)) {
    return `{ ${Object.entries(value as object)
      .map(([k, x]) => `${JSON.stringify(k)}: ${leafValue(x)}`)
      .join(', ')} }`;
  }
  const entries = Object.entries(value as object);
  return `{\n${entries
    .map(([k, x]) => `${indent}  ${JSON.stringify(k)}: ${format(x, `${indent}  `)}`)
    .join(',\n')}\n${indent}}`;
}

const text = readFileSync(FIXTURE, 'utf8');
const fixture = JSON.parse(text) as {
  statute: { versions: CoverageVersion[]; nationalSubjects: CoverageNationalSubject[] };
  cases: FixtureCase[];
};
strictEqual(`${format(fixture)}\n`, text, 'the formatter must reproduce the fixture it read');

const { versions, nationalSubjects } = fixture.statute;
const versionByCode = new Map(versions.map((v) => [v.code, v]));
const parentOf = new Map(nationalSubjects.map((s) => [s.code, s.parentCode]));

const run = (c: Omit<FixtureCase, 'check'>): TimplanCheck =>
  checkLocalTimplan({
    planningWeeksTenths: c.planningWeeksTenths,
    version: versionByCode.get(c.versionCode)!,
    nationalSubjects,
    subjects: c.subjects,
    entries: c.entries,
    gradeSpan: c.gradeSpan ?? null,
  });

// A span must change nothing for a plan without one.
const oldCases = fixture.cases.filter((c) => c.gradeSpan === undefined);
for (const c of oldCases) deepStrictEqual(JSON.parse(JSON.stringify(run(c))), c.check, c.name);

/**
 * A plan that meets the bilaga for the årskurser it holds: every top-level
 * cell at ceil(hours × 600 / weeks / årskurser of the stadium) minutes a week
 * in each held årskurs — the årskurser the SPAN holds, but divided by all the
 * årskurser of the stadium, so a partly held stadium is met exactly to its
 * share. A group with children (NO, SO) is planned child by child, each at its
 * minimum plus an even part of the rest.
 */
function compliant(
  versionCode: string,
  weeksTenths: number,
  span: GradeSpan | null,
  override: (code: string, stage: string, perGrade: number) => number = (_c, _s, perGrade) => perGrade,
): { subjects: CoverageSubject[]; entries: CoverageEntry[] } {
  const version = versionByCode.get(versionCode)!;
  const stageGrades = stageGradesFor(version);
  const held = (grade: number) => span === null || (grade >= span.gradeFrom && grade <= span.gradeTo);
  const gradesOf = (stage: string): number[] =>
    stage === 'LAG_MELLAN' ? [...stageGrades.LAG, ...stageGrades.MELLAN] : stageGrades[stage as 'LAG'];
  const subjects = new Map<string, CoverageSubject>();
  const entries: CoverageEntry[] = [];
  const subject = (code: string) => {
    if (!subjects.has(code)) {
      subjects.set(code, { id: `s-${code}`, name: code, nationalCode: code, countsTowardTimplan: true });
    }
    return `s-${code}`;
  };
  const place = (code: string, stage: string, hours: number) => {
    const grades = gradesOf(stage);
    const perGrade = override(code, stage, Math.ceil((hours * 600) / weeksTenths / grades.length));
    for (const grade of grades.filter(held)) {
      entries.push({ subjectId: subject(code), gradeLevel: grade, minutesPerWeek: perGrade });
    }
  };
  for (const entry of version.entries) {
    if (parentOf.get(entry.subjectCode)) continue;
    const children = version.entries.filter(
      (e) => e.stage === entry.stage && parentOf.get(e.subjectCode) === entry.subjectCode,
    );
    if (children.length === 0) {
      place(entry.subjectCode, entry.stage, entry.hours);
      continue;
    }
    const rest = entry.hours - children.reduce((sum, child) => sum + child.hours, 0);
    for (const child of children) place(child.subjectCode, entry.stage, child.hours + rest / children.length);
  }
  // The statute's own order of codes keeps a diff readable.
  return { subjects: [...subjects.values()], entries };
}

const WEEKS = 356;
const B1 = 'SFS2023:945/B1';

const scenarios: Omit<FixtureCase, 'check'>[] = [];
const add = (
  name: string,
  versionCode: string,
  gradeSpan: GradeSpan,
  plan: { subjects: CoverageSubject[]; entries: CoverageEntry[] },
  weeksTenths = WEEKS,
) => scenarios.push({ name, versionCode, planningWeeksTenths: weeksTenths, gradeSpan, ...plan });

/** The same plan with the minutes of one subject in some årskurser replaced. */
const withMinutes = (
  plan: { subjects: CoverageSubject[]; entries: CoverageEntry[] },
  code: string,
  grades: number[],
  minutes: number,
) => ({
  subjects: plan.subjects,
  entries: plan.entries.map((e) =>
    e.subjectId === `s-${code}` && grades.includes(e.gradeLevel) ? { ...e, minutesPerWeek: minutes } : e,
  ),
});

const withSubject = (
  plan: { subjects: CoverageSubject[]; entries: CoverageEntry[] },
  extra: CoverageSubject,
  entries: CoverageEntry[],
) => ({ subjects: [...plan.subjects, extra], entries: [...plan.entries, ...entries] });

const programming: CoverageSubject = {
  id: 's-PROG',
  name: 'Programmering',
  nationalCode: null,
  countsTowardTimplan: true,
};

// 1–3. The three schools of the report: a correct plan has no verdict at all.
add('a 4–9 plan holds no lågstadium: met, a guarantee of 4 988 h and 434,4 h of skolans val', B1, { gradeFrom: 4, gradeTo: 9 }, compliant(B1, WEEKS, { gradeFrom: 4, gradeTo: 9 }));
add(
  'an F–5 plan: lågstadiet whole, mellanstadiet two thirds, förskoleklassen outside every stadium',
  B1,
  { gradeFrom: 0, gradeTo: 5 },
  withSubject(
    compliant(B1, WEEKS, { gradeFrom: 0, gradeTo: 5 }),
    { id: 's-FKL', name: 'Förskoleklass', nationalCode: null, countsTowardTimplan: true },
    [{ subjectId: 's-FKL', gradeLevel: 0, minutesPerWeek: 600 }],
  ),
);
add('a 6–9 plan: mellanstadiet one third, högstadiet whole', B1, { gradeFrom: 6, gradeTo: 9 }, compliant(B1, WEEKS, { gradeFrom: 6, gradeTo: 9 }));

// 4. A span holding every årskurs is no span: the numbers of the whole form.
add('a span of every årskurs is the whole form: the numbers of no span', B1, { gradeFrom: 0, gradeTo: 9 }, compliant(B1, WEEKS, null));

// 5–6. A stadium held in part is a notice, a stadium held whole is judged as ever.
{
  const base = compliant(B1, WEEKS, { gradeFrom: 0, gradeTo: 5 });
  let plan = withMinutes(base, 'MA', [4, 5], 100);
  plan = withMinutes(plan, 'BL', [4, 5], 20);
  plan = withMinutes(plan, 'KE', [4, 5], 25);
  plan = withSubject(plan, programming, [1, 2, 3, 4, 5].map((g) => ({ subjectId: 's-PROG', gradeLevel: g, minutesPerWeek: 120 })));
  add('an F–5 plan under its share in mellanstadiet: notices only, a protected subject and a child minimum included', B1, { gradeFrom: 0, gradeTo: 5 }, plan);
  plan = withMinutes(plan, 'MA', [1, 2, 3], 200);
  add('an F–5 plan: lågstadiet is judged whole, so a protected subject reduced there is a warning, in mellanstadiet a notice', B1, { gradeFrom: 0, gradeTo: 5 }, plan);
}

// 6b. A short share is an estimate to the tenth and reads as planned + deficit.
add('an empty F–5 plan: every share is short and reads as planned + deficit', B1, { gradeFrom: 0, gradeTo: 5 }, { subjects: [], entries: [] });

// 7. Minutes in an årskurs the span lacks enter no sum.
add(
  'a 4–9 plan with minutes in åk 2: outside the span, reported and not counted',
  B1,
  { gradeFrom: 4, gradeTo: 9 },
  withSubject(compliant(B1, WEEKS, { gradeFrom: 4, gradeTo: 9 }), { ...programming, id: 's-NOT', name: 'Läsning' }, [
    { subjectId: 's-NOT', gradeLevel: 2, minutesPerWeek: 90 },
  ]),
);

// 8. A stadium the span holds whole is judged against all of it.
add(
  'a 4–9 plan short in högstadiet: judged against the whole stadium, protected subjects warned',
  B1,
  { gradeFrom: 4, gradeTo: 9 },
  withMinutes(withMinutes(compliant(B1, WEEKS, { gradeFrom: 4, gradeTo: 9 }), 'MA', [7, 8, 9], 100), 'EN', [7, 8, 9], 60),
);

// 9–10. The 2028 law has a total and no cells.
{
  const LAW = 'SFS2025:729';
  const subjects: CoverageSubject[] = [{ id: 's-MA', name: 'MA', nationalCode: 'MA', countsTowardTimplan: true }];
  const at = (grades: number[], minutes: number): CoverageEntry[] =>
    grades.map((gradeLevel) => ({ subjectId: 's-MA', gradeLevel, minutesPerWeek: minutes }));
  add('the 2028 law, a plan for åk 5–10: the total belongs to the whole form and is not judged', LAW, { gradeFrom: 5, gradeTo: 10 }, { subjects, entries: at([5, 6, 7, 8, 9, 10], 180) });
  add('the 2028 law, a plan for åk 1–10: the total is judged as before', LAW, { gradeFrom: 1, gradeTo: 10 }, { subjects, entries: at([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 180) });
}

// 11. An uneven denominator: specialskolan's merged låg- och mellanstadium spans seven årskurser.
{
  const B3 = 'SFS2023:945/B3';
  const span = { gradeFrom: 5, gradeTo: 10 };
  add('specialskolan åk 5–10: the merged cell is cut over seven årskurser, met', B3, span, compliant(B3, WEEKS, span));
  add('specialskolan åk 5–10: hem- och konsumentkunskap under its three sevenths is a notice', B3, span, withMinutes(compliant(B3, WEEKS, span), 'HKK', [5, 6, 7], 8));
}

// 12. Sameskolan has no högstadium: a 1–3 plan holds lågstadiet and half the merged cell.
add('sameskolan åk 1–3: lågstadiet whole, no mellanstadium, the merged cell half', 'SFS2023:945/B4', { gradeFrom: 1, gradeTo: 3 }, compliant('SFS2023:945/B4', WEEKS, { gradeFrom: 1, gradeTo: 3 }));

const spanCases: FixtureCase[] = scenarios.map((c) => ({ ...c, check: JSON.parse(JSON.stringify(run(c))) as TimplanCheck }));

// The whole form by span must read exactly as the whole form by no span.
{
  const whole = spanCases.find((c) => c.name.startsWith('a span of every årskurs'))!;
  const without = JSON.parse(JSON.stringify(run({ ...whole, gradeSpan: undefined }))) as TimplanCheck;
  deepStrictEqual({ ...whole.check, gradeSpan: undefined }, { ...without, gradeSpan: undefined });
}

fixture.cases = [...oldCases, ...spanCases];
writeFileSync(FIXTURE, `${format(fixture)}\n`);

for (const c of spanCases) {
  const verdicts = c.check.verdicts.map((v) => `${v.severity === 'warning' ? 'W' : 'n'}:${v.code.replace('TIMPLAN_', '')}${v.subjectCode ? `/${v.subjectCode}` : ''}`);
  console.log(`${c.name}\n  total ${JSON.stringify(c.check.total)} pool ${JSON.stringify(c.check.skolansVal)}\n  ${verdicts.join(' ') || 'no verdicts'}`);
}
console.log(`${oldCases.length} old cases kept, ${spanCases.length} span cases written`);
