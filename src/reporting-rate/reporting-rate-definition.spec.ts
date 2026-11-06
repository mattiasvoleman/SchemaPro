import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A HELD LESSON, DEFINED THREE TIMES, AND THE THREE ARE ONE.
 *
 * Rapporteringsgrad counts a lesson (app.reporting_lessons), Frånvarobevakning
 * counts the lessons a pupil's minutes are registered on
 * (app.absence_watch_evaluate) and genomförd tid counts the lessons that were
 * delivered (src/timplan/timplan-delivered.sql.ts). Each is SQL in a place no
 * call graph connects to the others, and each says which lessons were held the
 * same way: the status is SCHEDULED or COMPLETED. A cancelled lesson is
 * nobody's absence, nobody's unreported register and nobody's delivered time.
 * If one of the three learns a third status (or loses one), a teacher would be
 * told of a lesson the pupils' absence does not count, or the rate would
 * disagree with the school's delivered hours; this fails first.
 */

const ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const migration = (prefix: string) => {
  const dir = readdirSync(join(ROOT, 'prisma', 'migrations')).find((name) => name.startsWith(`${prefix}_`));
  if (!dir) throw new Error(`No migration starts with ${prefix}`);
  return read(`prisma/migrations/${dir}/migration.sql`);
};

/** Whitespace is layout, not meaning: the statement is compared without any, and without case. */
const compact = (sql: string) => sql.replace(/\s+/g, '').toLowerCase();

const STATUSES = compact(`cl."status" IN ('SCHEDULED', 'COMPLETED')`);

