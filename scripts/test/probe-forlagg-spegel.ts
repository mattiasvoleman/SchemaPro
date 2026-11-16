/**
 * The adapter probe's check of the judge of a förläggning against the contract fixture
 * src/requirement-placements/__fixtures__/placement-clash-cases.json (A2, brief #10).
 *
 * The web draws a ghost under a drag from a MIRROR of the judge (web/lib/placement-mirror.ts) and may be stricter than
 * the judge but never milder for the rules it has. The fixture is the meeting point: each case is a small world, one
 * candidate row and the verdict the judge gives it. This probe asks the REAL judge, through the real
 * RequirementPlacementsService.replace as the API's role over real Postgres (the PUT the page writes with), for every
 * case and requires the verdict the fixture holds; with FORLAGG_SPEGEL_WRITE=1 it writes the real verdicts back
 * instead (only the `verdict` lines, the rest of the file as it stands) and prints every case whose verdict differs
 * from the one the file had. web/lib/placement-mirror.contract.test.ts runs the same worlds through the mirror.
 *
 *   vv9  every case of the fixture: the world made in a school of its own (a Saturday-starting läsår, the nine-year
 *        numbering), the other posts' rows and the post's own other rows stored directly (so that a row the judge
 *        refuses can be stored), and the candidate asked of the PUT. The candidate is the FIRST row of the list the
 *        PUT is given: replace() throws at the first refused row, so with the candidate first its verdict is the
 *        refusal's (index 0), and a refusal at any later index is a mistake of the world (the post's own stored
 *        rows clash with something else), not an answer. A candidate that is let through is then taken away.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { RequirementPlacementsService } from '../../src/requirement-placements/requirement-placements.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const FIXTURE = join(__dirname, '../../src/requirement-placements/__fixtures__/placement-clash-cases.json');

type Recurrence = 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
interface WorldPost {
  key: string;
  class: string;
  subject: string;
  teacher: string;
  coTeacher?: string;
  minutes: number;
  lessons: number;
  recurrence?: Recurrence;
  startDate?: string;
  endDate?: string;
  /** The pupils' minutes before and after the post's lessons (TeachingRequirements.minutesBefore/minutesAfter): ombyte and dusch around an idrott. */
  minutesBefore?: number;
  minutesAfter?: number;
  shares?: { teacher: string; lessons: number }[];
}
interface WorldKept {
  class?: string;
  group?: string;
  subject: string;
  teacher: string;
  coTeacher?: string;
  room?: string;
  day: number;
  start: string;
  minutes: number;
  recurrence?: Recurrence;
  startDate?: string;
  endDate?: string;
  extraClasses?: string[];
  locked?: boolean;
}
interface WorldRow {
  post: string;
  day: number;
  start: string;
  minutes: number;
  room?: string;
  recurrence?: Recurrence;
  teacher?: string;
}
interface World {
  classes: { key: string; grade: number }[];
  teachers: string[];
  rooms: string[];
  subjects: string[];
  pupils: { key: string; class: string }[];
  groups: { key: string; members: string[] }[];
  posts: WorldPost[];
  kept: WorldKept[];
  rows: WorldRow[];
  unavailable: { kind: 'teacher' | 'room' | 'class' | 'grade'; key?: string; grades?: [number, number]; day: number; start: string; end: string }[];
  frames: { grades: [number, number]; start: string; end: string }[];
  meals: { class: string; day: number; start: string; end: string; generated?: boolean }[];
}
interface Candidate {
  post: string;
  day: number;
  start: string;
  minutes: number;
  room?: string;
  recurrence?: Recurrence;
  teacher?: string;
  replaces?: number;
}
type Verdict = { ok: true } | { ok: false; reason: string };
interface Case {
  name: string;
  rule: string;
  add: Partial<World>;
  candidate: Candidate;
  verdict: Verdict;
  outsideMirror?: boolean;
  mirrorStricter?: boolean;
}
interface Fixture {
  base: World;
  cases: Case[];
}

export const placementMirrorSlugPrefix = (marker: string): string => `${marker}-spegel-`;

