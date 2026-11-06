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
 *   (x-a)  THE SEED SCHOOL (demo-skola, after `npm run db:seed`): its classes
 *          and posts, copied into a läsår of the probe's own, are laid by the
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
 *          in the läslogg;
 *   (x-e)  the review of PR #256: the clash rule answers the same from the
 *          file-wide cache (ConflictReads) as from the database, over a school
 *          with pupils, halves and blocks; two applies of one file at once
 *          write it once; a teacher who has left does not turn "finns redan"
 *          into a refusal; an export logs every teacher the file names; no
 *          personnummer in a column comes back in the answer or is stored as
 *          a block's name;
 *   (x-f)  a file of 5 000 rows previews and applies in seconds, not minutes.
 *
 * Independent of what earlier CI steps left in the database. The demo school's
 * active year is NOT the probe's to wipe: by the time this runs the RLS fixtures
 * and the adapter probe have put their own rows there (a lesson at 06:10, one
 * held by a deactivated teacher, one with classes of another year as extra
 * groups, nine lessons of a made-up subject), and a round trip that deletes a
 * year's lessons and reads them back would delete those too, and refuse them
 * on the way in. So (x-a) works in a läsår it creates and drops, and (x-b)
 * onwards in a school it creates and drops; neither counts on a number of
 * lessons, teachers or classes the seed or an earlier step happened to leave.
 *
 * Cleans up after itself: the läsår and the school it made (everything in them
 * goes with them) and the change-log rows its writes made in the demo school,
 * which have no foreign key to the year. The läslogg rows an export leaves are
 * the audit trail's and append-only, so they stay.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ConflictReads } from '../../src/calendar/conflict-reads';
import { rostersOfYear } from '../../src/year-rollover/projected-rosters';
import { hasPersonalNumber } from '../../src/schedule-exchange/file-safety';
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
  // A lesson that points outside the year's own groups, teachers and subjects is not one this
  // probe laid; say so by name rather than comparing an "undefined".
  const named = <T>(what: string, from: Map<string, T>) => ({
    get: (id: string): T => {
      const found = from.get(id);
      if (found === undefined) throw new Error(`a lesson of the year names a ${what} (${id}) that is not the year's own`);
      return found;
    },
  });
  const sig = named('teacher', new Map(employments.map((e) => [e.userId, e.signature ?? ''])));
  const group = named('class or group', new Map(groups.map((g) => [g.id, g.name])));
  const subject = named('subject', new Map(subjects.map((s) => [s.id, s.name])));
  const room = named('room', new Map(rooms.map((r) => [r.id, r.name])));
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
  // In name order, not id order: the probe's groups get fresh ids every run, and
  // an id order lays a different timetable each time, so which post the clash
  // rule leaves without a lesson moved from run to run.
  const posts = (
    await owner.teachingRequirement.findMany({
      where: { academicYearId: school.yearId, ...where },
      include: { studentGroup: { select: { name: true } }, subject: { select: { name: true } } },
    })
  ).sort(
    (a, b) =>
      a.studentGroup.name.localeCompare(b.studentGroup.name, 'sv') ||
      a.subject.name.localeCompare(b.subject.name, 'sv') ||
      a.id.localeCompare(b.id),
  );
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
    await seedSchoolChecks(owner, exchange, masterLessons, tag, cleanup);
    await hogstadiumChecks(owner, api, exchange, masterLessons, tag, cleanup);
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

/**
 * The seed school's classes and posts in a läsår of the probe's own: same dates
 * as the active year (nothing forbids two years from overlapping, only one from
 * being active), the active year's classes, and every post whose teachers are
 * active, each with the signature the foreign formats join on (the seed gives
 * its teachers none). Posts naming a deactivated teacher are left out because
 * no import may place that teacher; that is the rule under test, not the seed's
 * data. Lessons are the probe's alone to lay.
 */
