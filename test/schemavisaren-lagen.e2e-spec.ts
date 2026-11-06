import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../src/auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../src/database/prisma.service';
import { MISSES } from '../src/publication/viewer-miss-limiter';
import { createTestApp, type TestHarness } from './utils/test-app';

/**
 * Schemavisarens lägen (20270118090000), against a database that has the
 * migrations (docker compose up, prisma migrate deploy): the viewer's open
 * routes asked as every kind of caller, in two schools, through the real
 * gateway and the real database under row security. The unit and mocked-e2e
 * suites cannot see this: what a stranger may read is decided by SQL.
 *
 * Two schools, each planted here as the owner and removed after: one with a
 * class, a teaching group, a room, two teachers, six pupils with a guardian
 * and a week of lessons on days near today; the other with a class, a
 * teacher and a pupil, to prove one school's settings, codes and marks reach
 * nobody in the other. Callers: a visitor (no principal), a pupil, a
 * guardian, a teacher and an administrator, of the school and of the other.
 *
 *   lg-a  the modes: nothing answers while every kind is off; CODE answers a
 *         link to one target and no list; LIST a list and its targets; a
 *         pupil by a code alone; a code typed any way a person types it;
 *   lg-b  the codes are drawn, kept as their hash, and the link list says
 *         why a link does not answer (to the administrator, never the visitor);
 *   lg-c  a viewer for staff: a visitor and another school's staff, a pupil
 *         and a guardian get the one not-found (or their role's refusal on
 *         the signed-in route); the school's own teacher and administrator
 *         read the page;
 *   lg-d  hidden schedules, and that hidden reads as not there;
 *   lg-e  a protected identity: a teacher, a pupil, a pupil's guardian, in
 *         every mode, on the page, in the list, in a new code, and in the
 *         calendar feeds' naming of others;
 *   lg-f  the settings' own refusals and who may write them;
 *   lg-g  the rate limit on links that do not exist;
 *   lg-h  the frames: only for a viewer open to everyone, never a pupil's;
 *   lg-i  the calendar feeds follow no viewer mode, and name no marked teacher.
 */

const DATABASE = process.env['LAGEN_DATABASE_URL'];
const OWNER = process.env['LAGEN_OWNER_URL'];
const KEY = 'test-viewer-proxy-key-of-at-least-32-chars';
const SLUGS = ['lagen-a', 'lagen-b'];
const maybe = DATABASE && OWNER ? describe : describe.skip;

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
/** The Monday of the week that holds `day`. */
const mondayOf = (day: string) => {
  const at = Date.parse(`${day}T00:00:00Z`);
  return new Date(at - ((new Date(at).getUTCDay() + 6) % 7) * DAY).toISOString().slice(0, 10);
};
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const CODE = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;
const NOT_FOUND = { type: 'about:blank', title: 'Not Found', status: 404, detail: 'Schemat finns inte.' };

interface School {
  id: string;
  year: string;
  cls: string;
  group?: string;
  room?: string;
  admin: AuthenticatedUser;
  teacher: AuthenticatedUser;
  colleague?: AuthenticatedUser;
  pupil: AuthenticatedUser;
  guardian?: AuthenticatedUser;
  pupils: string[];
}

