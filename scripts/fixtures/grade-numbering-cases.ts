/**
 * Regenerates src/common/__fixtures__/grade-numbering-cases.json from the
 * gateway's grade-numbering module — the fixture web/lib/grade-numbering.ts
 * replays too.
 *
 *   npx ts-node --transpile-only scripts/fixtures/grade-numbering-cases.ts
 *
 * Every årskurs 0..12 in both numberings, for every function; what the
 * answers MEAN is asserted in src/common/grade-numbering.spec.ts.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fromNioarig,
  gradeOfPlanRow,
  lydelseIsTioarig,
  planRowOf,
  toNioarig,
  toNioarigSpan,
  unitSpanIn,
  type GradeNumbering,
} from '../../src/common/grade-numbering';

const numberings: GradeNumbering[] = ['NIOARIG', 'TIOARIG'];
const grades = Array.from({ length: 13 }, (_, grade) => grade);

const spans = numberings.flatMap((numbering) =>
  [null, ...grades].map((gradeLevel) => ({
    numbering,
    gradeLevel,
    toNioarig: toNioarig(gradeLevel, numbering),
    fromNioarig: fromNioarig(gradeLevel, numbering),
  })),
);
const planRows = [false, true].flatMap((planTioarig) =>
  numberings.flatMap((numbering) =>
    grades.map((grade) => ({
      planTioarig,
      numbering,
      grade,
      planRowOf: planRowOf(planTioarig, numbering, grade),
      gradeOfPlanRow: gradeOfPlanRow(planTioarig, numbering, grade),
    })),
  ),
);
const lydelser = ['HT2023', 'HT2024', 'VT2028', 'HT2028', 'HT2031', 'bilaga 1'].map((term) => ({
  term,
  tioarig: lydelseIsTioarig(term),
}));

// Every span min ≤ max within 0..12, and every skolenhet span 0..10 and none.
const gradeSpans = numberings.flatMap((numbering) =>
  grades.flatMap((min) =>
    grades.filter((max) => max >= min).map((max) => ({ numbering, min, max, toNioarigSpan: toNioarigSpan({ min, max }, numbering) })),
  ),
);
const unitGrades = Array.from({ length: 11 }, (_, grade) => grade);
const unitSpans = numberings.flatMap((numbering) => [
  { numbering, gradeFrom: null, gradeTo: null, unitSpanIn: unitSpanIn({ gradeFrom: null, gradeTo: null }, numbering) },
  ...unitGrades.flatMap((gradeFrom) =>
    unitGrades
      .filter((gradeTo) => gradeTo >= gradeFrom)
      .map((gradeTo) => ({ numbering, gradeFrom, gradeTo, unitSpanIn: unitSpanIn({ gradeFrom, gradeTo }, numbering) })),
  ),
]);

writeFileSync(
  join(__dirname, '../../src/common/__fixtures__/grade-numbering-cases.json'),
  JSON.stringify({ spans, planRows, lydelser, gradeSpans, unitSpans }, null, 1) + '\n',
);
console.log('spans', spans.length, 'plan rows', planRows.length, 'lydelser', lydelser.length, 'grade spans', gradeSpans.length, 'unit spans', unitSpans.length);
