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

writeFileSync(
  join(__dirname, '../../src/common/__fixtures__/grade-numbering-cases.json'),
  JSON.stringify({ spans, planRows, lydelser }, null, 1) + '\n',
);
console.log('spans', spans.length, 'plan rows', planRows.length, 'lydelser', lydelser.length);
