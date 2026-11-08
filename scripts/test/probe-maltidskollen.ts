/**
 * Måltidskollen (D8, 20270123090000) against a real database, as the API role under
 * RLS, through the real MealCountsService, MealLetterJob and JobRunner.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-maltidskollen.ts
 *
 * The RLS sections 400-404 prove what the functions and the arms do, and the jest specs the
 * rules with the database faked; this is what the adapter makes of them: the casts of the
 * dates the service sends, the jsonb the count comes back as, a Time(0) column read and
 * written, the day of the school (not the machine's) deciding what is "today", the day of the
 * last letter read from the job's claims, and the file's bytes as Excel will read them.
 * In a school of its own (<tag>-maltid), removed whole before and after.
 *
 *   (ma)  the counts through the service: the sittings, the classes and what each adds, the
 *         absence before and after the cut-off, an activity over the lunch, the staff, and
 *         the file; a pupil's name nowhere in either;
 *   (mb)  the settings: nothing set, saved by Drift, refused for the läsare by the table,
 *         a letter that is on without an address refused by name, the cut-off as a time;
 *   (mc)  the letter through MealLetterJob.tick: due at the cut-off and not a second before,
 *         once a day, the same figures however late it goes, left open when the mail is not
 *         taken, and retried inside the three hours; a day without a sitting gets none;
 *   (md)  two passes at once send one letter.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import { JobRunner } from '../../src/jobs/job-runner';
import { MEAL_LETTER_JOB } from '../../src/meal-counts/meal-counts';
import { MealCountsService } from '../../src/meal-counts/meal-counts.service';
import { MealLetterJob } from '../../src/meal-counts/meal-letter.job';
import type { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

let failures = 0;
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const TZ = 'Europe/Stockholm';
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const day = (iso: string, by: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const slug = `${randomUUID().slice(0, 8)}-maltid`;

  const sweep = async () => {
    await owner.$executeRaw`DELETE FROM "JobClaims" WHERE job = ${MEAL_LETTER_JOB} AND "schoolId" IN (SELECT id FROM "Schools" WHERE slug LIKE '%-maltid')`;
    await owner.$executeRaw`DELETE FROM "Schools" WHERE slug LIKE '%-maltid'`;
  };
  await sweep();
  try {
    await checks(owner, api, slug);
  } finally {
    await sweep().catch((error) => console.error('cleanup:', error));
    await api.$disconnect();
    await owner.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nmaltidskollen probe passed.');
}

async function checks(owner: PrismaClient, api: PrismaService, slug: string): Promise<void> {
  /** An instant: `hhmm` on `iso` in the school's time. */
  const local = async (iso: string, hhmm: string): Promise<Date> => {
    const [row] = await owner.$queryRaw<Array<{ t: Date }>>`SELECT (${iso}::date + ${hhmm}::time) AT TIME ZONE ${TZ} AS t`;
    return row!.t;
  };

  const school = await owner.school.create({ data: { name: 'Måltidsprob', slug, timezone: TZ } });
  const s = school.id;
  // The database holds other schools with the letter on (the RLS fixtures'); the probe counts only its own.
  const ADDRESS = `kok-${slug}@skolan.test`;
  const [{ today }] = await owner.$queryRaw<Array<{ today: Date }>>`SELECT (now() AT TIME ZONE ${TZ})::date AS today`;
  const todayIso = today!.toISOString().slice(0, 10);
  const D = day(todayIso, 2);
  const D1 = day(D, 1);
  const year = await owner.academicYear.create({
    data: { schoolId: s, name: 'Måltid', startDate: new Date(`${day(todayIso, -300)}T00:00:00Z`), endDate: new Date(`${day(todayIso, 300)}T00:00:00Z`), isActive: true, gradeNumbering: 'NIOARIG' },
  });
  const klass = (name: string) => owner.studentGroup.create({ data: { schoolId: s, academicYearId: year.id, name, kind: 'CLASS', gradeLevel: 7 } });
  const [a, b, c] = [await klass('7A'), await klass('7B'), await klass('10A')];
  const pupils: Record<string, string> = {};
  let n = 0;
  const pupil = async (key: string, group: string, active = true) => {
    n += 1;
    const row = await owner.user.create({
      data: {
        schoolId: s, authId: randomUUID(), role: 'STUDENT', firstName: `Hemlig${n}`, lastName: `Elevsson${n}`, email: `p${n}@${slug}.test`,
        isActive: active, ...(active ? {} : { deactivatedAt: new Date() }), studentGroupId: group,
      },
    });
    pupils[key] = row.id;
  };
  for (const key of ['a1', 'a2', 'a3', 'a4']) await pupil(key, a.id);
  await pupil('aLeft', a.id, false);
  for (const key of ['b1', 'b2']) await pupil(key, b.id);
  for (const key of ['c1', 'c2', 'c3']) await pupil(key, c.id);
  const person = async (role: 'SCHOOL_ADMIN' | 'TEACHER', key: string, adminProfile?: 'FULL' | 'LASARE' | 'EXPEDITION') =>
    owner.user.create({
      data: { schoolId: s, authId: randomUUID(), role, firstName: key, lastName: 'Probe', email: `${key}@${slug}.test`, ...(adminProfile ? { adminProfile } : {}) },
    });
  const admin = await person('SCHOOL_ADMIN', 'admin', 'FULL');
  const expedition = await person('SCHOOL_ADMIN', 'expedition', 'EXPEDITION');
  const lasare = await person('SCHOOL_ADMIN', 'lasare', 'LASARE');
  const teacher = await person('TEACHER', 'teacher');
  const as = (user: { id: string; authId: string }, profile?: 'FULL' | 'LASARE' | 'EXPEDITION'): AuthenticatedUser => ({
    authId: user.authId, role: profile ? Role.SCHOOL_ADMIN : Role.TEACHER, userId: user.id, schoolId: s, ...(profile ? { adminProfile: profile } : {}),
  });
  const asAdmin = as(admin, 'FULL');
  const asExpedition = as(expedition, 'EXPEDITION');
  const asLasare = as(lasare, 'LASARE');
  const asTeacher = as(teacher);

  // D: 7A and 7B eat 10:30-11:00, 10A 11:00-11:30. D1: 7A alone. A lov-like day with none is D + 2.
  const lunch = async (group: string, iso: string, from: string, to: string) =>
    owner.calendarLunch.create({ data: { schoolId: s, studentGroupId: group, date: new Date(`${iso}T00:00:00Z`), startsAt: await local(iso, from), endsAt: await local(iso, to) } });
  await lunch(a.id, D, '10:30', '11:00');
  await lunch(b.id, D, '10:30', '11:00');
  await lunch(c.id, D, '11:00', '11:30');
  await lunch(a.id, D1, '10:30', '11:00');

  // Absence on D. The cut-off will be 08:30 in the school's time.
  const absent = async (key: string, startTime: string | null, endTime: string | null, reported: Date) =>
    owner.absenceReport.create({
      data: { schoolId: s, studentId: pupils[key]!, reportedById: admin.id, date: new Date(`${D}T00:00:00Z`), startTime: startTime ? time(startTime) : null, endTime: endTime ? time(endTime) : null, createdAt: reported },
    });
  await absent('a1', null, null, await local(day(D, -1), '19:00')); // before: taken off
  await absent('a2', null, null, await local(D, '09:00')); // after the cut-off: shown, not taken off
  await absent('a3', '10:45', '12:00', await local(day(D, -1), '19:00')); // does not cover the sitting: eats
  await absent('aLeft', null, null, await local(day(D, -1), '19:00')); // has left: nobody to count
  await absent('b1', '08:00', '11:00', await local(D, '07:00')); // covers it: taken off
  // A replacement lesson over 10A's lunch, and a pedagogisk lunch for the teacher in 10:45-11:15.
  const subject = await owner.subject.create({ data: { schoolId: s, name: 'Friluftsdag' } });
  const batch = await owner.cancellationBatch.create({
    data: { schoolId: s, academicYearId: year.id, name: 'Friluftsdag', cause: 'EVENT', fromDate: new Date(`${D}T00:00:00Z`), toDate: new Date(`${D}T00:00:00Z`), scope: 'GROUPS', groupIds: [c.id] },
  });
  const activity = await owner.scheduleActivity.create({ data: { schoolId: s, academicYearId: year.id, batchId: batch.id, replacementSubjectId: subject.id } });
  const lesson = await owner.calendarLesson.create({
    data: { schoolId: s, subjectId: subject.id, studentGroupId: c.id, date: new Date(`${D}T00:00:00Z`), startsAt: await local(D, '08:30'), endsAt: await local(D, '14:30') },
  });
  await owner.scheduleActivityLesson.create({ data: { activityId: activity.id, calendarLessonId: lesson.id, studentGroupId: c.id, date: new Date(`${D}T00:00:00Z`), schoolId: s } });
  const isoDow = (iso: string) => ((new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const duty = await owner.teacherDuty.create({ data: { schoolId: s, userId: teacher.id, academicYearId: year.id, kind: 'PEDAGOGISK_LUNCH', label: 'Lunch', minutesPerWeek: 30 } });
  const slot = await owner.availabilityConstraint.create({
    data: { schoolId: s, resourceType: 'TEACHER', userId: teacher.id, dayOfWeek: isoDow(D), startTime: time('10:45'), endTime: time('11:15'), type: 'UNAVAILABLE' },
  });
  await owner.teacherDutySlot.create({ data: { schoolId: s, teacherDutyId: duty.id, availabilityConstraintId: slot.id } });

  const service = new MealCountsService(api);

  await check('(mb) nothing is set: no cut-off, no letter, no address', async () => {
    assert.deepEqual(await service.settings(asAdmin), { cutoffTime: null, letterEnabled: false, kitchenEmail: null, lastLetterOn: null });
    const none = await service.view({ from: D, to: D }, asAdmin);
    assert.equal(none.cutoff, null);
    assert.deepEqual(
      none.days[0]!.sittings.map((x) => [x.start, x.absentBefore, x.absentAfter]),
      [['10:30', 0, 0], ['11:00', 0, 0]],
      'no cut-off, no absence taken off and none said to have come after',
    );
  });

  await check('(mb) Drift sets the cut-off and the address; the time is read back as HH:MM', async () => {
    const saved = await service.updateSettings({ cutoffTime: '08:30', kitchenEmail: ADDRESS }, asExpedition);
    assert.deepEqual(saved, { cutoffTime: '08:30', letterEnabled: false, kitchenEmail: ADDRESS, lastLetterOn: null });
    const [row] = await owner.$queryRaw<Array<{ t: string }>>`SELECT "cutoffTime"::text AS t FROM "KitchenSettings" WHERE "schoolId" = ${s}::uuid`;
    assert.equal(row!.t, '08:30:00');
    assert.deepEqual(await service.settings(asLasare), saved, 'a läsare reads what was set');
  });

  await check('(mb) a läsare and a teacher change nothing, and a letter without its address is refused by name', async () => {
    await assert.rejects(() => service.updateSettings({ cutoffTime: '09:00' }, asLasare), 'a läsare saved the cut-off');
    assert.equal((await service.settings(asAdmin)).cutoffTime, '08:30');
    await assert.rejects(() => service.view({ from: D }, asTeacher), 'a teacher read the counts');
    await assert.rejects(() => service.updateSettings({ kitchenEmail: null, letterEnabled: true }, asAdmin), (error: unknown) => {
      assert.equal((error as { response?: { code?: string } }).response?.code, 'MEAL_LETTER_NEEDS_ADDRESS_AND_HOUR');
      return true;
    });
    assert.equal((await service.settings(asAdmin)).kitchenEmail, ADDRESS);
  });

  await check('(ma) the counts: sittings, classes, absence before and after the cut-off, an activity, the staff', async () => {
    const view = await service.view({ from: D, days: 3 }, asAdmin);
    assert.deepEqual([view.from, view.to, view.cutoff, view.staffModelled], [D, day(D, 2), '08:30', true]);
    assert.deepEqual(view.days.map((x) => [x.date, x.sittings.length]), [[D, 2], [D1, 1], [day(D, 2), 0]]);
    const [first, second] = view.days[0]!.sittings;
    assert.deepEqual(first!.classes.map((x) => [x.name, x.pupils, x.absentBefore, x.absentAfter, x.underActivity, x.portions]), [
      ['7A', 4, 1, 1, false, 3],
      ['7B', 2, 1, 0, false, 1],
    ]);
    assert.deepEqual([first!.pupils, first!.absentBefore, first!.staff, first!.portions, first!.absentAfter], [6, 2, 1, 5, 1]);
    assert.deepEqual(second!.classes.map((x) => [x.name, x.pupils, x.underActivity, x.portions]), [['10A', 3, true, 3]]);
    assert.deepEqual([second!.staff, second!.portions, second!.underActivity], [0, 3, 3]);
    assert.deepEqual(view.days[0]!.totals, { pupils: 9, absentBefore: 2, staff: 1, portions: 8, absentAfter: 1, underActivity: 3 });
    assert.deepEqual(view.days[1]!.totals, { pupils: 4, absentBefore: 0, staff: 0, portions: 4, absentAfter: 0, underActivity: 0 });
  });

  await check('(ma) the days are the school\'s, from its own today: a day before it is refused, today answers', async () => {
    await assert.rejects(() => service.view({ from: day(todayIso, -1) }, asAdmin), (error: unknown) => {
      assert.equal((error as { response?: { code?: string } }).response?.code, 'MEAL_COUNTS_PAST');
      return true;
    });
    assert.equal((await service.view({}, asAdmin)).from, todayIso);
    assert.equal((await service.view({ days: 7 }, asAdmin)).to, day(todayIso, 6));
  });

  await check('(ma) another cut-off decides what is taken off, and the counts follow at once', async () => {
    await service.updateSettings({ cutoffTime: '09:30' }, asAdmin);
    const moved = await service.view({ from: D }, asAdmin);
    assert.deepEqual(moved.days[0]!.sittings[0]!.classes.map((x) => [x.name, x.absentBefore, x.absentAfter]), [['7A', 2, 0], ['7B', 1, 0]]);
    await service.updateSettings({ cutoffTime: '08:30' }, asAdmin);
  });

  await check('(ma) the file is windows-1252 with ; and names the classes and counts, no pupil', async () => {
    const file = await service.csv({ from: D, days: 2 }, asAdmin);
    assert.equal(file.filename, `portioner-${D}-${D1}.csv`);
    const text = new TextDecoder('windows-1252').decode(file.body);
    const lines = text.split('\r\n');
    assert.equal(lines.length, 5, 'a header, three sittings and the end');
    assert.ok(lines[0]!.startsWith('Datum;Veckodag;Sittning från;Sittning till;Klasser;'));
    assert.match(lines[1]!, new RegExp(`^${D};[a-zåäö]+dag;10:30;11:00;"7A 3, 7B 1";6;2;1;5;1;0$`));
    assert.ok(file.body.includes(Buffer.from('från', 'latin1')), 'å is the one byte 0xE5');
    for (const secret of [...Object.values(pupils), 'Hemlig', 'Elevsson', '@']) {
      assert.ok(!text.includes(secret) && !JSON.stringify(await service.view({ from: D }, asAdmin)).includes(secret), `${secret} is in the answer`);
    }
  });

  // --- the letter ---------------------------------------------------------------------------------------------
  const delivered: Array<{ address: string; subject: string; body: string }> = [];
  let taken = true;
  const delivery = {
    sendLetter: async (address: string, subject: string, body: string) => {
      if (taken) delivered.push({ address, subject, body });
      return taken;
    },
  } as unknown as NotificationDeliveryService;
  const runner = new JobRunner(api);
  const job = new MealLetterJob(api, delivery, undefined, runner);
  /** The letters that went to this school's address. */
  const mine = () => delivered.filter((l) => l.address === ADDRESS);
  const claimOf = async () =>
    owner.jobClaim.findMany({ where: { job: MEAL_LETTER_JOB, schoolId: s }, orderBy: { day: 'asc' } });
  await service.updateSettings({ letterEnabled: true }, asAdmin);

  await check('(mc) no letter before the cut-off, not even a second before, and none for a day without a sitting', async () => {
    await job.tick(await local(D, '08:29:59'));
    assert.equal(mine().length, 0);
    assert.equal((await claimOf()).length, 0, 'a claim was made before the hour');
    await job.tick(await local(day(D, 2), '08:45'));
    assert.equal(mine().length, 0, 'a letter went on a day with no sitting');
    assert.equal((await claimOf()).length, 0);
  });

  await check('(mc) at the cut-off the letter goes once, to the school\'s address, with the day\'s figures', async () => {
    await job.tick(await local(D, '08:30:00'));
    assert.equal(mine().length, 1);
    const letter = mine()[0]!;
    assert.equal(letter.address, ADDRESS);
    assert.match(letter.subject, /^Portioner [a-zåäö]+dag \d+ [a-zåäö]+ \d{4}$/);
    assert.match(letter.body, /Sittning 10:30–11:00: 5 portioner/);
    assert.match(letter.body, /Sittning 11:00–11:30: 3 portioner/);
    assert.match(letter.body, /Totalt: 8 portioner\./);
    assert.match(letter.body, /7A 3, 7B 1/);
    assert.match(letter.body, /Anmäld efter klockan 08:30 och inte avdragen: 1\./);
    assert.match(letter.body, /schemabrytande aktivitet över sittningen \(räknas med\): 10A/);
    assert.ok(!/Hemlig|Elevsson|@/.test(letter.body), 'a pupil or an address in the letter');
    const claims = await claimOf();
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.finishedAt !== null, true, 'the claim was not finished after the mail');
    assert.equal((await service.settings(asAdmin)).lastLetterOn, D);
  });

  await check('(mc) a second pass, and a later one, send no second letter that day', async () => {
    await job.tick(await local(D, '08:32'));
    await job.tick(await local(D, '10:15'));
    assert.equal(mine().length, 1);
  });

  await check('(md) two passes at once send one letter, in the school\'s second day', async () => {
    const before = mine().length;
    const at = await local(D1, '08:40');
    const other = new MealLetterJob(api, delivery, undefined, new JobRunner(api));
    await Promise.all([job.tick(at), other.tick(at)]);
    assert.equal(mine().length - before, 1, 'the same day\'s letter went twice');
  });

  await check('(mc) a mail that was not taken leaves the claim open, and it is taken again two hours on, inside the grace', async () => {
    await owner.$executeRaw`DELETE FROM "JobClaims" WHERE job = ${MEAL_LETTER_JOB} AND "schoolId" = ${s}::uuid AND day = ${D}::date`;
    taken = false;
    const before = mine().length;
    await job.tick(await local(D, '08:35'));
    await job.tick(await local(D, '09:00'));
    const open = (await claimOf()).find((x) => x.day.toISOString().slice(0, 10) === D)!;
    assert.equal(open.finishedAt, null, 'a letter that was not taken was marked done');
    assert.equal(mine().length, before);
    taken = true;
    await job.tick(await local(D, '09:00'));
    assert.equal(mine().length, before, 'the claim was taken again before two hours had passed');
    await job.tick(await local(D, '10:40'));
    assert.equal(mine().length, before + 1, 'the letter was not sent in the second try');
    assert.match(mine().at(-1)!.body, /Läget klockan 08:30\./);
  });

  await check('(mc) three hours on, a letter that has not gone does not go', async () => {
    await owner.$executeRaw`DELETE FROM "JobClaims" WHERE job = ${MEAL_LETTER_JOB} AND "schoolId" = ${s}::uuid AND day = ${D}::date`;
    const before = mine().length;
    await job.tick(await local(D, '11:30'));
    assert.equal(mine().length, before);
  });

  await check('(mc) switched off, no letter, and nothing about the school in the pass\'s counts but a number', async () => {
    await service.updateSettings({ letterEnabled: false }, asAdmin);
    await owner.$executeRaw`DELETE FROM "JobClaims" WHERE job = ${MEAL_LETTER_JOB} AND "schoolId" = ${s}::uuid`;
    const before = mine().length;
    await job.tick(await local(D, '08:45'));
    assert.equal(mine().length, before);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
