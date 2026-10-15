import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * WHO READS A POST, AND WHETHER THEY READ ITS PERIODS.
 *
 * A post changes from a date since migration 20261022120000: the base row in
 * TeacherEmployments, and periods in TeacherEmploymentPeriods overriding its
 * tjänstgöringsgrad, nedsättning and own riktmärke. The model is additive on
 * purpose — every reader of the base row keeps working — and that is also its
 * risk: a reader nobody moved silently reports the YEAR-START post, all year,
 * and nothing fails. So this spec reads src/ (not the specs) and fails on
 *
 *  1. a file that reads or writes either table — a model delegate call, or
 *     raw SQL naming one — that nobody has classified below;
 *  2. a file that reads a post's figures — targetMinutesPerWeek(), or the
 *     employmentPercent / reductionPercent / teachingTargetMinutesPerWeek of
 *     a post — that nobody has classified;
 *  3. a file classified PERIODS that does not read them: no periods include
 *     or read of the period rows, no stretchLoads / postStretches / postOn /
 *     postOfWeek / changesDuringYear;
 *  4. a file classified POST that reads one of the three figures: it was
 *     classified as reading only that a post or a period exists, a period's
 *     dates, or what a period never changes (signature, avtalsform);
 *  5. a change in the set of files classified NEXT: a file that reads the
 *     year-start post where the post on a date is the right answer. Since
 *     "Perioder i export och rullning" moved the SS12000 Duty there is none;
 *     one that joins the list is a decision, so the list is written out.
 *
 * The web half, for the screens and the files built in the browser, is
 * web/lib/employment-readers.inventory.test.ts.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

type Basis = 'PERIODS' | 'POST' | 'WRITES' | 'NEXT';

const CLASSIFIED: Record<string, { basis: Basis; why: string }> = {
  'src/staffing/load-input.ts': {
    basis: 'PERIODS',
    why: 'the one reader of the report, the staffing checks and the picker: each post with its periods, under the post’s own arms',
  },
  'src/staffing/teacher-load.ts': {
    basis: 'PERIODS',
    why: 'the report: a changing post judged stretch by stretch (stretchLoads), the year’s target and the annual block weighted over the stretches',
  },
  'src/staffing/staffing-checks.ts': {
    basis: 'PERIODS',
    why: 'WARN/REFUSE at every timplanspost write, single, imported or batched: per stretch for a changing post (STAFF_TEACHER_OVER_TARGET_IN_PERIOD)',
  },
  'src/staffing/suggest-teachers.ts': {
    basis: 'PERIODS',
    why: 'the picker’s room and wouldExceed, per stretch as the write is judged, so a candidate it calls OVER is one the write would refuse',
  },
  'src/staffing/teacher-employments.service.ts': {
    basis: 'PERIODS',
    why: 'writes the post and its periods, and lists the periods with the post',
  },
  'src/staffing/staffing-enforcement.ts': {
    basis: 'POST',
    why: 'locks the base row of every teacher a write ends up with; the period writes take the same lock, and the judgement reads the periods through load-input',
  },
  'src/cover/cover-reports.service.ts': {
    basis: 'POST',
    why: 'whether a pool member has a post at all (STAFF or POOL); a period never removes a post',
  },
  'src/publication/public-links.service.ts': {
    basis: 'POST',
    why: 'whether a teacher has a signature, which is the base row’s alone',
  },
  'src/resources/academic-years.service.ts': {
    basis: 'POST',
    why: 'counts the periods a new year bound would strand, by their dates, as it counts the uppdrag and the lov',
  },
  'src/users/users.service.ts': {
    basis: 'POST',
    why: 'counts a person’s posts before a role change that would leave a pupil with one; a period cascades with its post',
  },
  'src/import/import.service.ts': {
    basis: 'WRITES',
    why: 'the tjänster CSV writes the base row; a period is written on the Anställning card, and a re-import leaves a post’s periods as they are',
  },
  'src/cover/cover-context.ts': {
    basis: 'PERIODS',
    why: 'reads each post with its periods for the vikarie ranking (withPeriods); the hard rules ask only whether a post exists',
  },
  'src/cover/cover-suggestions.service.ts': {
    basis: 'PERIODS',
    why: 'the vikarie ranking judges the lesson’s week by the post in force on its Monday (postOfWeek), as the load report does',
  },
  'src/optimization/staffing-proposal.service.ts': {
    basis: 'PERIODS',
    why: 'plans a changing post on its tightest stretch and realises every stretch as its apply is judged; the periods are in the basis',
  },
  'src/publication/publications.service.ts': {
    basis: 'PERIODS',
    why: 'the publication gate names the worst stretch of a changing post it stops on, from the report',
  },
  'src/integration/ss12000.service.ts': {
    basis: 'PERIODS',
    why: 'SS12000 v1 /duties: a changing post is a Duty per stretch of its grad while the school shares employment, paged over the Duties',
  },
  'src/integration/ss12000-v2/slice.ts': {
    basis: 'PERIODS',
    why: 'SS12000 v2: reads the periods of the active year’s posts, only while the school shares employment',
  },
  'src/integration/ss12000-duties.ts': {
    basis: 'PERIODS',
    why: 'builds both SS12000 Duty shapes: one per stretch of the grad, each with its own dutyPercent, hoursPerYear and dates',
  },
  'src/year-rollover/rollover-staffing.ts': {
    basis: 'PERIODS',
    why: 'plans the carried post as it stands at the year’s end: a period with no Till gives its figures, one with a Till ended',
  },
  'src/year-rollover/rollover-source.ts': {
    basis: 'PERIODS',
    why: 'reads the source year’s posts with their periods for the carry',
  },
  'src/year-rollover/staffing-rollover.service.ts': {
    basis: 'POST',
    why: 'the same carry into a year rolled without it, through rollover-source and rollover-staffing; it reads the target’s posts only for who has one and their signatures',
  },
  'src/year-rollover/year-rollover.service.ts': {
    basis: 'POST',
    why: 'locks and counts the source year’s posts for the carry; a period write locks its post first, so the posts’ lock holds them',
  },
  'src/year-rollover/rollover-apply.ts': {
    basis: 'WRITES',
    why: 'writes the carried posts with the figures the plan gave them; no period row is copied',
  },
};

