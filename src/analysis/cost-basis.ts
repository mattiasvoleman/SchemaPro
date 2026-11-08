import type { GradeNumbering } from '../common/grade-numbering';
import type { TeacherLoadReport } from '../staffing/teacher-load';
import type { Audiences } from './audience';
import {
  COST_CATEGORIES,
  type AnalysisNotice,
  type CostBasisCell,
  type CostBasisPart,
  type CostBasisResponse,
  type CostCategory,
  type HoursByCategory,
  type SchoolPartView,
} from './analysis.types';
import { assignmentKey, unqualifiedKeys } from './key-figures';
import { byGrade, partOfGrade } from './school-part-rules';

/*
 * Kostnadsunderlag per elev: lärartid per elev gånger en kostnad per timme,
 * per skoldel och årskurs.
 *
 * THE TIME IS THE REPORT'S. The hours of a row are what the load report
 * charges its teacher over the year (TeacherAssignment.hoursPerYear: the
 * row's lessons × minutes × the year's teaching weeks, less lov, × the role's
 * percentage and, under the Faktor model, the subject's factor), so a
 * teacher's cost and their load are two views of one figure. Uppdrag and
 * rastvakt are not in it: they are time the school negotiated as such, are in
 * the löneunderlag, and have no pupil to be divided over. (BESLUT.)
 *
 * THE COST IS THE SCHOOL'S RATE, NEVER A SALARY. Each hour is in one
 * personalkategori and costs what the school states for it (StaffCostRates):
 *
 *   TEACHER              a row taught by a teacher whom a behörighet covers,
 *                        and every row of a school that has recorded none (it
 *                        has not said that nobody is qualified, it has said
 *                        nothing);
 *   UNQUALIFIED_TEACHER  a row the load report lists as unqualified;
 *   SUBSTITUTE           the held lessons a vikarie took, the hour export's
 *                        own rows, in clock hours.
 *
 * A category that carries hours and has no rate makes the cost of those rows
 * UNKNOWN (null), not zero: a cost per pupil that silently leaves the vikarie
 * out reads as cheaper than it was.
 *
 * DIVIDED OVER THE PUPILS OF THE ROW. A row's hours are shared equally by the
 * pupils on its roster (audience.ts), and each share lands in the årskurs of
 * that pupil's home class, so a group of eighth and ninth graders costs each
 * its own part. A cell is then an årskurs (and its skoldel): its hours are
 * what its pupils' rows charged, its pupils are the school's pupils in that
 * årskurs, and the cost per pupil is the cell's cost over them. A row with no
 * pupil on it stands on its group's own årskurs and is counted in a notice.
 *
 * PURE. The caller reads the rows and the rates.
 */

export interface SubstituteRow {
  studentGroupId: string;
  subjectId: string;
  /** Clock minutes of held cover. */
  minutes: number;
}

export interface CostInput {
  planned: TeacherLoadReport;
  audiences: Audiences;
  parts: readonly SchoolPartView[];
  numbering: GradeNumbering;
  rates: ReadonlyMap<CostCategory, number>;
  substitutes: readonly SubstituteRow[];
}

type Hours = HoursByCategory;
const noHours = (): Hours => ({ TEACHER: 0, UNQUALIFIED_TEACHER: 0, SUBSTITUTE: 0 });
const sumHours = (hours: Hours): number => hours.TEACHER + hours.UNQUALIFIED_TEACHER + hours.SUBSTITUTE;
const round = (value: number, places: number): number => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/** SEK for a set of hours, or null when a category that carries hours has no rate. */
function costOf(hours: Hours, rates: ReadonlyMap<CostCategory, number>): number | null {
  let cost = 0;
  for (const category of COST_CATEGORIES) {
    if (hours[category] <= 0) continue;
    const rate = rates.get(category);
    if (rate === undefined) return null;
    cost += hours[category] * rate;
  }
  return cost;
}

interface Tally {
  pupils: number;
  hours: Hours;
}

const rounded = (hours: Hours): Hours => ({
  TEACHER: round(hours.TEACHER, 2),
  UNQUALIFIED_TEACHER: round(hours.UNQUALIFIED_TEACHER, 2),
  SUBSTITUTE: round(hours.SUBSTITUTE, 2),
});

function figures(tally: Tally, rates: ReadonlyMap<CostCategory, number>) {
  const cost = costOf(tally.hours, rates);
  return {
    pupils: tally.pupils,
    hours: rounded(tally.hours),
    hoursPerPupil: tally.pupils > 0 ? round(sumHours(tally.hours) / tally.pupils, 2) : null,
    cost: cost === null ? null : round(cost, 2),
    costPerPupil: cost === null || tally.pupils === 0 ? null : round(cost / tally.pupils, 2),
  };
}

