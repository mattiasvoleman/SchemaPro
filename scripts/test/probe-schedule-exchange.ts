/**
 * Schemat som tabell och i öppna format against a real database, as the API
 * role under RLS, through the real services (round 9, S0).
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-schedule-exchange.ts
 *
 * The jest specs cover the rules with the database faked; this is what they
 * cannot see: the clash scan reading real rosters, the unique keys and the
 * TB409 trigger on the posts an import derives, row security on every read and
 * write, and a laid timetable going out and coming back.
 *
 *   (x-a)  THE SEED SCHOOL (demo-skola, after `npm run db:seed`) is laid by the
 *          product's own create (the clash scan chooses each lesson's slot),
 *          exported in all four formats and imported back after the lessons
 *          are deleted: the same lessons, for every format, up to what the
 *          format cannot carry (CARRIES below), and a second import is all
 *          "finns redan" and writes nothing;
 *   (x-b)  A HÖGSTADIUM (built here: halves, A and B weeks, a term split, a
 *          parallel block, a co-taught lesson, a lesson two classes attend, a
 *          lesson with neither room nor teacher) goes the same way, and with
 *          the posts and the block deleted as well the import derives them
 *          back: the same lessons a week, lengths, teacher, weeks and block;
 *   (x-c)  every kind of row that cannot be placed is refused by name, and the
 *          apply of such a file writes nothing, in a transaction that leaves
 *          the school as it was;
 *   (x-d)  who may do what: a läsare previews and exports but its apply is
 *          refused by the database, and an export of a teacher's name is a row
 *          in the läslogg.
 *
 * Cleans up after itself: the lessons it laid, the signatures it gave, its own
 * school, and the demo school's posts it deleted and restored.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { createPgAdapter } from '../../src/database/pool-config';
import { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { ScheduleExchangeService, type ImportPlan } from '../../src/schedule-exchange/exchange.service';
import { EXCHANGE_FORMATS, renderExport, readUpload, type ExchangeFormat, type UploadedFile } from '../../src/schedule-exchange/exchange-files';
import { blankLesson } from '../../src/schedule-exchange/exchange-model';
import { lessonsToTable } from '../../src/schedule-exchange/lesson-table';
import { writeCsv } from '../../src/schedule-exchange/csv';

type Owner = PrismaClient;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const clock = (d: Date) => d.toISOString().slice(11, 16);
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

/** What each format carries of a lesson's tuple: the fields the roundtrip compares. */
const CARRIES: Record<ExchangeFormat, ReadonlySet<'extra' | 'room' | 'period'>> = {
  TABLE_CSV: new Set(['extra', 'room', 'period']),
  TABLE_XLSX: new Set(['extra', 'room', 'period']),
  UNTIS_GPU: new Set(['extra', 'room', 'period']),
  ASC_XML: new Set(['extra', 'room', 'period']),
};

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

interface School {
  schoolId: string;
  yearId: string;
  admin: AuthenticatedUser;
}

async function adminOf(owner: Owner, schoolId: string, profile: 'FULL' | 'LASARE' = 'FULL'): Promise<AuthenticatedUser> {
  const row = await owner.user.findFirst({
    where: { schoolId, role: 'SCHOOL_ADMIN', isActive: true, adminProfile: profile },
    orderBy: { email: 'asc' },
  });
  assert.ok(row, `an active ${profile} administrator at ${schoolId}`);
  return { authId: row.authId, role: Role.SCHOOL_ADMIN, userId: row.id, schoolId, adminProfile: profile, hrRead: row.hrRead, channel: 'OTHER' };
}

// ---------------------------------------------------------------------------
// The lessons of a year, as one comparable line each
// ---------------------------------------------------------------------------

async function tuplesOf(owner: Owner, yearId: string, format: ExchangeFormat | null = null): Promise<string[]> {
  const [lessons, employments, groups, subjects, rooms] = await Promise.all([
    owner.masterLesson.findMany({ where: { academicYearId: yearId, isParked: false }, include: { extraGroups: true } }),
    owner.teacherEmployment.findMany({ where: { academicYearId: yearId } }),
    owner.studentGroup.findMany({ where: { academicYearId: yearId } }),
    owner.subject.findMany({ where: { masterLessons: { some: { academicYearId: yearId } } } }),
    owner.room.findMany(),
  ]);
  const sig = new Map(employments.map((e) => [e.userId, e.signature]));
  const group = new Map(groups.map((g) => [g.id, g.name]));
  const subject = new Map(subjects.map((s) => [s.id, s.name]));
  const room = new Map(rooms.map((r) => [r.id, r.name]));
  const carries = format ? CARRIES[format] : new Set(['extra', 'room', 'period']);
  return lessons
    .map((l) =>
      [
        group.get(l.studentGroupId),
        subject.get(l.subjectId),
        l.teacherId ? sig.get(l.teacherId) : '',
        l.coTeacherId ? sig.get(l.coTeacherId) : '',
        carries.has('room') ? (l.roomId ? room.get(l.roomId) : '') : '',
        l.dayOfWeek,
        clock(l.startTime),
        clock(l.endTime),
        l.recurrence,
        carries.has('period') ? `${iso(l.startDate)}..${iso(l.endDate)}` : '',
        carries.has('extra') ? l.extraGroups.map((e) => group.get(e.studentGroupId)).sort().join('+') : '',
      ].join('|'),
    )
    .sort();
}

