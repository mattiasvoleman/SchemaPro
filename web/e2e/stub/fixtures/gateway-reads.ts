import type { AccessLogAnswer } from "../../../app/[locale]/(app)/admin/dataskydd/use-access-log";
import type { GuardianChild } from "../../../lib/guardian-queries";
import type { GroupAttendanceRow, GroupMembershipRow } from "../../../lib/queries";
import type { AbsenceReport, AttendanceRecordRow, Person } from "../../../lib/types";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { MULTI_GUARDIAN, type SignedInPerson } from "../sessions";
import { CALENDAR_LESSONS_WITH_COVER } from "./cover-world";
import { ABSENCE_REPORTS, ATTENDANCE_RECORDS, GROUP_MEMBERS } from "./school-days";
import { ALL_PEOPLE, byId, GUARDIAN_LINKS, SCHOOL, SECOND_SCHOOL, STUDENT_LIST } from "./world";
import type { MySchool } from "../../../lib/types";

/** MULTI_GUARDIAN's child at Granskolan, the only person the stub keeps there. */
const SECOND_SCHOOL_CHILD: GuardianChild = {
  linkId: "00000090-0000-4000-8000-000000000901",
  id: "00000010-0000-4000-8000-000000000901",
  firstName: "Olle",
  lastName: "Granlund",
  isActive: true,
  studentGroupId: null,
};

const ROLE_OF = { admin: "SCHOOL_ADMIN", teacher: "TEACHER", student: "STUDENT", guardian: "GUARDIAN" } as const;

/**
 * The reads of other people's data that the läslogg moved from PostgREST to
 * the gateway (src/access-log): the school's people, group memberships,
 * attendance, absence reports and guardians. Leave requests, which #142
 * made the mentor's and rektor's inbox too, are in gateway-leave.ts. The gateway
 * scopes them by role as RLS did, so these do too: a guardian gets their
 * own children's rows, a pupil their own, staff the school's.
 *
 * Writing the läslogg is the gateway's business and has no effect a page can
 * see, so nothing here records anything.
 */

const unauthorised = new Reply(401, { message: "Not authenticated." });

/** The pupils a person may read family data of; null for staff, who read the school's. */
function pupilsOf(person: SignedInPerson): Set<string> | null {
  if (person.persona === "student") return new Set([person.userId]);
  if (person.persona === "guardian") {
    return new Set(GUARDIAN_LINKS.filter((link) => link.guardianId === person.userId).map((link) => link.studentId));
  }
  return null;
}

function scoped<T extends { studentId: string }>(context: GatewayContext, rows: T[]): T[] | Reply {
  if (!context.person) return unauthorised;
  const pupils = pupilsOf(context.person);
  return pupils ? rows.filter((row) => pupils.has(row.studentId)) : rows;
}

const staffOnly = (context: GatewayContext) =>
  !context.person ? unauthorised : context.person.persona === "admin" || context.person.persona === "teacher" ? null : new Reply(403, { message: "Forbidden." });

const lessonOf = (id: string) => CALENDAR_LESSONS_WITH_COVER.find((lesson) => lesson.id === id) ?? null;

