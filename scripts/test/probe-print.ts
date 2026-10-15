/**
 * The adapter probe's checks for Utskrift och inbäddning (20261102090000),
 * run inside viewerChecks against its school, its share links and its
 * published week of 1 October 2096 — after the viewer's own checks have
 * cancelled a lesson, handed one to a vikarie and set one to självstudier, so
 * the week holds every case the whitelist decides.
 *
 *   pr-a  the admin's print set draws each target's sheet exactly as the
 *         viewer draws the target's page — same days, same title — for a
 *         class, a room and a teacher, by signature and by name; the set is
 *         every class of the läsår and no teaching group, every room, and
 *         every showable teacher; and it carries no pupil, no note, no cause
 *         and no hidden teacher;
 *   pr-b  a set is the admin's: a teacher's principal gets no set, a
 *         teachers' set naming nobody is refused, a week in no läsår is
 *         not found, a date that is no day is refused;
 *   pr-c  app.timetable_validity paints what the admin's timeline paints
 *         (effectiveSegments over the PUBLISHED, non-REFILL publications),
 *         week by week over the läsår, with overlapping publications laid
 *         down in an order their ids do not follow; and the school's
 *         teacher, pupil and guardian read the same periods;
 *   pr-d  the link list's `embeddable` is app.public_timetable_embed's
 *         answer for every link, scope by scope, and a link's websites are
 *         the school's list as stored.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check` and the
 * viewer's state.
 */
import { strict as assert } from 'node:assert';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import type { PublicLinksService } from '../../src/publication/public-links.service';
import { effectiveSegments, type PublicationRange } from '../../src/publication/publication-validity';
import type { PublicationsService } from '../../src/publication/publications.service';
import { PrintTimetablesService, type PrintSet } from '../../src/publication/print-timetables.service';
import { tokenHashOf } from '../../src/publication/public-token';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;
type Doc = { title: string; days: unknown[] } & Record<string, unknown>;

export interface PrintContext {
  owner: Client;
  api: PrismaService;
  check: Check;
  school: { schoolId: string; yearId: string; admin: AuthenticatedUser; teacher: AuthenticatedUser; class7a: string; room: string; teacherId: string };
  links: PublicLinksService;
  publications: PublicationsService;
  made: Record<'klass' | 'room' | 'teacher' | 'index', { token: string; link: { id: string } }>;
  view: (token: string, target?: string | null, date?: string) => Promise<Record<string, unknown> | null>;
  /** Throws on a pupil's name or e-mail, a note, a cause or the hidden teacher anywhere in `doc`. */
  secrets: (doc: unknown) => void;
  hiddenTeacherId: string;
  smallGroupId: string;
}

const DAY_MS = 86_400_000;
const plusDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

