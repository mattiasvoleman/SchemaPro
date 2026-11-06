/**
 * Hela skolans data against a real database, as the API role under RLS,
 * through the real services (round 9, K5).
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-school-export.ts
 *
 * The jest specs cover the rules with the database faked; this is what they
 * cannot see: row security on every read the build makes, the unique key that
 * allows one order in hand, the job's lease, the pieces stored and read back,
 * the läslogg row a fetch writes, and a zip the system's unzip accepts.
 *
 * TWO SCHOOLS. A and B are built here, each with its own people, groups,
 * lessons, attendance, absence, leave and notices, and B has the same e-mail
 * address as one of A's. An export ordered at A is built, fetched and read:
 *
 *   (k-a)  it holds A's rows and not one of B's: every id and every address
 *          of B is searched for in every file of the archive, and every row
 *          of every table of B is counted against A's file;
 *   (k-b)  the archive is a zip the system's unzip accepts, the manifest's
 *          SHA-256 of each file is the file's, and the stored pieces are the
 *          file the row says;
 *   (k-c)  a marked person (skyddad identitet) is in no file, nor any row
 *          about them, and a protected recorder is a blank cell, counted;
 *   (k-d)  who may order: rektor and a full administrator; a schemaläggare,
 *          the expedition and a läsare are refused by the gateway, and their
 *          own insert is refused by the row-level security;
 *   (k-e)  one order in hand per school, and no fourth in a day;
 *   (k-f)  the fetch is recorded in the läslogg before the first byte, per
 *          kind, and is time-limited: past its expiry the pieces cannot be
 *          read, the job deletes them, and the order says EXPIRED;
 *   (k-g)  an order whose person has been demoted since is FAILED, and an
 *          export withdrawn while it runs stops writing;
 *   (k-h)  a RUNNING export whose heartbeat is stale is taken over and
 *          built again from nothing;
 *   (k-i)  a registerutdrag of a pupil with their guardian is the same files for two persons: the
 *          pupil's rows and the guardian's and no other pupil's, none of B's, a protected related
 *          person held out and counted, a protected person's own extract with no one else, a
 *          teacher's with the post and the lessons, and each recorded in the läslogg;
 *   (k-j)  who may ask for one: the same two profiles, and not across schools;
 *   (k-l)  a protected person's extract names nobody else: the id and the address of every
 *          other user of the school is searched for in every file, with and without the
 *          guardians asked for, for a protected pupil and a protected teacher;
 *   (k-m)  a teacher who decided a pupil's leave gets the decision, not the pupil's id, address
 *          or reason, nor the guardian's; a guardian alone, the same for the child; a teacher who
 *          marked pupils found in a drill gets the act in the crisis tables and not the pupils, nor
 *          a note that names one, and no file of the extract holds any pupil or guardian;
 *   (k-n)  free text that names a protected person, by id or full name, is empty in the
 *          school's file and in another person's extract, and counted;
 *   (k-o)  the history that keeps a person without a key to Users (a guardian link that was
 *          cut, who set a mark) is in the extract, and the catalogue holds no person column
 *          without a key that the extract has not decided;
 *   (k-p)  a lesson held by someone who is neither teacher nor administrator by role is in the
 *          grundschema with the holder named, and with a protected holder it is without them in
 *          every file of the school's export, said in the README, the manifest and the order.
 *
 * Cleans up after itself: the two schools (everything in them goes with them).
 * The läslogg rows a fetch leaves are append-only and go with their school.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import { FamilyReadsService } from '../../src/family/family-reads.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { ScheduleExchangeService } from '../../src/schedule-exchange/exchange.service';
import { SchoolExportJob } from '../../src/school-export/school-export.job';
import { SubjectAccessService } from '../../src/school-export/subject-access.service';
import { NOT_A_USER, SUBJECT_ACCESS, WITHOUT_KEY, WITHOUT_SCHOOL_COLUMN, tableFiles } from '../../src/school-export/person-tables';
import { MAX_ORDERS_PER_DAY, SchoolExportService } from '../../src/school-export/school-export.service';

type Owner = PrismaClient;

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

const time = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00.000Z`);

interface Built {
  schoolId: string;
  slug: string;
  yearId: string;
  admins: Record<'FULL' | 'REKTOR' | 'SCHEMALAGGARE' | 'EXPEDITION' | 'LASARE', AuthenticatedUser>;
  teacher: string;
  students: Array<{ id: string; email: string }>;
  guardians: Array<{ id: string; email: string }>;
  /** Every id and address a file of the other school must never contain. */
  tokens: string[];
  counts: { attendance: number; absences: number; leaves: number; notices: number };
}

const PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'] as const;

