import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LATE_MINUTES, MIN_GROUP } from './absence-stats';

/**
 * ONE DEFINITION OF A MINUTE OF ABSENCE, WRITTEN IN FIVE PLACES, AND THE FIVE ARE ONE.
 *
 * Frånvarostatistik counts a pupil's minutes in the month's sums
 * (app.absence_stats_month), a class's pupils (app.absence_stats_class_pupils),
 * a pupil's months (app.absence_stats_pupil) and the patterns
 * (app.absence_stats_patterns), all of them by what Frånvarobevakningen counts
 * (app.absence_watch_evaluate) and /admin/reports shows. SQL in a place no call
 * graph connects: if one of them learns another status, or another length of a
 * late arrival, or counts a cancelled lesson, the figures of one page would
 * disagree with the figures of the next. This fails first.
 */

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const migration = (prefix: string) => {
  const dir = readdirSync(join(ROOT, 'prisma', 'migrations')).find((name) => name.startsWith(`${prefix}_`));
  if (!dir) throw new Error(`No migration starts with ${prefix}`);
  return read(`prisma/migrations/${dir}/migration.sql`);
};
const compact = (sql: string) => sql.replace(/\s+/g, '').toLowerCase();

/** The text of the function: from its CREATE to the next CREATE or COMMENT (or the end of the file). */
function functionBody(sql: string, name: string): string {
  const start = sql.search(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i'));
  if (start < 0) throw new Error(`No function ${name}`);
  const rest = sql.slice(start + 1);
  const next = rest.search(/\n(?:CREATE\s|COMMENT\s|ALTER\s)/i);
  return next < 0 ? rest : rest.slice(0, next);
}

const STATS = migration('20270121090000');
const WATCH = functionBody(migration('20261231090100'), 'app.absence_watch_evaluate');

const HELD = compact(`"status" IN ('SCHEDULED', 'COMPLETED')`);
const MARKED = compact(`"status" <> 'UNKNOWN'`);
const LATE = compact(`WHEN a."status" = 'LATE' THEN least(15,`);
const LENGTH = compact(`round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)`);

/**
 * The doors that count minutes, and how each says it. Four SQL texts, one definition: the held statuses, a mark
 * that is not UNKNOWN, EXCUSED and ABSENT as they are, LATE as fifteen minutes at most the lesson's, and the
 * lesson's length rounded from its instants. (The pattern door counts from its own base of marks, whose rows
 * are named b.)
 */
const MINUTE_DOORS = [
  { name: 'app.absence_stats_month', late: LATE, excused: compact(`a."status" = 'EXCUSED'`), absent: compact(`a."status" = 'ABSENT'`) },
  { name: 'app.absence_stats_class_pupils', late: LATE, excused: compact(`a."status" = 'EXCUSED'`), absent: compact(`a."status" = 'ABSENT'`) },
  { name: 'app.absence_stats_pupil', late: LATE, excused: compact(`a."status" = 'EXCUSED'`), absent: compact(`a."status" = 'ABSENT'`) },
  {
    name: 'app.absence_stats_patterns',
    late: compact(`WHEN b."status" = 'LATE' THEN least(15, b.mins)`),
    excused: compact(`b."status" = 'EXCUSED'`),
    absent: compact(`b."status" = 'ABSENT'`),
  },
] as const;

describe('a minute of absence is defined once', () => {
  it('Frånvarobevakningen’s count says it the way these tests read it', () => {
    const text = compact(WATCH);
    expect(text).toContain(HELD);
    expect(text).toContain(MARKED);
    expect(text).toContain(compact(`WHEN m.status = 'EXCUSED'`));
    expect(text).toContain(compact(`WHEN 'LATE' THEN least(15, m.mins)`));
    expect(text).toContain(compact(`round(extract(epoch FROM (cl."endsAt" - cl."startsAt")) / 60)`));
  });

  it.each(MINUTE_DOORS)('$name counts the held lessons, the marks that are not UNKNOWN, a late arrival and a lesson’s length the same way', ({ name, late, excused, absent }) => {
    const text = compact(functionBody(STATS, name));
    expect(text).toContain(HELD);
    expect(text).toContain(MARKED);
    expect(text).toContain(excused);
    expect(text).toContain(absent);
    expect(text).toContain(late);
    expect(text).toContain(LENGTH);
    // A lesson that was called off is nobody's absence: no other status than the two is let in.
    expect(text).not.toContain(compact(`'CANCELLED'`));
  });

  it('a late arrival is fifteen minutes in the code, in the watch and in every door', () => {
    expect(LATE_MINUTES).toBe(15);
    for (const { name, late } of MINUTE_DOORS) expect(compact(functionBody(STATS, name))).toContain(late);
  });

  it('knows the function it reads and the text it looks for (this test is not vacuous)', () => {
    expect(() => functionBody(STATS, 'app.absence_stats_nothing')).toThrow('No function');
    expect(functionBody(STATS, 'app.absence_stats_month').length).toBeGreaterThan(2000);
    expect(compact(`cl."status" IN ('SCHEDULED', 'COMPLETED', 'RESCHEDULED')`)).not.toContain(HELD);
    expect(compact(`WHEN a."status" = 'LATE' THEN least(20, l.mins)`)).not.toContain(LATE);
    expect(compact(`WHEN a."status" = 'LATE' THEN least(15, l.mins)`)).toContain(LATE);
  });
});

/**
 * The text of the LAST definition of an app function across all migrations, in migration order (a later
 * CREATE OR REPLACE is the one that is live), with the migration it stands in. Comments are cut and whitespace
 * collapsed, so the comparison is of what the database runs.
 */
function liveBody(name: string): { migration: string; body: string } {
  const dirs = readdirSync(join(ROOT, 'prisma', 'migrations'))
    .filter((dir) => /^\d{14}_/.test(dir))
    .sort();
  const create = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'gi');
  let found: { migration: string; body: string } | null = null;
  for (const dir of dirs) {
    const sql = read(`prisma/migrations/${dir}/migration.sql`);
    for (const match of sql.matchAll(create)) {
      const tag = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(sql.slice(match.index))?.[1];
      if (!tag) throw new Error(`${name} in ${dir} has no dollar-quoted body`);
      const open = sql.indexOf(tag, match.index) + tag.length;
      const close = sql.indexOf(tag, open);
      found = { migration: dir, body: sql.slice(open, close).replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim() };
    }
  }
  if (!found) throw new Error(`No migration defines ${name}`);
  return found;
}