export async function sweepPlacementMirrorSchools(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug LIKE $1`, [`${placementMirrorSlugPrefix(marker)}%`]);
}

/** The world of a case: the base, the case's lists added to, and a post of an existing key replaced. */
export function worldOf(base: World, add: Partial<World>): World {
  const world: World = JSON.parse(JSON.stringify(base));
  for (const [name, value] of Object.entries(add) as [keyof World, unknown[]][]) {
    if (name === 'posts') {
      for (const post of value as WorldPost[]) {
        const at = world.posts.findIndex((entry) => entry.key === post.key);
        if (at === -1) world.posts.push(post);
        else world.posts[at] = post;
      }
    } else {
      (world[name] as unknown[]).push(...value);
    }
  }
  return world;
}

/** The text of the fixture with every case's `verdict` line replaced, and nothing else changed. */
export function withVerdicts(text: string, verdicts: Verdict[]): string {
  const casesAt = text.indexOf('"cases"');
  assert.ok(casesAt > 0, 'the fixture has no cases');
  let next = 0;
  const tail = text.slice(casesAt).replace(/"verdict": \{[^}]*\}/g, () => {
    const verdict = verdicts[next++];
    assert.ok(verdict, 'more verdict lines than cases');
    return verdict.ok ? '"verdict": { "ok": true }' : `"verdict": { "ok": false, "reason": "${verdict.reason}" }`;
  });
  assert.equal(next, verdicts.length, 'fewer verdict lines than cases');
  return text.slice(0, casesAt) + tail;
}

export async function placementMirrorChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepPlacementMirrorSchools(owner, marker);
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
  const write = process.env['FORLAGG_SPEGEL_WRITE'] === '1';
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
  const masters = new MasterLessonsService(api, realtime, {} as NotificationsService);
  const placements = new RequirementPlacementsService(api, masters);

  /** The world of one case in a school of its own, and the verdict the PUT gives the candidate. */
  const judgeCase = async (index: number, one_case: Case): Promise<Verdict> => {
    const world = worldOf(fixture.base, one_case.add);
    const slug = `${placementMirrorSlugPrefix(marker)}${index}`;
    const school = (
      await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`${marker} spegel ${index}`, slug])
    ).id;
    // A läsår that starts on a Saturday, the active one, in the nine-year numbering the grade rules read.
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe spegel', '2026-08-15', '2027-06-11', true, 'NIOARIG', now()) RETURNING id`,
        [school],
      )
    ).id;
    const user = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "adminProfile", "updatedAt")
         VALUES ($1, $2, $3, 'Spegel', $4, $5, true, $6, $7, now()) RETURNING id`,
        [school, `${slug}-${label}@example.invalid`, label, role, authId, extra.groupId ?? null, extra.adminProfile ?? null],
      );
      return { id: row.id, authId };
    };
    const group = async (name: string, kind: 'CLASS' | 'TEACHING_GROUP', grade: number | null) =>
      (
        await one<{ id: string }>(
          `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, $4::"StudentGroupKind", $5, now()) RETURNING id`,
          [school, year, name, kind, grade],
        )
      ).id;

    const classes = new Map<string, string>();
    for (const entry of world.classes) classes.set(entry.key, await group(entry.key, 'CLASS', entry.grade));
    const teachers = new Map<string, string>();
    for (const key of world.teachers) teachers.set(key, (await user(key, 'TEACHER')).id);
    const rooms = new Map<string, string>();
    for (const key of world.rooms) rooms.set(key, (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, key])).id);
    const subjects = new Map<string, string>();
    for (const key of world.subjects) subjects.set(key, (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, key])).id);
    const pupils = new Map<string, string>();
    for (const entry of world.pupils) pupils.set(entry.key, (await user(entry.key, 'STUDENT', { groupId: classes.get(entry.class)! })).id);
    const groups = new Map<string, string>();
    for (const entry of world.groups) {
      const id = await group(entry.key, 'TEACHING_GROUP', null);
      groups.set(entry.key, id);
      for (const member of entry.members) {
        await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [school, id, pupils.get(member)!]);
      }
    }
    const admin = await user('admin', 'SCHOOL_ADMIN', { adminProfile: 'SCHEMALAGGARE' });
    const caller = { authId: admin.authId, userId: admin.id, schoolId: school, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as AuthenticatedUser;

    const idOf = (map: Map<string, string>, key: string | undefined, what: string): string => {
      assert.ok(key !== undefined && map.has(key), `${one_case.name}: the world names no ${what} "${key}"`);
      return map.get(key)!;
    };
    const posts = new Map<string, string>();
    for (const post of world.posts) {
      const id = (
        await one<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId", "lessonsPerWeek", "minutesPerLesson", recurrence, "startDate", "endDate", "minutesBefore", "minutesAfter", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::"LessonRecurrence", $10, $11, $12, $13, now()) RETURNING id`,
          [
            school,
            year,
            idOf(subjects, post.subject, 'subject'),
            idOf(classes, post.class, 'class'),
            idOf(teachers, post.teacher, 'teacher'),
            post.coTeacher ? idOf(teachers, post.coTeacher, 'teacher') : null,
            post.lessons,
            post.minutes,
            post.recurrence ?? 'ALL_WEEKS',
            post.startDate ?? null,
            post.endDate ?? null,
            post.minutesBefore ?? 0,
            post.minutesAfter ?? 0,
          ],
        )
      ).id;
      posts.set(post.key, id);
      for (const share of post.shares ?? []) {
        await owner.query(
          `INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, $4, $5, now())`,
          [school, id, idOf(teachers, share.teacher, 'teacher'), share.lessons, post.minutes],
        );
      }
    }
    const clock = (start: string, minutes: number): string => {
      const at = Number(start.slice(0, 2)) * 60 + Number(start.slice(3, 5)) + minutes;
      return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    };
    for (const lesson of world.kept) {
      const id = (
        await one<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "coTeacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "startDate", "endDate", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12::"LessonRecurrence", $13, $14, now()) RETURNING id`,
          [
            school,
            year,
            idOf(subjects, lesson.subject, 'subject'),
            lesson.group ? idOf(groups, lesson.group, 'group') : idOf(classes, lesson.class, 'class'),
            idOf(teachers, lesson.teacher, 'teacher'),
            lesson.coTeacher ? idOf(teachers, lesson.coTeacher, 'teacher') : null,
            lesson.room ? idOf(rooms, lesson.room, 'room') : null,
            lesson.day,
            lesson.start,
            clock(lesson.start, lesson.minutes),
            lesson.locked === true,
            lesson.recurrence ?? 'ALL_WEEKS',
            lesson.startDate ?? null,
            lesson.endDate ?? null,
          ],
        )
      ).id;
      for (const extra of lesson.extraClasses ?? []) {
        await owner.query(`INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId") VALUES ($1, $2, $3)`, [school, id, idOf(classes, extra, 'class')]);
      }
    }
    for (const row of world.rows) {
      await owner.query(
        `INSERT INTO "TeachingRequirementPlacements" ("schoolId", "requirementId", "dayOfWeek", "startTime", minutes, "roomId", recurrence, "teacherId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7::"LessonRecurrence", $8, now())`,
        [school, idOf(posts, row.post, 'post'), row.day, row.start, row.minutes, row.room ? idOf(rooms, row.room, 'room') : null, row.recurrence ?? 'ALL_WEEKS', row.teacher ? idOf(teachers, row.teacher, 'teacher') : null],
      );
    }
    for (const rule of world.unavailable) {
      const resource = { teacher: 'TEACHER', room: 'ROOM', class: 'STUDENT_GROUP', grade: 'GRADE_LEVEL' }[rule.kind];
      await owner.query(
        `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "roomId", "studentGroupId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", type, "updatedAt")
         VALUES ($1, $2::"ConstraintResource", $3, $4, $5, $6, $7, $8, $9, $10, 'UNAVAILABLE', now())`,
        [
          school,
          resource,
          rule.kind === 'teacher' ? idOf(teachers, rule.key, 'teacher') : null,
          rule.kind === 'room' ? idOf(rooms, rule.key, 'room') : null,
          rule.kind === 'class' ? idOf(classes, rule.key, 'class') : null,
          rule.kind === 'grade' ? rule.grades![0] : null,
          rule.kind === 'grade' ? rule.grades![1] : null,
          rule.day,
          rule.start,
          rule.end,
        ],
      );
    }
    for (const frame of world.frames) {
      await owner.query(
        `INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "dayOfWeek", "startTime", "endTime", "updatedAt") VALUES ($1, $2, $3, NULL, $4, $5, now())`,
        [school, frame.grades[0], frame.grades[1], frame.start, frame.end],
      );
    }
    for (const meal of world.meals) {
      await owner.query(
        `INSERT INTO "LunchSittings" ("schoolId", "academicYearId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [school, year, idOf(classes, meal.class, 'class'), meal.day, meal.start, meal.end, meal.generated === true],
      );
    }

    // The list the PUT is given: the candidate first, then the post's own stored rows except the one the candidate moves.
    const candidate = one_case.candidate;
    const postId = idOf(posts, candidate.post, 'post');
    const input = (row: { day: number; start: string; minutes: number; room?: string; recurrence?: Recurrence; teacher?: string }) => ({
      dayOfWeek: row.day,
      startTime: row.start,
      minutes: row.minutes,
      roomId: row.room ? idOf(rooms, row.room, 'room') : null,
      recurrence: row.recurrence ?? 'ALL_WEEKS',
      ...(row.teacher ? { teacherId: idOf(teachers, row.teacher, 'teacher') } : {}),
    });
    const ownRows = world.rows.filter((row, at) => row.post === candidate.post && at !== candidate.replaces);
    const wanted = [input(candidate), ...ownRows.map(input)];
    try {
      await placements.replace(postId, { placements: wanted } as never, caller);
      return { ok: true };
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 409) {
        const body = error.getResponse() as { code?: string; params?: { reason?: string; index?: number } };
        if (body.code === 'REQUIREMENT_PLACEMENT_REFUSED') {
          assert.equal(body.params?.index, 0, `${one_case.name}: the PUT refused row ${body.params?.index}, not the candidate: the world's own rows clash with something else`);
          return { ok: false, reason: String(body.params?.reason) };
        }
        assert.fail(`${one_case.name}: a mistake of the world, the PUT is refused as ${body.code} ${JSON.stringify(body.params)}`);
      }
      // Not an answer of the gateway (a CHECK of the table that the judge should have said first, say): said with the case.
      assert.fail(`${one_case.name}: the PUT failed with ${error instanceof Error ? `${error.constructor.name} ${JSON.stringify(error.message).slice(0, 160)} ${JSON.stringify((error as { meta?: unknown }).meta ?? null).slice(0, 200)}` : String(error)}`);
    }
  };

  try {
    await check(`(vv9) the judge gives every one of the ${fixture.cases.length} cases of placement-clash-cases.json the verdict the fixture holds (${write ? 'WRITING the real verdicts back' : 'checking'})`, async () => {
      const real: Verdict[] = [];
      const differing: string[] = [];
      for (const [index, one_case] of fixture.cases.entries()) {
        const verdict = await judgeCase(index, one_case);
        real.push(verdict);
        if (JSON.stringify(verdict) !== JSON.stringify(one_case.verdict)) {
          differing.push(`  [${index}] ${one_case.name}\n       fixture ${JSON.stringify(one_case.verdict)}  real judge ${JSON.stringify(verdict)}`);
        }
      }
      if (write) {
        const text = readFileSync(FIXTURE, 'utf8');
        writeFileSync(FIXTURE, withVerdicts(text, real));
        console.log(`     ${differing.length} of ${fixture.cases.length} verdicts differed from the file and were rewritten${differing.length > 0 ? ':\n' + differing.join('\n') : ''}`);
        return;
      }
      assert.equal(differing.length, 0, `${differing.length} case(s) differ from the real judge (FORLAGG_SPEGEL_WRITE=1 writes them back):\n${differing.join('\n')}`);
    });
  } finally {
    await sweepPlacementMirrorSchools(owner, marker);
  }
}