async function wipeLessons(owner: Owner, yearId: string): Promise<void> {
  await owner.masterLesson.deleteMany({ where: { academicYearId: yearId } });
}

// ---------------------------------------------------------------------------
// Laying a timetable with the product's own rule
// ---------------------------------------------------------------------------

const SLOT_STARTS = [8 * 60 + 10, 9 * 60 + 20, 10 * 60 + 30, 12 * 60 + 30, 13 * 60 + 40];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Every lesson of every post, placed in the first slot the hand edit's clash
 * rule admits (MasterLessonsService.create refuses a clash with a 409): so the
 * timetable is valid by the product's own definition, and the import is judged
 * by the same rule that laid it.
 */
async function lay(
  owner: Owner,
  masterLessons: MasterLessonsService,
  school: School,
  where: { studentGroup?: { gradeLevel?: number } } = {},
): Promise<{ placed: number; unplaced: number }> {
  const posts = await owner.teachingRequirement.findMany({
    where: { academicYearId: school.yearId, ...where },
    orderBy: [{ studentGroupId: 'asc' }, { subjectId: 'asc' }],
  });
  const rooms = await owner.room.findMany({ where: { schoolId: school.schoolId }, orderBy: { name: 'asc' } });
  let placed = 0;
  let unplaced = 0;
  let n = 0;
  for (const post of posts) {
    const all = post.lessonLengths.length > 0 ? post.lessonLengths : Array<number>(post.lessonsPerWeek).fill(post.minutesPerLesson);
    // The lessons a post already has by hand are not laid twice.
    const have = await owner.masterLesson.count({ where: { academicYearId: school.yearId, studentGroupId: post.studentGroupId, subjectId: post.subjectId } });
    const lengths = all.slice(have);
    for (const [i, minutes] of lengths.entries()) {
      n += 1;
      let done = false;
      for (let attempt = 0; attempt < 25 && !done; attempt += 1) {
        const day = ((n + i * 2 + attempt) % 5) + 1;
        const start = SLOT_STARTS[Math.floor(attempt / 5) % SLOT_STARTS.length]!;
        try {
          await masterLessons.create(
            {
              academicYearId: school.yearId,
              subjectId: post.subjectId,
              studentGroupId: post.studentGroupId,
              teacherId: post.teacherId,
              coTeacherId: post.coTeacherId,
              // Half the lessons have a room: both shapes go through the formats.
              roomId: n % 2 === 0 && rooms.length > 0 ? rooms[n % rooms.length]!.id : null,
              dayOfWeek: day,
              startTime: hhmm(start),
              endTime: hhmm(start + minutes),
              recurrence: post.recurrence,
              startDate: iso(post.startDate) || null,
              endDate: iso(post.endDate) || null,
            },
            school.admin,
          );
          done = true;
          placed += 1;
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
        }
      }
      if (!done) unplaced += 1;
    }
  }
  return { placed, unplaced };
}

// ---------------------------------------------------------------------------
// The högstadium
// ---------------------------------------------------------------------------