/**
 * The one line that differs: D2 asks who is a teacher now, the history asks who was active when the lesson was over.
 * Since 20270210090000 that is read from UserDeactivations, every period a person was inactive, and not from the
 * latest stamp (Users."deactivatedAt", which a return clears): a lesson that ended inside a period does not count to
 * the teacher, one over at the instant they left or the instant they returned does.
 */
const D2_TEACHER = `AND u."role" = 'TEACHER' AND u."isActive"`;
const HISTORY_TEACHER = `AND u."role" = 'TEACHER' AND NOT EXISTS (SELECT 1 FROM "public"."UserDeactivations" d WHERE d."userId" = u."id" AND d."startsAt" < cl."endsAt" AND (d."endsAt" IS NULL OR cl."endsAt" < d."endsAt"))`;

describe('the lessons are Rapporteringsgradens, with the one line about the teacher', () => {
  it('app.absence_stats_month reads app.absence_stats_lessons, once a lesson, and asks no definition of its own', () => {
    const text = compact(functionBody(STATS, 'app.absence_stats_month'));
    expect(text).toContain(compact('FROM app.absence_stats_lessons(p_school, m_first, m_last, clock_timestamp())'));
    expect(text).toContain(compact('SELECT DISTINCT ON (r.lesson_id) r.lesson_id, r.reported'));
    // No second reading of the register or the teachers here: the lessons function is the definition.
    expect(text).not.toContain('"calendarlessonteachers"');
    // And not D2's own, which asks who is a teacher now and would drop every lesson of a teacher who has left.
    expect(text).not.toContain(compact('app.reporting_lessons('));
  });

  it('app.absence_stats_lessons is the live app.reporting_lessons but for the line about the teacher, and nothing else', () => {
    const d2 = liveBody('app.reporting_lessons');
    const history = liveBody('app.absence_stats_lessons');
    // The line is there, once, in each. (D2's own migration is not necessarily the one that is live: Elevens lektion för
    // dagen rewrites it, and whoever does has to carry the same into the history's function, in the same or a later migration.)
    expect(d2.body.split(D2_TEACHER)).toHaveLength(2);
    expect(history.body.split(HISTORY_TEACHER)).toHaveLength(2);
    expect(history.body).not.toContain(D2_TEACHER);
    expect(history.body).toBe(d2.body.replace(D2_TEACHER, HISTORY_TEACHER));
  });

  it('says which migration it compared when it fails, so that the one that has to change is named', () => {
    const d2 = liveBody('app.reporting_lessons');
    const history = liveBody('app.absence_stats_lessons');
    expect(history.migration >= '20270121090000').toBe(true);
    expect(d2.migration >= '20270112090100').toBe(true);
  });

  it('knows what it reads (this test is not vacuous): a changed condition is not the same text', () => {
    const d2 = liveBody('app.reporting_lessons').body;
    expect(d2.replace(D2_TEACHER, HISTORY_TEACHER)).not.toBe(d2);
    expect(d2.replace(D2_TEACHER, HISTORY_TEACHER).replace(`cl."endsAt" <= p_now`, `cl."endsAt" <= now()`)).not.toBe(d2.replace(D2_TEACHER, HISTORY_TEACHER));
    expect(() => liveBody('app.absence_stats_nothing')).toThrow('No migration defines');
  });
});