async function copyOfSeedYear(owner: Owner, schoolId: string, source: { id: string; startDate: Date; endDate: Date; gradeNumbering: 'NIOARIG' | 'TIOARIG' }, tag: string): Promise<{ yearId: string }> {
  const year = await owner.academicYear.create({
    data: { schoolId, name: `Probe S0 ${tag}`, startDate: source.startDate, endDate: source.endDate, gradeNumbering: source.gradeNumbering, isActive: false },
  });
  const classes = await owner.studentGroup.findMany({ where: { academicYearId: source.id }, orderBy: { name: 'asc' } });
  const group = new Map<string, string>();
  // A class before its halves: a half points at the class it halves.
  for (const g of [...classes.filter((c) => !c.halfOfId), ...classes.filter((c) => c.halfOfId)]) {
    const halfOfId = g.halfOfId ? group.get(g.halfOfId) : undefined;
    if (g.halfOfId && !halfOfId) continue;
    const made = await owner.studentGroup.create({
      data: { schoolId, academicYearId: year.id, name: g.name, kind: g.kind, gradeLevel: g.gradeLevel, ...(halfOfId ? { halfOfId } : {}) },
    });
    group.set(g.id, made.id);
  }

  const active = new Set((await owner.user.findMany({ where: { schoolId, isActive: true }, select: { id: true } })).map((u) => u.id));
  const signature = new Map<string, string>();
  const sign = async (userId: string): Promise<void> => {
    if (signature.has(userId)) return;
    const short = `PR${signature.size + 1}`;
    await owner.teacherEmployment.create({ data: { schoolId, userId, academicYearId: year.id, employmentPercent: 100, signature: short } });
    signature.set(userId, short);
  };
  const posts = await owner.teachingRequirement.findMany({ where: { academicYearId: source.id }, orderBy: [{ studentGroupId: 'asc' }, { subjectId: 'asc' }] });
  for (const post of posts) {
    const studentGroupId = group.get(post.studentGroupId);
    const people = [post.teacherId, post.coTeacherId].filter((id): id is string => id !== null);
    if (!studentGroupId || !people.every((id) => active.has(id))) continue;
    for (const id of people) await sign(id);
    // A post of its own, in the copied class, outside any block (a block is the source year's).
    const { id: _id, createdAt: _created, updatedAt: _updated, academicYearId: _year, studentGroupId: _group, blockId: _block, ...rest } = post;
    void [_id, _created, _updated, _year, _group, _block];
    await owner.teachingRequirement.create({ data: { ...rest, academicYearId: year.id, studentGroupId, blockId: null } });
  }
  return { yearId: year.id };
}