export function buildCostBasis(input: CostInput): Pick<CostBasisResponse, 'cells' | 'parts' | 'total' | 'missingRates' | 'notices'> {
  const { planned, audiences, parts, numbering, rates } = input;
  const unqualified = unqualifiedKeys(planned);
  const recorded = planned.qualificationsRecorded;

  const hoursByGrade = new Map<number | null, Hours>();
  let rowsWithoutPupils = 0;
  const put = (grade: number | null, category: CostCategory, hours: number) => {
    let entry = hoursByGrade.get(grade);
    if (!entry) hoursByGrade.set(grade, (entry = noHours()));
    entry[category] += hours;
  };
  /** Shares `hours` over the pupils of the row, each share in their årskurs. */
  const spread = (groupId: string, subjectId: string, category: CostCategory, hours: number) => {
    if (hours === 0) return;
    const audience = audiences.audienceOf(groupId, subjectId);
    if (audience.length === 0) {
      rowsWithoutPupils += 1;
      put(audiences.groupGradeOf(groupId), category, hours);
      return;
    }
    const perGrade = new Map<number | null, number>();
    for (const pupil of audience) {
      const grade = audiences.gradeOf.get(pupil) ?? null;
      perGrade.set(grade, (perGrade.get(grade) ?? 0) + 1);
    }
    for (const [grade, count] of perGrade) put(grade, category, (hours * count) / audience.length);
  };

  for (const teacher of planned.teachers) {
    for (const assignment of teacher.assignments) {
      const category: CostCategory =
        recorded && unqualified.has(assignmentKey(assignment.requirementId, teacher.userId, assignment.role))
          ? 'UNQUALIFIED_TEACHER'
          : 'TEACHER';
      spread(assignment.studentGroupId, assignment.subjectId, category, assignment.hoursPerYear);
    }
  }
  for (const row of input.substitutes) spread(row.studentGroupId, row.subjectId, 'SUBSTITUTE', row.minutes / 60);

  // The cells: every årskurs that has pupils or hours, by skoldel then årskurs.
  const grades = new Set<number | null>([...audiences.pupilsPerGrade.keys(), ...hoursByGrade.keys()]);
  const ordered = [...grades].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b));
  const partOf = (grade: number | null): SchoolPartView | null => partOfGrade(parts, grade, numbering);
  const partRank = new Map([...parts].sort(byGrade).map((part, index) => [part.id, index]));
  const rank = (grade: number | null): number => {
    const part = partOf(grade);
    return part === null ? parts.length : (partRank.get(part.id) ?? parts.length);
  };
  ordered.sort((a, b) => rank(a) - rank(b) || (a === null ? 1 : b === null ? -1 : a - b));

  const cells: CostBasisCell[] = [];
  const partTallies = new Map<string | null, Tally>();
  const total: Tally = { pupils: 0, hours: noHours() };
  const addTo = (tally: Tally, add: Tally) => {
    tally.pupils += add.pupils;
    for (const category of COST_CATEGORIES) tally.hours[category] += add.hours[category];
  };
  for (const grade of ordered) {
    const part = partOf(grade);
    const tally: Tally = { pupils: audiences.pupilsPerGrade.get(grade) ?? 0, hours: hoursByGrade.get(grade) ?? noHours() };
    cells.push({ schoolPartId: part?.id ?? null, gradeLevel: grade, ...figures(tally, rates) });
    let partTally = partTallies.get(part?.id ?? null);
    if (!partTally) partTallies.set(part?.id ?? null, (partTally = { pupils: 0, hours: noHours() }));
    addTo(partTally, tally);
    addTo(total, tally);
  }

  const partRows: CostBasisPart[] = [...partTallies.entries()]
    .map(([id, tally]) => {
      const part = id === null ? null : (parts.find((candidate) => candidate.id === id) ?? null);
      return { schoolPartId: id, name: part?.name ?? null, account: part?.account ?? null, ...figures(tally, rates) };
    })
    .sort((a, b) => (a.schoolPartId === null ? 1 : b.schoolPartId === null ? -1 : (partRank.get(a.schoolPartId) ?? 0) - (partRank.get(b.schoolPartId) ?? 0)));

  const missingRates = COST_CATEGORIES.filter((category) => total.hours[category] > 0 && !rates.has(category));
  const notices: AnalysisNotice[] = [];
  if (parts.length === 0) notices.push({ code: 'ANALYSIS_NO_SCHOOL_PARTS', params: {} });
  else if (cells.some((cell) => cell.gradeLevel !== null && cell.schoolPartId === null)) {
    notices.push({
      code: 'ANALYSIS_GRADES_WITHOUT_PART',
      params: { grades: cells.filter((cell) => cell.gradeLevel !== null && cell.schoolPartId === null).map((cell) => cell.gradeLevel).join(', ') },
    });
  }
  if (!recorded) notices.push({ code: 'ANALYSIS_QUALIFICATIONS_NOT_RECORDED', params: {} });
  for (const category of missingRates) notices.push({ code: 'ANALYSIS_RATE_MISSING', params: { category } });
  if (rowsWithoutPupils > 0) notices.push({ code: 'ANALYSIS_ROWS_WITHOUT_PUPILS', params: { rows: rowsWithoutPupils } });

  return { cells, parts: partRows, total: figures(total, rates), missingRates, notices };
}
