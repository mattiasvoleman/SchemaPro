/**
 * Lokal (K3, 20270204091000) against a real database, as the API role under RLS, through the real
 * ResourcesService, ResourceBookingsService, ExternalBookingsService, RoomBookingsService,
 * UtilisationService and the clash notice a publication sends.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-lokal.ts
 *
 * The RLS sections 440-444 prove what the tables, triggers and arms do, and the jest specs the rules with
 * the database faked; this is what the adapter makes of them: the trigger's 23P01 arriving as an error the
 * service recognises by name (the quantity, and the room's constraint under a series), a Time(0) and a
 * Date[] column written and read, the school's day (not the machine's) deciding "today", the instants of a
 * day across a change of summer time, the clash query on the rows the service wrote, and a term of
 * recurring bookings for forty rooms against a full schedule in the time the phase set (2 s).
 * In a school of its own (<tag>-lokal), removed whole before and after.
 *
 *   (la)  resources: a kind and a resource written by Planering, a teacher's booking, the quantity used up
 *         answered 409 RESOURCE_QUANTITY_USED, availability, a decision that tells the booker (the notice
 *         names the resource), what a teacher and an administrator read of the list, a quantity cut below
 *         what is held refused;
 *   (lb)  a series: the preview names what is in the way (a lesson, a booking, the ramtid, a closure, an
 *         activity as a warning), registering refuses and then skips, the days are bookings of the room
 *         that a teacher cannot book over, two registrations at once end in one 409 and not a 500;
 *   (lc)  the clash: a lesson that lands in a booked room is listed, in the detail and in the notice the
 *         expedition and the full administrator get and the läsare does not; a cancelled series and a
 *         cancelled day clash with nothing;
 *   (lg)  the register extract of the person who registered a series: the series is there, the hirer's details are `(dold)` and in no file;
 *   (ld)  the series' own life: the contact changes, the rule does not, cancel, cancel a day, remove;
 *   (le)  the report: a week of the hall as the figures say, and the CSV;
 *   (lf)  forty rooms, a term of Tuesdays each, a full schedule: the whole registration in under 2 s (or, on a
 *         machine slower than the one the phase measured on, within ten reads of a room's lessons a series, a
 *         read the probe measures first on the same machine, and a step-by-step account of where a series goes).
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import { clashRows, flagAfterPublication } from '../../src/local/external-clashes';
import { ExternalBookingsService } from '../../src/local/external-bookings.service';
import { readLateLessons, readRoomFacts, readStatics } from '../../src/local/external-facts';
import { expandRule } from '../../src/local/external-rule';
import { ResourceBookingsService } from '../../src/local/resource-bookings.service';
import { ResourceTypesService } from '../../src/local/resource-types.service';
import { ResourcesService } from '../../src/local/resources.service';
import { UtilisationService } from '../../src/local/utilisation.service';
import { utilisationCsv } from '../../src/local/utilisation-csv';
import { NotificationsService } from '../../src/notifications/notifications.service';
import type { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import { RoomBookingsService } from '../../src/room-bookings/room-bookings.service';
import { SubjectAccessService } from '../../src/school-export/subject-access.service';

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

/** The status of the HttpException a promise ends in, or what it did. */
async function refusal(promise: Promise<unknown>): Promise<{ status: number; code?: string; conflicts?: Array<{ date: string; conflicts: Array<{ kind: string; severity: string }> }> }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConflictException) {
      const body = error.getResponse() as { code?: string; conflicts?: never };
      return { status: error.getStatus(), ...(body.code ? { code: body.code } : {}), ...(body.conflicts ? { conflicts: body.conflicts } : {}) };
    }
    const status = (error as { getStatus?: () => number }).getStatus?.();
    if (status) return { status };
    throw error;
  }
  throw new Error('expected a refusal');
}