async function buildHogstadium(owner: Owner, masterLessons: MasterLessonsService, tag: string): Promise<School & { names: Record<string, string> }> {
  const school = await owner.school.create({ data: { name: `Probe högstadium ${tag}`, slug: `probe-s0-${tag}`, timezone: 'Europe/Stockholm' } });
  const schoolId = school.id;
  const year = await owner.academicYear.create({
    data: { schoolId, name: '2026/2027', startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), gradeNumbering: 'NIOARIG', isActive: true },
  });
  const yearId = year.id;
  await owner.user.create({
    data: { schoolId, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: 'FULL', firstName: 'Ada', lastName: 'Admin', email: `admin-${tag}@probe.example.com` },
  });
  await owner.user.create({
    data: { schoolId, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: 'LASARE', firstName: 'Lars', lastName: 'Läsare', email: `lasare-${tag}@probe.example.com` },
  });
  const teacher: Record<string, string> = {};
  for (const [short, first, last] of [
    ['ABE', 'Anna', 'Berg'],
    ['BLU', 'Bo', 'Lund'],
    ['CAN', 'Cia', 'Andersson'],
    ['DNO', 'Dan', 'Nord'],
    ['EST', 'Eva', 'Strand'],
    ['FAL', 'Farid', 'Alm'],
  ] as const) {
    const user = await owner.user.create({
      data: { schoolId, authId: randomUUID(), role: 'TEACHER', firstName: first, lastName: last, email: `${short.toLowerCase()}-${tag}@probe.example.com` },
    });
    await owner.teacherEmployment.create({ data: { schoolId, userId: user.id, academicYearId: yearId, employmentPercent: 100, signature: short } });
    teacher[short] = user.id;
  }
  const subject: Record<string, string> = {};
  for (const [name, code] of [['Matematik', 'MA'], ['Svenska', 'SV'], ['Engelska', 'EN'], ['Idrott och hälsa', 'IDH'], ['Bild', 'BL'], ['Musik', 'MU'], ['Slöjd', null], ['Moderna språk Spanska', 'MSP'], ['Moderna språk Tyska', 'MTY'], ['Moderna språk Franska', 'MFR']] as const) {
    subject[name] = (await owner.subject.create({ data: { schoolId, name, code } })).id;
  }
  const room: Record<string, string> = {};
  for (const name of ['A101', 'A102', 'Bildsalen', 'Musiksalen', 'Slöjdsalen', 'Gymnastiksalen']) {
    room[name] = (await owner.room.create({ data: { schoolId, name, capacity: 30 } })).id;
  }
  const group: Record<string, string> = {};
  const makeGroup = async (name: string, kind: 'CLASS' | 'TEACHING_GROUP', gradeLevel: number, halfOf?: string) => {
    group[name] = (await owner.studentGroup.create({ data: { schoolId, academicYearId: yearId, name, kind, gradeLevel, ...(halfOf ? { halfOfId: group[halfOf]! } : {}) } })).id;
  };
  for (const [name, grade] of [['7A', 7], ['7B', 7], ['8A', 8], ['8B', 8]] as const) await makeGroup(name, 'CLASS', grade);
  await makeGroup('7A-1', 'TEACHING_GROUP', 7, '7A');
  await makeGroup('7A-2', 'TEACHING_GROUP', 7, '7A');
  for (const name of ['Sp7', 'Ty7', 'Fr7']) await makeGroup(name, 'TEACHING_GROUP', 7);

  // The school's rules, which the import holds a lesson to.
  await owner.lunchSetting.create({ data: { schoolId, lunchEnabled: true, lunchStartTime: time('11:00'), lunchEndTime: time('13:00'), lunchMinutes: 30 } });
  await owner.frameTime.createMany({
    data: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ schoolId, minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek, startTime: time('08:00'), endTime: time('16:00') })),
  });

  // The posts: what the timetable below is derived from, and what an import must derive back.
  const HT = { startDate: new Date('2026-08-17'), endDate: new Date('2026-12-18') };
  const VT = { startDate: new Date('2027-01-11'), endDate: new Date('2027-06-11') };
  const block = await owner.teachingBlock.create({ data: { schoolId, academicYearId: yearId, name: 'Språkval åk 7' } });
  const post = (g: string, s: string, t: string | null, over: Record<string, unknown> = {}) =>
    owner.teachingRequirement.create({
      data: { schoolId, academicYearId: yearId, studentGroupId: group[g]!, subjectId: subject[s]!, teacherId: t ? teacher[t]! : null, lessonsPerWeek: 1, minutesPerLesson: 60, ...over },
    });
  await post('7A', 'Matematik', 'ABE', { lessonsPerWeek: 2 });
  await post('7A', 'Svenska', 'BLU');
  await post('7B', 'Matematik', 'ABE', { lessonsPerWeek: 2 });
  await post('7B', 'Svenska', 'BLU');
  await post('8A', 'Engelska', 'CAN');
  await post('8A', 'Idrott och hälsa', 'EST', { coTeacherId: teacher['FAL'], lessonsPerWeek: 1, minutesPerLesson: 90 });
  await post('8B', 'Idrott och hälsa', 'EST', { lessonsPerWeek: 1, minutesPerLesson: 90 });
  await post('8A', 'Musik', 'DNO');
  await post('8B', 'Engelska', null);
  await post('7A', 'Slöjd', 'FAL', { recurrence: 'ODD_WEEKS', minutesPerLesson: 80 });
  await post('7B', 'Slöjd', 'FAL', { recurrence: 'EVEN_WEEKS', minutesPerLesson: 80 });
  await post('7A-1', 'Bild', 'CAN', { minutesPerLesson: 80, ...HT });
  await post('7A-1', 'Musik', 'DNO', { minutesPerLesson: 80, ...VT });
  await post('7A-2', 'Musik', 'DNO', { minutesPerLesson: 80, ...HT });
  await post('7A-2', 'Bild', 'CAN', { minutesPerLesson: 80, ...VT });
  await post('Sp7', 'Moderna språk Spanska', 'BLU', { minutesPerLesson: 40, blockId: block.id });
  await post('Ty7', 'Moderna språk Tyska', 'ABE', { minutesPerLesson: 40, blockId: block.id });
  await post('Fr7', 'Moderna språk Franska', 'CAN', { minutesPerLesson: 40, blockId: block.id });

  const out: School & { names: Record<string, string> } = {
    schoolId,
    yearId,
    admin: await adminOf(owner, schoolId),
    names: { ...group },
  };
  // The lessons: those with a place of their own by hand, the rest by the clash rule.
  const make = (g: string, s: string, t: string | null, r: string | null, day: number, start: string, end: string, more: Record<string, unknown> = {}) =>
    masterLessons.create(
      { academicYearId: yearId, subjectId: subject[s]!, studentGroupId: group[g]!, teacherId: t ? teacher[t]! : null, roomId: r ? room[r]! : null, dayOfWeek: day, startTime: start, endTime: end, ...more },
      out.admin,
    );
  await make('8A', 'Idrott och hälsa', 'EST', 'Gymnastiksalen', 4, '08:10', '09:40', { coTeacherId: teacher['FAL'] });
  await make('8B', 'Idrott och hälsa', 'EST', 'Gymnastiksalen', 4, '09:50', '11:20');
  await make('8A', 'Musik', 'DNO', 'Musiksalen', 5, '10:30', '11:30', { extraGroupIds: [group['8B']!] });
  await make('8B', 'Engelska', null, null, 3, '13:00', '14:00');
  await make('7A', 'Slöjd', 'FAL', 'Slöjdsalen', 2, '13:00', '14:20', { recurrence: 'ODD_WEEKS' });
  await make('7B', 'Slöjd', 'FAL', 'Slöjdsalen', 2, '13:00', '14:20', { recurrence: 'EVEN_WEEKS' });
  await make('7A-1', 'Bild', 'CAN', 'Bildsalen', 3, '13:00', '14:20', { startDate: '2026-08-17', endDate: '2026-12-18' });
  await make('7A-1', 'Musik', 'DNO', 'Musiksalen', 3, '13:00', '14:20', { startDate: '2027-01-11', endDate: '2027-06-11' });
  await make('7A-2', 'Musik', 'DNO', 'Musiksalen', 3, '13:00', '14:20', { startDate: '2026-08-17', endDate: '2026-12-18' });
  await make('7A-2', 'Bild', 'CAN', 'Bildsalen', 3, '13:00', '14:20', { startDate: '2027-01-11', endDate: '2027-06-11' });
  await make('Sp7', 'Moderna språk Spanska', 'BLU', 'A102', 4, '13:00', '13:40');
  await make('Ty7', 'Moderna språk Tyska', 'ABE', 'A101', 4, '13:00', '13:40');
  await make('Fr7', 'Moderna språk Franska', 'CAN', 'Bildsalen', 4, '13:00', '13:40');
  // The posts that have no lesson yet (matematik and svenska), by the clash rule around the rest.
  await lay(owner, masterLessons, out);
  return out;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const owner = new PrismaClient({ adapter: createPgAdapter(requiredEnv('PROBE_OWNER_URL')) });
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
  const masterLessons = new MasterLessonsService(api, realtime, {} as NotificationsService);
  const exchange = new ScheduleExchangeService(api, realtime, masterLessons);

  const tag = randomUUID().slice(0, 8);
  const cleanup: Array<() => Promise<void>> = [];
  try {
    await seedSchoolChecks(owner, exchange, masterLessons, cleanup);
    await hogstadiumChecks(owner, exchange, masterLessons, tag, cleanup);
  } finally {
    for (const undo of cleanup.reverse()) await undo().catch((error) => console.error('cleanup:', error));
    await api.$disconnect();
    await owner.$disconnect();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nschedule-exchange probe passed.');
}