async function seedSchoolChecks(owner: Owner, exchange: ScheduleExchangeService, masterLessons: MasterLessonsService, tag: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  const demo = await owner.school.findUnique({ where: { slug: 'demo-skola' } });
  if (!demo) {
    console.log('skip (x-a): no demo-skola (npm run db:seed)');
    return;
  }
  const source = await owner.academicYear.findFirst({ where: { schoolId: demo.id, isActive: true } });
  assert.ok(source, 'the demo school’s active year');
  const { yearId } = await copyOfSeedYear(owner, demo.id, source, tag);
  cleanup.push(async () => {
    // The log has no foreign key to the year; the year's own rows go with it.
    await owner.scheduleChangeLog.deleteMany({ where: { schoolId: demo.id, academicYearId: yearId } });
    await owner.academicYear.delete({ where: { id: yearId } });
  });
  const school: School = { schoolId: demo.id, yearId, admin: await adminOf(owner, demo.id) };

  const posts = await owner.teachingRequirement.findMany({ where: { academicYearId: yearId } });
  const asked = posts.reduce((sum, post) => sum + (post.lessonLengths.length > 0 ? post.lessonLengths.length : post.lessonsPerWeek), 0);
  const laid = await lay(owner, masterLessons, school);
  const original = await tuplesOf(owner, yearId);
  await check(`(x-a) the seed school is laid by the clash rule (${laid.placed} of ${asked} lessons, ${laid.unplaced} left over)`, async () => {
    assert.ok(posts.length > 0, 'the seed school has posts to copy');
    assert.equal(laid.placed + laid.unplaced, asked, 'every lesson a post asks for was tried');
    assert.ok(laid.placed >= asked / 2, `only ${laid.placed} of ${asked} lessons were placed`);
    assert.equal(original.length, laid.placed);
  });

  for (const format of EXCHANGE_FORMATS) {
    await roundTrip(`(x-a) ${format}`, owner, exchange, school, format, original, { withPosts: false });
  }
  // The posts deleted as well: the import derives them back, equal to the school's own.
  await check('(x-a) the posts derived from the lessons are the posts the school had', async () => {
    const files = await bytesOf('TABLE_CSV', exchange, yearId, school.admin);
    // A post the clash rule left without a single lesson is in no row of the
    // file, so there is nothing to derive it from; every other post must come back.
    const laidKeys = new Set(
      (await owner.masterLesson.findMany({ where: { academicYearId: yearId }, select: { studentGroupId: true, subjectId: true } })).map(
        (l) => `${l.studentGroupId}|${l.subjectId}`,
      ),
    );
    await wipeLessons(owner, yearId);
    await owner.teachingRequirement.deleteMany({ where: { academicYearId: yearId } });
    await owner.teachingBlock.deleteMany({ where: { academicYearId: yearId } });
    const plan = await exchange.preview({ academicYearId: yearId, format: 'TABLE_CSV', files }, school.admin);
    assert.equal(plan.canApply, true, JSON.stringify(plan.rows.filter((r) => r.action === 'REFUSED').slice(0, 3)));
    await exchange.apply({ academicYearId: yearId, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, school.admin);
    const derived = await owner.teachingRequirement.findMany({ where: { academicYearId: yearId } });
    const key = (r: { studentGroupId: string; subjectId: string }) => `${r.studentGroupId}|${r.subjectId}`;
    const byKey = new Map(derived.map((r) => [key(r), r]));
    for (const original of posts) {
      const got = byKey.get(key(original));
      if (original.teacherId === null && !got) continue;
      if (!laidKeys.has(key(original))) continue;
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

async function hogstadiumChecks(owner: Owner, api: PrismaService, exchange: ScheduleExchangeService, masterLessons: MasterLessonsService, tag: string, cleanup: Array<() => Promise<void>>): Promise<void> {
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
  await reviewChecks(owner, api, exchange, masterLessons, school, original, tag, cleanup);
  await bigFileChecks(owner, exchange, masterLessons, tag, cleanup);
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
    let failed: unknown;
    try {
      await roundTripOf(owner, exchange, school, format, original, options, posts, blocks);
    } catch (error) {
      failed = error;
    }
    try {
      await wipeLessons(owner, school.yearId);
      await owner.teachingRequirement.deleteMany({ where: { academicYearId: school.yearId } });
      await owner.teachingBlock.deleteMany({ where: { academicYearId: school.yearId } });
      await owner.teachingBlock.createMany({ data: blocks, skipDuplicates: true });
      await owner.teachingRequirement.createMany({ data: posts, skipDuplicates: true });
      await restoreFrom(owner, school, original);
    } catch (error) {
      // The check's own failure is the one to read; putting the timetable back failing too is told beside it.
      if (failed === undefined) throw error;
      console.error(`     (and laying the timetable back for the next format failed: ${error instanceof Error ? error.message : String(error)})`);
    }
    if (failed !== undefined) throw failed;
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

    // The posts that had a lesson to export: each of them must come back below.
    const laidKeys = new Set(
      (await owner.masterLesson.findMany({ where: { academicYearId: school.yearId }, select: { studentGroupId: true, subjectId: true } })).map(
        (l) => `${l.studentGroupId}|${l.subjectId}`,
      ),
    );
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
        // A post with no lesson placed (the clash rule left it over) has nothing to derive from;
        // every other post must be derived back, so a derivation that drops one fails here.
        if (!laidKeys.has(key(was))) continue;
        const now = got.get(key(was));
        assert.ok(now, `no post for ${key(was)} (${format})`);
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
      assert.ok((codes(p) as string[]).includes(code), `${code} not in ${JSON.stringify(p.rows[0]!.refusals)}`);
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

// ---------------------------------------------------------------------------
// (x-e) the review of PR #256
// ---------------------------------------------------------------------------

/** The posts and blocks of a year, to put back after a check that deletes them. */
async function snapshotOf(owner: Owner, yearId: string) {
  return {
    posts: await owner.teachingRequirement.findMany({ where: { academicYearId: yearId } }),
    blocks: await owner.teachingBlock.findMany({ where: { academicYearId: yearId } }),
  };
}

async function putBack(owner: Owner, school: School, original: string[], snap: Awaited<ReturnType<typeof snapshotOf>>): Promise<void> {
  await wipeLessons(owner, school.yearId);
  await owner.teachingRequirement.deleteMany({ where: { academicYearId: school.yearId } });
  await owner.teachingBlock.deleteMany({ where: { academicYearId: school.yearId } });
  await owner.teachingBlock.createMany({ data: snap.blocks, skipDuplicates: true });
  await owner.teachingRequirement.createMany({ data: snap.posts, skipDuplicates: true });
  await restoreFrom(owner, school, original);
}

/** Pupils for the högstadium: a class's own, and the halves' and language groups' members, so the rosters are not empty. */
async function addPupils(owner: Owner, school: School & { names: Record<string, string> }): Promise<() => Promise<void>> {
  const ids: string[] = [];
  const pupil = async (n: number, home: string, ...groups: string[]) => {
    const row = await owner.user.create({
      data: { schoolId: school.schoolId, authId: randomUUID(), role: 'STUDENT', firstName: `Elev${n}`, lastName: 'Probe', email: `elev${n}-${randomUUID().slice(0, 6)}@probe.example.com`, studentGroupId: school.names[home]! },
    });
    ids.push(row.id);
    for (const g of groups) await owner.studentGroupMember.create({ data: { schoolId: school.schoolId, studentGroupId: school.names[g]!, studentId: row.id } });
  };
  await pupil(1, '7A', '7A-1', 'Sp7');
  await pupil(2, '7A', '7A-1', 'Ty7');
  await pupil(3, '7A', '7A-2', 'Sp7');
  await pupil(4, '7A', '7A-2', 'Fr7');
  await pupil(5, '7B', 'Sp7');
  await pupil(6, '8A');
  return async () => {
    await owner.user.deleteMany({ where: { id: { in: ids } } });
  };
}

async function reviewChecks(
  owner: Owner,
  api: PrismaService,
  exchange: ScheduleExchangeService,
  masterLessons: MasterLessonsService,
  school: School & { names: Record<string, string> },
  original: string[],
  tag: string,
  cleanup: Array<() => Promise<void>>,
): Promise<void> {
  // ---- The cache is the same rule -----------------------------------------
  await check('(x-e) the clash rule answers the same from the file-wide cache as from the database, over a school with pupils', async () => {
    const removePupils = await addPupils(owner, school);
    try {
      const year = await owner.academicYear.findUniqueOrThrow({ where: { id: school.yearId } });
      const compared = await api.withRls(school.admin, async (tx) => {
        const basis = await rostersOfYear(tx, school.admin, school.yearId, { isActive: year.isActive, predecessorId: year.predecessorId });
        const reads = new ConflictReads();
        const lessons = await tx.masterLesson.findMany({ where: { academicYearId: school.yearId, isParked: false }, include: { extraGroups: true } });
        const minutes = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();
        let clashes = 0;
        let n = 0;
        for (const l of lessons) {
          // The lesson itself (it must not clash with itself), as a new lesson (it clashes with itself), and moved to the
          // slot of the next lesson of the week, so that other classes, halves and teachers are in play.
          const next = lessons[(n + 1) % lessons.length]!;
          for (const where of [{ id: l.id, slot: l }, { id: null, slot: l }, { id: null, slot: next }, { id: l.id, slot: next }]) {
            const args = [
              tx,
              basis,
              { id: where.id, academicYearId: school.yearId, studentGroupId: l.studentGroupId, subjectId: l.subjectId },
              {
                dayOfWeek: where.slot.dayOfWeek,
                startMinutes: minutes(where.slot.startTime),
                endMinutes: minutes(where.slot.endTime),
                teacherId: l.teacherId,
                coTeacherId: l.coTeacherId,
                roomId: l.roomId,
                extraGroupIds: l.extraGroups.map((e) => e.studentGroupId),
                studentIds: [],
                recurrence: l.recurrence,
                startDate: l.startDate,
                endDate: l.endDate,
              },
            ] as const;
            const fresh = await masterLessons.findConflicts(args[0], args[1], args[2], args[3]);
            const cached = await masterLessons.findConflicts(args[0], args[1], args[2], args[3], { reads });
            assert.deepEqual(cached, fresh, `lesson ${l.id} ${JSON.stringify(where.slot.dayOfWeek)}`);
            clashes += fresh.length;
          }
          n += 1;
        }
        assert.ok(clashes > 20, `only ${clashes} clashes were compared: the lessons do not meet`);
        return lessons.length * 4;
      });
      assert.ok(compared >= 60, `only ${compared} comparisons`);
    } finally {
      await removePupils();
    }
  });

  // ---- Two applies at once ------------------------------------------------
  await check('(x-e) two applies of one previewed file at once write it once, the other is told', async () => {
    const snap = await snapshotOf(owner, school.yearId);
    try {
      const files = await bytesOf('TABLE_CSV', exchange, school.yearId, school.admin);
      const outcomes: string[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await wipeLessons(owner, school.yearId);
        await owner.teachingRequirement.deleteMany({ where: { academicYearId: school.yearId } });
        await owner.teachingBlock.deleteMany({ where: { academicYearId: school.yearId } });
        const plan = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files }, school.admin);
        assert.equal(plan.canApply, true);
        const dto = { academicYearId: school.yearId, format: 'TABLE_CSV' as const, files, fingerprint: plan.fingerprint };
        const settled = await Promise.allSettled([exchange.apply(dto, school.admin), exchange.apply(dto, school.admin)]);
        const wrote = settled.filter((r) => r.status === 'fulfilled').length;
        const told = settled.flatMap((r) => (r.status === 'rejected' ? [(r.reason as { response?: { code?: string } }).response?.code ?? String(r.reason)] : []));
        outcomes.push(`${wrote} wrote, ${told.join('+') || 'nobody told'}`);
        assert.equal(wrote, 1, `${wrote} applies wrote (${told.join(', ')})`);
        assert.ok(told.every((code) => code === 'IMPORT_PLAN_CHANGED' || code === 'SCHEDULE_BUSY'), `the other was told ${told.join(', ')}`);
        assert.equal(await owner.masterLesson.count({ where: { academicYearId: school.yearId } }), original.length, 'a lesson was written twice');
      }
      assert.equal(outcomes.length, 6);
    } finally {
      await putBack(owner, school, original, snap);
    }
  });

  // ---- A teacher who has left ---------------------------------------------
  await check('(x-e) the school’s own export, read back after a teacher has left, is still "finns redan"', async () => {
    const files = await bytesOf('TABLE_CSV', exchange, school.yearId, school.admin);
    const leaver = await owner.teacherEmployment.findFirstOrThrow({ where: { academicYearId: school.yearId, signature: 'ABE' } });
    await owner.user.update({ where: { id: leaver.userId }, data: { isActive: false } });
    try {
      const plan = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files }, school.admin);
      assert.equal(plan.canApply, true, JSON.stringify(plan.rows.filter((r) => r.action === 'REFUSED').slice(0, 2)));
      assert.equal(plan.summary.unchanged, original.length);
      assert.ok(plan.warnings.some((w) => w.code === 'TEACHER_NO_LONGER_ACTIVE'), 'the teacher who left is not mentioned');
      // A NEW lesson with that teacher is still refused.
      const extra = Buffer.from('Klass/grupp;Ämne;Dag;Start;Slut;Lärare\r\n8B;Svenska;Fre;13:00;14:00;ABE\r\n', 'utf8');
      const fresh = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files: [{ name: 'x.csv', bytes: extra }] }, school.admin);
      assert.deepEqual(fresh.rows[0]!.refusals.map((r) => r.code), ['TEACHER_INACTIVE']);
    } finally {
      await owner.user.update({ where: { id: leaver.userId }, data: { isActive: true } });
    }
  });

  // ---- The läslogg --------------------------------------------------------
  // A school of its own, with an administrator who has read nothing: the log lists a subject once
  // per reader and kind and quarter-hour, so teachers an earlier check already read would hide
  // whether this export logged them.
  await check('(x-e) an export of a school with no lesson yet logs the signed teachers it names', async () => {
    const row = await owner.school.create({ data: { name: `Probe läslogg ${tag}`, slug: `probe-s0-log-${tag}`, timezone: 'Europe/Stockholm' } });
    cleanup.push(async () => {
      await owner.school.delete({ where: { id: row.id } });
    });
    const year = await owner.academicYear.create({
      data: { schoolId: row.id, name: '2026/2027', startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), gradeNumbering: 'NIOARIG', isActive: true },
    });
    await owner.user.create({ data: { schoolId: row.id, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: 'FULL', firstName: 'Ada', lastName: 'Admin', email: `admin-log-${tag}@probe.example.com` } });
    const people: string[] = [];
    for (const [short, first] of [['AAA', 'Anna'], ['BBB', 'Bo'], ['CCC', 'Cia']] as const) {
      const user = await owner.user.create({ data: { schoolId: row.id, authId: randomUUID(), role: 'TEACHER', firstName: first, lastName: 'Utanlektion', email: `${short.toLowerCase()}-log-${tag}@probe.example.com` } });
      await owner.teacherEmployment.create({ data: { schoolId: row.id, userId: user.id, academicYearId: year.id, employmentPercent: 100, signature: short } });
      people.push(user.id);
    }
    const admin = await adminOf(owner, row.id);
    assert.equal(await owner.masterLesson.count({ where: { academicYearId: year.id } }), 0);
    const file = await exchange.export(year.id, 'ASC_XML', admin);
    assert.ok(file.body.toString('utf8').includes('bbb-log-'), 'the file does not name the teachers: the check below would prove nothing');
    const rows = await owner.personalDataAccess.findMany({ where: { schoolId: row.id, kind: 'PEOPLE', actorId: admin.userId! } });
    const logged = new Set(rows.flatMap((r) => r.subjectIds));
    for (const id of people) assert.ok(logged.has(id), 'a teacher the file names is not in the läslogg');
  });

  // ---- Personnummer -------------------------------------------------------
  await check('(x-e) a personnummer in any column is in no answer, and is not stored as a block’s name', async () => {
    const forms = [
      '19800101-1234', '8001011234', '198001011234', '800101-1234', '19800181-1234', 'Anna Berg 19800101-1234', '(800101-1234)', '19800101 - 1234',
      // The second review: other separators, no-break and invisible characters, line breaks, fullwidth digits, the date written as a date.
      '800101.1234', '800101/1234', '800101\u00a01234', '800101\n1234', '800101\u200b1234', '\uff18\uff10\uff10\uff11\uff10\uff11\uff0d\uff11\uff12\uff13\uff14', '1980-01-01-1234', '8 0 0 1 0 1 1 2 3 4',
    ];
    const columns = ['Klass/grupp', 'Ämne', 'Lärare', 'Sal', 'Dag', 'Start', 'Block', 'Veckomönster', 'Från'];
    const base = ['7B', 'Svenska', 'Tis', '15:00', '16:00', 'BLU', 'A102', '', '', ''];
    const header = ['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut', 'Lärare', 'Sal', 'Block', 'Veckomönster', 'Från'];
    for (const form of forms) {
      for (const column of columns) {
        const row = [...base];
        row[header.indexOf(column)] = form;
        const csv = Buffer.from(writeCsv([header, row]), 'utf8');
        const plan = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files: [{ name: 'pn.csv', bytes: csv }] }, school.admin);
        // The answer's own ids and fingerprint are random hex, and one of them now and then holds
        // "1234" or a date-shaped run of digits; that is not the number, so they are left out.
        const answer = JSON.stringify(plan)
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
          .replace(/(?<![0-9a-z])[0-9a-f]{32}(?![0-9a-z])/gi, '<hex>');
        assert.ok(!hasPersonalNumber(answer) && !/1234/.test(answer) && !/\uff11\uff12\uff13\uff14/.test(answer), `the answer to ${JSON.stringify(form)} in ${column} holds the number`);
        assert.equal(plan.canApply, false, `${column}: a row with a number in it was applicable`);
      }
    }
    const names = await owner.teachingBlock.findMany({ where: { academicYearId: school.yearId } });
    assert.ok(names.every((b) => !hasPersonalNumber(b.name)), 'a block is named like a personnummer');
    // And the Block column on its own, which is the one that is STORED: the spellings that would pass a narrow filter.
    const blockHeader = ['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut', 'Block'];
    for (const form of forms) {
      const csv = Buffer.from(writeCsv([blockHeader, ['7B', 'Svenska', 'Fre', '13:00', '14:00', `Val ${form}`]]), 'utf8');
      const plan = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files: [{ name: 'b.csv', bytes: csv }] }, school.admin);
      assert.equal(plan.canApply, false, `a block named ${JSON.stringify(form)} could be applied`);
    }
    assert.equal(await owner.teachingBlock.count({ where: { academicYearId: school.yearId, name: { contains: '1234' } } }), 0);
  });

  await check('(x-e) a block name the database would refuse is a refusal of the row, not a 500', async () => {
    const header = ['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut', 'Block'];
    for (const block of ['x'.repeat(81), 'å'.repeat(200)]) {
      const csv = Buffer.from(writeCsv([header, ['7B', 'Svenska', 'Fre', '13:00', '14:00', block]]), 'utf8');
      const plan = await exchange.preview({ academicYearId: school.yearId, format: 'TABLE_CSV', files: [{ name: 'b.csv', bytes: csv }] }, school.admin);
      assert.deepEqual(plan.rows[0]!.refusals.map((r) => r.code), ['BAD_BLOCK_NAME']);
      await assert.rejects(
        exchange.apply({ academicYearId: school.yearId, format: 'TABLE_CSV', files: [{ name: 'b.csv', bytes: csv }], fingerprint: plan.fingerprint }, school.admin),
        (e: unknown) => (e as { response?: { code?: string } }).response?.code === 'IMPORT_HAS_REFUSALS',
      );
    }
    void tag;
  });
}