/** A school with a class, people, lessons a fortnight back and the rows the export holds. */
async function makeSchool(owner: Owner, label: 'A' | 'B', tag: string, students: number): Promise<Built> {
  const slug = `k5-${label.toLowerCase()}-${tag}`;
  const school = await owner.school.create({ data: { name: `Probeskola ${label} ${tag}`, slug, timezone: 'Europe/Stockholm' } });
  const year = await owner.academicYear.create({
    data: { schoolId: school.id, name: `2026/27-${label}`, startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), gradeNumbering: 'NIOARIG', isActive: true },
  });
  const email = (name: string) => `${name}@${slug}.example.com`;
  const person = (name: string, role: 'SCHOOL_ADMIN' | 'TEACHER' | 'STUDENT' | 'GUARDIAN', extra: Record<string, unknown> = {}) =>
    owner.user.create({
      data: { schoolId: school.id, authId: randomUUID(), role, firstName: name, lastName: `Efternamn${label}`, email: email(name.toLowerCase()), ...extra },
    });

  const admins = {} as Built['admins'];
  const tokens: string[] = [slug];
  for (const profile of PROFILES) {
    const row = await person(`Admin${profile}`, 'SCHOOL_ADMIN', { adminProfile: profile, hrRead: profile === 'FULL' || profile === 'REKTOR' });
    admins[profile] = { authId: row.authId, role: Role.SCHOOL_ADMIN, userId: row.id, schoolId: school.id, adminProfile: profile, hrRead: row.hrRead, channel: 'OTHER' };
    tokens.push(row.id, row.email);
  }
  const roomType = await owner.roomType.create({ data: { schoolId: school.id, name: `Klassrum ${label}` } });
  const subject = await owner.subject.create({ data: { schoolId: school.id, name: `Matematik ${label}`, code: `MA${label}`, requiredRoomTypeId: roomType.id } });
  const group = await owner.studentGroup.create({
    data: { schoolId: school.id, academicYearId: year.id, name: `7${label}`, kind: 'CLASS', gradeLevel: 7 },
  });
  const teacher = await person('Lärare', 'TEACHER');
  await owner.teacherEmployment.create({
    data: { schoolId: school.id, userId: teacher.id, academicYearId: year.id, employmentPercent: 100, reductionPercent: 0, contractKind: 'FERIE', signature: `LA${label}` },
  });
  tokens.push(teacher.id, teacher.email);

  const kids: Built['students'] = [];
  const guardians: Built['guardians'] = [];
  for (let i = 1; i <= students; i += 1) {
    // School B's first pupil has the SAME address as school A's: the address key is per school.
    const row = await person(`Elev${i}`, 'STUDENT', { studentGroupId: group.id });
    const guardian = await person(`Vardnadshavare${i}`, 'GUARDIAN');
    await owner.guardianStudent.create({ data: { schoolId: school.id, guardianId: guardian.id, studentId: row.id } });
    kids.push({ id: row.id, email: row.email });
    guardians.push({ id: guardian.id, email: guardian.email });
    tokens.push(row.id, guardian.id);
  }
  await owner.studentGroupMember.createMany({ data: kids.map((kid) => ({ schoolId: school.id, studentGroupId: group.id, studentId: kid.id })) });
  await owner.teachingRequirement.create({
    data: { schoolId: school.id, academicYearId: year.id, studentGroupId: group.id, subjectId: subject.id, teacherId: teacher.id, lessonsPerWeek: 2, minutesPerLesson: 60 },
  });

  let attendance = 0;
  const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
  const statuses = ['PRESENT', 'ABSENT', 'LATE', 'EXCUSED'] as const;
  for (const day of days) {
    const lesson = await owner.calendarLesson.create({
      data: { schoolId: school.id, subjectId: subject.id, studentGroupId: group.id, date: new Date(day), startsAt: time(day, '07:00'), endsAt: time(day, '08:00') },
    });
    tokens.push(lesson.id);
    await owner.attendanceRecord.createMany({
      data: kids.map((kid, index) => ({
        schoolId: school.id, calendarLessonId: lesson.id, studentId: kid.id, status: statuses[(index + days.indexOf(day)) % 4]!,
        recordedById: teacher.id, recordedAt: time(day, '07:05'), note: index === 0 ? `Anteckning ${label}` : null,
      })),
    });
    attendance += kids.length;
  }
  for (const [index, kid] of kids.entries()) {
    await owner.absenceReport.create({
      data: { schoolId: school.id, studentId: kid.id, reportedById: guardians[index]!.id, date: new Date('2026-10-05'), type: 'SICK', note: `Sjuk ${label}${index}` },
    });
  }
  await owner.leaveRequest.create({
    data: {
      schoolId: school.id, studentId: kids[0]!.id, requestedById: guardians[0]!.id, startDate: new Date('2026-11-02'), endDate: new Date('2026-11-03'),
      reason: `Släktbesök ${label}`, status: 'APPROVED', decidedById: admins.FULL.userId!, decidedAt: time('2026-10-20', '09:00'), decidedAs: 'ADMIN',
    },
  });
  for (const guardian of guardians) {
    await owner.notification.create({ data: { schoolId: school.id, userId: guardian.id, type: 'LEAVE_DECIDED', meta: { note: `Notis ${label}` } } });
  }
  return {
    schoolId: school.id, slug, yearId: year.id, admins, teacher: teacher.id, students: kids, guardians,
    tokens: [...tokens, ...kids.map((kid) => kid.email), ...guardians.map((g) => g.email)],
    counts: { attendance, absences: kids.length, leaves: 1, notices: guardians.length },
  };
}

/** Reads every file of a zip into memory with the system's unzip (which checks every CRC). */
function unzip(bytes: Buffer): { dir: string; files: Map<string, Buffer> } {
  const dir = mkdtempSync(join(tmpdir(), 'k5-probe-'));
  writeFileSync(join(dir, 'x.zip'), bytes);
  const test = execFileSync('unzip', ['-t', join(dir, 'x.zip')], { encoding: 'utf8' });
  assert.match(test, /No errors detected/, 'the system unzip accepts the archive');
  execFileSync('unzip', ['-o', '-q', join(dir, 'x.zip'), '-d', join(dir, 'out')]);
  const files = new Map<string, Buffer>();
  const walk = (base: string, prefix: string) => {
    for (const name of readdirSync(base)) {
      const path = join(base, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else files.set(`${prefix}${name}`, readFileSync(path));
    }
  };
  walk(join(dir, 'out'), '');
  return { dir, files };
}

async function fetchFile(service: SchoolExportService, id: string, user: AuthenticatedUser): Promise<Buffer> {
  const opened = await service.openFile(id, user);
  const parts: Buffer[] = [];
  for await (const piece of opened.pieces()) parts.push(piece);
  const bytes = Buffer.concat(parts);
  assert.equal(bytes.length, opened.byteSize, 'the pieces add up to the length the row says');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), opened.sha256, "the SHA-256 is the file's");
  return bytes;
}

async function runJobUntilIdle(job: SchoolExportJob): Promise<void> {
  for (let pass = 0; pass < 4; pass += 1) await job.tick();
}