// ---------------------------------------------------------------------------
// (x-a) the seed school
// ---------------------------------------------------------------------------

async function bytesOf(format: ExchangeFormat, exchange: ScheduleExchangeService, yearId: string, admin: AuthenticatedUser): Promise<UploadedFile[]> {
  const file = await exchange.export(yearId, format, admin);
  return [{ name: file.filename, bytes: file.body }];
}

async function seedSchoolChecks(owner: Owner, exchange: ScheduleExchangeService, masterLessons: MasterLessonsService, cleanup: Array<() => Promise<void>>): Promise<void> {
  const demo = await owner.school.findUnique({ where: { slug: 'demo-skola' } });
  if (!demo) {
    console.log('skip (x-a): no demo-skola (npm run db:seed)');
    return;
  }
  const year = await owner.academicYear.findFirst({ where: { schoolId: demo.id, isActive: true } });
  assert.ok(year, 'the demo school’s active year');
  const school: School = { schoolId: demo.id, yearId: year.id, admin: await adminOf(owner, demo.id) };

  // Signatures: the seed gives its teachers none, and a signature is what the foreign formats join on.
  const teachers = await owner.user.findMany({ where: { schoolId: demo.id, role: 'TEACHER' }, orderBy: { email: 'asc' } });
  const signed: string[] = [];
  for (const [i, t] of teachers.entries()) {
    const existing = await owner.teacherEmployment.findFirst({ where: { academicYearId: year.id, userId: t.id } });
    if (existing) {
      if (!existing.signature) await owner.teacherEmployment.update({ where: { id: existing.id }, data: { signature: `PR${i + 1}` } });
    } else {
      const created = await owner.teacherEmployment.create({ data: { schoolId: demo.id, userId: t.id, academicYearId: year.id, employmentPercent: 100, signature: `PR${i + 1}` } });
      signed.push(created.id);
    }
  }
  cleanup.push(async () => {
    await owner.teacherEmployment.deleteMany({ where: { id: { in: signed } } });
    await owner.masterLesson.deleteMany({ where: { academicYearId: year.id } });
  });

  const laid = await lay(owner, masterLessons, school);
  const original = await tuplesOf(owner, year.id);
  await check(`(x-a) the seed school is laid by the clash rule (${laid.placed} lessons, ${laid.unplaced} left over)`, async () => {
    assert.ok(laid.placed >= 40, `only ${laid.placed} lessons were placed`);
    assert.equal(original.length, laid.placed);
  });

  const posts = await owner.teachingRequirement.findMany({ where: { academicYearId: year.id } });
  const blocks = await owner.teachingBlock.findMany({ where: { academicYearId: year.id } });
  const restore = async () => {
    // The posts the import derived have other ids and the same keys: out first, then the school's own back.
    await owner.teachingRequirement.deleteMany({ where: { academicYearId: year.id } });
    await owner.teachingBlock.deleteMany({ where: { academicYearId: year.id } });
    await owner.teachingBlock.createMany({ data: blocks });
    await owner.teachingRequirement.createMany({ data: posts });
  };
  cleanup.push(restore);

  for (const format of EXCHANGE_FORMATS) {
    await roundTrip(`(x-a) ${format}`, owner, exchange, school, format, original, { withPosts: false });
  }
  // The posts deleted as well: the import derives them back, equal to the school's own.
  await check('(x-a) the posts derived from the lessons are the posts the school had', async () => {
    const files = await bytesOf('TABLE_CSV', exchange, year.id, school.admin);
    await wipeLessons(owner, year.id);
    await owner.teachingRequirement.deleteMany({ where: { academicYearId: year.id } });
    await owner.teachingBlock.deleteMany({ where: { academicYearId: year.id } });
    const plan = await exchange.preview({ academicYearId: year.id, format: 'TABLE_CSV', files }, school.admin);
    assert.equal(plan.canApply, true, JSON.stringify(plan.rows.filter((r) => r.action === 'REFUSED').slice(0, 3)));
    await exchange.apply({ academicYearId: year.id, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, school.admin);
    const derived = await owner.teachingRequirement.findMany({ where: { academicYearId: year.id } });
    const key = (r: { studentGroupId: string; subjectId: string }) => `${r.studentGroupId}|${r.subjectId}`;
    const byKey = new Map(derived.map((r) => [key(r), r]));
    for (const original of posts) {
      const got = byKey.get(key(original));
      if (original.teacherId === null && !got) continue;
      assert.ok(got, `no post for ${key(original)}`);
      // The lessons the seed school's post asked for were all placed, or the post says fewer.
      assert.ok(got.lessonsPerWeek <= original.lessonsPerWeek, 'more lessons than the post asked for');
      assert.equal(got.minutesPerLesson, original.minutesPerLesson);
      assert.equal(got.teacherId, original.teacherId);
      assert.equal(got.coTeacherId, original.coTeacherId);
    }
  });
}

// ---------------------------------------------------------------------------
// (x-b), (x-c), (x-d) the högstadium
// ---------------------------------------------------------------------------

async function hogstadiumChecks(owner: Owner, exchange: ScheduleExchangeService, masterLessons: MasterLessonsService, tag: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  let school!: School & { names: Record<string, string> };
  await check('(x-b) a högstadium with halves, A and B weeks, a term split and a block is laid', async () => {
    school = await buildHogstadium(owner, masterLessons, tag);
    cleanup.push(async () => {
      await owner.school.delete({ where: { id: school.schoolId } });
    });
    const lessons = await owner.masterLesson.count({ where: { academicYearId: school.yearId } });
    assert.ok(lessons >= 15, `only ${lessons} lessons`);
  });
  if (!school) return;
  const original = await tuplesOf(owner, school.yearId);
  for (const format of EXCHANGE_FORMATS) {
    await roundTrip(`(x-b) ${format}`, owner, exchange, school, format, original, { withPosts: true });
  }
  await refusalChecks(owner, exchange, school);
  await roleChecks(owner, exchange, school);
}

/**
 * Out, delete, in, compare. The same school then a second import: all "finns
 * redan", nothing written. With `withPosts` the posts and the block are deleted
 * as well, and the import must derive the posts back.
 */
async function roundTrip(
  label: string,
  owner: Owner,
  exchange: ScheduleExchangeService,
  school: School,
  format: ExchangeFormat,
  original: string[],
  options: { withPosts: boolean },
): Promise<void> {
  await check(`${label}: out and back in gives the same timetable`, async () => {
    // Whatever happens below, the next format starts from the whole timetable.
    const posts = await owner.teachingRequirement.findMany({ where: { academicYearId: school.yearId } });
    const blocks = await owner.teachingBlock.findMany({ where: { academicYearId: school.yearId } });
    try {
      await roundTripOf(owner, exchange, school, format, original, options, posts, blocks);
    } finally {
      await wipeLessons(owner, school.yearId);
      await owner.teachingRequirement.deleteMany({ where: { academicYearId: school.yearId } });
      await owner.teachingBlock.deleteMany({ where: { academicYearId: school.yearId } });
      await owner.teachingBlock.createMany({ data: blocks, skipDuplicates: true });
      await owner.teachingRequirement.createMany({ data: posts, skipDuplicates: true });
      await restoreFrom(owner, school, original);
    }
  });
}

async function roundTripOf(
  owner: Owner,
  exchange: ScheduleExchangeService,
  school: School,
  format: ExchangeFormat,
  original: string[],
  options: { withPosts: boolean },
  posts: Awaited<ReturnType<Owner['teachingRequirement']['findMany']>>,
  blocks: Awaited<ReturnType<Owner['teachingBlock']['findMany']>>,
): Promise<void> {
  {
    const files = await bytesOf(format, exchange, school.yearId, school.admin);
    // Imported over itself first: every row is already there.
    const same = await exchange.preview({ academicYearId: school.yearId, format, files }, school.admin);
    assert.equal(same.summary.create, 0, `a re-import would create ${same.summary.create}: ${JSON.stringify(same.rows.find((r) => r.action !== 'UNCHANGED'))}`);
    assert.equal(same.summary.refused, 0, JSON.stringify(same.rows.find((r) => r.action === 'REFUSED')));
    assert.equal(same.canApply, true);

    await wipeLessons(owner, school.yearId);
    if (options.withPosts) {
      await owner.teachingRequirement.deleteMany({ where: { academicYearId: school.yearId } });
      await owner.teachingBlock.deleteMany({ where: { academicYearId: school.yearId } });
    }
    const plan = await exchange.preview({ academicYearId: school.yearId, format, files }, school.admin);
    assert.equal(plan.canApply, true, `${format}: ${JSON.stringify(plan.rows.filter((r) => r.action === 'REFUSED').slice(0, 3))} ${JSON.stringify(plan.unreadable.slice(0, 3))}`);
    assert.equal(plan.summary.create, original.length);
    await exchange.apply({ academicYearId: school.yearId, format, files, fingerprint: plan.fingerprint }, school.admin);
    assert.deepEqual(await tuplesOf(owner, school.yearId, format), compare(original, format));

    if (options.withPosts) {
      const derived = await owner.teachingRequirement.findMany({ where: { academicYearId: school.yearId } });
      const key = (r: { studentGroupId: string; subjectId: string }) => `${r.studentGroupId}|${r.subjectId}`;
      const got = new Map(derived.map((r) => [key(r), r]));
      for (const was of posts) {
        const now = got.get(key(was));
        if (!now) continue; // A post with no lesson placed (the clash rule left it over) has nothing to derive from.
        assert.equal(now.lessonsPerWeek <= was.lessonsPerWeek, true);
        assert.equal(now.minutesPerLesson, was.minutesPerLesson, `minutes of ${key(was)}`);
        assert.equal(now.recurrence, was.recurrence, `weeks of ${key(was)}`);
        assert.equal(iso(now.startDate), iso(was.startDate), `from of ${key(was)}`);
        assert.equal(iso(now.endDate), iso(was.endDate), `to of ${key(was)}`);
        if (format === 'TABLE_CSV' || format === 'TABLE_XLSX') {
          assert.equal(now.teacherId, was.teacherId, `teacher of ${key(was)}`);
          assert.equal(now.coTeacherId, was.coTeacherId, `co-teacher of ${key(was)}`);
        }
      }
      if (format === 'TABLE_CSV' || format === 'TABLE_XLSX') {
        const nowBlocks = await owner.teachingBlock.findMany({ where: { academicYearId: school.yearId }, include: { requirements: true } });
        assert.deepEqual(nowBlocks.map((b) => [b.name, b.requirements.length]), blocks.length ? [['Språkval åk 7', 3]] : []);
      }
    } else {
      // The posts the school has are never changed by an import over them.
      const after = await owner.teachingRequirement.findMany({ where: { academicYearId: school.yearId }, orderBy: { id: 'asc' } });
      assert.deepEqual(after, [...posts].sort((a, b) => a.id.localeCompare(b.id)));
    }

    // And again: the school now has exactly the file.
    const twice = await exchange.preview({ academicYearId: school.yearId, format, files }, school.admin);
    assert.equal(twice.summary.create, 0);
    assert.equal(twice.summary.unchanged, original.length);
    const done = await exchange.apply({ academicYearId: school.yearId, format, files, fingerprint: twice.fingerprint }, school.admin);
    assert.equal(done.created, 0);
    assert.deepEqual(await tuplesOf(owner, school.yearId, format), compare(original, format));
  }
}

/** What a format’s round trip is held to: the fields it carries. */
function compare(original: string[], format: ExchangeFormat): string[] {
  const carries = CARRIES[format];
  return original
    .map((line) => {
      const f = line.split('|');
      if (!carries.has('room')) f[4] = '';
      if (!carries.has('period')) f[9] = '..';
      if (!carries.has('extra')) f[10] = '';
      return f.join('|');
    })
    .sort();
}

/** Lays the original tuples back as rows, by the owner, after a lossy format. */
async function restoreFrom(owner: Owner, school: School, original: string[]): Promise<void> {
  const [groups, subjects, rooms, employments] = await Promise.all([
    owner.studentGroup.findMany({ where: { academicYearId: school.yearId } }),
    owner.subject.findMany({ where: { schoolId: school.schoolId } }),
    owner.room.findMany({ where: { schoolId: school.schoolId } }),
    owner.teacherEmployment.findMany({ where: { academicYearId: school.yearId } }),
  ]);
  const group = new Map(groups.map((g) => [g.name, g.id]));
  const subject = new Map(subjects.map((s) => [s.name, s.id]));
  const room = new Map(rooms.map((r) => [r.name, r.id]));
  const teacher = new Map(employments.map((e) => [e.signature, e.userId]));
  for (const line of original) {
    const [g, s, t, c, r, day, start, end, recurrence, period, extra] = line.split('|') as [string, string, string, string, string, string, string, string, string, string, string];
    const [from, to] = period.split('..') as [string, string];
    const lesson = await owner.masterLesson.create({
      data: {
        schoolId: school.schoolId,
        academicYearId: school.yearId,
        studentGroupId: group.get(g)!,
        subjectId: subject.get(s)!,
        teacherId: t ? (teacher.get(t) ?? null) : null,
        coTeacherId: c ? (teacher.get(c) ?? null) : null,
        roomId: r ? (room.get(r) ?? null) : null,
        dayOfWeek: Number(day),
        startTime: time(start),
        endTime: time(end),
        recurrence: recurrence as 'ALL_WEEKS',
        startDate: from ? new Date(from) : null,
        endDate: to ? new Date(to) : null,
      },
    });
    for (const name of extra ? extra.split('+') : []) {
      await owner.masterLessonGroup.create({ data: { schoolId: school.schoolId, masterLessonId: lesson.id, studentGroupId: group.get(name)! } });
    }
  }
}

// ---------------------------------------------------------------------------
// (x-c) what cannot be placed
// ---------------------------------------------------------------------------

async function refusalChecks(owner: Owner, exchange: ScheduleExchangeService, school: School & { names: Record<string, string> }): Promise<void> {
  const doc = async () => {
    const files = await bytesOf('TABLE_CSV', exchange, school.yearId, school.admin);
    return files;
  };
  void doc;
  const lessons = await owner.masterLesson.findMany({ where: { academicYearId: school.yearId }, include: { extraGroups: true } });
  const before = lessons.length;
  const csvOf = (rows: Array<Parameters<typeof blankLesson>[0]>) => {
    const table = lessonsToTable({
      school: 'x',
      year: { name: '2026/2027', start: '2026-08-17', end: '2027-06-11' },
      lessons: rows.map((r) => blankLesson(r)),
      groups: [],
      subjects: [],
      rooms: [],
      teachers: [],
    });
    return [{ name: 'schema.csv', bytes: Buffer.from(writeCsv(table), 'utf8') }];
  };
  const row = (over: Partial<Parameters<typeof blankLesson>[0]> & { ref?: string } = {}) => ({
    ref: '',
    group: '8B',
    subject: 'Musik',
    day: 2,
    start: '10:30',
    end: '11:30',
    teachers: [{ short: 'DNO', name: null, email: null, id: null }],
    ...over,
  });
  const plan = (rows: Array<ReturnType<typeof row>>): Promise<ImportPlan> =>
    exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files: csvOf(rows) }, school.admin);
  const codes = (p: ImportPlan, i = 0) => p.rows[i]!.refusals.map((r) => r.code);

  const cases: Array<[string, Array<ReturnType<typeof row>>, string]> = [
    ['an unknown class is named', [row({ group: '9Z' })], 'UNKNOWN_GROUP'],
    ['an unknown subject is named', [row({ subject: 'Latin' })], 'UNKNOWN_SUBJECT'],
    ['an unknown teacher is named', [row({ teachers: [{ short: 'ZZZ', name: null, email: null, id: null }] })], 'UNKNOWN_TEACHER'],
    ['an unknown room is named', [row({ room: 'Aulan' })], 'UNKNOWN_ROOM'],
    ['a teacher in two places at once is a clash', [row({ group: '8B', subject: 'Musik', day: 5, start: '10:30', end: '11:30', teachers: [{ short: 'DNO', name: null, email: null, id: null }] })], 'CLASH_TEACHER'],
    ['a room booked twice is a clash', [row({ day: 5, start: '10:30', end: '11:30', teachers: [{ short: 'ABE', name: null, email: null, id: null }], group: '7B', room: 'Musiksalen' })], 'CLASH_ROOM'],
    ['a class in two places at once is a clash', [row({ group: '8A', subject: 'Engelska', day: 5, start: '11:00', end: '12:00', teachers: [{ short: 'CAN', name: null, email: null, id: null }] })], 'CLASH_GROUP'],
    ['a lesson outside the frame is named', [row({ day: 1, start: '16:00', end: '17:00' })], 'OUTSIDE_FRAME'],
    ['a lesson on the Saturday is named', [row({ day: 6 })], 'DAY_OUTSIDE_SCHOOL_WEEK'],
    ['a lesson off the five-minute grid is named', [row({ start: '10:32' })], 'OFF_GRID'],
    ['a period outside the year is named', [row({ from: '2025-01-01' })], 'PERIOD_OUTSIDE_YEAR'],
    ['a lesson the school has, with another room, is named and not changed', [row({ group: '8A', subject: 'Musik', day: 5, start: '10:30', end: '11:30', room: 'A101', extraGroups: ['8B'] })], 'EXISTS_DIFFERENT'],
  ];
  for (const [label, rows, code] of cases) {
    await check(`(x-c) ${label}`, async () => {
      const p = await plan(rows);
      assert.ok(codes(p).includes(code), `${code} not in ${JSON.stringify(p.rows[0]!.refusals)}`);
      assert.equal(p.canApply, false);
      await assert.rejects(exchange.apply({ academicYearId: school.yearId, format: 'TABLE_CSV', files: csvOf(rows), fingerprint: p.fingerprint }, school.admin), (e: unknown) => (e as { response?: { code?: string } }).response?.code === 'IMPORT_HAS_REFUSALS');
      assert.equal(await owner.masterLesson.count({ where: { academicYearId: school.yearId } }), before, 'the refused import wrote something');
    });
  }

  await check('(x-c) a lesson over a rast is named', async () => {
    const rast = await owner.rast.create({ data: { schoolId: school.schoolId, name: 'Förmiddagsrast', minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: time('09:10'), endTime: time('09:20') } });
    try {
      const p = await plan([row({ day: 1, start: '09:00', end: '09:30' })]);
      assert.deepEqual(codes(p), ['IN_RAST']);
    } finally {
      await owner.rast.delete({ where: { id: rast.id } });
    }
  });

  await check('(x-c) a lunch window with no 30 free minutes is named, and the lesson that tips it over', async () => {
    // 8B has no lesson at 11:00-13:00 on Monday: a lesson 11:00-12:45 leaves 15 minutes of the window.
    const p = await plan([row({ day: 1, start: '11:00', end: '12:45' })]);
    assert.deepEqual(codes(p), ['NO_ROOM_FOR_LUNCH']);
    const ok = await plan([row({ day: 1, start: '11:00', end: '12:15' })]);
    assert.deepEqual(codes(ok), []);
  });

  await check('(x-c) the generator’s own lunch for a class is not built over', async () => {
    const group = school.names['8B']!;
    const sitting = await owner.lunchSitting.create({ data: { schoolId: school.schoolId, academicYearId: school.yearId, studentGroupId: group, dayOfWeek: 1, startTime: time('11:30'), endTime: time('12:00'), isGenerated: true } });
    try {
      const p = await plan([row({ day: 1, start: '11:00', end: '12:00' })]);
      assert.ok(codes(p).includes('ON_LUNCH_SITTING'), JSON.stringify(p.rows[0]!.refusals));
    } finally {
      await owner.lunchSitting.delete({ where: { id: sitting.id } });
    }
  });

  await check('(x-c) the second of two rows that collide is held against the first, and the file as a whole is refused', async () => {
    const p = await plan([row({ day: 1, start: '13:00', end: '14:00' }), row({ day: 1, start: '13:30', end: '14:30', subject: 'Engelska', teachers: [{ short: 'DNO', name: null, email: null, id: null }] })]);
    assert.deepEqual([p.rows[0]!.action, codes(p, 1)], ['CREATE', ['CLASH_TEACHER', 'CLASH_GROUP']]);
    assert.equal(p.canApply, false);
  });

  await check('(x-c) an apply for a plan that moved since the preview writes nothing', async () => {
    const rows = [row({ day: 1, start: '13:00', end: '14:00' })];
    const p = await plan(rows);
    assert.equal(p.canApply, true);
    const blocker = await owner.masterLesson.create({
      data: { schoolId: school.schoolId, academicYearId: school.yearId, studentGroupId: school.names['8B']!, subjectId: (await owner.subject.findFirstOrThrow({ where: { schoolId: school.schoolId, name: 'Svenska' } })).id, dayOfWeek: 1, startTime: time('13:00'), endTime: time('14:00') },
    });
    try {
      await assert.rejects(exchange.apply({ academicYearId: school.yearId, format: 'TABLE_CSV', files: csvOf(rows), fingerprint: p.fingerprint }, school.admin), (e: unknown) => (e as { response?: { code?: string } }).response?.code === 'IMPORT_PLAN_CHANGED');
      assert.equal(await owner.masterLesson.count({ where: { academicYearId: school.yearId } }), before + 1);
    } finally {
      await owner.masterLesson.delete({ where: { id: blocker.id } });
    }
  });

  await check('(x-c) a personnummer column is dropped unread, and its content is in no answer', async () => {
    const csv = 'Klass/grupp;Ämne;Dag;Start;Slut;Personnummer\r\n8B;Musik;Tis;12:30;13:30;19121212-1212\r\n';
    const p = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files: [{ name: 's.csv', bytes: Buffer.from(csv, 'utf8') }] }, school.admin);
    assert.ok(!JSON.stringify(p).includes('19121212'), 'the personnummer is in the answer');
    assert.ok(p.notes.some((n) => n.includes('Personnummer')));
  });
}

