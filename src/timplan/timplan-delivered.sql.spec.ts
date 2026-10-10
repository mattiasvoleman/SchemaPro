import { createHash } from 'node:crypto';
import {
  audienceStatement,
  datesStatement,
  deliveredLessons,
  horizonStatement,
  segmentedAudienceStatement,
  staffingCreditStatement,
  substituteHoursStatement,
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

  describe('segmentedAudienceStatement (timplan P4)', () => {
    it('wraps the same classification, byte for byte, and groups by the segment too', () => {
      const plain = audienceStatement(WINDOW);
      const cut = segmentedAudienceStatement(WINDOW, ['2026-11-02', '2027-01-11']);
      const cte = (sql: string) => sql.slice(sql.indexOf('WITH l AS ('), sql.indexOf(')\n    SELECT'));
      expect(cte(cut.sql)).toBe(cte(plain.sql));
      expect(cut.sql).toMatch(/width_bucket\("date", \?::date\[\]\)::int AS "segment"/);
      expect(cut.sql).toMatch(/GROUP BY 1, 2, 3, 4, 5, 6\s*$/);
      expect(cut.values.at(-1)).toEqual(['2026-11-02', '2027-01-11']);
    });

    it('is segment 0 for every row when nobody moved', () => {
      const none = segmentedAudienceStatement(WINDOW, []);
      expect(none.sql).toMatch(/0::int AS "segment"/);
      expect(none.sql).not.toMatch(/width_bucket/);
    });

    it('leaves P3’s own statement pinned', () => {
      expect(audienceStatement(WINDOW).sql).not.toMatch(/segment/);
    });
  });
});

describe('the published key (Publicering), read in a DRAFT school by somebody who must not see the draft', () => {
  const key = { publicationId: '77777777-7777-4777-8777-777777777777' };
  const range = { from: '2026-09-07', to: '2026-09-18' };

  it('leaves every default statement as it was: no key, no change', () => {
    expect(hash(horizonStatement(WINDOW, null))).toBe(hash(horizonStatement(WINDOW)));
    expect(hash(staffingCreditStatement(WINDOW, range, 'me', null))).toBe(hash(staffingCreditStatement(WINDOW, range, 'me')));
    expect(staffingCreditStatement(WINDOW, range, null).sql).toContain('JOIN "MasterLessons" m ON m."id" = l."masterLessonId"');
  });

  it('keys C on coalesce(the row\'s master, the pending record\'s)', () => {
    const { sql } = horizonStatement(WINDOW, key);
    expect(sql).toContain('coalesce(cl."masterLessonId", ppr."masterLessonId") AS "masterLessonId"');
    expect(sql).toContain('LEFT JOIN "PublicationPendingRemovals" ppr ON ppr."calendarLessonId" = cl."id"');
    expect(sql).toContain('GROUP BY GROUPING SETS ((k."masterLessonId"), (k."date"), ())');
  });

  it('reads the slot a substitute covered from the published snapshot on that key', () => {
    const statement = staffingCreditStatement(WINDOW, range, 'me', key);
    expect(statement.sql).not.toContain('"MasterLessons"');
    expect(statement.sql).toContain('JOIN "PublishedLessons" m ON m."publicationId" = ');
    expect(statement.sql).toContain('m."masterLessonId" = coalesce(l."masterLessonId", ppr."masterLessonId")');
    expect(statement.values).toContain(key.publicationId);
  });

  // Pinned as P3's are, so a change to a variant is a decision taken here.
  it.each([
    ['horizonStatement(published)', () => horizonStatement(WINDOW, key), '186464a356afa4dd51d0745ae39fd8bcecb2e0cd59442aceceda0c97ca796a99'],
    [
      'staffingCreditStatement(published)',
      () => staffingCreditStatement(WINDOW, range, 'me', key),
      '9012dedced0dff85e750392bbfa3709335c183e29c5b48894ec1c5acbd0781ba',
    ],
  ] as const)('%s is pinned', (_name, build, expected) => {
    expect(hash(build())).toBe(expected);
  });
});

describe('substituteHoursStatement (vikarietimmar)', () => {
  const range = { from: '2026-09-07', to: '2026-09-18' };

  it('is pinned: the hour export changes only by a commit that says so', () => {
    expect(hash(substituteHoursStatement(WINDOW, range, null))).toBe(
      'cc31f423b09212610a43b146c84f50a831efb60ae13b3ce8f9f198cf906771ff',
    );
  });

  it('reads statement E’s classification unchanged — every subject, the extra groups, MATERIALIZED once', () => {
    const { sql } = substituteHoursStatement(WINDOW, range, null);
    const ePrefix = staffingCreditStatement(WINDOW, range, null).sql.split('SELECT \'T\'')[0]!;
    expect(sql.startsWith(ePrefix)).toBe(true);
    expect(sql).toContain(`t."role" = 'SUBSTITUTE'`);
    expect(sql).toContain(`WHERE l."bucket" = 'DELIVERED'`);
    // The times and the room come from the lesson row itself, not from a
    // changed deliveredLessons (whose hash above is unchanged).
    expect(sql).toContain('JOIN "CalendarLessons" c ON c."id" = l."id"');
  });

  it('narrows to one substitute with own', () => {
    const statement = substituteHoursStatement(WINDOW, range, 'me');
    expect(statement.sql).toContain('AND t."teacherId" = ');
    expect(statement.values).toContain('me');
  });
});
