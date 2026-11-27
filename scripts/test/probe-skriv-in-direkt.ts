/**
 * Skriv in förläggningarna (E4b) in Direkt, against a real database, as the API role, through the real services (granskaren g505, M-2).
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-skriv-in-direkt.ts
 *
 * A school in Direkt with a published period that has not answered P5's question (requireDirectReachAnswered): a write that takes the replaced lesson's
 * dated lessons off the families' calendar is refused with 409 DIRECT_REACH_UNANSWERED and changes nothing (z1); once the school has answered it goes through
 * (z2); a write that reaches no published lesson is asked nothing (z3). It works in a school of its own and drops it.
 */
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { PrismaService } from '../../src/database/prisma.service';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PlacementWriteInService } from '../../src/requirement-placements/placement-write-in.service';
import { RequirementPlacementsService } from '../../src/requirement-placements/requirement-placements.service';
import { plant, type World } from './probe-domaren';

const WORLD: World = {
  classes: [{ key: '7A', grade: 7 }],
  teachers: ['T1'],
  rooms: ['R1', 'R2'],
  subjects: ['Matematik'],
  lessons: [],
  unavailable: [],
  frames: [{ grades: [7, 9], start: '08:00', end: '15:00' }],
  meals: [],
};
const fails: string[] = [];
const expect = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} EXPECT ${label}${ok ? '' : ` -- ${JSON.stringify(detail)}`}`);
  if (!ok) fails.push(label);
};
const show = (label: string, value: unknown) => console.log(`  ..    ${label}: ${JSON.stringify(value)}`);
const refusal = (e: unknown) => (e instanceof HttpException ? { status: e.getStatus(), code: (e.getResponse() as { code?: string }).code } : String(e).slice(0, 200));

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const bridge = new PlacementWriteInService(api, new RequirementPlacementsService(api, masters), new ScheduleVersionsService(api), realtime as never);
  const q = async <T extends object>(sql: string, p: unknown[] = []) => (await owner.query<T>(sql, p)).rows;
  const SLUG = 'probe-skriv-in-direkt';
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
  try {
    const a = await plant(owner, SLUG, WORLD);
    const R1 = a.roomId.get('R1')!;
    const post = (await q<{ id: string }>(
      `INSERT INTO "TeachingRequirements" ("schoolId","academicYearId","subjectId","studentGroupId","teacherId","lessonsPerWeek","minutesPerLesson","updatedAt") VALUES ($1,$2,$3,$4,$5,1,60,now()) RETURNING id`,
      [a.school, a.year, a.subjectId.get('Matematik'), a.classId.get('7A'), a.teacherId.get('T1')],
    ))[0]!.id;
    const row = (await q<{ id: string }>(
      `INSERT INTO "TeachingRequirementPlacements" ("schoolId","requirementId","dayOfWeek","startTime",minutes,"roomId",recurrence,"updatedAt") VALUES ($1,$2,1,'09:00',60,$3,'ALL_WEEKS',now()) RETURNING id`,
      [a.school, post, R1],
    ))[0]!.id;
    const first = await bridge.write(a.year, a.caller);
    show('first write (nothing published yet)', { written: first.lessonsWritten });
    const lesson = (await q<{ id: string }>(`SELECT id FROM "MasterLessons" WHERE "academicYearId"=$1 AND "fromPlacement"`, [a.year]))[0]!.id;
    // A published period (as the publish writes it): the publication and the lesson's dated lesson on the calendar.
    await q(
      `INSERT INTO "TimetablePublications" ("schoolId","academicYearId",kind,outcome,"publishMode","validFrom","validTo","publishedAt") VALUES ($1,$2,'PUBLISH','PUBLISHED','DIRECT','2026-08-15','2027-06-11',now())`,
      [a.school, a.year],
    );
    await q(
      `INSERT INTO "CalendarLessons" ("schoolId","masterLessonId","subjectId","studentGroupId",date,"startsAt","endsAt",status,"updatedAt") SELECT "schoolId", id, "subjectId", "studentGroupId", current_date + 7, (current_date + 7)::timestamptz + interval '9 hours', (current_date + 7)::timestamptz + interval '10 hours', 'SCHEDULED', now() FROM "MasterLessons" WHERE id=$1`,
      [lesson],
    );
    const calendar = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "CalendarLessons" WHERE "schoolId"=$1`, [a.school]))[0]!.n);
    // The school moves the row to Tuesday and writes again, in Direkt, never having answered the question.
    await q(`UPDATE "TeachingRequirementPlacements" SET "dayOfWeek"=2 WHERE id=$1`, [row]);
    const before = { calendar: await calendar(), lessonDay: (await q<{ d: number }>(`SELECT "dayOfWeek" AS d FROM "MasterLessons" WHERE id=$1`, [lesson]))[0]?.d };
    let answer: unknown;
    try {
      const r = await bridge.write(a.year, a.caller);
      answer = { written: r.lessonsWritten, replaced: r.lessonsReplaced, calendarLessonsRemoved: r.calendarLessonsRemoved };
    } catch (e) {
      answer = refusal(e);
    }
    const after = { calendar: await calendar(), lessonStillThere: (await q<{ n: string }>(`SELECT count(*) AS n FROM "MasterLessons" WHERE id=$1`, [lesson]))[0]!.n };
    show('write in Direkt, published period, unanswered', answer);
    show('calendar lessons before/after, replaced lesson still there', { before, after });
    expect('z1 the write asks first (409 DIRECT_REACH_UNANSWERED) and changes nothing when it would take lessons off a published calendar', JSON.stringify(answer).includes('DIRECT_REACH_UNANSWERED') && after.calendar === before.calendar && after.lessonStillThere === '1', { answer, before, after });
    // The school answers; the same write goes through.
    await q(`INSERT INTO "PublicationSettings" ("schoolId","publishMode","directReachAcknowledgedAt","updatedAt") VALUES ($1,'DIRECT',now(),now()) ON CONFLICT ("schoolId") DO UPDATE SET "directReachAcknowledgedAt" = now()`, [a.school]);
    const answered = await bridge.write(a.year, a.caller).then((r) => ({ written: r.lessonsWritten, calendarLessonsRemoved: r.calendarLessonsRemoved }), refusal);
    show('write after the answer', answered);
    expect('z2 once the school has answered the write goes through and takes the dated lesson off', (answered as { calendarLessonsRemoved?: number }).calendarLessonsRemoved === 1, answered);
    // A write that reaches no published lesson is never asked.
    await q(`UPDATE "PublicationSettings" SET "directReachAcknowledgedAt" = NULL WHERE "schoolId"=$1`, [a.school]);
    await q(`UPDATE "TeachingRequirementPlacements" SET "dayOfWeek"=3 WHERE id=$1`, [row]);
    const quiet = await bridge.write(a.year, a.caller).then((r) => ({ written: r.lessonsWritten, calendarLessonsRemoved: r.calendarLessonsRemoved }), refusal);
    show('write that reaches no calendar lesson, unanswered', quiet);
    expect('z3 a write that reaches no published lesson asks nothing', (quiet as { calendarLessonsRemoved?: number }).calendarLessonsRemoved === 0, quiet);
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await owner.end();
    await api.$disconnect();
  }
  console.log(fails.length ? `==> probe-skriv-in-direkt: ${fails.length} EXPECT line(s) failed: ${fails.join(' | ')}` : '==> probe-skriv-in-direkt: all EXPECT lines ok');
  if (fails.length) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exit(1); });
