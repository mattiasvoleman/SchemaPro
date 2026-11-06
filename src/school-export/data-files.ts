import { Prisma, type PrismaClient } from '@prisma/client';
import type { AccessKind } from '../access-log/access-log';

/**
 * The files of the whole-school export that no page exports: the school's
 * attendance, absence reports, leave, notices and läslogg, and the people and
 * links they refer to. They are written for a reader who wants everything,
 * not for an importer, so they carry ids (the join keys between the files),
 * the e-mail address beside each id (a human can read the file), and every
 * row the school holds, active or not.
 *
 * ONE SET OF QUERIES, TWO SCOPES. The registerutdrag (GDPR art. 15) is these
 * same files for one person: `scope.ids` null is the school, a list is the
 * rows of those persons. A scope changes which rows a query keeps and nothing
 * else; the columns, the order, the dialect and the held-out rules are the
 * same, so what a person is given is what the school's file holds about them.
 *
 * SKYDDAD IDENTITET (20270107090000). Per file, and counted:
 *   - a row ABOUT a marked person (the pupil, the recipient, the person
 *     listed) is left out;
 *   - a marked person named in a column that is not what the row is about (who
 *     recorded an attendance mark, who reported an absence, who decided a
 *     leave) is blanked, not the row: the pupil's absence is the pupil's, and
 *     a protected teacher having recorded it does not make it a protected
 *     pupil's. A blank in those columns means "none, or protected";
 *   - a notice that names a marked person in its content (their id or full
 *     name) keeps its type and time and loses its content;
 *   - a läslogg row keeps its persons but the marked ones, and is left out if
 *     its reader is marked or no person is left.
 * `exempt` are the persons the scope is about (the registerutdrag's subject):
 * they are not held out of their own file.
 *
 * Read under the ordering administrator's row-level security, a short
 * transaction per batch (`env.read`), in batches that keep their place in the
 * table (a day, or a position in the key), so the file is never in memory.
 */

export interface DataScope {
  /** The persons the file is about, or null for the whole school. */
  ids: readonly string[] | null;
}

export interface DataEnv {
  schoolId: string;
  scope: DataScope;
  /** Marked persons, less `exempt`: those whose rows are held out. */
  markedOut: readonly string[];
  /** Their full names, lower-cased, for the notices' content. */
  markedNames: readonly string[];
  read<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T>;
  /** The persons a file holds rows about, for the läslogg of the download. */
  named(kind: AccessKind, ids: Iterable<string | null | undefined>): void;
  /** Rows held out (or cells blanked) in a file, for its line in the manifest. */
  held(file: string, what: 'rows' | 'blanked', count: number): void;
  /** Called between batches: a place to beat the job's heart and stop a withdrawn export. */
  checkpoint(): Promise<void>;
}

export interface DataColumn {
  name: string;
  doc: string;
}

export interface DataFile {
  /** Path of the file, or of its first part when it is split. */
  path: string;
  title: string;
  /** Which tables the rows come from, for the format document. */
  source: string;
  columns: readonly DataColumn[];
  /** The rows, in the file's order. */
  rows(env: DataEnv): AsyncGenerator<string[]>;
}

const BATCH = 5000;
/** A day's lessons, or this many days of one person's. */
const DAYS_PER_BATCH_PERSON = 120;

const scoped = (column: Prisma.Sql, ids: readonly string[] | null): Prisma.Sql =>
  ids === null ? Prisma.empty : Prisma.sql`AND ${column} = ANY(${[...ids]}::uuid[])`;

/** A blank for a person who is held out of a column that is not what the row is about. */
const nobodyMarked = (column: Prisma.Sql, markedOut: readonly string[]): Prisma.Sql =>
  Prisma.sql`CASE WHEN ${column} = ANY(${[...markedOut]}::uuid[]) THEN NULL ELSE ${column} END`;

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