export const readRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/users", (context): Person[] | Reply => staffOnly(context) ?? ALL_PEOPLE),

  route("GET", "/api/v1/users/counts", (context) => {
    if (context.person?.persona !== "admin") return context.person ? new Reply(403, { message: "Forbidden." }) : unauthorised;
    const count = (role: Person["role"]) => ALL_PEOPLE.filter((person) => person.role === role).length;
    return {
      byRole: { STUDENT: count("STUDENT"), TEACHER: count("TEACHER"), GUARDIAN: count("GUARDIAN"), SCHOOL_ADMIN: count("SCHOOL_ADMIN") },
    };
  }),

  route("GET", "/api/v1/attendance/summary", (context) => {
    if (context.person?.persona !== "admin") return context.person ? new Reply(403, { message: "Forbidden." }) : unauthorised;
    const since = context.query.get("since") ?? "";
    const rows = ATTENDANCE_RECORDS.filter((row) => (row.recordedAt ?? "") >= `${since}T00:00:00Z`);
    return { recorded: rows.length, present: rows.filter((row) => row.status === "PRESENT" || row.status === "LATE").length };
  }),

  route("GET", "/api/v1/student-groups/memberships", (context): GroupMembershipRow[] | Reply => staffOnly(context) ?? GROUP_MEMBERS),

  /*
   * The login's schools (Flera skolor per inloggning): one for every person
   * the stub knows, and two for the guardian with a second school. The one
   * the request names is the chosen one; none named is the fixture school.
   */
  route("GET", "/api/v1/me/schools", (context): MySchool[] | Reply => {
    if (!context.person) return unauthorised;
    const own = (school: { id: string; name: string }, role: MySchool["role"]): MySchool => ({
      schoolId: school.id,
      schoolName: school.name,
      role,
      adminProfile: role === "SCHOOL_ADMIN" ? "FULL" : null,
      closed: null,
      current: (context.school ?? SCHOOL.id) === school.id,
    });
    const role = ROLE_OF[context.person.persona];
    if (context.person.authId !== MULTI_GUARDIAN.authId) return [own(SCHOOL, role)];
    return [own(SCHOOL, "GUARDIAN"), own(SECOND_SCHOOL, "GUARDIAN")];
  }),

  route("GET", "/api/v1/family/children", (context): GuardianChild[] | Reply => {
    if (!context.person) return unauthorised;
    if (context.school === SECOND_SCHOOL.id) {
      return context.person.authId === MULTI_GUARDIAN.authId ? [SECOND_SCHOOL_CHILD] : new Reply(403, { code: "SCHOOL_NOT_AVAILABLE" });
    }
    return GUARDIAN_LINKS.filter((link) => link.guardianId === context.person!.userId).map((link) => {
      const child = byId(STUDENT_LIST, link.studentId)!;
      return {
        linkId: link.id,
        id: child.id,
        firstName: child.firstName,
        lastName: child.lastName,
        isActive: child.isActive,
        studentGroupId: child.studentGroupId,
      };
    });
  }),

  route("GET", "/api/v1/absence-reports", (context): AbsenceReport[] | Reply => {
    const date = context.query.get("date");
    const studentId = context.query.get("studentId");
    const rows = ABSENCE_REPORTS.filter(
      (row) => (!date || row.date === date) && (!studentId || row.studentId === studentId),
    ).sort((a, b) => (a.date < b.date ? 1 : -1));
    return scoped(context, rows);
  }),


  route("GET", "/api/v1/attendance/lessons/:lessonId/records", (context): { records: AttendanceRecordRow[] } | Reply => {
    const refused = staffOnly(context);
    if (refused) return refused;
    return { records: ATTENDANCE_RECORDS.filter((row) => row.calendarLessonId === context.params.lessonId) };
  }),

  route("GET", "/api/v1/attendance/groups/:groupId/records", (context): { records: GroupAttendanceRow[] } | Reply => {
    const refused = staffOnly(context);
    if (refused) return refused;
    const from = context.query.get("from") ?? "0000-00-00";
    const to = context.query.get("to") ?? "9999-12-31";
    // By the pupil's home class, as the gateway counts it.
    const pupils = new Set(STUDENT_LIST.filter((pupil) => pupil.studentGroupId === context.params.groupId).map((pupil) => pupil.id));
    const records = ATTENDANCE_RECORDS.filter((row) => pupils.has(row.studentId)).flatMap((row) => {
      const lesson = lessonOf(row.calendarLessonId);
      if (!lesson || lesson.date < from || lesson.date > to) return [];
      return [{ studentId: row.studentId, status: row.status, lesson: { id: lesson.id, date: lesson.date, startsAt: lesson.startsAt, endsAt: lesson.endsAt } }];
    });
    return { records };
  }),

  route("GET", "/api/v1/guardian-links", (context) => {
    if (context.person?.persona !== "admin") return context.person ? new Reply(403, { message: "Forbidden." }) : unauthorised;
    const studentId = context.query.get("studentId");
    return GUARDIAN_LINKS.filter((link) => link.studentId === studentId).map((link) => {
      const guardian = byId(ALL_PEOPLE, link.guardianId)!;
      return {
        id: link.id,
        guardianId: link.guardianId,
        guardian: { id: guardian.id, firstName: guardian.firstName, lastName: guardian.lastName, email: guardian.email },
      };
    });
  }),

  // /admin/dataskydd's "Vem har läst om …": asked only by the form's button.
  route("GET", "/api/v1/access-log", (context): AccessLogAnswer | Reply => {
    if (context.person?.persona !== "admin") return context.person ? new Reply(403, { message: "Forbidden." }) : unauthorised;
    const person = byId(ALL_PEOPLE, context.query.get("personId"));
    if (!person) return new Reply(404, { message: "Not found." });
    return {
      person: { id: person.id, firstName: person.firstName, lastName: person.lastName, role: person.role },
      timezone: SCHOOL.timezone,
      from: context.query.get("from"),
      to: context.query.get("to"),
      entries: [],
      truncated: false,
    };
  }),
];