const csvLines = (buffer: Buffer | undefined): string[] =>
  (buffer?.toString('utf8') ?? '').replace(/^﻿/, '').split('\r\n').filter((line) => line !== '');

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
  const masterLessons = new MasterLessonsService(api, realtime, {} as NotificationsService);
  const exchange = new ScheduleExchangeService(api, realtime, masterLessons);
  const family = new FamilyReadsService(api);
  const service = new SchoolExportService(api);
  const job = new SchoolExportJob(api, family, exchange);
  const access = new SubjectAccessService(api);

  const tag = randomUUID().slice(0, 8);
  const cleanup: Array<() => Promise<void>> = [];
  try {
    const a = await makeSchool(owner, 'A', tag, 6);
    const b = await makeSchool(owner, 'B', tag, 4);
    cleanup.push(async () => void (await owner.school.deleteMany({ where: { id: { in: [a.schoolId, b.schoolId] } } })));
    // The same address in both schools: the key is per school. B's person is not A's, so A's file holds the address
    // for A's person only, and B's id for it is searched for like any other of B's tokens.
    await owner.user.update({ where: { id: b.students[0]!.id }, data: { email: a.students[0]!.email } });

    // A's pupil 2 has a protected identity; its recorder is a protected teacher in an extra lesson.
    const protectedPupil = a.students[1]!;
    await owner.personProtection.create({ data: { userId: protectedPupil.id, schoolId: a.schoolId, source: 'MANUAL' } });
    const protectedTeacher = await owner.user.create({
      data: { schoolId: a.schoolId, authId: randomUUID(), role: 'TEACHER', firstName: 'Skyddad', lastName: 'Lärare', email: `skyddad@${a.slug}.example.com` },
    });
    await owner.personProtection.create({ data: { userId: protectedTeacher.id, schoolId: a.schoolId, source: 'MANUAL' } });
    const someAttendance = await owner.attendanceRecord.findFirstOrThrow({ where: { schoolId: a.schoolId, studentId: a.students[2]!.id } });
    await owner.attendanceRecord.update({ where: { id: someAttendance.id }, data: { recordedById: protectedTeacher.id } });

    let first!: { id: string; bytes: Buffer; files: Map<string, Buffer> };

    await check('(k-a) an order by a full administrator is built into a file of A and not one row of B', async () => {
      const order = await service.order(a.admins.FULL);
      assert.equal(order.status, 'QUEUED');
      await runJobUntilIdle(job);
      const [row] = (await service.list(a.admins.FULL)).filter((o) => o.id === order.id);
      assert.equal(row!.status, 'READY', `the export is READY (was ${row!.status} ${row!.errorClass ?? ''})`);
      assert.equal(row!.fetchable, true);
      const bytes = await fetchFile(service, order.id, a.admins.FULL);
      const { dir, files } = unzip(bytes);
      cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
      first = { id: order.id, bytes, files };
      if (process.env['PROBE_KEEP_ZIP']) writeFileSync(process.env['PROBE_KEEP_ZIP'], bytes);
      for (const [name, content] of files) {
        const text = content.toString('utf8');
        for (const token of b.tokens) assert.ok(!text.includes(token), `${name} holds B's ${token}`);
      }
      // A's rows, all of them, as the tables hold them.
      assert.equal(csvLines(files.get('data/narvaro.csv')).length - 1, a.counts.attendance - 5 /* the protected pupil's five */);
      assert.equal(csvLines(files.get('data/franvaroanmalningar.csv')).length - 1, a.counts.absences - 1);
      assert.equal(csvLines(files.get('data/ledigheter.csv')).length - 1, 1);
      assert.equal(csvLines(files.get('data/notiser.csv')).length - 1, a.counts.notices);
      for (const name of ['csv/amnen.csv', 'csv/elever.csv', 'csv/larare.csv', 'csv/klasser.csv', 'csv/salstyper.csv', 'csv/timplansposter.csv', 'README.txt', 'FORMAT.md', 'manifest.json']) {
        assert.ok(files.has(name), `the archive holds ${name}`);
      }
    });

    await check("(k-b) the manifest's SHA-256 is each file's, and the export's row says what the archive holds", async () => {
      const manifest = JSON.parse(first.files.get('manifest.json')!.toString('utf8')) as { files: Array<{ path: string; sha256: string; byte: number }> };
      for (const entry of manifest.files) {
        const content = first.files.get(entry.path);
        assert.ok(content, `${entry.path} is in the archive`);
        assert.equal(createHash('sha256').update(content).digest('hex'), entry.sha256, `${entry.path}'s SHA-256`);
        assert.equal(content.length, entry.byte, `${entry.path}'s length`);
      }
      const row = await owner.schoolExport.findUniqueOrThrow({ where: { id: first.id } });
      assert.equal(Number(row.byteSize), first.bytes.length);
      assert.equal(await owner.schoolExportChunk.count({ where: { exportId: first.id } }), row.chunkCount);
    });

    await check('(k-c) a marked person is in no file, and a protected recorder is a counted blank', async () => {
      for (const [name, content] of first.files) {
        const text = content.toString('utf8');
        assert.ok(!text.includes(protectedPupil.id) && !text.includes(protectedPupil.email), `${name} names the protected pupil`);
        assert.ok(!text.includes(protectedTeacher.id) && !text.includes(protectedTeacher.email), `${name} names the protected teacher`);
      }
      const manifest = JSON.parse(first.files.get('manifest.json')!.toString('utf8')) as {
        heldOut: { skyddadIdentitetPersoner: number; kopplingar: number };
        files: Array<{ path: string; utelamnadeRader?: number; tommaCeller?: number }>;
      };
      assert.equal(manifest.heldOut.skyddadIdentitetPersoner, 2);
      assert.equal(manifest.heldOut.kopplingar, 1, "the protected pupil's guardian link");
      const narvaro = manifest.files.find((f) => f.path === 'data/narvaro.csv')!;
      assert.equal(narvaro.utelamnadeRader, 5);
      assert.equal(narvaro.tommaCeller, 1, 'one mark recorded by the protected teacher');
      const row = await owner.schoolExport.findUniqueOrThrow({ where: { id: first.id } });
      assert.deepEqual(row.heldOut, { people: 2, links: 1 });
    });

    await check('(k-d) a schemaläggare, the expedition and a läsare cannot order; rektor can', async () => {
      for (const profile of ['SCHEMALAGGARE', 'EXPEDITION', 'LASARE'] as const) {
        await assert.rejects(() => service.order(a.admins[profile]), /Hela skolans data hämtas/, `${profile} is refused by the service`);
        await assert.rejects(() => service.list(a.admins[profile]), /Hela skolans data hämtas/);
        // And by the row security alone, past the gateway:
        await assert.rejects(
          () => api.withRls(a.admins[profile], (tx) => tx.schoolExport.create({ data: { schoolId: a.schoolId, requestedById: a.admins[profile].userId! } })),
          `${profile}'s own insert is refused by the arms`,
        );
        const seen = await api.withRls(a.admins[profile], (tx) => tx.schoolExport.count());
        assert.equal(seen, 0, `${profile} reads no export`);
        const pieces = await api.withRls(a.admins[profile], (tx) => tx.schoolExportChunk.count());
        assert.equal(pieces, 0, `${profile} reads no piece`);
      }
      // Rektor decides: may order, and may fetch the full administrator's file.
      const bytes = await fetchFile(service, first.id, a.admins.REKTOR);
      assert.equal(bytes.length, first.bytes.length);
      // Not B's administrator: B sees none of A's.
      assert.equal((await service.list(b.admins.FULL)).length, 0, "B's administrator lists none of A's orders");
      await assert.rejects(() => service.openFile(first.id, b.admins.FULL), /finns inte/);
    });

    await check('(k-e) one order in hand per school, and no fourth in a day', async () => {
      const second = await service.order(a.admins.REKTOR);
      await assert.rejects(() => service.order(a.admins.FULL), /pågår redan/);
      await runJobUntilIdle(job);
      const third = await service.order(a.admins.FULL);
      await runJobUntilIdle(job);
      assert.ok(third.id && second.id);
      await assert.rejects(() => service.order(a.admins.FULL), (error: { status?: number }) => error.status === 429);
      assert.equal(MAX_ORDERS_PER_DAY, 3);
    });

    await check('(k-f) a fetch is recorded in the läslogg before the first byte, and the file is time-limited', async () => {
      const before = await owner.personalDataAccess.count({ where: { schoolId: a.schoolId, actorId: a.admins.REKTOR.userId! } });
      const second = (await service.list(a.admins.FULL)).find((o) => o.id !== first.id && o.fetchable)!;
      const opened = await service.openFile(second.id, a.admins.REKTOR);
      const rows = await owner.personalDataAccess.findMany({ where: { schoolId: a.schoolId, actorId: a.admins.REKTOR.userId! } });
      assert.ok(rows.length > before, 'the open itself wrote läslogg rows, before any piece was read');
      const kinds = new Set(rows.map((row) => row.kind));
      for (const kind of ['PEOPLE', 'ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'GUARDIANS']) assert.ok(kinds.has(kind as never), `${kind} is recorded`);
      const attendanceRow = rows.find((row) => row.kind === 'ATTENDANCE')!;
      assert.ok(!attendanceRow.subjectIds.includes(protectedPupil.id), 'a marked person is not named in the record');
      assert.ok(attendanceRow.subjectIds.includes(a.students[0]!.id), 'an unmarked pupil is');
      void opened;
      // Past its time: the pieces cannot be read, even before the job runs.
      await owner.$executeRaw`UPDATE "SchoolExports" SET "expiresAt" = clock_timestamp() - interval '1 minute' WHERE "id" = ${second.id}::uuid`;
      await assert.rejects(() => service.openFile(second.id, a.admins.FULL), /gått ut/);
      const readable = await api.withRls(a.admins.FULL, (tx) => tx.schoolExportChunk.count({ where: { exportId: second.id } }));
      assert.equal(readable, 0, 'the row security hides the pieces of an expired file');
      assert.ok((await owner.schoolExportChunk.count({ where: { exportId: second.id } })) > 0, 'still stored until the job runs');
      await job.tick();
      assert.equal(await owner.schoolExportChunk.count({ where: { exportId: second.id } }), 0, 'the job deleted the pieces');
      const row = await owner.schoolExport.findUniqueOrThrow({ where: { id: second.id } });
      assert.equal(row.status, 'EXPIRED');
      assert.equal(row.readAbout, null, 'and the list of persons');
    });

    await check('(k-g) an order by someone demoted since fails; an export withdrawn while it runs stops', async () => {
      // Make room under the day's limit without touching the others: delete the oldest finished orders as the owner.
      await owner.schoolExport.deleteMany({ where: { schoolId: a.schoolId, id: { not: first.id } } });
      const order = await service.order(a.admins.REKTOR);
      await owner.user.update({ where: { id: a.admins.REKTOR.userId! }, data: { adminProfile: 'EXPEDITION' } });
      await runJobUntilIdle(job);
      const row = await owner.schoolExport.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, 'FAILED');
      assert.equal(row.errorClass, 'RequesterGone');
      assert.equal(await owner.schoolExportChunk.count({ where: { exportId: order.id } }), 0);
      await owner.user.update({ where: { id: a.admins.REKTOR.userId! }, data: { adminProfile: 'REKTOR' } });

      // Withdrawn while running: the heartbeat finds the row gone.
      await owner.schoolExport.deleteMany({ where: { schoolId: a.schoolId, id: { not: first.id } } });
      const withdrawn = await service.order(a.admins.FULL);
      const [claim] = await owner.$queryRaw<Array<{ export_id: string; school_id: string; user_id: string; auth_id: string; admin_profile: 'FULL'; hr_read: boolean; attempt: number }>>`
        SELECT * FROM app.school_export_claim(interval '3 minutes')`;
      assert.equal(claim!.export_id, withdrawn.id);
      await service.withdraw(withdrawn.id, a.admins.FULL);
      await assert.rejects(() => job.build(claim!), /no longer this job/);
      assert.equal(await owner.schoolExportChunk.count({ where: { exportId: withdrawn.id } }), 0);
    });

    await check("(k-h) a RUNNING export whose heartbeat is stale is taken over and built again", async () => {
      await owner.schoolExport.deleteMany({ where: { schoolId: a.schoolId, id: { not: first.id } } });
      const order = await service.order(a.admins.FULL);
      const [claim] = await owner.$queryRaw<Array<{ export_id: string }>>`SELECT * FROM app.school_export_claim(interval '3 minutes')`;
      assert.equal(claim!.export_id, order.id);
      await owner.$executeRaw`SELECT app.school_export_put(${order.id}::uuid, 0, ${Buffer.from('half a file')}::bytea)`;
      // Fresh heartbeat: nobody else takes it. Stale: the next claim does, and starts from nothing.
      const [none] = await owner.$queryRaw<Array<{ export_id: string }>>`SELECT * FROM app.school_export_claim(interval '3 minutes')`;
      assert.equal(none, undefined);
      await owner.$executeRaw`UPDATE "SchoolExports" SET "heartbeatAt" = clock_timestamp() - interval '10 minutes' WHERE "id" = ${order.id}::uuid`;
      await runJobUntilIdle(job);
      const row = await owner.schoolExport.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, 'READY');
      assert.equal(row.attempts, 2);
      const bytes = await fetchFile(service, order.id, a.admins.FULL);
      assert.ok(!bytes.includes(Buffer.from('half a file')));
    });

    await check('(k-i0) every table an extract dumps exists, has a schoolId unless listed, and an administrator reads it', async () => {
      const rows = await owner.$queryRaw<Array<{ table: string; school: boolean; grant: boolean }>>`
        SELECT c.relname AS "table", bool_or(a.attname = 'schoolId') AS school,
               has_table_privilege('app_authenticated', c.oid, 'SELECT') AS "grant"
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE c.relname = ANY(${tableFiles().map((file) => file.table)}::text[]) AND c.relkind = 'r'
         GROUP BY c.relname, c.oid`;
      const have = new Map(rows.map((row) => [row.table, row]));
      for (const file of tableFiles()) {
        const row = have.get(file.table);
        assert.ok(row, `${file.table} is a table`);
        assert.ok(row.grant, `the API role reads ${file.table}`);
        assert.equal(row.school, !WITHOUT_SCHOOL_COLUMN.has(file.table), `${file.table}'s schoolId column against WITHOUT_SCHOOL_COLUMN`);
        // The columns the dump asks for are columns.
        const columns = await owner.$queryRaw<Array<{ name: string }>>`
          SELECT attname AS name FROM pg_attribute WHERE attrelid = ${`public."${file.table}"`}::regclass AND attnum > 0 AND NOT attisdropped`;
        const names = new Set(columns.map((column) => column.name));
        for (const column of [...file.dump.columns, ...(file.dump.inside ?? [])]) assert.ok(names.has(column), `${file.table}.${column} is a column`);
        for (const [column, parent, parentColumn] of file.dump.through ?? []) {
          assert.ok(names.has(column), `${file.table}.${column} is a column`);
          const parentNames = await owner.$queryRaw<Array<{ name: string }>>`
            SELECT attname AS name FROM pg_attribute WHERE attrelid = ${`public."${parent}"`}::regclass AND attnum > 0 AND NOT attisdropped`;
          assert.ok(parentNames.some((p) => p.name === parentColumn), `${parent}.${parentColumn} is a column`);
        }
      }
    });

    await check('(k-i1) no person column without a key to Users is undecided: the catalogue against WITHOUT_KEY and the dumps', async () => {
      const found = await owner.$queryRaw<Array<{ tbl: string; col: string }>>`
        SELECT c.relname AS tbl, a.attname AS col
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid AND c.relkind = 'r'
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
         WHERE a.attnum > 0 AND NOT a.attisdropped
           AND a.atttypid IN ('uuid'::regtype, '_uuid'::regtype, 'jsonb'::regtype)
           AND a.attname ~* '(user|teacher|student|guardian|actor|author|substitute|person|mentor|owner|reviewer|assignee|creator|approver|decider|reporter|requester|recorder|writer|sender|recipient|member|holder|supervisor|principal)ids?$|by(user)?id$|teachers$'
           AND a.attname !~* 'group'
           AND NOT EXISTS (
             SELECT 1 FROM pg_constraint k
              WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confrelid = '"Users"'::regclass AND a.attnum = ANY (k.conkey))`;
      const decided = new Set<string>();
      for (const [table, decision] of Object.entries(SUBJECT_ACCESS)) {
        if ('dump' in decision) for (const column of [...decision.dump.columns, ...(decision.dump.inside ?? []), ...(decision.dump.through ?? []).map(([c]) => c)]) decided.add(`${table}.${column}`);
      }
      for (const [table, columns] of Object.entries(WITHOUT_KEY)) for (const column of columns) decided.add(`${table}.${column}`);
      const undecided = found.map((row) => `${row.tbl}.${row.col}`).filter((name) => !decided.has(name) && !(name in NOT_A_USER));
      assert.deepEqual(undecided, [], 'a person column with no key to Users that the extract has not decided (add it to WITHOUT_KEY and SUBJECT_ACCESS)');
      // And the list is no longer than the catalogue: every column named exists and still has no key.
      const present = new Set(found.map((row) => `${row.tbl}.${row.col}`));
      for (const [table, columns] of Object.entries(WITHOUT_KEY)) {
        for (const column of columns) assert.ok(present.has(`${table}.${column}`), `${table}.${column} is a person column without a key (remove it from WITHOUT_KEY if it has one now)`);
      }
      for (const name of Object.keys(NOT_A_USER)) assert.ok(present.has(name), `${name} is in the catalogue`);
    });

    await check('(k-i) a registerutdrag is the same files for the person, and a protected person is held out', async () => {
      const readLines = (files: Map<string, Buffer>, name: string) => csvLines(files.get(name));
      const extract = async (who: AuthenticatedUser, personId: string, withRelated: boolean) => {
        const answer = await access.extract(who, personId, withRelated);
        const { dir, files } = unzip(Buffer.from(answer.contentBase64, 'base64'));
        cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
        return { answer, files };
      };
      // Pupil 1 with their guardian.
      const pupil = a.students[0]!;
      const guardian = a.guardians[0]!;
      const one = await extract(a.admins.FULL, pupil.id, true);
      assert.equal(one.answer.relatedIncluded, 1);
      assert.equal(one.answer.subjectIsMarked, false);
      assert.deepEqual(readLines(one.files, 'data/personer.csv').slice(1).map((line) => line.split(';')[0]).sort(), [guardian.id, pupil.id].sort());
      assert.equal(readLines(one.files, 'data/narvaro.csv').length - 1, 5, "the pupil's five marks");
      assert.equal(readLines(one.files, 'data/kopplingar.csv').length - 1, 1);
      assert.equal(readLines(one.files, 'data/ledigheter.csv').length - 1, 1, 'the leave the guardian asked for');
      assert.equal(readLines(one.files, 'data/notiser.csv').length - 1, 1, "the guardian's notice");
      assert.ok(one.files.has('data/person/studentgroupmembers.csv'), "the pupil's membership is a table of its own");
      for (const [name, content] of one.files) {
        const text = content.toString('utf8');
        for (const token of b.tokens) assert.ok(!text.includes(token), `${name} holds B's ${token}`);
        for (const other of a.students.slice(2)) assert.ok(!text.includes(other.id), `${name} holds another pupil of A: ${other.id}`);
      }
      // Without the guardian: one person.
      const alone = await extract(a.admins.REKTOR, pupil.id, false);
      assert.equal(alone.answer.relatedIncluded, 0);
      assert.equal(readLines(alone.files, 'data/personer.csv').length - 1, 1);

      // A protected pupil's own extract: their rows, no guardian, no one else, and it says so.
      const own = await extract(a.admins.FULL, protectedPupil.id, true);
      assert.equal(own.answer.subjectIsMarked, true);
      assert.equal(own.answer.relatedIncluded, 0);
      assert.equal(readLines(own.files, 'data/personer.csv').length - 1, 1);
      assert.equal(readLines(own.files, 'data/narvaro.csv').length - 1, 5, "the protected pupil's own marks are theirs");
      assert.match(own.files.get('README.txt')!.toString('utf8'), /Personen har en markering för skyddad identitet/);
      assert.ok(own.files.has('data/person/personprotections.csv'), 'the mark itself is data about them');

      // A marked guardian is held out of the pupil's extract and counted.
      const pupil4 = a.students[3]!;
      const guardian4 = a.guardians[3]!;
      await owner.personProtection.create({ data: { userId: guardian4.id, schoolId: a.schoolId, source: 'MANUAL' } });
      cleanup.push(async () => void (await owner.personProtection.deleteMany({ where: { userId: guardian4.id } })));
      const held = await extract(a.admins.FULL, pupil4.id, true);
      assert.equal(held.answer.relatedHeldOut, 1);
      assert.equal(held.answer.relatedIncluded, 0);
      for (const [name, content] of held.files) assert.ok(!content.toString('utf8').includes(guardian4.id), `${name} names the protected guardian`);

      // A teacher's extract holds the post and the requirement.
      const teacher = await extract(a.admins.FULL, a.teacher, false);
      assert.ok(teacher.files.has('data/person/teacheremployments.csv'));
      assert.ok(teacher.files.has('data/person/teachingrequirements.csv'));
      assert.match(teacher.files.get('data/person/teacheremployments.csv')!.toString('utf8'), /employmentPercent/);
      const rowsAbout = await owner.personalDataAccess.count({ where: { schoolId: a.schoolId, actorId: a.admins.FULL.userId!, kind: 'EMPLOYMENT', subjectIds: { has: a.teacher } } });
      assert.ok(rowsAbout >= 1, "the extract of the teacher's post is recorded as a read of EMPLOYMENT about them");
    });

    // ---- the third parties of an extract (the review of #269) ------------------------------------------------------
    const extractZip = async (who: AuthenticatedUser, personId: string, withRelated: boolean) => {
      const answer = await access.extract(who, personId, withRelated);
      const { dir, files } = unzip(Buffer.from(answer.contentBase64, 'base64'));
      cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
      const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as { files: Array<{ path: string; tommaCeller?: number }> };
      return { answer, files, emptied: (path: string) => manifest.files.find((file) => file.path === path)?.tommaCeller ?? 0 };
    };
    /** Every file of the archive, searched for the id and the address of each user of school A who is not `allowed`. */
    const assertNames = async (files: Map<string, Buffer>, allowed: string[], label: string) => {
      const others = await owner.user.findMany({ where: { schoolId: a.schoolId, id: { notIn: allowed } }, select: { id: true, email: true } });
      assert.ok(others.length > 10, 'there are users to look for');
      for (const [name, content] of files) {
        const text = content.toString('utf8').toLowerCase();
        for (const other of others) {
          assert.ok(!text.includes(other.id), `${label}: ${name} holds the id of ${other.id}`);
          assert.ok(!text.includes(other.email.toLowerCase()), `${label}: ${name} holds the address ${other.email}`);
        }
      }
    };
    const lineWith = (files: Map<string, Buffer>, name: string, needle: string): string[] | undefined =>
      csvLines(files.get(name)).slice(1).map((line) => line.split(';')).find((cells) => cells.includes(needle));

    // The rows these checks are about: leaves a teacher decided, history that outlives its keys, a note that names.
    const pupilE = a.students[4]!;
    const guardianE = a.guardians[4]!;
    const pupilF = a.students[5]!;
    const guardianF = a.guardians[5]!;
    const sibling = a.students[2]!;
    const siblingGuardian = a.guardians[2]!;
    const leave = (data: Record<string, unknown>) =>
      owner.leaveRequest.create({
        data: { schoolId: a.schoolId, startDate: new Date('2026-11-09'), endDate: new Date('2026-11-10'), status: 'APPROVED', decidedAt: time('2026-10-21', '09:00'), ...data } as never,
      });
    await leave({ studentId: pupilE.id, requestedById: guardianE.id, decidedById: a.teacher, decidedAs: 'MENTOR', reason: 'Känsligt läkarbesök E4', decisionNote: 'Tala med mamma E4' });
    await leave({ studentId: pupilF.id, requestedById: guardianF.id, decidedById: protectedTeacher.id, decidedAs: 'MENTOR', reason: 'Orsak E5' });
    await leave({ studentId: protectedPupil.id, requestedById: a.guardians[1]!.id, decidedById: a.admins.FULL.userId!, decidedAs: 'ADMIN', reason: 'Orsak skyddad' });
    // The history of a cut guardian link is written by the database, when the link is deleted.
    const formerGuardian = await owner.user.create({
      data: { schoolId: a.schoolId, authId: randomUUID(), role: 'GUARDIAN', firstName: 'Tidigare', lastName: 'Vardnadshavare', email: `tidigare@${a.slug}.example.com` },
    });
    for (const kid of [protectedPupil, a.students[0]!]) {
      const link = await owner.guardianStudent.create({ data: { schoolId: a.schoolId, guardianId: formerGuardian.id, studentId: kid.id } });
      await owner.guardianStudent.delete({ where: { id: link.id } });
    }

    // A drill the teacher ran: the teacher marked one pupil found and the protected pupil too, and ended it with a note that names a pupil.
    const crisisGroup = await owner.studentGroup.findFirstOrThrow({ where: { schoolId: a.schoolId, academicYearId: a.yearId } });
    const alarm = await owner.crisisAlarm.create({ data: { schoolId: a.schoolId, kind: 'EVACUATION', mode: 'DRILL', startedByUserId: a.teacher } });
    const call = await owner.crisisCall.create({
      data: { schoolId: a.schoolId, alarmId: alarm.id, basis: 'NO_LESSON', groupName: crisisGroup.name, subjectName: 'Matematik', lessonStartsAt: time('2026-10-06', '07:00'), lessonEndsAt: time('2026-10-06', '08:00') },
    });
    await owner.crisisCallTeacher.create({ data: { schoolId: a.schoolId, callId: call.id, teacherId: a.teacher } });
    for (const pupil of [pupilE, protectedPupil]) {
      await owner.crisisPupil.create({ data: { schoolId: a.schoolId, alarmId: alarm.id, callId: call.id, studentId: pupil.id } });
      await owner.crisisReport.create({
        data: { id: randomUUID(), schoolId: a.schoolId, alarmId: alarm.id, callId: call.id, studentId: pupil.id, state: 'FOUND', at: new Date(), byUserId: a.teacher },
      });
    }
    await owner.crisisAlarm.update({ where: { id: alarm.id }, data: { endedAt: new Date(), endedByUserId: a.teacher, endNote: 'Övning klar, Elev5 EfternamnA kom sist' } });

    await check("(k-l) a protected person's extract names nobody else: not the guardian, the teacher, the reader or the decider", async () => {
      for (const withRelated of [true, false]) {
        const pupil = await extractZip(a.admins.FULL, protectedPupil.id, withRelated);
        await assertNames(pupil.files, [protectedPupil.id], `protected pupil, withRelated=${withRelated}`);
        // What the person is entitled to is still there, with the other party empty and counted.
        const link = lineWith(pupil.files, 'data/kopplingar.csv', protectedPupil.id)!;
        assert.ok(link, 'the link is the pupil\'s own row');
        assert.equal(link[1], '', "the guardian's id is empty");
        assert.equal(link[2], '', "the guardian's address is empty");
        assert.ok(pupil.emptied('data/kopplingar.csv') >= 1 && pupil.emptied('data/narvaro.csv') >= 1 && pupil.emptied('data/franvaroanmalningar.csv') >= 1, 'counted');
        assert.ok(pupil.emptied('data/ledigheter.csv') >= 2, 'the requester and the decider of the leave');
        assert.ok(csvLines(pupil.files.get('data/laslogg.csv')).length > 1, 'the readers are in the läslogg, unnamed');
        assert.ok(csvLines(pupil.files.get('data/laslogg.csv')).slice(1).every((line) => line.split(';')[2] === '' && line.split(';')[3] === ''), 'no reader is named');
        assert.match(pupil.files.get('README.txt')!.toString('utf8'), /ingen annan person pekas ut i det/);
      }
      const teacher = await extractZip(a.admins.FULL, protectedTeacher.id, true);
      await assertNames(teacher.files, [protectedTeacher.id], 'protected teacher');
    });

    await check("(k-m) a teacher who decided a leave gets the decision and not the pupil's id, address or reason; a guardian alone, the same for the child", async () => {
      const teacher = await extractZip(a.admins.FULL, a.teacher, false);
      const decided = lineWith(teacher.files, 'data/ledigheter.csv', a.teacher)!;
      assert.ok(decided, "the leave the teacher decided is in the teacher's extract");
      assert.equal(decided[1], '', "the pupil's id is empty");
      assert.equal(decided[2], '', "the pupil's address is empty");
      assert.equal(decided[3], '', "the guardian's id is empty");
      assert.equal(decided[7], '', 'the reason is empty');
      assert.equal(decided[12], '', "the decision's note is empty");
      assert.ok(decided[8] === 'APPROVED' && decided[13] === 'MENTOR', 'the decision itself stays');
      assert.ok(teacher.emptied('data/ledigheter.csv') >= 4);
      for (const [name, content] of teacher.files) {
        const text = content.toString('utf8');
        for (const secret of [pupilE.id, pupilE.email, guardianE.id, guardianE.email, 'Känsligt läkarbesök E4', 'Tala med mamma E4']) assert.ok(!text.includes(secret), `${name} holds ${secret} in the teacher's extract`);
      }
      // The drill: the teacher's act is there, the pupils and their state are not, and neither is a note that names a pupil.
      const marked = teacher.files.get('data/person/crisispupils.csv');
      const reports = teacher.files.get('data/person/crisisreports.csv');
      assert.ok(marked && reports, 'the crisis tables are in the extract of the teacher who marked pupils found');
      for (const [name, file] of [['crisispupils', marked], ['crisisreports', reports]] as const) {
        const [header, ...rows] = csvLines(file).map((line) => line.split(';'));
        assert.ok(rows.length >= 2, `${name} holds the act of marking`);
        for (const row of rows) {
          assert.equal(row[header!.indexOf('studentId')], '', `${name}: the pupil is empty`);
          assert.equal(row[header!.indexOf('state')], '', `${name}: the pupil's state is empty`);
          assert.ok(row.includes(a.teacher), `${name}: the teacher's own act stays`);
        }
      }
      assert.ok(teacher.emptied('data/person/crisispupils.csv') >= 4 && teacher.emptied('data/person/crisisreports.csv') >= 4, 'counted');
      const alarmFile = teacher.files.get('data/person/crisisalarms.csv')!.toString('utf8');
      assert.ok(alarmFile.includes(a.teacher) && !alarmFile.includes('Övning klar'), 'the teacher started the drill, and the note that names a pupil is empty');
      // No file of the teacher's extract holds any pupil or guardian of the school: id, address or full name (R4-L1).
      const strangers = await owner.user.findMany({ where: { schoolId: a.schoolId, role: { in: ['STUDENT', 'GUARDIAN'] } }, select: { id: true, email: true, firstName: true, lastName: true } });
      assert.ok(strangers.length > 10);
      for (const [name, content] of teacher.files) {
        const text = content.toString('utf8').toLowerCase();
        for (const other of strangers) {
          for (const needle of [other.id, other.email.toLowerCase(), `${other.firstName} ${other.lastName}`.toLowerCase()]) assert.ok(!text.includes(needle), `${name} holds ${needle} in the teacher's extract`);
        }
      }
      // The guardian alone: the leave she asked for, the absence she reported, and nothing of the child's.
      const alone = await extractZip(a.admins.FULL, guardianE.id, false);
      for (const [name, content] of alone.files) {
        const text = content.toString('utf8');
        for (const secret of [a.teacher, 'Känsligt läkarbesök E4', 'Tala med mamma E4', 'Sjuk A4']) assert.ok(!text.includes(secret), `${name} holds ${secret} in the guardian's extract`);
        // Whose guardian she is stays in the link; nothing else of the child's.
        if (name !== 'data/kopplingar.csv') for (const secret of [pupilE.id, pupilE.email]) assert.ok(!text.includes(secret), `${name} holds ${secret} in the guardian's extract`);
      }
      assert.ok(lineWith(alone.files, 'data/ledigheter.csv', 'APPROVED'), 'the leave is still there, as her own act');
      assert.ok(csvLines(alone.files.get('data/franvaroanmalningar.csv')).length > 1, 'and the absence she reported');
      // With the child asked for, the rows are about the child and whole.
      const both = await extractZip(a.admins.FULL, guardianE.id, true);
      const whole = lineWith(both.files, 'data/ledigheter.csv', pupilE.id)!;
      assert.ok(whole && whole.includes('Känsligt läkarbesök E4') && whole.includes('Tala med mamma E4'), 'the child\'s own leave is whole in the child\'s extract');
    });

    await check('(k-n) free text that names a protected person is empty, in the school\'s file and in another person\'s extract, and counted', async () => {
      const name = 'Elev2 EfternamnA';
      const teacherName = 'Skyddad Lärare';
      const records = await owner.attendanceRecord.findMany({ where: { schoolId: a.schoolId, studentId: sibling.id }, orderBy: { recordedAt: 'asc' }, take: 3 });
      await owner.attendanceRecord.update({ where: { id: records[0]!.id }, data: { note: `Syskon till ${name} ringde` } });
      await owner.attendanceRecord.update({ where: { id: records[1]!.id }, data: { note: `Se ${protectedTeacher.id}` } });
      await owner.attendanceRecord.update({ where: { id: records[2]!.id }, data: { note: 'Kom sent, bussen' } });
      await owner.absenceReport.updateMany({ where: { schoolId: a.schoolId, studentId: sibling.id }, data: { note: `Anmäld via ${teacherName}` } });
      await leave({ studentId: sibling.id, requestedById: siblingGuardian.id, decidedById: a.admins.FULL.userId!, decidedAs: 'ADMIN', reason: `Följer med ${teacherName} på läger`, decisionNote: `Hänvisad till ${protectedTeacher.id}` });
      const needles = [name.toLowerCase(), teacherName.toLowerCase(), protectedTeacher.id, protectedPupil.id];
      // The other forms free text takes (R2-L2): each in a cell of its own, led by a marker that stays only if the cell does.
      const forms = ['NOTEA', 'NOTEB', 'NOTEC', 'NOTED', 'NOTEE', 'NOTEF'];
      const pupilZero = await owner.attendanceRecord.findMany({ where: { schoolId: a.schoolId, studentId: a.students[0]!.id }, orderBy: { recordedAt: 'asc' }, take: 5 });
      const planted = [
        'NOTEA Ring EfternamnA,  Elev2 (föräldern)', // reverse order, comma, two spaces
        'NOTEB Elev2\u00a0\u00a0EfternamnA ringde', // hard spaces
        'NOTEC Elev2-EfternamnA ringde', // hyphen between the names
        `NOTED ${protectedPupil.id.toUpperCase()}`, // upper-case id
        `NOTEE ${protectedPupil.id.replace(/-/g, '')}`, // id without hyphens
      ];
      for (const [index, note] of planted.entries()) await owner.attendanceRecord.update({ where: { id: pupilZero[index]!.id }, data: { note } });
      await owner.absenceReport.updateMany({ where: { schoolId: a.schoolId, studentId: a.students[0]!.id }, data: { note: `NOTEF ${protectedTeacher.email.toUpperCase()}` } });

      await owner.schoolExport.deleteMany({ where: { schoolId: a.schoolId, id: { not: first.id } } });
      const order = await service.order(a.admins.FULL);
      await runJobUntilIdle(job);
      const bytes = await fetchFile(service, order.id, a.admins.FULL);
      const school = unzip(bytes);
      cleanup.push(async () => rmSync(school.dir, { recursive: true, force: true }));
      const manifest = JSON.parse(school.files.get('manifest.json')!.toString('utf8')) as { files: Array<{ path: string; tommaCeller?: number }> };
      const emptied = (path: string) => manifest.files.find((file) => file.path === path)?.tommaCeller ?? 0;
      for (const [file, content] of school.files) {
        const text = content.toString('utf8').toLowerCase();
        for (const needle of needles) assert.ok(!text.includes(needle), `${file} names ${needle} in the school's file`);
      }
      assert.ok(emptied('data/narvaro.csv') >= 3, 'two notes and the protected recorder');
      assert.ok(emptied('data/franvaroanmalningar.csv') >= 1 && emptied('data/ledigheter.csv') >= 2, 'the absence note, the reason and the decision note');
      assert.ok(csvLines(school.files.get('data/narvaro.csv')).join('\n').includes('Kom sent, bussen'), 'a note that names nobody stays');
      for (const [file, content] of school.files) {
        const text = content.toString('utf8');
        for (const marker of forms) assert.ok(!text.includes(marker), `${file} keeps a note of form ${marker}: it names a protected person`);
      }
      assert.ok(emptied('data/narvaro.csv') >= 8 && emptied('data/franvaroanmalningar.csv') >= 2, 'every form counted');
      assert.match(school.files.get('README.txt')!.toString('utf8'), /med id, fullständigt namn \(i båda ordningarna\) eller e-postadress är tom/);

      const person = await extractZip(a.admins.FULL, sibling.id, false);
      for (const [file, content] of person.files) {
        const text = content.toString('utf8').toLowerCase();
        for (const needle of needles) assert.ok(!text.includes(needle), `${file} names ${needle} in another person's extract`);
      }
      assert.ok(csvLines(person.files.get('data/narvaro.csv')).join('\n').includes('Kom sent, bussen'));
      const pupilOne = await extractZip(a.admins.FULL, a.students[0]!.id, false);
      for (const [file, content] of pupilOne.files) {
        const text = content.toString('utf8');
        for (const marker of forms) assert.ok(!text.includes(marker), `${file} keeps a note of form ${marker} in another person's extract`);
      }
    });

    await check('(k-o) history that outlives its keys is in the extract, with the other parties held out for a protected person', async () => {
      const pupil = await extractZip(a.admins.FULL, a.students[0]!.id, false);
      const history = pupil.files.get('data/person/guardianstudenthistory.csv');
      assert.ok(history && history.toString('utf8').includes(a.students[0]!.id) && history.toString('utf8').includes(formerGuardian.id), 'a cut guardian link is data about the pupil');
      const own = await extractZip(a.admins.FULL, protectedPupil.id, false);
      const cut = own.files.get('data/person/guardianstudenthistory.csv');
      assert.ok(cut && cut.toString('utf8').includes(protectedPupil.id), "the protected pupil's own cut link is in it");
      assert.ok(!cut.toString('utf8').includes(formerGuardian.id), 'without the guardian who was cut');
      const events = own.files.get('data/person/personprotectionevents.csv');
      assert.ok(events && events.toString('utf8').includes(protectedPupil.id), 'that the person was marked, and when, is theirs to know (the database wrote the event)');
      assert.match(own.files.get('README.txt')!.toString('utf8'), /PublishedLessons: En kopia av lektionerna/, 'a table left out says why');
    });

    await check('(k-p) a lesson held by a guardian is named in the grundschema; a protected holder is in no file, and the export says so', async () => {
      const group = await owner.studentGroup.findFirstOrThrow({ where: { schoolId: a.schoolId, academicYearId: a.yearId } });
      const subject = await owner.subject.findFirstOrThrow({ where: { schoolId: a.schoolId } });
      const open = a.guardians[5]!;
      const closed = a.guardians[3]!; // marked in (k-i)
      const lesson = (teacherId: string, dayOfWeek: number) =>
        owner.masterLesson.create({
          data: { schoolId: a.schoolId, academicYearId: a.yearId, subjectId: subject.id, studentGroupId: group.id, teacherId, dayOfWeek, startTime: time('1970-01-01', '08:10'), endTime: time('1970-01-01', '09:10') },
        });
      await lesson(open.id, 2);
      await lesson(closed.id, 3);
      await owner.schoolExport.deleteMany({ where: { schoolId: a.schoolId, id: { not: first.id } } });
      const order = await service.order(a.admins.FULL);
      await runJobUntilIdle(job);
      const school = unzip(await fetchFile(service, order.id, a.admins.FULL));
      cleanup.push(async () => rmSync(school.dir, { recursive: true, force: true }));
      const schema = school.files.get('schema/grundschema.csv');
      assert.ok(schema, 'the grundschema is in the file');
      assert.ok(schema.toString('utf8').includes(open.email), "an unprotected holder is named: the lesson is theirs");
      for (const [name, content] of school.files) {
        const text = content.toString('utf8').toLowerCase();
        assert.ok(!text.includes(closed.id) && !text.includes(closed.email.toLowerCase()), `${name} names the protected holder`);
      }
      const note = '1 lektion hålls av en person med skyddad identitet som inte är lärare eller administratör';
      const manifest = JSON.parse(school.files.get('manifest.json')!.toString('utf8')) as { anmarkningar?: string[] };
      assert.ok(manifest.anmarkningar?.some((line) => line.includes(note)), 'the manifest says it');
      const readme = school.files.get('README.txt')!.toString('utf8');
      assert.ok(readme.includes('Delar som saknas') && readme.includes(note), 'the README says it first');
      const row = await owner.schoolExport.findUniqueOrThrow({ where: { id: order.id } });
      assert.ok(((row.heldOut as { notes?: string[] }).notes ?? []).some((line) => line.includes(note)), "and the order's row, which the card shows");
    });

    await check('(k-j) only those who decide ask for one, and only about their own school', async () => {
      for (const profile of ['SCHEMALAGGARE', 'EXPEDITION', 'LASARE'] as const) {
        await assert.rejects(() => access.extract(a.admins[profile], a.students[0]!.id, false), /lämnas ut av rektor/, `${profile} is refused`);
      }
      await assert.rejects(() => access.extract(b.admins.FULL, a.students[0]!.id, false), /finns inte/, "B's administrator cannot see A's person");
      await assert.rejects(() => access.extract(a.admins.FULL, randomUUID(), false), /finns inte/);
    });
  } finally {
    for (const undo of cleanup.reverse()) await undo().catch((error) => console.error('cleanup:', error));
    await owner.$disconnect();
    await api.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll school-export checks passed.');
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
