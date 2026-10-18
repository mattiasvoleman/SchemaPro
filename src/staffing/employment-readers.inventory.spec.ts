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
 * A post is also read where no delegate of its own is called: through a
 * relation of another model — a filter on whether a person has a post
 * (`employments: { none: … }`), a nested select, a `_count` of them. That
 * is a read of the table all the same (TABLE_READ's relation arm).
 *
 * DELTID IN DAYS (maxTeachingDaysPerWeek, 20261123090000) is HR data on the
 * post, and the most likely way for it to leak is a new reader nobody told
 * about it: the generator, a hand edit of the grundschema and the
 * Vikarietavla all judge with it, for every reader alike, and only the
 * wording of what they answer may differ. So the spec also fails on
 *
 *  6. a file that names the column and is not in DAYS_READERS, which says
 *     how its answer keeps the days from a reader without HR-läs;
 *  7. a file in DAYS_READERS that no longer names it.
 *
 * A file that reads the post whole and maps a list that leaves the days out
 * (load-input.ts into LoadEmployment, decision 7) names no column and needs
 * no entry: the day it maps them, 6 asks.
 *
 * The web half, for the screens and the file built in the browser, is
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
  'src/staffing/scb/scb-pedpers.ts': {
    basis: 'PERIODS',
    why: 'SCB’s Pedagogisk personal: the post on the mätdatum (postOn, 15 oktober), a full leave measured over the periods around it',
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
  'src/staffing/staff-candidates.ts': {
    basis: 'POST',
    why: 'whether a person has a post this year, as a relation filter (a pool member has none); a period never removes a post',
  },
  'src/optimization/optimization-proxy.service.ts': {
    basis: 'POST',
    why: 'the generator’s payload reads the posts’ deltid in days (20261123090000), which a period never states',
  },
  'src/optimization/optimization-jobs.service.ts': {
    basis: 'POST',
    why: 'a run read by a reader with HR-läs reads back the days of the posts its refusals name (20261123090000); a period never states them',
  },
  'src/calendar/master-lessons.service.ts': {
    basis: 'POST',
    why: 'a hand edit counts the year’s posts with a day limit (a _count in a read it already makes) and reads the days of those it warns about; a period never states them',
  },
};

/** The readers left on the year-start post, written out: see 5. */
const NEXT_RELEASE: string[] = [];

const TABLE_READ =
  /\b(?:teacherEmployment|teacherEmploymentPeriod)\.(?:findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|create|createMany|update|updateMany|upsert|delete|deleteMany|aggregate|groupBy)\b|"TeacherEmployments"|"TeacherEmploymentPeriods"|\b(?:employments|teacherEmployments|teacherEmploymentPeriods)\s*:\s*(?:\{|true\b)/;
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

/**
 * How a file that names deltid in days keeps them from a reader without
 * HR-läs (hr-visibility.ts readsHr):
 *  - HIDES: hands a post out, through hideHr / hideHrChanges, which null the
 *    days or leave their change out (EMPLOYMENT_HR_FIELDS);
 *  - WORDS: judges with them for every reader alike and words its answer
 *    for the reader: the figure, and a teacher a days refusal names, only
 *    with readsHr, a *_HIDDEN code otherwise;
 *  - ENGINE: sends them to the engine, unmasked and anonymised, and masks
 *    what comes back at read;
 *  - WRITES: the post's own write, which only a decider makes (@Decides),
 *    and every decider reads HR;
 *  - CARRIES: the rollover, whose staffing preview only a decider opens;
 *  - SHAPE: declares the field or a list of fields and reads no post.
 */
type DaysUse = 'HIDES' | 'WORDS' | 'ENGINE' | 'WRITES' | 'CARRIES' | 'SHAPE';

const DAYS_READERS: Record<string, { use: DaysUse; why: string }> = {
  'src/staffing/hr-visibility.ts': {
    use: 'HIDES',
    why: 'EMPLOYMENT_HR_FIELDS: hideHr nulls the days on a post, hideHrChanges leaves their change out of a version whole',
  },
  'src/staffing/employment-log-diff.ts': {
    use: 'HIDES',
    why: 'the Historik field order; the history masks it through hideHrChanges and drops a version that changed only the days',
  },
  'src/staffing/teacher-employments.service.ts': {
    use: 'HIDES',
    why: 'writes the days when sent (absent keeps) and hands the post back through hideHr, list and PUT echo alike',
  },
  'src/staffing/dto/teacher-employment.dto.ts': {
    use: 'WRITES',
    why: 'the post’s PUT body, 1..6 as the CHECK; the route is @Decides',
  },
  'src/common/teacher-day.ts': {
    use: 'SHAPE',
    why: 'the arithmetic of a teacher’s day over a rule handed to it; reads no post',
  },
  'src/common/utils/prisma-errors.ts': {
    use: 'SHAPE',
    why: 'names the column in the CHECK’s 400 sentence, the bound a decider’s own write (@Decides) broke; reads no post',
  },
  'src/year-rollover/rollover-registry.ts': {
    use: 'SHAPE',
    why: 'the column’s rule in the carry: COPY_UNLESS_DEFAULT',
  },
  'src/year-rollover/rollover-source.ts': {
    use: 'CARRIES',
    why: 'reads the source year’s posts, the days among them, for the carry',
  },
  'src/year-rollover/rollover-staffing.ts': {
    use: 'CARRIES',
    why: 'carries the days with the post and names the posts that have them (withDayLimit) in the preview a decider opens',
  },
  'src/year-rollover/rollover-apply.ts': {
    use: 'CARRIES',
    why: 'writes the days the plan carried, only where a post had them',
  },
  'src/optimization/optimization-proxy.service.ts': {
    use: 'ENGINE',
    why: 'the generator’s payload: teacherDayLimits, anonymised and unmasked to the engine, recorded EMPLOYMENT; a days refusal is masked at read',
  },
  'src/optimization/optimization-jobs.service.ts': {
    use: 'WORDS',
    why: 'a stored days sentence carries no figure; read back from the post for a reader with HR-läs, TEACHER_WORK_DAYS_HIDDEN otherwise (work-days.ts)',
  },
  'src/optimization/interfaces/ai-engine-payload.interface.ts': {
    use: 'SHAPE',
    why: 'the wire shape of teacherDayLimits, which only the engine reads',
  },
  'src/calendar/master-lessons.service.ts': {
    use: 'WORDS',
    why: 'the hand edit’s TEACHER_WEEK_TOO_MANY_DAYS warning: {days, max} with readsHr, TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN otherwise',
  },
  'src/cover/cover-context.ts': {
    use: 'WORDS',
    why: 'the Vikarietavla’s WORK_DAYS rule reads each candidate’s days in the post read it already makes; maskFindings words it for the reader',
  },
  'src/cover/cover-rules.ts': {
    use: 'WORDS',
    why: 'hardFindings judges WORK_DAYS {days} for every reader alike; maskFindings / maskWarnings make it WORK_DAYS_HIDDEN without readsHr',
  },
};

/** The column, as code names it: a select, a where, a property, a list of field names. */
const DAYS_READ = /\bmaxTeachingDaysPerWeek\b/;

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

  it('classifies every file that names deltid in days, by how it keeps them from a reader without HR-läs (20261123090000)', () => {
    const readers = files.filter((file) => DAYS_READ.test(file.text)).map((file) => file.path);
    expect(readers.filter((path) => !(path in DAYS_READERS))).toEqual([]);
  });

  it('holds a file classified as naming the days to naming them', () => {
    const present = new Map(files.map((file) => [file.path, file.text]));
    expect(Object.keys(DAYS_READERS).filter((path) => !DAYS_READ.test(present.get(path) ?? ''))).toEqual([]);
  });

  it('reads a post through another model’s relation as a read of the table', () => {
    // The arm that catches a nested select or a _count, not only a delegate call.
    for (const text of [
      'NOT: { employments: { none: { academicYearId } } }',
      '_count: { select: { employments: { where: { maxTeachingDaysPerWeek: { not: null } } } } }',
      'include: { teacherEmployments: true }',
      'select: { teacherEmploymentPeriods: { select: { validFrom: true } } }',
    ]) {
      expect({ text, read: TABLE_READ.test(text) }).toEqual({ text, read: true });
    }
    // A preview's own object of that name holds no relation: it is not a read …
    expect(TABLE_READ.test('const employments = posts.map(toRow)')).toBe(false);
    // … and the file that has one is classified anyway.
    expect(CLASSIFIED['src/year-rollover/rollover-staffing.ts']).toBeDefined();
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
