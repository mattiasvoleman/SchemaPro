import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Läsloggen (20261026091000): what a read of another person's personal data
 * is recorded as. Each value is a kind of data, not an endpoint; one response
 * that carries two kinds (an SS12000 person with their guardians) is two
 * records.
 *
 *   PEOPLE                   names and contact details
 *   ROSTER                   who is in a group or on a lesson
 *   ATTENDANCE               attendance marks
 *   ABSENCE_REPORTS          reported absence, with its type and note
 *   LEAVE_REQUESTS           leave requests, with their reason and decision
 *   LEAVE_REASON_AS_MENTOR   a mentor read a leave request's reason (Skoldagen)
 *   GUARDIANS                who is whose guardian
 *   EMPLOYMENT               tjänst and anställning
 *   STAFF_ABSENCES           when a member of staff is away, and why
 *   ACCESS_LOG               the log itself, read about a person
 *   SCHEDULE                 one pupil's timetable: the family's week, and an
 *                            SS12000 v2 read filtered to the pupil (20261026110000)
 *   TEACHING_TIME            undervisningstid per pupil: timplan coverage and
 *                            the pupil's statement (20261026110000)
 *
 * NOT RECORDED, by decision. Each of these hands out something about other
 * people and was weighed; the reason is why a row would answer nothing:
 *
 *   - the timetable layer: who teaches a lesson and which pupils are named on
 *     it (schedule versions, the calendar, master lessons). The web and the
 *     app read CalendarLessons, MasterLessons and MasterLessonStudents
 *     directly through PostgREST, where every member of staff sees them, so
 *     a row for one gateway copy (GET /schedule-versions/:id) would not
 *     answer who saw a pupil's lessons. Recorded where the gateway is the
 *     only way: the family's week (SCHEDULE). The admin's print set (GET
 *     /print/timetables) is this layer too, every class's, teacher's or
 *     room's week by Schemavisaren's whitelist, with no pupil on it; a
 *     printed week of a pupil is the family's week, recorded when it was
 *     read;
 *   - substitute suggestions (GET /calendar-lessons/:id/substitute-
 *     suggestions) and the rollover preview's cleared teachers and
 *     qualification warnings: teachers with their behörighet, which staff
 *     read directly (TeacherSubjectQualifications), against the timetable.
 *     An absent teacher is left out, not named. The cover candidates, which
 *     do name the absent and state load, are recorded;
 *   - the cover day proposal's absences, which it gives only by id: who
 *     is away is the board's, which records it. The substitutes it would
 *     book come with their cover counter and their week against their
 *     tjänst, and are recorded (EMPLOYMENT), as the candidates are;
 *   - counts and summaries that name nobody (/users/counts, the attendance
 *     summary, the rollover preview's pupils, the stage overview without a
 *     class);
 *   - the publication check's timplan coverage (preview and publish): it
 *     judges by both layers and hands out group lines and the verdicts'
 *     sentences, and a pupil verdict's sentence ("En elev i 7A ...") names
 *     no pupil. The teachers a REFUSE staffing check stops on are named,
 *     and recorded (EMPLOYMENT);
 *   - a write's echo: POST /users answers with the row its caller just
 *     typed. PATCH /users/:id answers with the whole row, fields the caller
 *     did not send among them, so it is recorded (PEOPLE). PUT
 *     /teacher-employments/:userId answers with the post it was sent and
 *     the post's periods, which it was not, so a post with periods is
 *     recorded (EMPLOYMENT);
 *   - the realtime pushes (src/realtime): a changed lesson's pupil ids to
 *     its teachers, the timetable editor's presence to the staff. Nobody
 *     asks, no transaction is the recipient's, and the ids name no one
 *     without the register, which records its read;
 *   - notification meta (names in an absence or leave notice): a delivery
 *     the school's rules decide, and the Notifications row is its record —
 *     recipient, kind, content and time, kept until gallring;
 *   - an SS12000 sync change about a person not yet in Users (a CREATE):
 *     the log names Users rows only. The run's changes about linked people
 *     are recorded.
 */
export const ACCESS_KINDS = [
  'PEOPLE',
  'ROSTER',
  'ATTENDANCE',
  'ABSENCE_REPORTS',
  'LEAVE_REQUESTS',
  'LEAVE_REASON_AS_MENTOR',
  'GUARDIANS',
  'EMPLOYMENT',
  'STAFF_ABSENCES',
  'ACCESS_LOG',
  'SCHEDULE',
  'TEACHING_TIME',
] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

/** Which client a person read through, as the request says it. */
export type AccessChannel = 'WEB' | 'APP' | 'OTHER';

/** The header the app names itself in: `X-SchemaPro-Client: app`. */
export const CLIENT_HEADER = 'x-schemapro-client';

type Headers = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim();

/**
 * The channel a request came through: APP when it says so in
 * X-SchemaPro-Client, WEB when a browser sent it (an Origin header: the web
 * calls the gateway cross-origin, so every request of it carries one), OTHER
 * for anything else (a script with a token). A description for the log's
 * reader, never a permission: any caller can send any header.
 *
 * The web sends nothing new. A custom header from the browser would have to
 * be in the gateway's CORS allowlist before the first web build that sends
 * it, or every preflight fails; the app is no browser and has no preflight.
 */
export function channelOf(headers: Headers | undefined): AccessChannel {
  if (first(headers?.[CLIENT_HEADER])?.toLowerCase() === 'app') return 'APP';
  if (first(headers?.['origin'])) return 'WEB';
  return 'OTHER';
}

/**
 * Records, in the read's own transaction, that the transaction's reader read
 * `kind` about `subjectIds`: app.personal_data_read takes the reader from the
 * claims (withRls) or the integration key (withServicePrincipal), drops the
 * reader's own id and anyone not of the school, and leaves out whoever the
 * same reader already read of that kind in the last 15 minutes.
 *
 * One statement, after the reads it records and before the transaction
 * commits: a log that cannot be written fails the read, so a response is never
 * delivered unrecorded. A read that names nobody sends nothing.
 *
 * `channel` is the person's client (AuthenticatedUser.channel); an
 * integration key's read is INTEGRATION whatever is passed.
 */
export async function recordRead(
  tx: PrismaClient,
  kind: AccessKind,
  subjectIds: Iterable<string | null | undefined>,
  channel?: AccessChannel | null,
): Promise<void> {
  const ids = [...new Set([...subjectIds].filter((id): id is string => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return;
  await tx.$executeRaw(
    Prisma.sql`SELECT app.personal_data_read(${kind}::"PersonalDataAccessKind",
                                             ${channel ?? null}::"PersonalDataAccessChannel",
                                             ${ids}::uuid[])`,
  );
}
