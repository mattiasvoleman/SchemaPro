import type { LeaveDelegation, LeaveInboxRequest } from "../../../lib/leave-queries";
import type { LeaveRequest } from "../../../lib/types";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import type { SignedInPerson } from "../sessions";
import { addDays, isoWeekday, stockholmInstant, YEAR_START } from "./calendar";
import { LEAVE_REQUESTS, SCHOOL_BREAKS } from "./school-days";
import { DUTIES } from "./staffing-rows";
import { ADMIN, ALL_PEOPLE, byId, GROUP_LIST, GUARDIAN_LINKS, STUDENT_LIST, YEAR } from "./world";

/**
 * Ledighet as the gateway answers it since the mentor decides (#142,
 * src/family/leave.service.ts): one GET /api/v1/leave-requests for every role
 * — the families' flat row with the names and, for rektor and the mentor, the
 * facts they decide on — and rektor's delegation.
 *
 * Rektor lets a mentor decide a request of at most three skoldagar. Ella's
 * three days sit with her mentor Anna ("Hos elevens mentor" on /admin/leave,
 * the mentor's inbox on /teacher/ledighet); Ines's five wait for rektor.
 */

export const DELEGATION: LeaveDelegation = {
  mentorMaxSchoolDays: 3,
  reference: "Delegationsordning, punkt 4.2",
  decidedAt: stockholmInstant(addDays(YEAR_START, -14), "09:00"),
  decidedBy: `${ADMIN.firstName} ${ADMIN.lastName}`,
};

const nameOf = (id: string | null) => {
  const person = byId(ALL_PEOPLE, id);
  return person ? `${person.firstName} ${person.lastName}` : null;
};

/** Weekdays in the span outside every lov and studiedag. */
function schoolDays(from: string, to: string): number {
  let days = 0;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (isoWeekday(date) > 5) continue;
    if (SCHOOL_BREAKS.some((entry) => entry.startDate <= date && date <= entry.endDate)) continue;
    days++;
  }
  return days;
}

/** A pupil's mentors: whoever holds MENTORSKAP for the pupil's class. */
function mentorsOf(studentId: string): Array<{ id: string; name: string }> {
  const groupId = byId(STUDENT_LIST, studentId)?.studentGroupId ?? null;
  return DUTIES.filter((duty) => duty.kind === "MENTORSKAP" && duty.studentGroupId === groupId).map((duty) => ({
    id: duty.userId,
    name: nameOf(duty.userId) ?? "—",
  }));
}

/**
 * One request as the inbox answers it. The läsår's totals go to whoever
 * weighs them (20261101090000, app.leave_request_facts): rektor on every
 * request, a mentor only on a pending one theirs to decide; a mentor's
 * decided request carries none, and a family's list has no facts at all.
 */
function inboxRow(request: LeaveRequest, family: boolean, weighs = true): LeaveInboxRequest {
  const student = byId(STUDENT_LIST, request.studentId)!;
  const mentors = mentorsOf(request.studentId);
  const days = schoolDays(request.startDate, request.endDate);
  const pending = request.status === "PENDING";
  const toMentor =
    pending && mentors.length > 0 && DELEGATION.mentorMaxSchoolDays !== null && days <= DELEGATION.mentorMaxSchoolDays;
  const own = LEAVE_REQUESTS.filter((row) => row.studentId === request.studentId);
  const approved = own.filter((row) => row.status === "APPROVED");
  return {
    ...request,
    student: {
      id: student.id,
      name: `${student.firstName} ${student.lastName}`,
      className: byId(GROUP_LIST, student.studentGroupId)?.name ?? null,
    },
    requestedBy: nameOf(request.requestedById),
    decidedByName: nameOf(request.decidedById),
    referral: null,
    schoolDays: family ? null : days,
    decides: pending ? (toMentor ? "MENTOR" : "ADMIN") : null,
    mentors: family ? [] : mentors,
    decidingMentors: family || !toMentor ? [] : mentors,
    year: family || !weighs
      ? null
      : {
          name: YEAR.name,
          startDate: YEAR.startDate,
          endDate: YEAR.endDate,
          approvedDays: approved.reduce((sum, row) => sum + schoolDays(row.startDate, row.endDate), 0),
          approvedRequests: approved.length,
          pendingRequests: own.filter((row) => row.status === "PENDING").length,
        },
  };
}

/**
 * Which requests a person reads: rektor all; a mentor the pending ones they
 * may decide and the ones they decided ("Ansökningar som du beslutar om som
 * elevens mentor" — a request over the delegation is rektor's, not theirs);
 * a family its own.
 */
function visible(person: SignedInPerson): LeaveRequest[] {
  if (person.persona === "admin") return LEAVE_REQUESTS;
  if (person.persona === "teacher") {
    return LEAVE_REQUESTS.filter((row) =>
      row.status === "PENDING"
        ? inboxRow(row, false).decidingMentors.some((mentor) => mentor.id === person.userId)
        : row.decidedById === person.userId,
    );
  }
  const own =
    person.persona === "student"
      ? new Set([person.userId])
      : new Set(GUARDIAN_LINKS.filter((link) => link.guardianId === person.userId).map((link) => link.studentId));
  return LEAVE_REQUESTS.filter((row) => own.has(row.studentId));
}

export const leaveRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/leave-requests", (context: GatewayContext): LeaveInboxRequest[] | Reply => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    const status = context.query.get("status");
    const family = context.person.persona === "student" || context.person.persona === "guardian";
    const admin = context.person.persona === "admin";
    return visible(context.person)
      .filter((row) => !status || row.status === status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((row) => inboxRow(row, family, admin || row.status === "PENDING"));
  }),
  route("GET", "/api/v1/leave-delegation", (context) => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    if (context.person.persona !== "admin" && context.person.persona !== "teacher") {
      return new Reply(403, { message: "Forbidden." });
    }
    return { current: DELEGATION, history: [DELEGATION] };
  }),
];
