import { createHash } from 'node:crypto';
import {
  audienceStatement,
  datesStatement,
  deliveredLessons,
  horizonStatement,
  staffingCreditStatement,
} from './timplan-delivered.sql';

/**
 * P3's statements are the one definition of held time. Fas 3 gave
 * deliveredLessons an options object for the staffing reconciliation; with no
 * options it must be P3's statement BYTE FOR BYTE, text and bound values. The
 * hashes below are of JSON.stringify({ sql, values }) taken from 8d2fb2e (the
 * branch's base, before the options existed) for this exact window, so the
 * coverage cannot change by the options existing.
 */
const WINDOW = {
  academicYearId: '99999999-9999-4999-8999-999999999999',
  yearStart: '2026-08-17',
  yearEnd: '2027-06-11',
  asOf: new Date('2026-10-09T12:00:00.000Z'),
};
const hash = (statement: { sql: string; values: unknown[] }): string =>
  createHash('sha256').update(JSON.stringify({ sql: statement.sql, values: statement.values })).digest('hex');

describe('P3’s statements are unchanged by the options', () => {
  it.each([
    ['deliveredLessons', () => deliveredLessons(WINDOW), 'bae6b546037745129311eb73794929b3dc32107a582edc3eea07bc6afa88b036'],
    ['deliveredLessons({})', () => deliveredLessons(WINDOW, {}), 'bae6b546037745129311eb73794929b3dc32107a582edc3eea07bc6afa88b036'],
    ['audienceStatement', () => audienceStatement(WINDOW), 'e06c44e00670c88e723e9a521fd926994bd2be5b155db8a9235621fd4c6924fc'],
    ['datesStatement', () => datesStatement(WINDOW, ['2026-09-25']), '2b24fedf493008b11b904247076da5d2c3a40d48884c85c01f7246a1cc07dc88'],
    ['horizonStatement', () => horizonStatement(WINDOW), 'ad3cc12f7ecee14fc6e7769193f22eb19a7bc52efc4d2c0f3a5a17564eb15e8d'],
  ] as const)('%s is 8d2fb2e’s to the byte', (_name, build, expected) => {
    expect(hash(build())).toBe(expected);
  });
});

describe('deliveredLessons options', () => {
  it('subjects: all drops rule 5 and nothing else', () => {
    const timplan = deliveredLessons(WINDOW).sql;
    const all = deliveredLessons(WINDOW, { subjects: 'all' }).sql;
    expect(timplan).toContain('AND s."countsTowardTimplan"');
    expect(all).not.toContain('countsTowardTimplan');
    expect(all.replace('AND TRUE', 'AND s."countsTowardTimplan"')).toBe(timplan);
  });

  it('audience: groups keeps the extra groups and no pupil subquery; none keeps neither', () => {
    const groups = deliveredLessons(WINDOW, { audience: 'groups' }).sql;
    expect(groups).toContain('"CalendarLessonGroups"');
    expect(groups).not.toContain('"CalendarLessonStudents"');
    expect(groups).toContain(`'{}'::uuid[] AS "studentIds"`);
    const none = deliveredLessons(WINDOW, { audience: 'none' }).sql;
    expect(none).not.toContain('"CalendarLessonGroups"');
    expect(none).toContain(`'{}'::uuid[] AS "extraGroupIds"`);
  });

  it('range narrows the dates and keeps the year as the year', () => {
    const ranged = deliveredLessons(WINDOW, { range: { from: '2026-09-07', to: '2026-09-18' } });
    expect(ranged.values).toContain('2026-09-07');
    expect(ranged.values).toContain('2026-09-18');
    expect(ranged.values).not.toContain('2027-06-11');
  });

  it('the CASE is the same text under every option', () => {
    const caseOf = (sql: string) => sql.slice(sql.indexOf('CASE'), sql.indexOf('END AS "bucket"'));
    const p3 = caseOf(deliveredLessons(WINDOW).sql);
    for (const options of [{ subjects: 'all' as const }, { audience: 'groups' as const }, { audience: 'none' as const }]) {
      expect(caseOf(deliveredLessons(WINDOW, options).sql)).toBe(p3);
    }
  });
});

describe('staffingCreditStatement (statement E)', () => {
  const range = { from: '2026-09-07', to: '2026-09-18' };

  it('reads the one classification with every subject and the extra groups, MATERIALIZED once', () => {
    const { sql } = staffingCreditStatement(WINDOW, range, null);
    expect(sql).toContain('WITH l AS MATERIALIZED (');
    expect(sql).not.toContain('countsTowardTimplan');
    expect(sql).not.toContain('"CalendarLessonStudents"');
    expect(sql).toContain(`THEN 'DISPLACED'`);
    // A row beside a vikarie is displaced whatever the lesson's bucket, so a
    // cancelled or coming lesson's minutes are never charged to it as well.
    expect(sql).toContain(`ELSE 'DISPLACED_NOT_HELD' END`);
    expect(sql).not.toMatch(/WHEN l\."bucket" = 'DELIVERED' AND t\."role" <> 'SUBSTITUTE'/);
    expect(sql).toContain(`VALUES (m."teacherId", 'LEAD'), (m."coTeacherId", 'ASSISTANT')`);
  });

  it('for the admin: the three parts, no teacher filter', () => {
    const statement = staffingCreditStatement(WINDOW, range, null);
    expect(statement.sql).toContain(`SELECT 'G'`);
    expect(statement.sql).not.toContain('t."teacherId" =');
  });

  it('for a teacher: their rows and slots alone, and no bortfall per group', () => {
    const own = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const statement = staffingCreditStatement(WINDOW, range, own);
    expect(statement.sql).not.toContain(`SELECT 'G'`);
    expect(statement.sql).toContain('WHERE t."teacherId" =');
    expect(statement.sql).toContain('AND s."person" =');
    expect(statement.values.filter((value) => value === own)).toHaveLength(2);
  });
});
