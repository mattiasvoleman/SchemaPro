/**
 * Salväljaren (E3) och en sal som flera lektioner får dela: the room chooser against the judge, as the API role under RLS.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-salvaljare-delade-salar.ts
 *
 * The prune does not count pupils in a room the school lets several lessons share (the judge does), so a room whose seats are taken was
 * called free and ranked among the rooms a lesson can have, and refused by the judge when it was chosen. The chooser asks the judge of such
 * rooms. A room it calls free is never one the judge refuses for the room, and the one it cannot seat is named with the lesson that sits in it.
 * It works in a school of its own and drops it.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PossibleTimesService } from '../../src/calendar/possible-times.service';
import { WhatFitsService } from '../../src/calendar/what-fits.service';
import { PrismaService } from '../../src/database/prisma.service';

const SLUG = 'probe-salvaljare-delade-salar';

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const masters = new MasterLessonsService(api, { notifyMasterTimetableChanged: () => undefined } as never, { recipientsForLessons: async () => [], notifyUsers: async () => undefined } as never);
  const fitting = new WhatFitsService(api, new PossibleTimesService(api, masters));
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  try {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    const school = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
    const year = (await one<{ id: string }>(`INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'p', '2026-08-15', '2027-06-11', true, 'NIOARIG', now()) RETURNING id`, [school])).id;
    const person = async (label: string, role: string, group: string | null = null, profile: string | null = null) => {
      const authId = randomUUID();
      const row = await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "studentGroupId", "updatedAt") VALUES ($1, $2, $3, 'Probe', $4, $5, true, $6, $7, now()) RETURNING id`,
        [school, `${SLUG}-${label}@example.invalid`, label, role, authId, profile, group],
      );
      return { id: row.id, authId };
    };
    const klass = async (name: string) => {
      const id = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`, [school, year, name])).id;
      for (let pupil = 0; pupil < 4; pupil++) await person(`${name}-p${pupil}`, 'STUDENT', id);
      return id;
    };
    const [a, b] = [await klass('7A'), await klass('7B')];
    const [t1, t2] = [await person('T1', 'TEACHER'), await person('T2', 'TEACHER')];
    const subject = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, 'Ma', now()) RETURNING id`, [school])).id;
    const room = async (name: string, capacity: number, shared: boolean) => (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "canBeShared", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`, [school, name, capacity, shared])).id;
    const [shared, plain] = [await room('Delad 6', 6, true), await room('Vanlig 30', 30, false)];
    const lesson = async (group: string, teacher: string, roomId: string, day: number) =>
      (await one<{ id: string }>(`INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "isLocked", "isGenerated", recurrence, "isParked", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, '09:00', '10:00', false, false, 'ALL_WEEKS', false, now()) RETURNING id`, [school, year, subject, group, teacher, roomId, day])).id;
    await lesson(a, t1.id, shared, 2); // seven A: four pupils in a room of six seats
    const moved = await lesson(b, t2.id, plain, 4); // seven B: four more would be eight
    await owner.query(`INSERT INTO "LunchSettings" ("schoolId", "lunchEnabled", "lunchStartTime", "lunchEndTime", "lunchMinutes", "placementSharedMode", "updatedAt") VALUES ($1, false, '11:00', '13:00', 30, 'SOFT'::"PlacementRuleMode", now()) ON CONFLICT ("schoolId") DO UPDATE SET "placementSharedMode" = EXCLUDED."placementSharedMode"`, [school]);
    const admin = await person('admin', 'SCHOOL_ADMIN', null, 'SCHEMALAGGARE');
    const caller = { authId: admin.authId, userId: admin.id, schoolId: school, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', channel: 'WEB', hrRead: false } as unknown as AuthenticatedUser;

    const chosen = await fitting.roomChoices({ lessonId: moved, dayOfWeek: 2, startTime: '09:00' }, caller);
    for (const row of chosen.rooms) {
      const verdict = await masters.judgeMoves({ moves: [{ lessonId: moved, dayOfWeek: 2, startTime: '09:00', endTime: '10:00', roomId: row.roomId }] }, caller);
      const refusedForTheRoom = verdict.moves[0]!.refusals.some((refusal) => refusal.reason === 'ROOM');
      if (row.state === 'FREE') assert.ok(!refusedForTheRoom, `${row.name}: the chooser says free (rank ${row.rank}) and the judge refuses the room`);
    }
    const full = chosen.rooms.find((row) => row.roomId === shared)!;
    assert.equal(full.state, 'BUSY', 'the room whose six seats the seven A holds is busy for seven B');
    assert.equal(full.rank, null, 'and it is not ranked among the rooms the lesson can have');
    assert.equal(full.occupant?.className, '7A');
    assert.equal(chosen.rooms[0]!.roomId, plain, 'the room that is free comes first');
    console.log('  ok  salväljaren: a shared room with no seats left is busy and unranked, as the judge says');
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await owner.end();
    await api.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