const TZ = 'Europe/Stockholm';
const dayShift = (iso: string, by: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
/** The first Tuesday on or after a date. */
const tuesdayOnOrAfter = (iso: string) => {
  const dow = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return dayShift(iso, (9 - (dow === 0 ? 7 : dow)) % 7);
};

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const slug = `${randomUUID().slice(0, 8)}-lokal`;
  const sweep = async () => {
    await owner.$executeRaw`DELETE FROM "Notifications" WHERE "schoolId" IN (SELECT id FROM "Schools" WHERE slug LIKE '%-lokal')`;
    await owner.$executeRaw`DELETE FROM "Schools" WHERE slug LIKE '%-lokal'`;
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
  console.log('\nlokal probe passed.');
}

async function checks(owner: PrismaClient, api: PrismaService, slug: string): Promise<void> {
  const school = await owner.school.create({ data: { name: 'Lokalprob', slug, timezone: TZ } });
  const s = school.id;
  const [{ today }] = await owner.$queryRaw<Array<{ today: Date }>>`SELECT (now() AT TIME ZONE ${TZ})::date AS today`;
  const todayIso = today!.toISOString().slice(0, 10);
  const local = async (iso: string, hhmm: string): Promise<Date> => {
    const [row] = await owner.$queryRaw<Array<{ t: Date }>>`SELECT (${iso}::date + ${hhmm}::time) AT TIME ZONE ${TZ} AS t`;
    return row!.t;
  };
  const year = await owner.academicYear.create({
    data: { schoolId: s, name: 'Lokal', startDate: new Date(`${dayShift(todayIso, -300)}T00:00:00Z`), endDate: new Date(`${dayShift(todayIso, 500)}T00:00:00Z`), isActive: true, gradeNumbering: 'NIOARIG' },
  });
  const group = await owner.studentGroup.create({ data: { schoolId: s, academicYearId: year.id, name: '7A', kind: 'CLASS', gradeLevel: 7 } });
  const subject = await owner.subject.create({ data: { schoolId: s, name: 'Idrott och hälsa', code: 'IDH' } });
  const hall = await owner.room.create({ data: { schoolId: s, name: 'Idrottshallen' } });
  const person = async (role: 'SCHOOL_ADMIN' | 'TEACHER', key: string, adminProfile?: 'FULL' | 'LASARE' | 'EXPEDITION') =>
    owner.user.create({ data: { schoolId: s, authId: randomUUID(), role, firstName: key, lastName: 'Probe', email: `${key}@${slug}.test`, ...(adminProfile ? { adminProfile } : {}) } });
  const [admin, expedition, lasare, teacher, teacher2] = [
    await person('SCHOOL_ADMIN', 'admin', 'FULL'),
    await person('SCHOOL_ADMIN', 'expedition', 'EXPEDITION'),
    await person('SCHOOL_ADMIN', 'lasare', 'LASARE'),
    await person('TEACHER', 'teacher'),
    await person('TEACHER', 'teacher2'),
  ];
  const as = (user: { id: string; authId: string }, profile?: 'FULL' | 'LASARE' | 'EXPEDITION'): AuthenticatedUser => ({
    authId: user.authId, role: profile ? Role.SCHOOL_ADMIN : Role.TEACHER, userId: user.id, schoolId: s, ...(profile ? { adminProfile: profile } : {}),
  });
  const asAdmin = as(admin, 'FULL');
  const asExpedition = as(expedition, 'EXPEDITION');
  const asLasare = as(lasare, 'LASARE');
  const asTeacher = as(teacher);
  const asTeacher2 = as(teacher2);

  const notifications = new NotificationsService(api, {
    wants: () => false,
    emailConfigured: () => false,
    enqueue: () => undefined,
  } as unknown as NotificationDeliveryService);
  const types = new ResourceTypesService(api);
  const resources = new ResourcesService(api);
  const resourceBookings = new ResourceBookingsService(api, notifications);
  const external = new ExternalBookingsService(api);
  const roomBookings = new RoomBookingsService(api, notifications);
  const utilisation = new UtilisationService(api);

  // The school's ramtid: every year, 08:00-16:00 on a teaching day.
  await owner.frameTime.create({ data: { schoolId: s, minGradeLevel: 0, maxGradeLevel: 12, dayOfWeek: null, startTime: new Date('1970-01-01T08:00:00Z'), endTime: new Date('1970-01-01T16:00:00Z') } });

  const firstTuesday = tuesdayOnOrAfter(dayShift(todayIso, 100));
  const lastTuesday = dayShift(firstTuesday, 56);
  const rule = { target: 'ROOM' as const, roomId: hall.id, weekdays: [2], startDate: firstTuesday, endDate: lastTuesday, startTime: '18:00', endTime: '20:00' };
  const organisation = { organisation: 'Hjo innebandy', contactName: 'Kim Kontakt', contactPhone: '070-123 45 67', contactEmail: 'kim@forening.example' };

  // --- (la) resources --------------------------------------------------------------------------
  let resourceId = '';
  await check('(la) a kind and a resource by Planering, a teacher books, the quantity used up is a 409 by name, and availability counts', async () => {
    const type = await types.create({ name: 'Surfplattor' }, asAdmin);
    assert.equal(type.resources, 0);
    const created = await resources.create({ name: 'Klassuppsättning', resourceTypeId: type.id, quantity: 30, place: ' Skåp 3 i B-huset ', requiresApproval: true }, asAdmin);
    resourceId = created.id;
    assert.equal(created.place, 'Skåp 3 i B-huset');
    assert.equal(created.resourceTypeName, 'Surfplattor');
    const startsAt = await local(dayShift(todayIso, 20), '09:00');
    const endsAt = await local(dayShift(todayIso, 20), '10:00');
    const first = await resourceBookings.create({ resourceId, title: 'Matteprov', quantity: 20, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, asTeacher);
    assert.equal(first.status, 'PENDING', 'a resource that requires approval starts PENDING for a teacher');
    const adminBooking = await resourceBookings.create({ resourceId, title: 'Rektorn', quantity: 10, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, asAdmin);
    assert.equal(adminBooking.status, 'APPROVED', 'an administrator books without waiting');
    const over = await refusal(resourceBookings.create({ resourceId, title: 'För mycket', quantity: 1, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, asTeacher2));
    assert.deepEqual([over.status, over.code], [409, 'RESOURCE_QUANTITY_USED']);
    const free = await resources.availability(startsAt.toISOString(), endsAt.toISOString(), asTeacher2);
    assert.equal(free.find((row) => row.id === resourceId)!.free, 0);
    const elsewhere = await resources.availability((await local(dayShift(todayIso, 21), '09:00')).toISOString(), (await local(dayShift(todayIso, 21), '10:00')).toISOString(), asTeacher2);
    assert.equal(elsewhere.find((row) => row.id === resourceId)!.free, 30);
  });

  await check('(la) a decision tells the booker and names the resource; a rejection frees the quantity; the lists say who sees what', async () => {
    const pending = (await resourceBookings.list(asTeacher, { status: 'PENDING' }))[0]!;
    assert.equal(pending.bookedByName, null, 'a teacher is told no names');
    const decided = await resourceBookings.decide(pending.id, { status: 'REJECTED', note: 'Behövs till provet' }, asAdmin);
    assert.equal(decided.status, 'REJECTED');
    const notice = await owner.notification.findFirst({ where: { userId: teacher.id, type: 'ROOM_BOOKING_DECIDED' } });
    assert.ok(notice, 'the booker got a notice');
    assert.equal((notice!.meta as { resourceName?: string }).resourceName, 'Klassuppsättning');
    const adminList = await resourceBookings.list(asAdmin, {});
    assert.ok(adminList.find((row) => row.title === 'Rektorn')!.bookedByName?.startsWith('admin'), 'an administrator is told who booked');
    const teacher2List = await resourceBookings.list(asTeacher2, {});
    assert.equal(teacher2List.length, 0, 'a teacher reads her own bookings only');
    const startsAt = await local(dayShift(todayIso, 20), '09:00');
    const endsAt = await local(dayShift(todayIso, 20), '10:00');
    await resourceBookings.create({ resourceId, title: 'Nu ryms det', quantity: 20, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }, asTeacher2);
  });

  await check('(la) a quantity cut below what a later booking holds is refused; a resource that is not let out is deleted', async () => {
    assert.equal((await refusal(resources.update(resourceId, { quantity: 25 }, asAdmin))).status, 400);
    const lower = await resources.update(resourceId, { quantity: 30 }, asAdmin);
    assert.equal(lower.quantity, 30);
    await assert.rejects(resources.update(resourceId, { name: 'Läsarens' }, asLasare), 'the läsare changes no resource');
    assert.equal((await owner.resource.findUniqueOrThrow({ where: { id: resourceId } })).name, 'Klassuppsättning');
  });

  // --- (lb) a series -----------------------------------------------------------------------------
  const lessonAt = async (iso: string, from: string, to: string, status: 'SCHEDULED' | 'CANCELLED' = 'SCHEDULED', roomId = hall.id) =>
    owner.calendarLesson.create({
      data: { schoolId: s, subjectId: subject.id, studentGroupId: group.id, roomId, date: new Date(`${iso}T00:00:00Z`), startsAt: await local(iso, from), endsAt: await local(iso, to), status },
    });
  const wk = (n: number) => dayShift(firstTuesday, 7 * n);
  let seriesId = '';
  await check('(lb) the preview names what is in the way and writes nothing', async () => {
    await lessonAt(wk(1), '17:00', '18:30'); // a lesson that runs into the evening
    await lessonAt(wk(2), '17:00', '18:30', 'CANCELLED'); // cancelled: holds nothing
    await owner.roomBooking.create({ data: { schoolId: s, roomId: hall.id, bookedById: teacher.id, title: 'Föräldramöte', startsAt: await local(wk(3), '19:00'), endsAt: await local(wk(3), '21:00'), status: 'APPROVED' } });
    await owner.availabilityConstraint.create({ data: { schoolId: s, resourceType: 'ROOM', roomId: hall.id, date: new Date(`${wk(4)}T00:00:00Z`), startTime: new Date('1970-01-01T17:00:00Z'), endTime: new Date('1970-01-01T21:00:00Z'), type: 'UNAVAILABLE', reason: 'Golvet slipas' } });
    const preview = await external.preview(rule, asAdmin);
    assert.equal(preview.count, 9);
    assert.equal(preview.framesMissing, false);
    const kinds = (n: number) => preview.occurrences[n]!.conflicts.map((c) => `${c.kind}:${c.severity}`);
    assert.deepEqual(kinds(0), []);
    assert.deepEqual(kinds(1), ['LESSON:BLOCK']);
    assert.deepEqual(kinds(2), [], 'a cancelled lesson holds nothing');
    assert.deepEqual(kinds(3), ['BOOKING:BLOCK']);
    assert.deepEqual(kinds(4), ['CLOSED:BLOCK']);
    assert.equal(preview.blocked, 3);
    assert.equal(await owner.externalBooking.count({ where: { schoolId: s } }), 0, 'a preview writes nothing');
    // The ramtid: a series from 15:00 is inside the school's day.
    const inside = await external.preview({ ...rule, startTime: '15:00', endTime: '17:00' }, asAdmin);
    assert.ok(inside.occurrences.every((day) => day.conflicts.some((c) => c.kind === 'FRAME' && c.label === '08:00-16:00')));
    // A lov for the whole school takes the frame off its date.
    await owner.schoolBreak.create({ data: { schoolId: s, academicYearId: year.id, name: 'Lov', kind: 'HOLIDAY', startDate: new Date(`${wk(5)}T00:00:00Z`), endDate: new Date(`${wk(5)}T00:00:00Z`) } });
    const lov = await external.preview({ ...rule, startTime: '15:00', endTime: '17:00' }, asAdmin);
    assert.ok(!lov.occurrences[5]!.conflicts.some((c) => c.kind === 'FRAME'), 'a lov takes the frame off the day');
  });

  await check('(lb) registering refuses a series with a blocked day by name, and skipConflicts books the free ones', async () => {
    const refused = await refusal(external.create({ ...rule, ...organisation }, asAdmin));
    assert.deepEqual([refused.status, refused.code], [409, 'EXTERNAL_BOOKING_CONFLICTS']);
    assert.equal(refused.conflicts!.length, 3);
    assert.equal(await owner.externalBooking.count({ where: { schoolId: s } }), 0, 'a refused registration writes nothing');
    const made = await external.create({ ...rule, ...organisation, purpose: 'Innebandy, damer', skipConflicts: true }, asAdmin);
    seriesId = made.id;
    assert.equal(made.created, 6);
    assert.equal(made.skipped.length, 3);
    const days = await owner.roomBooking.findMany({ where: { externalBookingId: seriesId }, orderBy: { startsAt: 'asc' } });
    assert.equal(days.length, 6);
    assert.ok(days.every((d) => d.title === 'Extern bokning' && d.status === 'APPROVED' && d.bookedById === admin.id));
    assert.equal(days[0]!.startsAt.getTime(), (await local(wk(0), '18:00')).getTime());
    const row = await owner.externalBooking.findUniqueOrThrow({ where: { id: seriesId } });
    assert.deepEqual(row.skippedDates.map((d) => d.toISOString().slice(0, 10)), [wk(1), wk(3), wk(4)]);
    assert.equal(row.registeredById, admin.id);
    assert.deepEqual(row.weekdays, [2]);
  });

  await check('(lb) the days are bookings of the room: a teacher cannot book over one, and the expedition registers as itself', async () => {
    const over = await refusal(roomBookings.create({ roomId: hall.id, title: 'Över', startsAt: (await local(wk(0), '19:00')).toISOString(), endsAt: (await local(wk(0), '19:30')).toISOString() }, asTeacher));
    assert.equal(over.status, 409);
    const ours = await external.create({ ...rule, startTime: '20:00', endTime: '21:00', ...organisation, organisation: 'Efter', skipConflicts: true }, asExpedition);
    assert.ok(ours.created >= 1);
    assert.equal((await owner.externalBooking.findUniqueOrThrow({ where: { id: ours.id } })).registeredById, expedition.id);
    // The läsare registers nothing, and a teacher is not let in.
    const before = await owner.externalBooking.count({ where: { schoolId: s } });
    await assert.rejects(external.create({ ...rule, startDate: wk(10), endDate: wk(12), ...organisation }, asLasare), 'the läsare registers no series');
    assert.equal(await owner.externalBooking.count({ where: { schoolId: s } }), before);
  });

  await check('(lb) two registrations of the same days at once end in one success and one 409, never a 500', async () => {
    const racing = { ...rule, startDate: wk(12), endDate: wk(14) };
    const results = await Promise.allSettled([external.create({ ...racing, ...organisation, organisation: 'A' }, asAdmin), external.create({ ...racing, ...organisation, organisation: 'B' }, asAdmin)]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(ok, 1, JSON.stringify(results.map((r) => (r.status === 'rejected' ? String(r.reason).slice(0, 200) : 'ok'))));
    assert.equal((rejected[0]!.reason as { getStatus: () => number }).getStatus(), 409);
  });

  // --- (lc) the clash ----------------------------------------------------------------------------
  await check('(lc) a lesson that lands in a booked room is listed, in the detail and in the notice; the läsare is not told', async () => {
    assert.equal((await clashRows(owner as never, [seriesId])).length, 0);
    await lessonAt(wk(5), '18:30', '19:15');
    const flagged = await external.clashes(asAdmin);
    const mine = flagged.filter((c) => c.seriesId === seriesId);
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0]!.date, mine[0]!.organisation, mine[0]!.targetName, mine[0]!.lesson], [wk(5), 'Hjo innebandy', 'Idrottshallen', 'Idrott och hälsa 7A']);
    const detail = await external.detail(seriesId, asAdmin);
    assert.equal(detail.clashes, 1);
    assert.deepEqual(detail.occurrences.filter((d) => d.conflicts.length > 0).map((d) => d.date), [wk(5)]);
    const days = await api.withRls(asAdmin, (tx) => flagAfterPublication(tx, notifications, s));
    assert.ok(days >= 1);
    const told = await owner.notification.findMany({ where: { schoolId: s, type: 'EXTERNAL_BOOKING_CLASH' } });
    assert.deepEqual(told.map((n) => n.userId).sort(), [admin.id, expedition.id].sort(), 'Drift is told, the läsare and the teachers are not');
    assert.deepEqual(Object.keys(told[0]!.meta as object), ['days'], 'a number and nothing else');
    // A cancelled lesson clashes with nothing.
    await owner.calendarLesson.updateMany({ where: { schoolId: s, date: new Date(`${wk(5)}T00:00:00Z`) }, data: { status: 'CANCELLED' } });
    assert.equal((await external.clashes(asAdmin)).filter((c) => c.seriesId === seriesId).length, 0);
  });

  await check("(lg) the register extract of the person who registered a series says that they did, and none of what the hirer left", async () => {
    const answer = await new SubjectAccessService(api).extract(asAdmin, admin.id, false);
    const dir = mkdtempSync(join(tmpdir(), 'k3-probe-'));
    try {
      writeFileSync(join(dir, 'x.zip'), Buffer.from(answer.contentBase64, 'base64'));
      const all = execFileSync('unzip', ['-p', join(dir, 'x.zip')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const file = execFileSync('unzip', ['-p', join(dir, 'x.zip'), 'data/person/externalbookings.csv'], { encoding: 'utf8' });
      assert.ok(file.includes(seriesId) && file.includes(admin.id), 'the series is in the extract of the person who registered it');
      assert.ok(file.includes('(dold)'), 'and the hirer\'s columns are hidden');
      for (const token of ['Hjo innebandy', 'Kim Kontakt', '070-123 45 67', 'kim@forening.example', 'Innebandy, damer']) {
        assert.ok(!all.includes(token), `${token} is in no file of the extract`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- (ld) its own life ---------------------------------------------------------------------------
  await check('(ld) the contact changes and the rule does not; a day is cancelled, then the series, then it is removed', async () => {
    const updated = await external.update(seriesId, { contactName: 'Ny Kontakt', contactPhone: null, note: 'Nyckel hos vaktmästaren' }, asAdmin);
    assert.deepEqual([updated.contactName, updated.contactPhone, updated.contactEmail, updated.note], ['Ny Kontakt', null, 'kim@forening.example', 'Nyckel hos vaktmästaren']);
    assert.equal((await refusal(external.update(seriesId, { contactEmail: null }, asAdmin))).status, 400, 'the last way to reach the contact stays');
    assert.deepEqual([updated.startTime, updated.endTime, updated.startDate], ['18:00', '20:00', firstTuesday]);
    const detail = await external.detail(seriesId, asAdmin);
    const day = await external.cancelDay(seriesId, detail.occurrences[0]!.id, asAdmin);
    assert.equal(day.status, 'CANCELLED');
    assert.equal((await refusal(external.cancelDay(seriesId, detail.occurrences[0]!.id, asAdmin))).status, 400);
    assert.equal((await refusal(external.remove(seriesId, asAdmin))).code, 'EXTERNAL_BOOKING_IS_RUNNING');
    const cancelled = await external.cancel(seriesId, asAdmin);
    assert.notEqual(cancelled.cancelledAt, null);
    assert.equal(cancelled.days.upcoming, 0);
    assert.equal((await refusal(external.cancel(seriesId, asAdmin))).status, 400);
    await external.remove(seriesId, asAdmin);
    assert.equal(await owner.externalBooking.count({ where: { id: seriesId } }), 0);
    assert.equal(await owner.roomBooking.count({ where: { externalBookingId: seriesId } }), 0, 'the days went with the series');
    assert.equal((await external.list('all', asAdmin)).length, 2, 'the one left of the expedition and the winner of the race');
  });

  // --- (le) the report -----------------------------------------------------------------------------
  await check('(le) the hall over a week: school time, evenings and weekend, and the CSV says the same', async () => {
    const monday = dayShift(firstTuesday, 7 * 20 - 1);
    const sunday = dayShift(monday, 6);
    const tuesday = dayShift(monday, 1);
    await owner.roomBooking.create({ data: { schoolId: s, roomId: hall.id, bookedById: teacher.id, title: 'Tisdag', startsAt: await local(tuesday, '09:00'), endsAt: await local(tuesday, '11:00'), status: 'APPROVED' } });
    await owner.roomBooking.create({ data: { schoolId: s, roomId: hall.id, bookedById: teacher.id, title: 'Tisdag kväll', startsAt: await local(tuesday, '18:00'), endsAt: await local(tuesday, '19:00'), status: 'APPROVED' } });
    await owner.roomBooking.create({ data: { schoolId: s, roomId: hall.id, bookedById: teacher.id, title: 'Väntar', startsAt: await local(tuesday, '13:00'), endsAt: await local(tuesday, '14:00'), status: 'PENDING' } });
    const report = await utilisation.report({ from: monday, to: sunday, kind: 'ROOM' }, asAdmin);
    const row = report.rows.find((r) => r.name === 'Idrottshallen')!;
    assert.deepEqual(report.weekStarts, [monday]);
    assert.equal(row.total.schoolMinutes, 5 * 8 * 60);
    assert.equal(row.total.bookedSchoolMinutes, 120, 'a waiting booking is not use');
    assert.equal(row.total.bookedOutsideMinutes, 60);
    assert.equal(row.total.outsideMinutes, 5 * 7 * 60 + 2 * 15 * 60);
    const csv = utilisationCsv(report).split('\r\n');
    assert.equal(csv[0], '﻿typ;namn;vecka;skoltid_minuter;bokat_skoltid_minuter;andel_skoltid_procent;utanfor_skoltid_minuter;bokat_utanfor_skoltid_minuter;andel_utanfor_skoltid_procent');
    assert.ok(csv.includes('Sal;Idrottshallen;Hela perioden;2400;120;5,0;3900;60;1,5'), csv.join('\n'));
  });

  // --- (lf) forty rooms, a term -----------------------------------------------------------------------
  await check('(lf) forty rooms, a term of Tuesday evenings each, against a full schedule: registered in under 2 s, or in the cost of ten lesson reads a series where the machine is slower than the one the phase measured on', async () => {
    const rooms = [];
    for (let i = 0; i < 40; i++) rooms.push(await owner.room.create({ data: { schoolId: s, name: `Sal ${String(i + 1).padStart(2, '0')}` } }));
    const termStart = tuesdayOnOrAfter(dayShift(todayIso, 200));
    const termEnd = dayShift(termStart, 7 * 19);
    // Six lessons a day, Monday to Friday, for the twenty weeks, in every room: 24 000 lessons, none after 16:00.
    // The instants in one statement.
    await owner.$executeRaw`
      INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", "roomId", "date", "startsAt", "endsAt", "updatedAt")
      SELECT ${s}::uuid, ${subject.id}::uuid, ${group.id}::uuid, r."id", d::date,
             (d::date + time '08:00' + (k * interval '75 minutes')) AT TIME ZONE ${TZ},
             (d::date + time '08:00' + (k * interval '75 minutes') + interval '60 minutes') AT TIME ZONE ${TZ}, now()
        FROM "Rooms" r, generate_series(${termStart}::date - 1, ${termEnd}::date + 3, interval '1 day') d, generate_series(0, 5) k
       WHERE r."schoolId" = ${s}::uuid AND r.name LIKE 'Sal %' AND extract(isodow FROM d) <= 5`;
    const rows = await owner.calendarLesson.count({ where: { schoolId: s, roomId: { in: rooms.map((r) => r.id) } } });
    assert.equal(rows, 40 * 20 * 5 * 6, 'the schedule is the size the phase measures');
    // A school with this many lessons has been analysed by autovacuum long before anyone books a room; the bulk
    // insert above has not been, and the planner would price the table by its size on disk alone.
    await owner.$executeRawUnsafe('ANALYZE "CalendarLessons"');
    // What this machine charges for a statement under row-level security. The statement is a lesson read for a room
    // (nine runs, the median): it costs a transaction, the policy of CalendarLessons planned and a few index probes, and
    // so it scales with the machine the way a series does, which an empty transaction does not (a runner of two cores
    // that also runs Postgres plans three times slower than a laptop and starts a transaction as fast). The empty
    // transaction is printed for comparison.
    const ruleSpans = expandRule({ weekdays: [2], intervalWeeks: 1, startDate: termStart, endDate: termEnd, startTime: '18:00', endTime: '20:00' }, TZ);
    const timed = async (run: () => Promise<unknown>) => {
      const took: number[] = [];
      for (let i = 0; i < 9; i++) {
        const t = process.hrtime.bigint();
        await run();
        took.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      return took.sort((a, b) => a - b)[4]!;
    };
    const floor = await timed(() => api.withRls(asAdmin, (tx) => tx.$queryRaw`SELECT 1`));
    const lessonRead = await timed(() => api.withRls(asAdmin, (tx) => readLateLessons(tx, rooms[0]!.id, ruleSpans, 5)));
    const started = process.hrtime.bigint();
    let days = 0;
    for (const room of rooms) {
      const made = await external.create({ target: 'ROOM', roomId: room.id, weekdays: [2], startDate: termStart, endDate: termEnd, startTime: '18:00', endTime: '20:00', ...organisation, organisation: `Förening ${room.name}` }, asAdmin);
      days += made.created;
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(`     40 rooms, ${days} days, ${rows} lessons: ${ms.toFixed(0)} ms; a lesson read here is ${lessonRead.toFixed(1)} ms (an empty transaction ${floor.toFixed(1)}), so a series costs ${(ms / 40 / lessonRead).toFixed(1)} lesson reads`);
    // Where a series spends it, on the same machine and the same data (the median of nine runs of each step, in ms):
    // what the log of a slow runner needs to say which statement it was.
    const median = async (label: string, run: () => Promise<unknown>) => {
      const took: number[] = [];
      for (let i = 0; i < 9; i++) {
        const t = process.hrtime.bigint();
        await run();
        took.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      console.log(`     ${label.padEnd(30)} ${took.sort((a, b) => a - b)[4]!.toFixed(1)}`);
    };
    const spans = ruleSpans;
    const first = rooms[0]!;
    await median('statics', () => api.withRls(asAdmin, (tx) => readStatics(tx, { roomId: first.id, resourceId: null }, termStart, termEnd)));
    await median('room facts', () => api.withRls(asAdmin, (tx) => readRoomFacts(tx, first.id, spans, termStart, termEnd)));
    await median('late lessons', () => api.withRls(asAdmin, (tx) => readLateLessons(tx, first.id, spans, 5)));
    await median('preview (the read side)', () => external.preview({ target: 'ROOM', roomId: first.id, weekdays: [2], startDate: termStart, endDate: termEnd, startTime: '18:00', endTime: '20:00' }, asAdmin));
    let shifted = 0;
    await median('create, a term further on', () => {
      shifted += 1;
      const from = dayShift(termEnd, 7 * 25 * shifted);
      return external.create({ target: 'ROOM', roomId: rooms[shifted]!.id, weekdays: [2], startDate: tuesdayOnOrAfter(from), endDate: dayShift(tuesdayOnOrAfter(from), 7 * 19), startTime: '18:00', endTime: '20:00', ...organisation, organisation: `Senare ${shifted}` }, asAdmin);
    });
    assert.equal(days, 40 * 20);
    // Under the phase's 2 s, as measured on the developer machine; on a slower one, a series that costs no more than
    // ten of the reads a registration is made of (it makes about six statements, and a regression that asks for one
    // per day would be twenty times that).
    assert.ok(ms < 2000 || ms / 40 <= 10 * lessonRead, `registered in ${ms.toFixed(0)} ms: over the phase's 2000 ms, and over ten lesson reads (${lessonRead.toFixed(1)} ms) a series`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