const ISO = (column: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// ---------------------------------------------------------------------------
// personer.csv
// ---------------------------------------------------------------------------

interface PersonRow {
  id: string;
  role: string;
  first: string;
  last: string;
  email: string;
  phone: string | null;
  active: boolean;
  klass: string | null;
  created: string;
  deactivated: string | null;
  pseudonymised: string | null;
  profile: string | null;
  hr: boolean;
}

export const PERSONER: DataFile = {
  path: 'data/personer.csv',
  title: 'Personer',
  source: 'Users, med hemklassens namn ur StudentGroups',
  columns: [
    { name: 'id', doc: 'Personens id. Nyckeln som de andra filerna refererar till.' },
    { name: 'roll', doc: 'STUDENT, GUARDIAN, TEACHER eller SCHOOL_ADMIN.' },
    { name: 'fornamn', doc: 'Förnamn. Tomt hos en person som gallringen har pseudonymiserat.' },
    { name: 'efternamn', doc: 'Efternamn.' },
    { name: 'epost', doc: 'E-postadress.' },
    { name: 'telefon', doc: 'Telefonnummer, om personen har ett.' },
    { name: 'aktiv', doc: 'ja eller nej. En avaktiverad person finns kvar tills gallringen tar bort den.' },
    { name: 'klass', doc: 'Elevens hemklass, om den har en.' },
    { name: 'skapad', doc: 'När raden skapades (UTC, ISO 8601).' },
    { name: 'avaktiverad', doc: 'När personen avaktiverades (UTC), annars tomt.' },
    { name: 'pseudonymiserad', doc: 'När gallringen pseudonymiserade personen (UTC), annars tomt.' },
    { name: 'administratorsprofil', doc: 'För en administratör: FULL, REKTOR, SCHEMALAGGARE, EXPEDITION eller LASARE.' },
    { name: 'hr_las', doc: 'ja om administratören har HR-läs (tjänst och nedsättning i procent).' },
  ],
  async *rows(env) {
    let after: string | null = null;
    for (;;) {
      const batch: PersonRow[] = await env.read((tx) =>
        tx.$queryRaw<PersonRow[]>(Prisma.sql`
          SELECT u."id"::text AS id, u."role"::text AS role, u."firstName" AS first, u."lastName" AS last,
                 u."email" AS email, u."phone" AS phone, u."isActive" AS active, g."name" AS klass,
                 ${ISO(Prisma.sql`u."createdAt"`)} AS created, ${ISO(Prisma.sql`u."deactivatedAt"`)} AS deactivated,
                 ${ISO(Prisma.sql`u."pseudonymisedAt"`)} AS pseudonymised,
                 u."adminProfile"::text AS profile, u."hrRead" AS hr
            FROM "Users" u LEFT JOIN "StudentGroups" g ON g."id" = u."studentGroupId"
           WHERE u."schoolId" = ${env.schoolId}::uuid
             AND NOT (u."id" = ANY(${[...env.markedOut]}::uuid[]))
             ${scoped(Prisma.sql`u."id"`, env.scope.ids)}
             ${after === null ? Prisma.empty : Prisma.sql`AND u."id" > ${after}::uuid`}
           ORDER BY u."id"
           LIMIT ${BATCH}`),
      );
      if (batch.length === 0) return;
      env.named('PEOPLE', batch.map((row) => row.id));
      for (const row of batch) {
        yield [
          row.id, row.role, row.first, row.last, row.email, text(row.phone), row.active ? 'ja' : 'nej', text(row.klass),
          row.created, text(row.deactivated), text(row.pseudonymised), text(row.profile), row.hr ? 'ja' : 'nej',
        ];
      }
      after = batch[batch.length - 1]!.id;
      await env.checkpoint();
      if (batch.length < BATCH) return;
    }
  },
};

// ---------------------------------------------------------------------------
// kopplingar.csv
// ---------------------------------------------------------------------------

interface LinkRow {
  id: string;
  guardian: string;
  guardianEmail: string;
  student: string;
  studentEmail: string;
  origin: string;
  created: string;
}

export const KOPPLINGAR: DataFile = {
  path: 'data/kopplingar.csv',
  title: 'Kopplingar mellan vårdnadshavare och elever',
  source: 'GuardianStudents',
  columns: [
    { name: 'id', doc: 'Kopplingens id.' },
    { name: 'vardnadshavare_id', doc: 'Vårdnadshavarens id (personer.csv).' },
    { name: 'vardnadshavare_epost', doc: 'Vårdnadshavarens e-postadress.' },
    { name: 'elev_id', doc: 'Elevens id (personer.csv).' },
    { name: 'elev_epost', doc: 'Elevens e-postadress.' },
    { name: 'ursprung', doc: 'MANUAL (skolan la in kopplingen) eller SS12000 (kommer från skolans register).' },
    { name: 'skapad', doc: 'När kopplingen skapades (UTC).' },
  ],
  async *rows(env) {
    let after: string | null = null;
    for (;;) {
      const batch: LinkRow[] = await env.read((tx) =>
        tx.$queryRaw<LinkRow[]>(Prisma.sql`
          SELECT l."id"::text AS id, l."guardianId"::text AS guardian, gu."email" AS "guardianEmail",
                 l."studentId"::text AS student, st."email" AS "studentEmail", l."origin"::text AS origin,
                 ${ISO(Prisma.sql`l."createdAt"`)} AS created
            FROM "GuardianStudents" l
            JOIN "Users" gu ON gu."id" = l."guardianId" JOIN "Users" st ON st."id" = l."studentId"
           WHERE l."schoolId" = ${env.schoolId}::uuid
             AND NOT (l."guardianId" = ANY(${[...env.markedOut]}::uuid[]))
             AND NOT (l."studentId" = ANY(${[...env.markedOut]}::uuid[]))
             ${env.scope.ids === null ? Prisma.empty : Prisma.sql`AND (l."guardianId" = ANY(${[...env.scope.ids]}::uuid[]) OR l."studentId" = ANY(${[...env.scope.ids]}::uuid[]))`}
             ${after === null ? Prisma.empty : Prisma.sql`AND l."id" > ${after}::uuid`}
           ORDER BY l."id"
           LIMIT ${BATCH}`),
      );
      if (batch.length === 0) break;
      env.named('GUARDIANS', batch.flatMap((row) => [row.guardian, row.student]));
      env.named('PEOPLE', batch.flatMap((row) => [row.guardian, row.student]));
      for (const row of batch) yield [row.id, row.guardian, row.guardianEmail, row.student, row.studentEmail, row.origin, row.created];
      after = batch[batch.length - 1]!.id;
      await env.checkpoint();
      if (batch.length < BATCH) break;
    }
    if (env.markedOut.length > 0) {
      const [counted] = await env.read((tx) =>
        tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
          SELECT count(*)::int AS n FROM "GuardianStudents" l
           WHERE l."schoolId" = ${env.schoolId}::uuid
             AND (l."guardianId" = ANY(${[...env.markedOut]}::uuid[]) OR l."studentId" = ANY(${[...env.markedOut]}::uuid[]))
             ${env.scope.ids === null ? Prisma.empty : Prisma.sql`AND (l."guardianId" = ANY(${[...env.scope.ids]}::uuid[]) OR l."studentId" = ANY(${[...env.scope.ids]}::uuid[]))`}`),
      );
      env.held(KOPPLINGAR.path, 'rows', counted?.n ?? 0);
    }
  },
};

// ---------------------------------------------------------------------------
// narvaro.csv
// ---------------------------------------------------------------------------

interface AttendanceRow {
  date: string;
  start: string;
  end: string;
  subject: string;
  code: string | null;
  grp: string;
  lesson: string;
  lessonStatus: string;
  student: string;
  studentEmail: string;
  status: string;
  recorder: string | null;
  recorderEmail: string | null;
  recordedAt: string | null;
  note: string | null;
}

export const NARVARO: DataFile = {
  path: 'data/narvaro.csv',
  title: 'Närvaro',
  source: 'AttendanceRecords med lektionen ur CalendarLessons',
  columns: [
    { name: 'datum', doc: 'Lektionens datum (ÅÅÅÅ-MM-DD).' },
    { name: 'start', doc: 'Lektionens början, skolans lokala tid (TT:MM).' },
    { name: 'slut', doc: 'Lektionens slut, skolans lokala tid (TT:MM).' },
    { name: 'amne', doc: 'Ämnets namn.' },
    { name: 'amnes_kod', doc: 'Ämnets kod, om det har en.' },
    { name: 'grupp', doc: 'Gruppens eller klassens namn.' },
    { name: 'lektion_id', doc: 'Lektionens id. Raderna med samma lektion hör ihop.' },
    { name: 'lektionsstatus', doc: 'SCHEDULED, CANCELLED, COMPLETED eller RESCHEDULED.' },
    { name: 'elev_id', doc: 'Elevens id (personer.csv).' },
    { name: 'elev_epost', doc: 'Elevens e-postadress.' },
    { name: 'status', doc: 'PRESENT, ABSENT, LATE, EXCUSED eller UNKNOWN (inte registrerad).' },
    { name: 'registrerad_av_id', doc: 'Id på den som registrerade. Tomt om personen är borttagen eller har skyddad identitet.' },
    { name: 'registrerad_av_epost', doc: 'E-postadress till den som registrerade.' },
    { name: 'registrerad', doc: 'När registreringen gjordes (UTC).' },
    { name: 'anteckning', doc: 'Anteckning till raden, om det finns en.' },
  ],
  async *rows(env) {
    const markedOut = [...env.markedOut];
    const school = await env.read((tx) =>
      tx.$queryRaw<Array<{ tz: string }>>(Prisma.sql`SELECT "timezone" AS tz FROM "Schools" WHERE "id" = ${env.schoolId}::uuid`),
    );
    const timezone = school[0]?.tz ?? 'Europe/Stockholm';
    // The lesson days to read, oldest first. A school's day is one batch; one person's days go several at a time.
    const dates = await env.read((tx) =>
      env.scope.ids === null
        ? tx.$queryRaw<Array<{ d: string }>>(Prisma.sql`
            SELECT DISTINCT cl."date"::text AS d FROM "CalendarLessons" cl WHERE cl."schoolId" = ${env.schoolId}::uuid ORDER BY 1`)
        : tx.$queryRaw<Array<{ d: string }>>(Prisma.sql`
            SELECT DISTINCT cl."date"::text AS d
              FROM "AttendanceRecords" ar JOIN "CalendarLessons" cl ON cl."id" = ar."calendarLessonId"
             WHERE ar."schoolId" = ${env.schoolId}::uuid AND ar."studentId" = ANY(${[...env.scope.ids]}::uuid[])
             ORDER BY 1`),
    );
    const per = env.scope.ids === null ? 1 : DAYS_PER_BATCH_PERSON;
    for (let at = 0; at < dates.length; at += per) {
      const days = dates.slice(at, at + per).map((row) => row.d);
      const batch: AttendanceRow[] = await env.read((tx) =>
        tx.$queryRaw<AttendanceRow[]>(Prisma.sql`
          SELECT cl."date"::text AS date,
                 to_char(cl."startsAt" AT TIME ZONE ${timezone}::text, 'HH24:MI') AS start,
                 to_char(cl."endsAt" AT TIME ZONE ${timezone}::text, 'HH24:MI') AS "end",
                 s."name" AS subject, s."code" AS code, g."name" AS grp, cl."id"::text AS lesson,
                 cl."status"::text AS "lessonStatus", ar."studentId"::text AS student, st."email" AS "studentEmail",
                 ar."status"::text AS status,
                 ${nobodyMarked(Prisma.sql`ar."recordedById"`, markedOut)}::text AS recorder,
                 CASE WHEN ar."recordedById" = ANY(${markedOut}::uuid[]) THEN NULL ELSE rb."email" END AS "recorderEmail",
                 ${ISO(Prisma.sql`ar."recordedAt"`)} AS "recordedAt", ar."note" AS note
            FROM "AttendanceRecords" ar
            JOIN "CalendarLessons" cl ON cl."id" = ar."calendarLessonId"
            JOIN "Subjects" s ON s."id" = cl."subjectId"
            JOIN "StudentGroups" g ON g."id" = cl."studentGroupId"
            JOIN "Users" st ON st."id" = ar."studentId"
            LEFT JOIN "Users" rb ON rb."id" = ar."recordedById"
           WHERE cl."schoolId" = ${env.schoolId}::uuid AND cl."date" = ANY(${days}::date[])
             AND NOT (ar."studentId" = ANY(${markedOut}::uuid[]))
             ${scoped(Prisma.sql`ar."studentId"`, env.scope.ids)}
           ORDER BY cl."date", cl."startsAt", cl."id", ar."studentId"`),
      );
      env.named('ATTENDANCE', batch.map((row) => row.student));
      env.named('PEOPLE', batch.flatMap((row) => [row.student, row.recorder]));
      for (const row of batch) {
        yield [
          row.date, row.start, row.end, row.subject, text(row.code), row.grp, row.lesson, row.lessonStatus,
          row.student, row.studentEmail, row.status, text(row.recorder), text(row.recorderEmail), text(row.recordedAt), text(row.note),
        ];
      }
      await env.checkpoint();
    }
    if (markedOut.length > 0) {
      const [counted] = await env.read((tx) =>
        tx.$queryRaw<Array<{ held: number; blanked: number }>>(Prisma.sql`
          SELECT count(*) FILTER (WHERE ar."studentId" = ANY(${markedOut}::uuid[]))::int AS held,
                 count(*) FILTER (WHERE ar."recordedById" = ANY(${markedOut}::uuid[]) AND NOT (ar."studentId" = ANY(${markedOut}::uuid[])))::int AS blanked
            FROM "AttendanceRecords" ar
           WHERE ar."schoolId" = ${env.schoolId}::uuid
             AND (ar."studentId" = ANY(${markedOut}::uuid[]) OR ar."recordedById" = ANY(${markedOut}::uuid[]))
             ${scoped(Prisma.sql`ar."studentId"`, env.scope.ids)}`),
      );
      env.held(NARVARO.path, 'rows', counted?.held ?? 0);
      env.held(NARVARO.path, 'blanked', counted?.blanked ?? 0);
    }
  },
};

// ---------------------------------------------------------------------------
// franvaroanmalningar.csv
// ---------------------------------------------------------------------------

interface AbsenceRow {
  id: string;
  date: string;
  from: string | null;
  to: string | null;
  type: string;
  student: string;
  studentEmail: string;
  reporter: string | null;
  reporterEmail: string | null;
  note: string | null;
  granted: boolean;
  created: string;
  key: string;
}

export const FRANVARO: DataFile = {
  path: 'data/franvaroanmalningar.csv',
  title: 'Frånvaroanmälningar',
  source: 'AbsenceReports',
  columns: [
    { name: 'id', doc: 'Anmälans id.' },
    { name: 'datum', doc: 'Dagen frånvaron gäller (ÅÅÅÅ-MM-DD).' },
    { name: 'fran', doc: 'Klockslag frånvaron börjar (TT:MM:SS), tomt för hela dagen.' },
    { name: 'till', doc: 'Klockslag frånvaron slutar (TT:MM:SS), tomt för hela dagen.' },
    { name: 'typ', doc: 'Typ av frånvaro: SICK (sjukdom), APPOINTMENT (besök) eller OTHER.' },
    { name: 'elev_id', doc: 'Elevens id (personer.csv).' },
    { name: 'elev_epost', doc: 'Elevens e-postadress.' },
    { name: 'anmald_av_id', doc: 'Id på den som anmälde (vårdnadshavare eller eleven). Tomt om personen har skyddad identitet.' },
    { name: 'anmald_av_epost', doc: 'E-postadress till den som anmälde.' },
    { name: 'anteckning', doc: 'Anteckning till anmälan, om det finns en.' },
    { name: 'beviljad_ledighet', doc: 'ja om skolan beviljat frånvaron som ledighet.' },
    { name: 'skapad', doc: 'När anmälan gjordes (UTC).' },
  ],
  async *rows(env) {
    const markedOut = [...env.markedOut];
    let after: { date: string; id: string } | null = null;
    for (;;) {
      const batch: AbsenceRow[] = await env.read((tx) =>
        tx.$queryRaw<AbsenceRow[]>(Prisma.sql`
          SELECT a."id"::text AS id, a."date"::text AS date, a."startTime"::text AS "from", a."endTime"::text AS "to",
                 a."type"::text AS type, a."studentId"::text AS student, st."email" AS "studentEmail",
                 ${nobodyMarked(Prisma.sql`a."reportedById"`, markedOut)}::text AS reporter,
                 CASE WHEN a."reportedById" = ANY(${markedOut}::uuid[]) THEN NULL ELSE rp."email" END AS "reporterEmail",
                 a."note" AS note, a."grantedLeave" AS granted, ${ISO(Prisma.sql`a."createdAt"`)} AS created, a."date"::text AS key
            FROM "AbsenceReports" a JOIN "Users" st ON st."id" = a."studentId" JOIN "Users" rp ON rp."id" = a."reportedById"
           WHERE a."schoolId" = ${env.schoolId}::uuid
             AND NOT (a."studentId" = ANY(${markedOut}::uuid[]))
             ${env.scope.ids === null ? Prisma.empty : Prisma.sql`AND (a."studentId" = ANY(${[...env.scope.ids]}::uuid[]) OR a."reportedById" = ANY(${[...env.scope.ids]}::uuid[]))`}
             ${after === null ? Prisma.empty : Prisma.sql`AND (a."date", a."id") > (${after.date}::date, ${after.id}::uuid)`}
           ORDER BY a."date", a."id"
           LIMIT ${BATCH}`),
      );
      if (batch.length === 0) break;
      env.named('ABSENCE_REPORTS', batch.map((row) => row.student));
      env.named('PEOPLE', batch.flatMap((row) => [row.student, row.reporter]));
      for (const row of batch) {
        yield [
          row.id, row.date, text(row.from), text(row.to), row.type, row.student, row.studentEmail,
          text(row.reporter), text(row.reporterEmail), text(row.note), row.granted ? 'ja' : 'nej', row.created,
        ];
      }
      const last = batch[batch.length - 1]!;
      after = { date: last.key, id: last.id };
      await env.checkpoint();
      if (batch.length < BATCH) break;
    }
    if (markedOut.length > 0) {
      const [counted] = await env.read((tx) =>
        tx.$queryRaw<Array<{ held: number; blanked: number }>>(Prisma.sql`
          SELECT count(*) FILTER (WHERE a."studentId" = ANY(${markedOut}::uuid[]))::int AS held,
                 count(*) FILTER (WHERE a."reportedById" = ANY(${markedOut}::uuid[]) AND NOT (a."studentId" = ANY(${markedOut}::uuid[])))::int AS blanked
            FROM "AbsenceReports" a
           WHERE a."schoolId" = ${env.schoolId}::uuid AND (a."studentId" = ANY(${markedOut}::uuid[]) OR a."reportedById" = ANY(${markedOut}::uuid[]))
             ${env.scope.ids === null ? Prisma.empty : Prisma.sql`AND (a."studentId" = ANY(${[...env.scope.ids]}::uuid[]) OR a."reportedById" = ANY(${[...env.scope.ids]}::uuid[]))`}`),
      );
      env.held(FRANVARO.path, 'rows', counted?.held ?? 0);
      env.held(FRANVARO.path, 'blanked', counted?.blanked ?? 0);
    }
  },
};

// ---------------------------------------------------------------------------
// ledigheter.csv
// ---------------------------------------------------------------------------

interface LeaveRow {
  id: string;
  student: string;
  studentEmail: string;
  requester: string | null;
  requesterEmail: string | null;
  start: string;
  end: string;
  reason: string;
  status: string;
  decider: string | null;
  deciderEmail: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedAs: string | null;
  referrer: string | null;
  referredAt: string | null;
  created: string;
  at: string;
}

export const LEDIGHETER: DataFile = {
  path: 'data/ledigheter.csv',
  title: 'Ledighetsansökningar',
  source: 'LeaveRequests',
  columns: [
    { name: 'id', doc: 'Ansökans id.' },
    { name: 'elev_id', doc: 'Elevens id (personer.csv).' },
    { name: 'elev_epost', doc: 'Elevens e-postadress.' },
    { name: 'begard_av_id', doc: 'Id på den som ansökte. Tomt om personen har skyddad identitet.' },
    { name: 'begard_av_epost', doc: 'E-postadress till den som ansökte.' },
    { name: 'fran', doc: 'Första dagen (ÅÅÅÅ-MM-DD).' },
    { name: 'till', doc: 'Sista dagen (ÅÅÅÅ-MM-DD).' },
    { name: 'skal', doc: 'Skälet som ansökan gavs.' },
    { name: 'status', doc: 'PENDING (väntar), APPROVED (beviljad) eller REJECTED (avslagen).' },
    { name: 'beslut_av_id', doc: 'Id på den som beslutade. Tomt om personen är borttagen eller har skyddad identitet.' },
    { name: 'beslut_av_epost', doc: 'E-postadress till den som beslutade.' },
    { name: 'beslut_tid', doc: 'När beslutet fattades (UTC).' },
    { name: 'beslut_anteckning', doc: 'Beslutets anteckning.' },
    { name: 'beslut_som', doc: 'I vilken egenskap beslutet fattades: MENTOR eller ADMIN.' },
    { name: 'hanvisad_av_id', doc: 'Id på mentorn som lämnade vidare till rektor. Tomt om ingen, eller skyddad identitet.' },
    { name: 'hanvisad_tid', doc: 'När ansökan lämnades vidare (UTC).' },
    { name: 'skapad', doc: 'När ansökan gjordes (UTC).' },
  ],
  async *rows(env) {
    const markedOut = [...env.markedOut];
    let after: { at: string; id: string } | null = null;
    for (;;) {
      const batch: LeaveRow[] = await env.read((tx) =>
        tx.$queryRaw<LeaveRow[]>(Prisma.sql`
          SELECT l."id"::text AS id, l."studentId"::text AS student, st."email" AS "studentEmail",
                 ${nobodyMarked(Prisma.sql`l."requestedById"`, markedOut)}::text AS requester,
                 CASE WHEN l."requestedById" = ANY(${markedOut}::uuid[]) THEN NULL ELSE rq."email" END AS "requesterEmail",
                 l."startDate"::text AS start, l."endDate"::text AS "end", l."reason" AS reason, l."status"::text AS status,
                 ${nobodyMarked(Prisma.sql`l."decidedById"`, markedOut)}::text AS decider,
                 CASE WHEN l."decidedById" = ANY(${markedOut}::uuid[]) THEN NULL ELSE dc."email" END AS "deciderEmail",
                 ${ISO(Prisma.sql`l."decidedAt"`)} AS "decidedAt", l."decisionNote" AS "decisionNote", l."decidedAs"::text AS "decidedAs",
                 ${nobodyMarked(Prisma.sql`l."referredById"`, markedOut)}::text AS referrer,
                 ${ISO(Prisma.sql`l."referredAt"`)} AS "referredAt", ${ISO(Prisma.sql`l."createdAt"`)} AS created,
                 to_char(l."createdAt", 'YYYY-MM-DD HH24:MI:SS.US+00') AS at
            FROM "LeaveRequests" l JOIN "Users" st ON st."id" = l."studentId" JOIN "Users" rq ON rq."id" = l."requestedById"
            LEFT JOIN "Users" dc ON dc."id" = l."decidedById"
           WHERE l."schoolId" = ${env.schoolId}::uuid
             AND NOT (l."studentId" = ANY(${markedOut}::uuid[]))
             ${env.scope.ids === null ? Prisma.empty : Prisma.sql`AND (l."studentId" = ANY(${[...env.scope.ids]}::uuid[]) OR l."requestedById" = ANY(${[...env.scope.ids]}::uuid[]) OR l."decidedById" = ANY(${[...env.scope.ids]}::uuid[]) OR l."referredById" = ANY(${[...env.scope.ids]}::uuid[]))`}
             ${after === null ? Prisma.empty : Prisma.sql`AND (l."createdAt", l."id") > (${after.at}::timestamptz, ${after.id}::uuid)`}
           ORDER BY l."createdAt", l."id"
           LIMIT ${BATCH}`),
      );
      if (batch.length === 0) break;
      env.named('LEAVE_REQUESTS', batch.map((row) => row.student));
      env.named('PEOPLE', batch.flatMap((row) => [row.student, row.requester, row.decider, row.referrer]));
      for (const row of batch) {
        yield [
          row.id, row.student, row.studentEmail, text(row.requester), text(row.requesterEmail), row.start, row.end, row.reason,
          row.status, text(row.decider), text(row.deciderEmail), text(row.decidedAt), text(row.decisionNote), text(row.decidedAs),
          text(row.referrer), text(row.referredAt), row.created,
        ];
      }
      const last = batch[batch.length - 1]!;
      after = { at: last.at, id: last.id };
      await env.checkpoint();
      if (batch.length < BATCH) break;
    }
    if (markedOut.length > 0) {
      const [counted] = await env.read((tx) =>
        tx.$queryRaw<Array<{ held: number; blanked: number }>>(Prisma.sql`
          SELECT count(*) FILTER (WHERE l."studentId" = ANY(${markedOut}::uuid[]))::int AS held,
                 count(*) FILTER (WHERE NOT (l."studentId" = ANY(${markedOut}::uuid[]))
                                    AND (l."requestedById" = ANY(${markedOut}::uuid[]) OR l."decidedById" = ANY(${markedOut}::uuid[]) OR l."referredById" = ANY(${markedOut}::uuid[])))::int AS blanked
            FROM "LeaveRequests" l
           WHERE l."schoolId" = ${env.schoolId}::uuid
             ${env.scope.ids === null ? Prisma.empty : Prisma.sql`AND (l."studentId" = ANY(${[...env.scope.ids]}::uuid[]) OR l."requestedById" = ANY(${[...env.scope.ids]}::uuid[]) OR l."decidedById" = ANY(${[...env.scope.ids]}::uuid[]) OR l."referredById" = ANY(${[...env.scope.ids]}::uuid[]))`}`),
      );
      env.held(LEDIGHETER.path, 'rows', counted?.held ?? 0);
      env.held(LEDIGHETER.path, 'blanked', counted?.blanked ?? 0);
    }
  },
};

// ---------------------------------------------------------------------------
// notiser.csv
// ---------------------------------------------------------------------------

interface NoticeRow {
  id: string;
  recipient: string;
  recipientEmail: string;
  type: string;
  content: string | null;
  mentionsMarked: boolean;
  readAt: string | null;
  emailedAt: string | null;
  created: string;
  at: string;
}

export const NOTISER: DataFile = {
  path: 'data/notiser.csv',
  title: 'Notiser',
  source: 'Notifications',
  columns: [
    { name: 'id', doc: 'Notisens id.' },
    { name: 'mottagare_id', doc: 'Mottagarens id (personer.csv).' },
    { name: 'mottagare_epost', doc: 'Mottagarens e-postadress.' },
    { name: 'typ', doc: 'Notisens typ, till exempel LEAVE_DECIDED eller LESSON_CANCELLED.' },
    { name: 'innehall', doc: 'Notisens innehåll som JSON-text. Tomt om innehållet nämner en person med skyddad identitet.' },
    { name: 'last', doc: 'När mottagaren läste notisen (UTC), tomt om den inte lästs.' },
    { name: 'epostad', doc: 'När notisen skickades som e-post (UTC), tomt om den inte gjorts.' },
    { name: 'skapad', doc: 'När notisen skapades (UTC).' },
  ],
  async *rows(env) {
    const markedOut = [...env.markedOut];
    const names = [...env.markedNames];
    let after: { at: string; id: string } | null = null;
    // No marked person, nothing to look for in a notice's content: the scan of every notice is for a school that has marks.
    const mentions =
      markedOut.length === 0 && names.length === 0
        ? Prisma.sql`false`
        : Prisma.sql`(n."meta" IS NOT NULL AND (EXISTS (SELECT 1 FROM unnest(${markedOut}::text[]) m WHERE position(m in n."meta"::text) > 0)
                                                OR EXISTS (SELECT 1 FROM unnest(${names}::text[]) m WHERE m <> '' AND position(m in lower(n."meta"::text)) > 0)))`;
    for (;;) {
      const batch: NoticeRow[] = await env.read((tx) =>
        tx.$queryRaw<NoticeRow[]>(Prisma.sql`
          SELECT n."id"::text AS id, n."userId"::text AS recipient, u."email" AS "recipientEmail", n."type"::text AS type,
                 n."meta"::text AS content,
                 ${mentions} AS "mentionsMarked",
                 ${ISO(Prisma.sql`n."readAt"`)} AS "readAt", ${ISO(Prisma.sql`n."emailedAt"`)} AS "emailedAt", ${ISO(Prisma.sql`n."createdAt"`)} AS created,
                 to_char(n."createdAt", 'YYYY-MM-DD HH24:MI:SS.US+00') AS at
            FROM "Notifications" n JOIN "Users" u ON u."id" = n."userId"
           WHERE n."schoolId" = ${env.schoolId}::uuid
             AND NOT (n."userId" = ANY(${markedOut}::uuid[]))
             ${scoped(Prisma.sql`n."userId"`, env.scope.ids)}
             ${after === null ? Prisma.empty : Prisma.sql`AND (n."createdAt", n."id") > (${after.at}::timestamptz, ${after.id}::uuid)`}
           ORDER BY n."createdAt", n."id"
           LIMIT ${BATCH}`),
      );
      if (batch.length === 0) break;
      env.named('PEOPLE', batch.map((row) => row.recipient));
      let blanked = 0;
      for (const row of batch) {
        if (row.mentionsMarked) blanked += 1;
        yield [
          row.id, row.recipient, row.recipientEmail, row.type, row.mentionsMarked ? '' : text(row.content),
          text(row.readAt), text(row.emailedAt), row.created,
        ];
      }
      if (blanked > 0) env.held(NOTISER.path, 'blanked', blanked);
      const last = batch[batch.length - 1]!;
      after = { at: last.at, id: last.id };
      await env.checkpoint();
      if (batch.length < BATCH) break;
    }
    if (markedOut.length > 0) {
      const [counted] = await env.read((tx) =>
        tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
          SELECT count(*)::int AS n FROM "Notifications" n
           WHERE n."schoolId" = ${env.schoolId}::uuid AND n."userId" = ANY(${markedOut}::uuid[])
             ${scoped(Prisma.sql`n."userId"`, env.scope.ids)}`),
      );
      env.held(NOTISER.path, 'rows', counted?.n ?? 0);
    }
  },
};