/** The text of the function: from its CREATE to the next CREATE (or the end of the file). */
function functionBody(sql: string, name: string): string {
  const start = sql.search(new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name.replace('.', '\\.')}\\s*\\(`, 'i'));
  if (start < 0) throw new Error(`No function ${name}`);
  const rest = sql.slice(start + 1);
  const next = rest.search(/\nCREATE\s/i);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * The status test of delivered time's DELIVERED branch: from the status the
 * CASE tests to the branch's result. (The AHEAD branch tests the same status
 * earlier; it is the last status test before 'DELIVERED' that belongs to it.)
 */
function deliveredBranch(source: string): string {
  const text = compact(source);
  const result = text.indexOf(`then'delivered'`);
  if (result < 0) throw new Error('No DELIVERED branch');
  const test = text.lastIndexOf('cl."status"', result);
  if (test < 0) throw new Error('No status test before DELIVERED');
  return text.slice(test, result);
}

describe('a held lesson is defined once: SCHEDULED or COMPLETED', () => {
  it('app.reporting_lessons (Rapporteringsgrad) tests the statuses, and only them', () => {
    const body = functionBody(migration('20270112090100'), 'app.reporting_lessons');
    expect(body.length).toBeGreaterThan(200);
    expect(compact(body)).toContain(STATUSES);
    // One test of the lesson's status, not a second one beside it.
    expect(body.match(/\bcl\."status"/g)).toHaveLength(1);
  });

  it('app.absence_watch_evaluate (Frånvarobevakning) tests the same statuses', () => {
    const body = functionBody(migration('20261231090100'), 'app.absence_watch_evaluate');
    expect(body.length).toBeGreaterThan(200);
    expect(compact(body)).toContain(STATUSES);
  });

  it('genomförd tid (timplan-delivered.sql.ts) has them in its DELIVERED branch', () => {
    const branch = deliveredBranch(read('src/timplan/timplan-delivered.sql.ts'));
    expect(branch.startsWith(STATUSES)).toBe(true);
    // And the branch is the one that asks for a teacher on the lesson, as the rate does.
    expect(branch).toContain('"calendarlessonteachers"');
  });

  describe('the reading of the three', () => {
    it('does not care about layout: line breaks, indentation and the case of the keywords', () => {
      expect(compact(`cl."status"\n      in\n  ('SCHEDULED',\n 'COMPLETED')`)).toContain(STATUSES);
      expect(compact(`cl."status" IN ('SCHEDULED','COMPLETED')`)).toContain(STATUSES);
    });

    it('does notice a third status, a missing one and another order', () => {
      for (const drifted of [
        `cl."status" IN ('SCHEDULED', 'COMPLETED', 'RESCHEDULED')`,
        `cl."status" IN ('SCHEDULED')`,
        `cl."status" = 'SCHEDULED'`,
        `cl."status" NOT IN ('CANCELLED')`,
      ]) {
        expect(compact(`WHERE ${drifted} AND`)).not.toContain(STATUSES);
      }
      // A reorder is a different text: the three are written in one order so that this check is one string.
      expect(compact(`cl."status" IN ('COMPLETED', 'SCHEDULED')`)).not.toContain(STATUSES);
    });

    it('finds the function in the migration, and the branch in the statement, not nothing', () => {
      expect(() => functionBody('CREATE FUNCTION app.other() RETURNS int', 'app.reporting_lessons')).toThrow('No function');
      expect(() => deliveredBranch(`WHEN cl."status" = 'CANCELLED' THEN 'X'`)).toThrow('No DELIVERED branch');
      expect(() => deliveredBranch(`THEN 'DELIVERED'`)).toThrow('No status test');
      const two = `CREATE FUNCTION app.a() RETURNS int AS $$ one $$;\n\nCREATE OR REPLACE FUNCTION app.b() RETURNS int AS $$ two $$;`;
      expect(functionBody(two, 'app.a')).toContain('one');
      expect(functionBody(two, 'app.a')).not.toContain('two');
      expect(functionBody(two, 'app.b')).toContain('two');
    });
  });
});

/**
 * WHO ATTENDS A LESSON, ASKED TWICE, AND THE TWO ARE ONE.
 *
 * A lesson no pupil can be marked on is nobody's: it can never be reported, so
 * the rate leaves it out (app.reporting_lessons). Which pupils can be marked is
 * the register's reader (calendar/lesson-roster.ts), TypeScript behind
 * Prisma, a place no call graph reaches from the SQL. Both ask the same
 * sources: the class and the groups joined to the lesson, the members of those
 * groups, and the pupils the lesson names. If the reader learns a source, or a
 * role, this fails first; the SQL then has to learn it too.
 *
 * The SQL reads them so that a day already counted does not move. The reader
 * answers for now; the läsårsaktivering moves every pupil to next year's class
 * and empties last year's, so the class is also asked as it was on the
 * lesson's day (StudentEnrollments, the class history). Members of a teaching
 * group and named pupils have no dates, so they count as recorded, whether the
 * pupil is active or not (RECORDED in the reader, which is what the register
 * accepts for saving).
 */
describe('who attends a lesson is read the way the register reads it', () => {
  const body = () => functionBody(migration('20270112090100'), 'app.reporting_lessons');
  const count = (text: string, part: string) => text.split(compact(part)).length - 1;

  it('app.reporting_lessons asks five sources, and the class twice: as it is and as it was', () => {
    const text = compact(body());
    for (const table of ['Users', 'StudentEnrollments', 'StudentGroupMembers', 'CalendarLessonGroups', 'CalendarLessonStudents']) {
      expect(text).toContain(compact(`"public"."${table}"`));
    }
    // Every source is of pupils; the class as it is asks for active ones, the groups' members and the named pupils do not.
    expect(count(text, `p."role" = 'STUDENT'`)).toBe(5);
    expect(count(text, `p."role" = 'STUDENT' AND p."isActive"`)).toBe(2);
    // The class as it was: the segment of the history that holds the lesson's day, [validFrom, validTo), for the lesson's class and the joined ones.
    expect(count(text, `e."validFrom" <= cl."date" AND (e."validTo" IS NULL OR cl."date" < e."validTo")`)).toBe(2);
  });

  it('a register already saved is a register whatever the roster has become, and is looked for on the teacher’s row', () => {
    const text = compact(body());
    expect(text).toContain(compact(`AND (\n r."saved"\n OR EXISTS`));
    // Written against t."calendarLessonId" so that it runs after the join with the teacher (see the comment on the function).
    expect(text).toContain(compact(`a."calendarLessonId" = t."calendarLessonId" AND a."status" <> 'UNKNOWN'`));
  });

  it('the register’s reader asks for the same pupils and reads the same stores', () => {
    const source = read('src/calendar/lesson-roster.ts');
    expect(compact(source)).toContain(compact(`const PUPIL = { role: 'STUDENT', isActive: true } as const;`));
    expect(source).toContain(`pupils: 'ACTIVE' | 'RECORDED'`);
    expect(source).toContain('tx.user.findMany');
    expect(source).toContain('tx.studentGroupMember.findMany');
    expect(source).toMatch(/participantIds/);
  });
});