export async function printChecks(context: PrintContext): Promise<void> {
  const { owner, api, check, school, links, publications, made, view, secrets } = context;
  const print = new PrintTimetablesService(api);
  const set = (kind: 'GROUP' | 'TEACHER' | 'ROOM', teachers: 'NONE' | 'SIGNATURE' | 'NAME', user = school.admin, date = '2096-10-03') =>
    print.timetables({ kind, date, teachers, meals: true }, user);
  const sheetOf = (printed: PrintSet, id: string) => {
    const sheet = printed.sheets.find((entry) => entry.id === id);
    assert.ok(sheet, `the set has no sheet for ${id}`);
    return sheet;
  };
  // A sheet's id is the admin's to select by; everything else of it is the viewer's whitelist.
  const daysOnly = (printed: PrintSet) => printed.sheets.map((sheet) => ({ title: sheet.title, days: sheet.days }));

  await check('(pr-a) the print set draws each sheet exactly as the viewer draws the page: a class, a room, a teacher, by signature and by name', async () => {
    for (const [kind, token, id] of [
      ['GROUP', made.klass.token, school.class7a],
      ['ROOM', made.room.token, school.room],
      ['TEACHER', made.teacher.token, school.teacherId],
    ] as const) {
      const page = (await view(token)) as Doc | null;
      assert.ok(page, `the ${kind} link did not resolve`);
      const printed = await set(kind, 'SIGNATURE');
      const sheet = sheetOf(printed, id);
      assert.equal(sheet.title, page.title, `${kind}: the sheet is titled ${sheet.title}, the page ${page.title}`);
      assert.deepEqual(sheet.days, page.days, `${kind}: the sheet and the page differ`);
      assert.deepEqual(printed.week, page['week']);
      assert.equal(printed.school, page['school']);
      secrets(daysOnly(printed));
    }
    // The set is every class of the läsår (no teaching group, however big),
    // every room, and every teacher the display can name; never the hidden one.
    const classes = await set('GROUP', 'SIGNATURE');
    assert.deepEqual(classes.sheets.map((sheet) => sheet.id), [school.class7a]);
    assert.ok(!classes.sheets.some((sheet) => sheet.id === context.smallGroupId), 'a teaching group is in the class set');
    const teachers = await set('TEACHER', 'SIGNATURE');
    assert.deepEqual(teachers.sheets.map((sheet) => [sheet.id, sheet.title]), [[school.teacherId, 'ANLI']]);
    const named = await set('TEACHER', 'NAME');
    assert.ok(!named.sheets.some((sheet) => sheet.id === context.hiddenTeacherId), 'the hidden teacher is in the set');
    assert.equal(sheetOf(named, school.teacherId).title, 'Probe Publicering');
    assert.equal(named.teachers, 'NAME');
    // By name, a class's held lesson names its teacher by name, as the viewer
    // would with NAME, and never the hidden teacher beside them: a lesson of
    // its own, since the week's others are cancelled or have lost their
    // teachers to the checks before this one.
    const added = await owner.query<{ id: string }>(
      `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
       SELECT $1, s.id, $2, DATE '2096-10-02', '2096-10-02 13:00 Europe/Stockholm', '2096-10-02 14:00 Europe/Stockholm', 'SCHEDULED', now()
         FROM "Subjects" s WHERE s."schoolId" = $1 ORDER BY s.name, s.id LIMIT 1
       RETURNING id`,
      [school.schoolId, school.class7a],
    );
    const lessonId = added.rows[0]!.id;
    try {
      await owner.query(
        `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
         VALUES ($1, $2, $3, 'LEAD'), ($1, $2, $4, 'ASSISTANT')`,
        [school.schoolId, lessonId, school.teacherId, context.hiddenTeacherId],
      );
      const byName = await set('GROUP', 'NAME');
      const labels = sheetOf(byName, school.class7a).days.flatMap((day) => day.lessons.flatMap((lesson) => lesson.teachers ?? []));
      assert.deepEqual(labels, ['Probe Publicering'], `the class sheet by name reads ${labels.join(', ')}`);
      // The teacher's own name shares a word with a pupil's: the rest of the sheet is checked as the others are.
      secrets(JSON.parse(JSON.stringify(daysOnly(byName)).replaceAll('"Probe Publicering"', '"–"')));
    } finally {
      await owner.query(`DELETE FROM "CalendarLessons" WHERE id = $1`, [lessonId]);
    }
  });

  await check('(pr-b) a set is the admin\'s: none for a teacher, a teachers\' set naming nobody refused, no week outside a läsår, no non-day', async () => {
    await assert.rejects(set('GROUP', 'SIGNATURE', school.teacher), NotFoundException);
    await assert.rejects(set('TEACHER', 'NONE'), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.equal((error.getResponse() as { code?: string }).code, 'PRINT_TEACHERS_UNNAMED');
      return true;
    });
    await assert.rejects(set('GROUP', 'SIGNATURE', school.admin, '2099-01-07'), (error: unknown) => {
      assert.ok(error instanceof NotFoundException);
      assert.equal((error.getResponse() as { code?: string }).code, 'PRINT_WEEK_OUTSIDE_YEARS');
      return true;
    });
    await assert.rejects(set('GROUP', 'SIGNATURE', school.admin, '2096-02-30'), BadRequestException);
  });

  await check('(pr-c) the validity of a week is the timeline\'s painting, week by week, for the admin, the teacher, a pupil and a guardian', async () => {
    // Overlapping publications whose ids run against their order: the
    // painting goes by publishedAt, then id, and REFILL and REFUSED make
    // nothing valid.
    const publish = (kind: string, outcome: string, from: string, to: string, hoursAgo: number, id: string) =>
      owner.query(
        `INSERT INTO "TimetablePublications" (id, "schoolId", "academicYearId", kind, outcome, "publishMode", "validFrom", "validTo", "publishedAt")
         VALUES ($1, $2, $3, $4::"PublicationKind", $5::"PublicationOutcome", 'DIRECT', $6::date, $7::date, now() - make_interval(hours => $8))`,
        [id, school.schoolId, school.yearId, kind, outcome, from, to, hoursAgo],
      );
    await publish('PUBLISH', 'PUBLISHED', '2096-08-13', '2097-06-11', 50, 'ffffffff-0000-4000-8000-000000000001');
    await publish('PUBLISH', 'PUBLISHED', '2096-11-02', '2096-12-20', 40, '00000000-0000-4000-8000-0000000000aa');
    await publish('PUBLISH', 'PUBLISHED', '2096-12-01', '2097-01-15', 30, '00000000-0000-4000-8000-0000000000ab');
    await publish('PUBLISH', 'REFUSED', '2096-09-01', '2097-03-01', 20, '00000000-0000-4000-8000-0000000000ac');
    await publish('REFILL', 'PUBLISHED', '2096-10-10', '2096-10-20', 10, '00000000-0000-4000-8000-0000000000ad');
    await publish('PUBLISH', 'PUBLISHED', '2097-02-02', '2097-02-02', 5, '00000000-0000-4000-8000-0000000000ae');

    const timeline = await publications.timeline(school.yearId, school.admin);
    const ranges: PublicationRange[] = timeline.publications.filter((row) => row.outcome === 'PUBLISHED' && row.kind !== 'REFILL');
    const segments = effectiveSegments(ranges);
    assert.deepEqual(segments, timeline.segments, 'the timeline paints otherwise than effectiveSegments');

    const pupil = await owner.query<{ id: string; authId: string }>(
      `SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT' ORDER BY id LIMIT 1`,
      [school.schoolId],
    );
    const guardian = await owner.query<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       VALUES ($1, $2, 'Probe', 'Vårdnadshavare', 'GUARDIAN', gen_random_uuid(), true, now()) RETURNING id, "authId"`,
      [school.schoolId, `${school.schoolId}-utskrift-guardian@example.invalid`],
    );
    const readers: AuthenticatedUser[] = [
      school.admin,
      school.teacher,
      { authId: pupil.rows[0]!.authId, userId: pupil.rows[0]!.id, schoolId: school.schoolId, role: Role.STUDENT },
      { authId: guardian.rows[0]!.authId, userId: guardian.rows[0]!.id, schoolId: school.schoolId, role: Role.GUARDIAN },
    ];
    let weeks = 0;
    for (let monday = '2096-08-13'; monday <= '2097-06-11'; monday = plusDays(monday, 7)) {
      const sunday = plusDays(monday, 6);
      const expected = segments
        .filter((segment) => segment.from <= sunday && segment.to >= monday)
        .map((segment) => ({ from: segment.from, to: segment.to }));
      for (const reader of readers) {
        const answer = await print.validity({ week: plusDays(monday, 2) }, reader);
        assert.deepEqual(answer.week, { from: monday, to: sunday });
        assert.deepEqual(answer.validity, expected, `week of ${monday} as ${reader.role}`);
      }
      weeks += 1;
    }
    assert.ok(weeks >= 40, `only ${weeks} weeks were compared`);
    // The set carries its week's validity too: Sunday 2 December's week,
    // from Monday 26 November, straddles two publications.
    const printed = await set('GROUP', 'SIGNATURE', school.admin, '2096-12-02');
    assert.deepEqual(printed.week, { from: '2096-11-26', to: '2096-12-02', isoWeek: '2096-W48' });
    assert.deepEqual(
      printed.validity,
      segments.filter((segment) => segment.from <= printed.week.to && segment.to >= printed.week.from).map(({ from, to }) => ({ from, to })),
    );
    assert.deepEqual(printed.validity.map((period) => period.from), ['2096-11-02', '2096-12-01']);
  });

  await check('(pr-d) the link list\'s embeddable is app.public_timetable_embed\'s answer, scope by scope', async () => {
    const embedOf = async (token: string) =>
      api.withPublicViewer(async (tx) => {
        const [row] = await tx.$queryRaw<{ origins: string[] | null }[]>`SELECT app.public_timetable_embed(${tokenHashOf(token)}) AS "origins"`;
        return row?.origins ?? null;
      });
    const agree = async () => {
      const listed = new Map((await links.list(school.yearId, school.admin)).map((entry) => [entry.id, entry.embeddable]));
      const out: Record<string, boolean> = {};
      for (const [name, link] of Object.entries(made)) {
        const origins = await embedOf(link.token);
        assert.equal(listed.get(link.link.id), origins !== null, `${name}: listed ${String(listed.get(link.link.id))}, the door ${JSON.stringify(origins)}`);
        out[name] = origins !== null;
      }
      return out;
    };
    assert.deepEqual(await agree(), { klass: false, room: false, teacher: false, index: false });
    const sites = ['https://skolan.example', 'https://www.skolan.example:8443'];
    await publications.upsertSettings({ publicEmbedGroups: true, publicEmbedOrigins: sites }, school.admin);
    assert.deepEqual(await agree(), { klass: true, room: false, teacher: false, index: true });
    assert.deepEqual(await embedOf(made.klass.token), sites);
    await publications.upsertSettings({ publicEmbedRooms: true, publicEmbedTeachers: true }, school.admin);
    assert.deepEqual(await agree(), { klass: true, room: true, teacher: true, index: true });
    await publications.upsertSettings({ publicEmbedOrigins: [] }, school.admin);
    assert.deepEqual(await agree(), { klass: false, room: false, teacher: false, index: false });
    await publications.upsertSettings({ publicEmbedOrigins: sites, publicRooms: false }, school.admin);
    assert.equal((await agree()).room, false);
    await publications.upsertSettings({ publicRooms: true }, school.admin);
    // The table refuses what the DTO would not let through: a path, plain http.
    await assert.rejects(publications.upsertSettings({ publicEmbedOrigins: ['https://skolan.example/schema'] }, school.admin));
    await assert.rejects(publications.upsertSettings({ publicEmbedOrigins: ['http://skolan.example'] }, school.admin));
    await publications.upsertSettings(
      { publicEmbedGroups: false, publicEmbedRooms: false, publicEmbedTeachers: false, publicEmbedOrigins: [] },
      school.admin,
    );
  });
}
