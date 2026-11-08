/**
 * The adapter probe's check of the order of a page. A list read a page at a time (limit and offset) is the same list on every
 * page only if its order is total: rows that tie on the sort key come back in whatever order the plan happens to give them, and
 * the plan is not the same for LIMIT 7 OFFSET 0 and LIMIT 7 OFFSET 7 (a top-N sort keeps a heap of offset + limit rows, and
 * what it does with equal keys depends on how big the heap is). A row that ties falls between two pages, or is on both.
 *
 * SS12000 v1's lists are read that way by a municipality's system, a page after a page, and three of them were sorted on a
 * key that is shared by whole classes of rows (a surname, a weekday and a start time, a start time). In a school of its own
 * (slug <marker>-sidning), swept whole before and after:
 *
 *   sp-a  persons: sixty people with one surname, read seven at a time, are each on exactly one page, in the order of their ids
 *   sp-b  activities: twenty-four lessons of one weekday and one start time, read five at a time
 *   sp-c  calendarEvents: forty lessons that start at one moment, read six at a time
 *
 * Kvittens' own two lists (a cursor, not an offset) have their ties in probe-kvittens.ts km, with the same idea.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import type { Client } from 'pg';
import { Ss12000Service } from '../../src/integration/ss12000.service';
import type { PrismaService } from '../../src/database/prisma.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function pagingSlug(marker: string): string {
  return `${marker}-sidning`;
}

export async function sweepPagingSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [pagingSlug(marker)]);
}

export async function pagingOrderChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepPagingSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} sidning`, pagingSlug(marker)],
  );
  const s = school.id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'sp probe', '${today}'::date - 200, '${today}'::date + 200, true, now()) RETURNING id`,
    [s],
  );
  const subject = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, 'Sidning', now()) RETURNING id`, [s]);
  const ss12000 = new Ss12000Service(api);

  /** Every page of a list, `size` rows at a time, as the municipality's system reads it. */
  const pages = async (read: (limit: string, offset: string) => Promise<{ totalCount: number; data: Array<{ id: string }> }>, size: number): Promise<string[]> => {
    const seen: string[] = [];
    for (let offset = 0, total = Infinity; offset < total; offset += size) {
      const got = await read(String(size), String(offset));
      total = got.totalCount;
      assert.ok(got.data.length <= size);
      seen.push(...got.data.map((row) => row.id));
    }
    return seen;
  };
  /** Each row once, whatever the order of the pages. The order of ties is the id's, so the pages are the ids in sorted order too. */
  const eachOnce = (seen: string[], all: string[], what: string) => {
    assert.equal(seen.length, all.length, `${what}: ${seen.length} rows on the pages of ${all.length}`);
    assert.equal(new Set(seen).size, seen.length, `${what}: a row on two pages`);
    assert.deepEqual([...seen].sort(), [...all].sort(), `${what}: a row on no page`);
  };

  await check('sp-a: persons with one surname are each on exactly one page, in the order of their ids', async () => {
    const all = (
      await owner.query<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         SELECT $1, $2 || '-sp-' || i || '@example.invalid', 'Person' || i, 'Andersson', 'TEACHER', gen_random_uuid(), true, now()
           FROM generate_series(1, 60) i RETURNING id`,
        [s, marker],
      )
    ).rows.map((r) => r.id);
    // Seven at a time leaves a page break inside the run of equal surnames on every page, and a short last page.
    const seen = await pages((limit, offset) => ss12000.persons(s, limit, offset), 7);
    eachOnce(seen, all, 'persons');
    assert.deepEqual(seen, [...all].sort(), 'persons of one surname are not in the order of their ids');
    // The same set read in one page, and by role (a filter changes the plan, not the order).
    assert.deepEqual((await ss12000.persons(s, '500', '0')).data.map((p) => p.id), seen);
    eachOnce(await pages((limit, offset) => ss12000.persons(s, limit, offset, 'TEACHER'), 11), all, 'persons by role');
  });

  await check('sp-b: activities of one weekday and one start time are each on exactly one page', async () => {
    const groups = (
      await owner.query<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt")
         SELECT $1, $2, 'SP' || i, 7, now() FROM generate_series(1, 24) i RETURNING id`,
        [s, year.id],
      )
    ).rows.map((r) => r.id);
    // A group of its own each and no teacher or room, so that no rule of the schedule keeps two of them apart: they tie on
    // (dayOfWeek, startTime) and on nothing else.
    const lessons = (
      await owner.query<{ id: string }>(
        `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "updatedAt")
         SELECT $1, $2, $3, g, 1, '08:00', '08:45', now() FROM unnest($4::uuid[]) g RETURNING id`,
        [s, year.id, subject.id, groups],
      )
    ).rows.map((r) => r.id);
    const seen = await pages((limit, offset) => ss12000.activities(s, limit, offset), 5);
    eachOnce(seen, lessons, 'activities');
    assert.deepEqual(seen, [...lessons].sort(), 'activities of one start time are not in the order of their ids');

    // And the groups that carry them: a name is the school's own in its year, so that list was already total.
    const named = await pages((limit, offset) => ss12000.groups(s, limit, offset), 5);
    eachOnce(named, groups, 'groups');
  });

  await check('sp-c: calendarEvents that start at one moment are each on exactly one page', async () => {
    const group = (await one<{ id: string }>(`SELECT id FROM "StudentGroups" WHERE "schoolId" = $1 ORDER BY name LIMIT 1`, [s])).id;
    const lessons = (
      await owner.query<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
         SELECT $1, $2, $3, '${today}'::date, ('${today} 08:00')::timestamp AT TIME ZONE 'Europe/Stockholm', ('${today} 08:45')::timestamp AT TIME ZONE 'Europe/Stockholm', now()
           FROM generate_series(1, 40) i RETURNING id`,
        [s, subject.id, group],
      )
    ).rows.map((r) => r.id);
    const seen = await pages((limit, offset) => ss12000.calendarEvents(s, today, today, limit, offset), 6);
    eachOnce(seen, lessons, 'calendarEvents');
    assert.deepEqual(seen, [...lessons].sort(), 'calendarEvents of one start time are not in the order of their ids');
  });

  await sweepPagingSchool(owner, marker);
}