maybe('Schemavisarens lägen: the open routes as every caller, in two schools (a real database)', () => {
  let harness: TestHarness;
  let prisma: PrismaService;
  let owner: Client;
  let a: School;
  let b: School;
  const http = () => harness.app.getHttpServer();
  let address = 0;
  /** A fresh viewer address for each ask, so no test spends another's rate limit. */
  const fresh = () => ({ 'X-Viewer-Client-Ip': `10.77.${Math.floor(++address / 250)}.${address % 250}`, 'X-Viewer-Proxy-Key': KEY });
  const as = (user: AuthenticatedUser) => ({ 'x-test-user': JSON.stringify(user) });

  async function plant(slug: string, full: boolean): Promise<School> {
    const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await owner.query<T>(text, values)).rows;
    const [{ id: school }] = await q<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`Lägen ${slug}`, slug]);
    const [{ id: year }] = await q<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, '2026/27', $2, $3, true, now()) RETURNING id`,
      [school, iso(-60), iso(250)],
    );
    const person = async (role: string, first: string, last: string, extra = '', values: unknown[] = []) => {
      const authId = randomUUID();
      const [{ id }] = await q<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", "authId", role, "firstName", "lastName", email, "isActive", "updatedAt"${extra ? ', ' + extra.split('=')[0] : ''})
         VALUES ($1, $2, $3, $4, $5, $6, true, now()${extra ? ', $7' : ''}) RETURNING id`,
        [school, authId, role, first, last, `${first}.${last}.${slug}@example.invalid`.toLowerCase(), ...values],
      );
      return { authId, id };
    };
    const adminRow = await person('SCHOOL_ADMIN', 'Rut', `Rektor${slug}`);
    await q(`UPDATE "Users" SET "adminProfile" = 'FULL' WHERE id = $1`, [adminRow.id]);
    const teacherRow = await person('TEACHER', 'Kalle', `Kxalfa${slug}`);
    const [{ id: cls }] = await q<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt") VALUES ($1, $2, '7K', 'CLASS', now()) RETURNING id`, [school, year]);
    const pupilRows = [];
    for (let i = 1; i <= (full ? 6 : 1); i++) pupilRows.push(await person('STUDENT', `Elev${i}`, `Ek${slug}`, '"studentGroupId"', [cls]));
    const principal = (role: Role, row: { authId: string; id: string }, extra: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
      ({ authId: row.authId, role, userId: row.id, schoolId: school, ...extra }) as AuthenticatedUser;
    const out: School = {
      id: school,
      year,
      cls,
      admin: principal(Role.SCHOOL_ADMIN, adminRow, { adminProfile: 'FULL', hrRead: false } as Partial<AuthenticatedUser>),
      teacher: principal(Role.TEACHER, teacherRow),
      pupil: principal(Role.STUDENT, pupilRows[0]!),
      pupils: pupilRows.map((row) => row.id),
    };
    await q(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt") VALUES ($1, $2, $3, 100, 'KXA', now())`, [school, teacherRow.id, year]);
    const [{ id: subject }] = await q<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, 'Matematik', now()) RETURNING id`, [school]);
    const [{ id: room }] = await q<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, 'Sal 1', now()) RETURNING id`, [school]);
    out.room = room;
    const monday = mondayOf(iso(7));
    const lesson = async (group: string, day: number, hour: number, status: string, teacher: string) => {
      const date = new Date(Date.parse(`${monday}T00:00:00Z`) + day * DAY).toISOString().slice(0, 10);
      const [{ id }] = await q<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, "updatedAt")
         VALUES ($1, $2, $3, $4, $5, ($5::date + $6 * interval '1 hour') AT TIME ZONE 'Europe/Stockholm', ($5::date + ($6 + 1) * interval '1 hour') AT TIME ZONE 'Europe/Stockholm', $7, now()) RETURNING id`,
        [school, subject, group, room, date, hour, status],
      );
      await q(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'LEAD')`, [school, id, teacher]);
      return id;
    };
    await lesson(cls, 1, 8, 'SCHEDULED', teacherRow.id);
    if (full) {
      const colleagueRow = await person('TEACHER', 'Lena', `Lxbeta${slug}`);
      out.colleague = principal(Role.TEACHER, colleagueRow);
      await q(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt") VALUES ($1, $2, $3, 100, 'LXB', now())`, [school, colleagueRow.id, year]);
      const [{ id: group }] = await q<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt") VALUES ($1, $2, 'Ma7', 'TEACHING_GROUP', now()) RETURNING id`, [school, year]);
      out.group = group;
      for (const pupil of out.pupils.slice(0, 5)) await q(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [school, group, pupil]);
      await lesson(group, 2, 10, 'SCHEDULED', colleagueRow.id);
      // The class's second lesson has both teachers on it: the colleague named beside the first.
      const second = await lesson(cls, 3, 9, 'SCHEDULED', colleagueRow.id);
      await q(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'ASSISTANT')`, [school, second, teacherRow.id]);
      const guardianRow = await person('GUARDIAN', 'Vera', `Vxgamma${slug}`);
      out.guardian = principal(Role.GUARDIAN, guardianRow);
      await q(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [school, guardianRow.id, out.pupils[0]]);
    }
    return out;
  }

  beforeAll(async () => {
    process.env['DATABASE_URL'] = DATABASE;
    owner = new Client({ connectionString: OWNER });
    await owner.connect();
    await owner.query(`DELETE FROM "Schools" WHERE slug = ANY ($1)`, [SLUGS]);
    prisma = new PrismaService();
    await prisma.$connect();
    harness = await createTestApp({ configure: (builder) => builder.overrideProvider(PrismaService).useValue(prisma) });
    await harness.app.listen(0, '127.0.0.1');
    a = await plant(SLUGS[0]!, true);
    b = await plant(SLUGS[1]!, false);
  });

  afterAll(async () => {
    await harness?.close();
    await prisma?.$disconnect();
    if (owner) {
      // LAGEN_KEEP=1 leaves the two schools in the database, to look at what a failing run left.
      if (!process.env['LAGEN_KEEP']) await owner.query(`DELETE FROM "Schools" WHERE slug = ANY ($1)`, [SLUGS]).catch(() => undefined);
      await owner.end();
    }
  });

  const settings = (school: School, body: Record<string, unknown>) => request(http()).put('/api/v1/publication-settings').set(as(school.admin)).send(body);
  const link = async (school: School, body: Record<string, unknown>) => {
    const made = await request(http()).post('/api/v1/public-links').set(as(school.admin)).send({ academicYearId: school.year, ...body }).expect(201);
    return made.body as { link: { id: string; notShownBecause: string | null; embeddable: boolean; targetId: string | null }; token: string };
  };
  const viewer = (token: string, query = '') => request(http()).get(`/public/v1/timetables/${token}${query}`).set(fresh());
  const staffRoute = (token: string, user: AuthenticatedUser | null, query = '') => {
    const call = request(http()).get(`/api/v1/schemavisaren/${token}${query}`);
    return user ? call.set(as(user)) : call;
  };
  const week = `?date=${mondayOf(iso(7))}`;
  const everyKind = (mode: 'OFF' | 'LIST' | 'CODE') => ({
    viewerClassMode: mode,
    viewerGroupMode: mode,
    viewerRoomMode: mode,
    viewerTeacherMode: mode,
    viewerStudentMode: mode === 'LIST' ? 'CODE' : mode,
  });

  const codes: Record<string, { token: string; id: string }> = {};
  /** What a list calls its entries (never the database's id of them). */
  const handles: Record<string, string> = {};
  let otherSchoolClass: { token: string; id: string };

  it('lg-a: with every kind off nothing answers; CODE answers a link to one target and no list; LIST a list; a pupil by a code alone', async () => {
    await settings(a, { publicTeacherDisplay: 'SIGNATURE', viewerAudience: 'EVERYONE', ...everyKind('OFF') }).expect(200);
    await settings(b, { publicTeacherDisplay: 'SIGNATURE', viewerAudience: 'EVERYONE', ...everyKind('OFF') }).expect(200);
    for (const [name, body] of Object.entries({
      cls: { kind: 'GROUP', targetId: a.cls },
      classes: { kind: 'GROUP' },
      group: { kind: 'GROUP', targetId: a.group },
      room: { kind: 'ROOM', targetId: a.room },
      rooms: { kind: 'ROOM' },
      teacher: { kind: 'TEACHER', targetId: a.teacher.userId },
      teachers: { kind: 'TEACHER' },
      pupil: { kind: 'STUDENT', targetId: a.pupils[0], label: 'Barn 1' },
      pupil2: { kind: 'STUDENT', targetId: a.pupils[1] },
    })) {
      const made = await link(a, body as Record<string, unknown>);
      codes[name] = { token: made.token, id: made.link.id };
      expect(made.token).toMatch(CODE);
    }
    const made = await link(b, { kind: 'GROUP', targetId: b.cls });
    otherSchoolClass = { token: made.token, id: made.link.id };

    // Every kind off: the one not-found for all, however it is asked, and the same bytes as for a code that was never made.
    const never = await viewer('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', week).expect(404);
    expect(never.body).toEqual(NOT_FOUND);
    for (const { token } of Object.values(codes)) {
      const answer = await viewer(token, week).expect(404);
      expect(answer.body).toEqual(never.body);
      expect(answer.headers['cache-control']).toBe('no-store');
    }
    // The administrator, and only the administrator, is told why.
    const listed = (await request(http()).get(`/api/v1/public-links?academicYearId=${a.year}`).set(as(a.admin)).expect(200)).body as { id: string; notShownBecause: string | null }[];
    expect(listed.length).toBe(Object.keys(codes).length);
    expect(new Set(listed.map((row) => row.notShownBecause))).toEqual(new Set(['VIEWER_OFF']));
    for (const caller of [a.teacher, a.pupil, a.guardian!]) await request(http()).get(`/api/v1/public-links?academicYearId=${a.year}`).set(as(caller)).expect(403);

    // CODE: each link to one target answers; no list does.
    await settings(a, everyKind('CODE')).expect(200);
    for (const name of ['cls', 'group', 'room', 'teacher', 'pupil']) {
      const answer = await viewer(codes[name]!.token, week).expect(200);
      expect(answer.headers['cache-control']).toBe('public, max-age=60, s-maxage=60');
      expect(answer.headers['set-cookie']).toBeUndefined();
    }
    for (const name of ['classes', 'rooms', 'teachers']) expect((await viewer(codes[name]!.token).expect(404)).body).toEqual(NOT_FOUND);
    expect((await viewer(codes['classes']!.token, `?target=${a.cls}`).expect(404)).body).toEqual(NOT_FOUND);
    const pupilPage = (await viewer(codes['pupil']!.token, week).expect(200)).body as { title: string; days: { lessons: Record<string, unknown>[] }[] };
    expect(pupilPage.title).toBe('Barn 1');
    expect((await viewer(codes['pupil2']!.token, week).expect(200)).body).toMatchObject({ title: '' });
    const keys = new Set(pupilPage.days.flatMap((day) => day.lessons.flatMap((lesson) => Object.keys(lesson))));
    expect([...keys].sort()).toEqual(['cancelled', 'end', 'groups', 'room', 'start', 'subject', 'teachers']);
    expect(pupilPage.days.flatMap((day) => day.lessons).every((lesson) => (lesson['groups'] as unknown[]).length === 0)).toBe(true);

    // LIST for classes and rooms: the list holds its kind, and a listed target opens through it.
    await settings(a, { viewerClassMode: 'LIST', viewerRoomMode: 'LIST', viewerTeacherMode: 'LIST', viewerGroupMode: 'CODE' }).expect(200);
    const classList = (await viewer(codes['classes']!.token).expect(200)).body as { kind: string; targets: { id: string; label: string }[] };
    expect(classList.kind).toBe('GROUP');
    expect(classList.targets.map((target) => target.label)).toEqual(['7K']);
    // A list names its entries by its own handle, never by the database's id: the handle opens the class, the id opens nothing.
    expect(JSON.stringify(classList)).not.toContain(a.cls);
    handles['cls'] = classList.targets[0]!.id;
    await viewer(codes['classes']!.token, `?target=${handles['cls']}&date=${mondayOf(iso(7))}`).expect(200);
    await viewer(codes['classes']!.token, `?target=${a.cls}&date=${mondayOf(iso(7))}`).expect(404);
    await viewer(codes['classes']!.token, `?target=${a.group}`).expect(404);
    const teacherList = (await viewer(codes['teachers']!.token).expect(200)).body as { targets: { id: string; label: string }[] };
    expect(teacherList.targets.map((target) => target.label)).toEqual(['KXA', 'LXB']);
    expect(JSON.stringify(teacherList)).not.toContain(a.teacher.userId!);
    handles['teacher'] = teacherList.targets[0]!.id;
    await viewer(codes['rooms']!.token).expect(200);
    // A pupil is reached by their own code and by nothing else: a list takes no pupil as its target.
    await viewer(codes['classes']!.token, `?target=${a.pupils[0]}`).expect(404);
    await viewer(codes['teachers']!.token, `?target=${a.pupils[0]}`).expect(404);

    // A code typed as a person types it opens the same page; a mistyped one is the one not-found.
    const typed = codes['cls']!.token.toLowerCase().replaceAll('-', ' ');
    expect((await viewer(encodeURIComponent(typed), week).expect(200)).body).toEqual((await viewer(codes['cls']!.token, week).expect(200)).body);
    await viewer(codes['cls']!.token.slice(0, -1) + (codes['cls']!.token.endsWith('0') ? '1' : '0'), week).expect(404);

    // One school's modes reach nobody in the other: school B never turned anything on.
    await viewer(otherSchoolClass.token, week).expect(404);
    await settings(b, { viewerClassMode: 'CODE' }).expect(200);
    await viewer(otherSchoolClass.token, week).expect(200);
    await settings(a, { viewerClassMode: 'OFF' }).expect(200);
    await viewer(otherSchoolClass.token, week).expect(200);
    await viewer(codes['cls']!.token, week).expect(404);
    await settings(a, { viewerClassMode: 'CODE' }).expect(200);
  });

  it('lg-b: a code is drawn and kept as its hash alone; an old token still opens; the list says why a link is shut', async () => {
    const rows = (await owner.query<{ tokenHash: string }>(`SELECT "tokenHash" FROM "PublicTimetableLinks" WHERE "schoolId" = $1`, [a.id])).rows;
    for (const { token } of Object.values(codes)) {
      const canonical = token.replaceAll('-', '');
      expect(rows.map((row) => row.tokenHash)).toContain(sha(canonical));
      expect(rows.map((row) => row.tokenHash)).not.toContain(sha(token));
    }
    const text = (await owner.query<{ t: string }>(`SELECT string_agg(l::text, ' ') AS t FROM "PublicTimetableLinks" l WHERE "schoolId" = $1`, [a.id])).rows[0]!.t;
    for (const { token } of Object.values(codes)) expect(text).not.toContain(token.replaceAll('-', ''));
    // A link made before the lägen, a 43-character token, opens as it did.
    const legacy = 'L'.repeat(43);
    await owner.query(
      `INSERT INTO "PublicTimetableLinks" ("schoolId", "academicYearId", kind, "targetGroupId", "tokenHash") VALUES ($1, $2, 'GROUP', $3, $4)`,
      [a.id, a.year, a.cls, sha(legacy)],
    );
    await viewer(legacy, week).expect(200);
    await settings(a, { viewerClassMode: 'OFF' }).expect(200);
    const listed = (await request(http()).get(`/api/v1/public-links?academicYearId=${a.year}`).set(as(a.admin)).expect(200)).body as { id: string; kind: string; targetId: string | null; notShownBecause: string | null }[];
    const reason = (name: string) => listed.find((row) => row.id === codes[name]!.id)!.notShownBecause;
    expect(reason('cls')).toBe('SCOPE_OFF');
    // The class list is not the classes' to answer; the groups are still in CODE mode, which has no list.
    expect(reason('classes')).toBe('INDEX_NOT_LISTED');
    expect(reason('teachers')).toBeNull();
    await settings(a, { viewerClassMode: 'CODE' }).expect(200);
    const again = (await request(http()).get(`/api/v1/public-links?academicYearId=${a.year}`).set(as(a.admin)).expect(200)).body as typeof listed;
    expect(again.find((row) => row.id === codes['classes']!.id)!.notShownBecause).toBe('INDEX_NOT_LISTED');
    expect(again.find((row) => row.id === codes['cls']!.id)!.notShownBecause).toBeNull();
    await settings(a, { viewerClassMode: 'LIST' }).expect(200);
  });

  it('lg-c: a viewer for staff answers a visitor as an unknown link, and only the school\'s own teacher and administrator read it', async () => {
    const open = (await viewer(codes['cls']!.token, week).expect(200)).body;
    await settings(a, { viewerAudience: 'STAFF' }).expect(200);
    for (const name of ['cls', 'classes', 'room', 'teacher', 'pupil']) {
      expect((await viewer(codes[name]!.token, week).expect(404)).body).toEqual(NOT_FOUND);
      // The signed-in route for staff reads it.
      const own = await staffRoute(codes[name]!.token, a.teacher, week).expect(200);
      expect(own.headers['cache-control']).toBe('private, no-store');
      await staffRoute(codes[name]!.token, a.admin, week).expect(200);
      await staffRoute(codes[name]!.token, a.colleague!, week).expect(200);
      // Another school's staff, a pupil and a guardian of this one: not-found, or their role's refusal.
      await staffRoute(codes[name]!.token, b.teacher, week).expect(404);
      await staffRoute(codes[name]!.token, b.admin, week).expect(404);
      await staffRoute(codes[name]!.token, a.pupil, week).expect(403);
      await staffRoute(codes[name]!.token, a.guardian!, week).expect(403);
      await staffRoute(codes[name]!.token, null, week).expect(401);
    }
    expect((await staffRoute(codes['cls']!.token, a.teacher, week).expect(200)).body).toEqual(open);
    // A viewer for staff is framed nowhere.
    await settings(a, { publicEmbedOrigins: ['https://skolan.example'], publicEmbedGroups: true }).expect(200);
    await request(http()).get(`/public/v1/timetables/${codes['cls']!.token}/embed`).set(fresh()).expect(404);
    // Open to everyone again: the staff route and the open one agree.
    await settings(a, { viewerAudience: 'EVERYONE' }).expect(200);
    expect((await staffRoute(codes['cls']!.token, a.teacher, week).expect(200)).body).toEqual((await viewer(codes['cls']!.token, week).expect(200)).body);
    expect((await request(http()).get(`/public/v1/timetables/${codes['cls']!.token}/embed`).set(fresh()).expect(200)).body).toEqual({ frameAncestors: ['https://skolan.example'] });
    // A pupil's page is framed nowhere, with everything on.
    await settings(a, { publicEmbedTeachers: true, publicEmbedRooms: true }).expect(200);
    await request(http()).get(`/public/v1/timetables/${codes['pupil']!.token}/embed`).set(fresh()).expect(404);
    const view = (await request(http()).get(`/api/v1/public-links?academicYearId=${a.year}`).set(as(a.admin)).expect(200)).body as { id: string; embeddable: boolean }[];
    expect(view.find((row) => row.id === codes['pupil']!.id)!.embeddable).toBe(false);
    expect(view.find((row) => row.id === codes['cls']!.id)!.embeddable).toBe(true);
  });

  it('lg-d: a hidden class, group, room or pupil is found by no link and no list, and reads as not there', async () => {
    const hide = (user: AuthenticatedUser, kind: string, id: string, hidden = true) => request(http()).put(`/api/v1/viewer-hidden/${kind}/${id}`).set(as(user)).send({ hidden });
    await settings(a, { viewerClassMode: 'LIST', viewerRoomMode: 'LIST', viewerStudentMode: 'CODE' }).expect(200);
    await viewer(codes['cls']!.token, week).expect(200);
    for (const caller of [a.teacher, a.pupil, a.guardian!]) await hide(caller, 'group', a.cls).expect(403);
    // Another school's administrator cannot hide this school's class (a key that names another school's group is refused).
    expect(((await hide(b.admin, 'group', a.cls)).status)).toBeGreaterThanOrEqual(400);
    await hide(a.admin, 'group', a.cls).expect(200);
    await hide(a.admin, 'room', a.room!).expect(200);
    await hide(a.admin, 'student', a.pupils[0]!).expect(200);
    expect((await request(http()).get('/api/v1/viewer-hidden').set(as(a.admin)).expect(200)).body).toEqual({ groups: [a.cls], rooms: [a.room], students: [a.pupils[0]] });
    await request(http()).get('/api/v1/viewer-hidden').set(as(a.teacher)).expect(403);
    const never = (await viewer('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', week).expect(404)).body;
    for (const name of ['cls', 'room', 'pupil']) expect((await viewer(codes[name]!.token, week).expect(404)).body).toEqual(never);
    await viewer(codes['classes']!.token, `?target=${handles['cls']}`).expect(404);
    expect(((await viewer(codes['classes']!.token).expect(200)).body as { targets: unknown[] }).targets).toEqual([]);
    const reasons = (await request(http()).get(`/api/v1/public-links?academicYearId=${a.year}`).set(as(a.admin)).expect(200)).body as { id: string; notShownBecause: string | null }[];
    expect(reasons.find((row) => row.id === codes['cls']!.id)!.notShownBecause).toBe('TARGET_HIDDEN');
    await hide(a.admin, 'group', a.cls, false).expect(200);
    await hide(a.admin, 'room', a.room!, false).expect(200);
    await hide(a.admin, 'student', a.pupils[0]!, false).expect(200);
    for (const name of ['cls', 'room', 'pupil']) await viewer(codes[name]!.token, week).expect(200);
    // A teacher is hidden by the label that was there before the lägen.
    await request(http()).put(`/api/v1/teacher-public-labels/${a.teacher.userId}`).set(as(a.admin)).send({ hidden: true }).expect(200);
    await viewer(codes['teacher']!.token, week).expect(404);
    expect((await viewer(codes['cls']!.token, week).expect(200)).text).not.toContain('KXA');
    await request(http()).put(`/api/v1/teacher-public-labels/${a.teacher.userId}`).set(as(a.admin)).send({ hidden: false }).expect(200);
  });

  it('lg-e: a protected identity is in no page, no list and no new code, in any mode and for any audience', async () => {
    const mark = (user: string) => owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'SS12000') ON CONFLICT DO NOTHING`, [user, a.id]);
    const lift = () => owner.query(`DELETE FROM "PersonProtections" WHERE "schoolId" = $1`, [a.id]);
    const wire = async (user?: AuthenticatedUser) => {
      const pages = await Promise.all(['cls', 'room', 'teacher', 'pupil', 'pupil2', 'teachers'].map(async (name) => {
        const answer = user ? await staffRoute(codes[name]!.token, user, week) : await viewer(codes[name]!.token, week);
        return [name, answer.status, answer.text] as const;
      }));
      return Object.fromEntries(pages.map(([name, status, text]) => [name, { status, text }]));
    };
    for (const audience of ['EVERYONE', 'STAFF'] as const) {
      for (const mode of ['LIST', 'CODE'] as const) {
        await settings(a, { viewerAudience: audience, ...everyKind(mode) }).expect(200);
        const reader = audience === 'STAFF' ? a.teacher : undefined;
        await lift();
        const before = await wire(reader);
        expect(before['cls']!.text).toContain('KXA');
        expect(before['teacher']!.status).toBe(200);
        expect(before['pupil']!.status).toBe(200);
        // A teacher with a mark.
        await mark(a.teacher.userId!);
        const marked = await wire(reader);
        expect(marked['teacher']!.status).toBe(404);
        for (const page of Object.values(marked)) expect(page.text).not.toMatch(/KXA|Kalle|Kxalfa/);
        expect(marked['cls']!.text).toContain('LXB');
        await lift();
        // A pupil with a mark, and a pupil whose guardian has one.
        await mark(a.pupils[0]!);
        expect((await wire(reader))['pupil']!.status).toBe(404);
        await lift();
        await mark(a.guardian!.userId!);
        const guarded = await wire(reader);
        expect(guarded['pupil']!.status).toBe(404);
        // The guardian's other children are not the point; no document names the guardian.
        for (const page of Object.values(guarded)) expect(page.text).not.toMatch(/Vera|Vxgamma/);
        await lift();
        expect((await wire(reader))['pupil']!.status).toBe(200);
      }
    }
    // The answer for a protected page is the answer for no page, byte for byte, and the link list tells only the administrator.
    await settings(a, { viewerAudience: 'EVERYONE', ...everyKind('CODE') }).expect(200);
    await mark(a.teacher.userId!);
    const gone = await viewer(codes['teacher']!.token, week).expect(404);
    expect(gone.body).toEqual((await viewer('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', week).expect(404)).body);
    const listed = (await request(http()).get(`/api/v1/public-links?academicYearId=${a.year}`).set(as(a.admin)).expect(200)).body as { id: string; notShownBecause: string | null }[];
    expect(listed.find((row) => row.id === codes['teacher']!.id)!.notShownBecause).toBe('PROTECTED');
    // No new code for a marked teacher or pupil.
    const refused = await request(http()).post('/api/v1/public-links').set(as(a.admin)).send({ academicYearId: a.year, kind: 'TEACHER', targetId: a.teacher.userId }).expect(400);
    expect(refused.body.code).toBe('PUBLIC_TEACHER_NOT_SHOWABLE');
    await lift();
    await mark(a.pupils[2]!);
    const refusedPupil = await request(http()).post('/api/v1/public-links').set(as(a.admin)).send({ academicYearId: a.year, kind: 'STUDENT', targetId: a.pupils[2] }).expect(400);
    expect(refusedPupil.body.code).toBe('PUBLIC_STUDENT_NOT_SHOWABLE');
    await lift();
  });

  it('lg-f: the settings refuse a list of pupils and teachers shown by nobody\'s name, and only an administrator writes them', async () => {
    const list = await settings(a, { viewerStudentMode: 'LIST' }).expect(400);
    expect(list.body.code).toBe('PUBLIC_STUDENTS_NOT_LISTED');
    await settings(a, { publicTeacherDisplay: 'NONE' }).expect(400).then((answer) => expect(answer.body.code).toBe('PUBLIC_TEACHERS_UNNAMED'));
    await settings(a, { viewerTeacherMode: 'OFF' }).expect(200);
    await settings(a, { publicTeacherDisplay: 'NONE' }).expect(200);
    await settings(a, { viewerTeacherMode: 'CODE' }).expect(400).then((answer) => expect(answer.body.code).toBe('PUBLIC_TEACHERS_UNNAMED'));
    await settings(a, { publicTeacherDisplay: 'SIGNATURE', viewerTeacherMode: 'CODE' }).expect(200);
    for (const caller of [a.teacher, a.pupil, a.guardian!, b.admin]) {
      const answer = await request(http()).put('/api/v1/publication-settings').set(as(caller)).send({ viewerAudience: 'EVERYONE' });
      // Another school's administrator writes their own school's settings, never this one's.
      if (caller === b.admin) expect(answer.status).toBe(200);
      else expect(answer.status).toBe(403);
    }
    const stored = (await owner.query(`SELECT "schoolId", "viewerAudience", "viewerStudentMode", "publicViewerEnabled", "publicGroups", "publicTeachers", "publicRooms" FROM "PublicationSettings" WHERE "schoolId" = $1`, [a.id])).rows[0]!;
    // The four switches the viewer had stay in step with the modes, for a rollback.
    expect(stored).toMatchObject({ viewerAudience: 'EVERYONE', viewerStudentMode: 'CODE', publicViewerEnabled: true, publicGroups: true, publicTeachers: true, publicRooms: true });
    // The default for a school that never chose: nothing shown, and for staff.
    await owner.query(`DELETE FROM "PublicationSettings" WHERE "schoolId" = $1`, [b.id]);
    const defaults = (await request(http()).get('/api/v1/publication-settings').set(as(b.admin)).expect(200)).body;
    expect(defaults).toMatchObject({ viewerAudience: 'STAFF', viewerClassMode: 'OFF', viewerGroupMode: 'OFF', viewerTeacherMode: 'OFF', viewerStudentMode: 'OFF', viewerRoomMode: 'OFF', stored: false });
  });

  it('lg-g: an address that tries too many links that do not exist is refused, and another address is not', async () => {
    await settings(a, { viewerAudience: 'EVERYONE', ...everyKind('CODE') }).expect(200);
    const same = { 'X-Viewer-Client-Ip': '10.99.0.1', 'X-Viewer-Proxy-Key': KEY };
    // Codes that are well formed and were never made.
    const unmade = (i: number) => `ZZZZZ-ZZZZZ-ZZZZZ-${(1000 + i).toString(32).toUpperCase().replace(/[ILOU]/g, 'Z').padStart(5, 'Z')}`;
    for (let i = 0; i <= MISSES.limit; i++) await request(http()).get(`/public/v1/timetables/${unmade(i)}`).set(same).expect(404);
    const refused = await request(http()).get(`/public/v1/timetables/${codes['cls']!.token}${week}`).set(same).expect(429);
    expect(refused.headers['cache-control']).toBe('no-store');
    await viewer(codes['cls']!.token, week).expect(200);
  });

  it('lg-i: the calendar feeds follow no viewer mode, and name no marked teacher', async () => {
    await settings(a, { ...everyKind('OFF'), calendarFeedTeachers: true, calendarFeedStudents: true, calendarFeedGuardians: true }).expect(200);
    const feed = async (user: AuthenticatedUser, body: Record<string, unknown> = {}) => {
      const made = await request(http()).post('/api/v1/calendar-feeds').set(as(user)).send(body).expect(201);
      return request(http()).get(`/public/v1/calendar-feeds/${(made.body as { token: string }).token}.ics`).set(fresh());
    };
    const mark = (user: string) => owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL') ON CONFLICT DO NOTHING`, [user, a.id]);
    const lift = () => owner.query(`DELETE FROM "PersonProtections" WHERE "schoolId" = $1`, [a.id]);
    // With every viewer mode off: the colleague's feed names the colleague's colleague, the pupil's the teacher.
    const teachers = await feed(a.teacher);
    expect(teachers.status).toBe(200);
    expect(teachers.text).toContain('Lxbeta');
    const pupils = await feed(a.pupil);
    expect(pupils.status).toBe(200);
    expect(pupils.text).toMatch(/LXB|KXA/);
    await mark(a.colleague!.userId!);
    const marked = await feed(a.teacher);
    expect(marked.status).toBe(200);
    expect(marked.text).not.toContain('Lxbeta');
    expect((await feed(a.pupil)).text).not.toContain('LXB');
    // The marked teacher's own feed is theirs: still there.
    expect((await feed(a.colleague!)).status).toBe(200);
    await lift();
    expect((await feed(a.teacher)).text).toContain('Lxbeta');
    // A pupil reaches no feed of a school whose audience is off: another school's feeds are off and refuse the pupil.
    await request(http()).post('/api/v1/calendar-feeds').set(as(b.pupil)).send({}).expect(409);
  });
});