/** The readers left on the year-start post, written out: see 5. */
const NEXT_RELEASE: string[] = [];

const TABLE_READ =
  /\b(?:teacherEmployment|teacherEmploymentPeriod)\.(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|create|createMany|update|updateMany|upsert|delete|deleteMany|aggregate|groupBy)\b|"TeacherEmployments"|"TeacherEmploymentPeriods"/;
const FIGURES_READ =
  /\btargetMinutesPerWeek\(|\.(?:employmentPercent|reductionPercent|teachingTargetMinutesPerWeek)\b/;
const PERIODS_READ =
  /\bperiods\b|\bteacherEmploymentPeriod\.findMany\(|\bstretchLoads\(|\bpostStretches\(|\bpostOn\(|\bpostOfWeek\(|\bchangesDuringYear\(/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

/** The code without comments, so a sentence about a field is not a read of it. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const files = sourceFiles(SRC).map((path) => ({
  path: relative(ROOT, path).split('\\').join('/'),
  text: code(readFileSync(path, 'utf8')),
}));

/** The period module and its pure helpers define the figures; they read no post. */
const DEFINES = new Set(['src/staffing/employment-periods.ts']);

describe('who reads a post, and whether they read its periods (20261022120000)', () => {
  it('classifies every file that reads or writes a post or its periods', () => {
    const readers = files.filter((file) => TABLE_READ.test(file.text)).map((file) => file.path);
    expect(readers.length).toBeGreaterThan(10);
    expect(readers.filter((path) => !(path in CLASSIFIED))).toEqual([]);
  });

  it('classifies every file that reads a post’s figures', () => {
    const readers = files
      .filter((file) => !DEFINES.has(file.path) && FIGURES_READ.test(file.text))
      .map((file) => file.path);
    expect(readers.filter((path) => !(path in CLASSIFIED))).toEqual([]);
  });

  it('holds a file classified PERIODS to reading them', () => {
    const silent = Object.entries(CLASSIFIED)
      .filter(([, entry]) => entry.basis === 'PERIODS')
      .map(([path]) => path)
      .filter((path) => !PERIODS_READ.test(files.find((file) => file.path === path)?.text ?? ''));
    expect(silent).toEqual([]);
  });

  it('holds a file classified POST to reading none of the three figures a period changes', () => {
    const reading = Object.entries(CLASSIFIED)
      .filter(([, entry]) => entry.basis === 'POST')
      .map(([path]) => path)
      .filter((path) => FIGURES_READ.test(files.find((file) => file.path === path)?.text ?? ''));
    expect(reading).toEqual([]);
  });

  it('names the readers left on the year-start post, and every classified file still exists', () => {
    expect(
      Object.entries(CLASSIFIED)
        .filter(([, entry]) => entry.basis === 'NEXT')
        .map(([path]) => path)
        .sort(),
    ).toEqual(NEXT_RELEASE);
    const present = new Set(files.map((file) => file.path));
    expect(Object.keys(CLASSIFIED).filter((path) => !present.has(path))).toEqual([]);
  });
});