// ---------------------------------------------------------------------------
// laslogg.csv
// ---------------------------------------------------------------------------

interface AccessRow {
  id: string;
  at: string;
  channel: string;
  actor: string | null;
  actorEmail: string | null;
  role: string | null;
  member: string | null;
  key: string | null;
  huvudmanKey: string | null;
  kind: string;
  size: number;
  subjects: string[];
  atKey: string;
  actorHeld: boolean;
}

export const LASLOGG: DataFile = {
  path: 'data/laslogg.csv',
  title: 'Läsloggen',
  source: 'PersonalDataAccess',
  columns: [
    { name: 'tid', doc: 'När läsningen gjordes (UTC).' },
    { name: 'kanal', doc: 'WEB, APP, OTHER, INTEGRATION eller CALENDAR.' },
    { name: 'laste_id', doc: 'Id på den som läste. Tomt för en integration och för en person med skyddad identitet.' },
    { name: 'laste_epost', doc: 'E-postadress till den som läste.' },
    { name: 'laste_roll', doc: 'Läsarens roll när läsningen gjordes.' },
    { name: 'huvudmannens_medlem', doc: 'Huvudmannens medlem som läste, när det var huvudmannens läsare.' },
    { name: 'nyckel', doc: 'Id på den integrationsnyckel som läste, när det var en integration.' },
    { name: 'slag', doc: 'Slag av uppgift: PEOPLE, ROSTER, ATTENDANCE, ABSENCE_REPORTS, LEAVE_REQUESTS, GUARDIANS, EMPLOYMENT, STAFF_ABSENCES, ACCESS_LOG, SCHEDULE, TEACHING_TIME.' },
    { name: 'antal', doc: 'Hur många personer läsningen gällde. I ett registerutdrag är det läsningens hela storlek, medan personer bara listar dem utdraget gäller.' },
    { name: 'personer', doc: 'Id på personerna läsningen gällde (personer.csv), åtskilda av blanksteg. Personer med skyddad identitet är inte med.' },
  ],
  async *rows(env) {
    const markedOut = [...env.markedOut];
    const everyone = new Set<string>();
    // In a registerutdrag a read lists only the persons the extract is about, not the others the same read named.
    const inScope = env.scope.ids === null ? null : new Set(env.scope.ids);
    let after: { at: string; id: string } | null = null;
    let heldRows = 0;
    let heldIds = 0;
    for (;;) {
      const batch: AccessRow[] = await env.read((tx) =>
        tx.$queryRaw<AccessRow[]>(Prisma.sql`
          SELECT a."id"::text AS id, ${ISO(Prisma.sql`a."at"`)} AS at, a."channel"::text AS channel,
                 a."actorId"::text AS actor, ac."email" AS "actorEmail", a."actorRole"::text AS role,
                 a."huvudmanMemberId"::text AS member, a."apiKeyId"::text AS key, a."huvudmanApiKeyId"::text AS "huvudmanKey",
                 a."kind"::text AS kind, a."readSize" AS size, a."subjectIds"::text[] AS subjects,
                 to_char(a."at", 'YYYY-MM-DD HH24:MI:SS.US+00') AS "atKey",
                 (a."actorId" = ANY(${markedOut}::uuid[])) AS "actorHeld"
            FROM "PersonalDataAccess" a LEFT JOIN "Users" ac ON ac."id" = a."actorId"
           WHERE a."schoolId" = ${env.schoolId}::uuid
             ${env.scope.ids === null ? Prisma.empty : Prisma.sql`AND (a."subjectIds" && ${[...env.scope.ids]}::uuid[] OR a."actorId" = ANY(${[...env.scope.ids]}::uuid[]))`}
             ${after === null ? Prisma.empty : Prisma.sql`AND (a."at", a."id") > (${after.at}::timestamptz, ${after.id}::uuid)`}
           ORDER BY a."at", a."id"
           LIMIT ${BATCH}`),
      );
      if (batch.length === 0) break;
      for (const row of batch) {
        if (row.actorHeld) {
          heldRows += 1;
          continue;
        }
        const kept = row.subjects.filter((id) => !markedOut.includes(id));
        if (inScope === null) {
          heldIds += row.subjects.length - kept.length;
          if (kept.length === 0 && row.subjects.length > 0) {
            heldRows += 1;
            continue;
          }
        }
        const listed = inScope === null ? kept : kept.filter((id) => inScope.has(id));
        for (const id of listed) everyone.add(id);
        yield [
          row.at, row.channel, text(row.actor), text(row.actorEmail), text(row.role), text(row.member), text(row.key || row.huvudmanKey),
          row.kind, String(inScope === null ? kept.length : row.size), listed.join(' '),
        ];
      }
      const last = batch[batch.length - 1]!;
      after = { at: last.atKey, id: last.id };
      await env.checkpoint();
      if (batch.length < BATCH) break;
    }
    env.named('ACCESS_LOG', everyone);
    if (heldRows > 0) env.held(LASLOGG.path, 'rows', heldRows);
    if (heldIds > 0) env.held(LASLOGG.path, 'blanked', heldIds);
  },
};

/** The data files, in the order the zip holds them. */
export const DATA_FILES: readonly DataFile[] = [PERSONER, KOPPLINGAR, NARVARO, FRANVARO, LEDIGHETER, NOTISER, LASLOGG];