// ---------------------------------------------------------------------------
// (x-f) a file of 5 000 rows
// ---------------------------------------------------------------------------

/**
 * 125 classes of grade 5, each with 40 lessons a week (five days, eight hours)
 * and no pupils, in a school of its own with the generator's lunch on: the
 * file the review (H6) timed at 76 s to preview and 80 s to apply, and held
 * the year's lock and a connection for the whole of it. Checked with a bound
 * far above what it takes on a loaded machine and far below what it took.
 */
async function bigFileChecks(owner: Owner, exchange: ScheduleExchangeService, masterLessons: MasterLessonsService, tag: string, cleanup: Array<() => Promise<void>>): Promise<void> {
  let school: School | undefined;
  await check('(x-f) a school with 125 classes is made', async () => {
    const row = await owner.school.create({ data: { name: `Probe stor skola ${tag}`, slug: `probe-s0-big-${tag}`, timezone: 'Europe/Stockholm' } });
    cleanup.push(async () => {
      await owner.school.delete({ where: { id: row.id } });
    });
    const year = await owner.academicYear.create({
      data: { schoolId: row.id, name: '2026/2027', startDate: new Date('2026-08-17'), endDate: new Date('2027-06-11'), gradeNumbering: 'NIOARIG', isActive: true },
    });
    await owner.user.create({ data: { schoolId: row.id, authId: randomUUID(), role: 'SCHOOL_ADMIN', adminProfile: 'FULL', firstName: 'Ada', lastName: 'Admin', email: `admin-big-${tag}@probe.example.com` } });
    await owner.subject.createMany({ data: ['Matematik', 'Svenska', 'Engelska', 'Idrott', 'Bild', 'Musik', 'NO', 'SO'].map((name) => ({ schoolId: row.id, name })) });
    await owner.studentGroup.createMany({
      data: Array.from({ length: 125 }, (_v, i) => ({ schoolId: row.id, academicYearId: year.id, name: `Z${String(i + 1).padStart(3, '0')}`, kind: 'CLASS' as const, gradeLevel: 5 })),
    });
    await owner.lunchSetting.create({ data: { schoolId: row.id, lunchEnabled: true, lunchStartTime: time('11:00'), lunchEndTime: time('13:00'), lunchMinutes: 30 } });
    school = { schoolId: row.id, yearId: year.id, admin: await adminOf(owner, row.id) };
  });
  if (!school) return;
  const big = school;

  const subjects = ['Matematik', 'Svenska', 'Engelska', 'Idrott', 'Bild', 'Musik', 'NO', 'SO'];
  const starts = ['08:00', '09:00', '10:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
  const days = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre'];
  const rows: string[][] = [];
  let n = 0;
  for (let c = 1; c <= 125; c += 1) {
    for (const d of days) {
      for (const st of starts) {
        const h = Number(st.slice(0, 2));
        rows.push([`Z${String(c).padStart(3, '0')}`, subjects[n % subjects.length]!, d, st, `${String(h + 1).padStart(2, '0')}:00`]);
        n += 1;
      }
    }
  }
  const files = [{ name: 'big.csv', bytes: Buffer.from(writeCsv([['Klass/grupp', 'Ämne', 'Dag', 'Start', 'Slut'], ...rows]), 'utf8') }];

  let fingerprint = '';
  await check('(x-f) 5 000 rows preview in seconds', async () => {
    const started = Date.now();
    const plan = await exchange.preview({ academicYearId: big.yearId, format: 'TABLE_CSV', files }, big.admin);
    const ms = Date.now() - started;
    console.log(`     5 000-row preview: ${ms} ms`);
    assert.equal(plan.summary.rows, 5000);
    assert.equal(plan.canApply, true, JSON.stringify(plan.rows.filter((r) => r.action === 'REFUSED').slice(0, 2)));
    assert.ok(ms < BIG_PREVIEW_MS, `${ms} ms`);
    fingerprint = plan.fingerprint;
  });
  await check('(x-f) 5 000 rows apply in seconds, and all are written', async () => {
    const started = Date.now();
    const done = await exchange.apply({ academicYearId: big.yearId, format: 'TABLE_CSV', files, fingerprint }, big.admin);
    const ms = Date.now() - started;
    console.log(`     5 000-row apply: ${ms} ms`);
    assert.equal(done.created, 5000);
    assert.equal(await owner.masterLesson.count({ where: { academicYearId: big.yearId } }), 5000);
    assert.ok(ms < BIG_APPLY_MS, `${ms} ms`);
  });
  await check('(x-f) the same file again is all "finns redan"', async () => {
    const plan = await exchange.preview({ academicYearId: big.yearId, format: 'TABLE_CSV', files }, big.admin);
    assert.equal(plan.summary.unchanged, 5000);
    assert.equal(plan.summary.create, 0);
  });
  await check('(x-f) a hand edit made while an import is written waits for it and does not double-book', async () => {
    await owner.masterLesson.deleteMany({ where: { academicYearId: big.yearId } });
    const plan = await exchange.preview({ academicYearId: big.yearId, format: 'TABLE_CSV', files }, big.admin);
    const klass = await owner.studentGroup.findFirstOrThrow({ where: { academicYearId: big.yearId, name: 'Z001' } });
    const subject = await owner.subject.findFirstOrThrow({ where: { schoolId: big.schoolId, name: 'Bild' } });
    const importing = exchange.apply({ academicYearId: big.yearId, format: 'TABLE_CSV', files, fingerprint: plan.fingerprint }, big.admin);
    // Settled either way, so the import's own failure is not swallowed by the edit's.
    const imported = importing.then(() => 'ok' as const, (error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // The file also lays Z001 on Monday 08:00-09:00 (with another subject): the edit's slot is the import's.
    const edited = await masterLessons
      .create({ academicYearId: big.yearId, subjectId: subject.id, studentGroupId: klass.id, dayOfWeek: 1, startTime: '08:00', endTime: '09:00' } as never, big.admin)
      .then(() => 'created' as const, (error: unknown) => error);
    assert.equal(await imported, 'ok', 'the import did not go through');
    assert.notEqual(edited, 'created', 'the hand edit was let in beside the import');
    const code = (edited as { response?: { code?: string } }).response?.code;
    assert.ok(code === 'SCHEDULE_BUSY' || edited instanceof ConflictException, `the hand edit was answered ${String(code ?? edited)}`);
    const there = await owner.masterLesson.count({ where: { academicYearId: big.yearId, studentGroupId: klass.id, dayOfWeek: 1, startTime: time('08:00') } });
    assert.equal(there, 1, `${there} lessons in one slot`);
  });
}

/** Generous: what the review measured was 76 s and 80 s; a loaded Mac and a CI runner both have to pass. */
const BIG_PREVIEW_MS = 45_000;
const BIG_APPLY_MS = 60_000;

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