describe('the smallest group is one number', () => {
  it('is five in the code, the function, the check of the group and the check of a figure', () => {
    expect(MIN_GROUP).toBe(5);
    expect(compact(functionBody(STATS, 'app.absence_stats_min_group'))).toContain(compact('SELECT 5'));
    expect(compact(STATS)).toContain(compact(`CONSTRAINT "AbsenceStatsMonths_a_group_has_five_pupils" CHECK ("pupils" >= 5)`));
    expect(compact(STATS)).toContain(compact(`("pupilsRegistered" >= 5`));
    expect(compact(STATS)).toContain(compact(`OR ("pupilsRegistered" < 5`));
  });
});

describe('the class a pupil sat in is read from the history, never from the pupil’s row', () => {
  it('app.absence_stats_month asks StudentEnrollments for the day of the mark', () => {
    const text = compact(functionBody(STATS, 'app.absence_stats_month'));
    expect(text).toContain('"studentenrollments"');
    expect(text).toContain(compact(`e."validFrom" <= d.day AND (e."validTo" IS NULL OR d.day < e."validTo")`));
  });

  it('app.absence_stats_patterns asks StudentEnrollments for the day of the lesson', () => {
    const text = compact(functionBody(STATS, 'app.absence_stats_patterns'));
    expect(text).toContain('"studentenrollments"');
    // The roster holds the pupil's segments in the class and its predecessors; a mark counts when its lesson's day is inside one.
    expect(text).toContain(compact(`cl."date" >= r."validFrom" AND (r."validTo" IS NULL OR cl."date" < r."validTo")`));
  });

  it('nothing here reads the pupil’s current class (Users.studentGroupId) to place a mark in a class', () => {
    for (const name of ['app.absence_stats_month', 'app.absence_stats_patterns', 'app.absence_stats_class_pupils'] as const) {
      expect(compact(functionBody(STATS, name))).not.toMatch(/u\."studentgroupid"|"users"[^;]*"studentgroupid"/);
    }
  });
});