// ---------------------------------------------------------------------------
// (x-d) who may do what
// ---------------------------------------------------------------------------

async function roleChecks(owner: Owner, exchange: ScheduleExchangeService, school: School): Promise<void> {
  const lasare = await adminOf(owner, school.schoolId, 'LASARE');
  await check('(x-d) a läsare exports and previews, and the database refuses its apply', async () => {
    const files = await bytesOf('TABLE_CSV', exchange, school.yearId, lasare);
    const p = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files }, lasare);
    assert.equal(p.canApply, true);
    await wipeLessons(owner, school.yearId);
    try {
      const fresh = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files }, lasare);
      await assert.rejects(exchange.apply({ academicYearId: school.yearId, format: 'TABLE_CSV', files, fingerprint: fresh.fingerprint }, lasare));
      assert.equal(await owner.masterLesson.count({ where: { academicYearId: school.yearId } }), 0);
    } finally {
      const plan = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files }, school.admin);
      await exchange.apply({ academicYearId: school.yearId, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, school.admin);
    }
  });

  await check('(x-d) an export names teachers, so every teacher it names is in the läslogg as read by the administrator', async () => {
    await exchange.export(school.yearId, 'TABLE_CSV', school.admin);
    // One row per reader, kind and fifteen minutes lists each subject once (recordRead), so
    // the rows of the last quarter-hour together hold every teacher the exports above named.
    const rows = await owner.personalDataAccess.findMany({
      where: { schoolId: school.schoolId, kind: 'PEOPLE', actorId: school.admin.userId!, at: { gte: new Date(Date.now() - 15 * 60_000) } },
    });
    const logged = new Set(rows.flatMap((row) => row.subjectIds));
    const teachers = await owner.teacherEmployment.findMany({ where: { academicYearId: school.yearId } });
    for (const teacher of teachers) assert.ok(logged.has(teacher.userId), `teacher ${teacher.signature} is not in the läslogg`);
  });

  // The readers are exercised end to end by the format specs; one cross-check here that
  // the same bytes read the same through the service's own reader.
  await check('(x-d) the readers agree with the service on what a file holds', async () => {
    const files = await bytesOf('TABLE_CSV', exchange, school.yearId, school.admin);
    const parsed = readUpload('TABLE_CSV', files);
    assert.equal(parsed.problems.length, 0);
    assert.equal(parsed.lessons.length, await owner.masterLesson.count({ where: { academicYearId: school.yearId } }));
    void renderExport;
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
