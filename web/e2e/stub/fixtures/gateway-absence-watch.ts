import type { AbsenceWatchFinding, AbsenceWatchLimit, AbsenceWatchOverview } from "../../../lib/absence-watch";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { KIND, uid } from "../sessions";
import { addDays, THIS_MONDAY } from "./calendar";
import { DUTIES } from "./staffing-rows";
import { byId, GROUP_LIST, GUARDIAN_LINKS, STUDENTS, STUDENT_LIST } from "./world";

/**
 * Frånvarobevakning as the gateway answers it (src/absence-watch/): the
 * administrator's overview (the switch, the cadences and the limits) and the
 * findings each reader's row security hands them.
 *
 * The school has the watch on with three limits. Four pupils have passed one:
 * Ines (7A) and Jamal (7A) the mentor's, Ella (7A) the guardians' share of
 * the minutes, Klara (7B) a run of days for rektor; Leo (7B) came back under
 * the mentor's limit two days ago, shown only to a reader who asks for the
 * recent. Figures are minutes and days; nothing here says why anyone was away.
 */

const LIMITS: AbsenceWatchLimit[] = [
  { id: uid(KIND.misc, 8001), recipientGroup: "MENTOR", kind: "SHARE", basis: "INVALID", percent: 10, windowDays: 14, consecutiveDays: null },
  { id: uid(KIND.misc, 8002), recipientGroup: "REKTOR", kind: "CONSECUTIVE", basis: "ALL", percent: null, windowDays: null, consecutiveDays: 5 },
  { id: uid(KIND.misc, 8003), recipientGroup: "GUARDIAN", kind: "SHARE", basis: "ALL", percent: 20, windowDays: 28, consecutiveDays: null },
];

export const ABSENCE_WATCH_OVERVIEW: AbsenceWatchOverview = {
  settings: {
    enabled: true,
    enabledOn: addDays(THIS_MONDAY, -30),
    cadence: { MENTOR: "WEEKLY", REKTOR: "WEEKLY", KANSLI: "WEEKLY", GUARDIAN: "MONTHLY" },
  },
  limits: LIMITS,
};

const nameOf = (pupil: (typeof STUDENT_LIST)[number]) => `${pupil.firstName} ${pupil.lastName}`;
const classOf = (pupil: (typeof STUDENT_LIST)[number]) => byId(GROUP_LIST, pupil.studentGroupId)?.name ?? null;

function share(
  n: number,
  pupil: (typeof STUDENT_LIST)[number],
  limit: AbsenceWatchLimit,
  absentMinutes: number,
  recordedMinutes: number,
  firstCrossedOn: string,
  clearedOn: string | null = null,
): AbsenceWatchFinding {
  return {
    id: uid(KIND.misc, 8100 + n),
    studentId: pupil.id,
    studentName: nameOf(pupil),
    className: classOf(pupil),
    recipientGroup: limit.recipientGroup,
    kind: limit.kind,
    basis: limit.basis,
    percent: limit.percent,
    windowDays: limit.windowDays,
    consecutiveDays: limit.consecutiveDays,
    firstCrossedOn,
    lastSeenOn: clearedOn ? addDays(clearedOn, -1) : addDays(THIS_MONDAY, -1),
    clearedOn,
    absentMinutes,
    recordedMinutes,
    streakDays: null,
  };
}

const FINDINGS: AbsenceWatchFinding[] = [
  share(1, STUDENTS.ines, LIMITS[0]!, 340, 2400, addDays(THIS_MONDAY, -3)),
  share(2, STUDENTS.jamal, LIMITS[0]!, 275, 2520, addDays(THIS_MONDAY, -10)),
  share(3, STUDENTS.ella, LIMITS[2]!, 1010, 4200, addDays(THIS_MONDAY, -6)),
  {
    ...share(4, STUDENTS.klara, LIMITS[1]!, 0, 0, addDays(THIS_MONDAY, -8)),
    absentMinutes: null,
    recordedMinutes: null,
    streakDays: 6,
  },
  share(5, STUDENTS.leo, LIMITS[0]!, 250, 2500, addDays(THIS_MONDAY, -20), addDays(THIS_MONDAY, -2)),
];

/** A teacher's: the MENTOR-group findings of the classes they hold MENTORSKAP for. */
function mentored(userId: string): Set<string> {
  return new Set(DUTIES.filter((duty) => duty.kind === "MENTORSKAP" && duty.userId === userId).map((duty) => duty.studentGroupId ?? ""));
}

function visible(context: GatewayContext): AbsenceWatchFinding[] {
  const person = context.person!;
  if (person.persona === "admin") return FINDINGS;
  if (person.persona === "teacher") {
    const classes = mentored(person.userId);
    return FINDINGS.filter(
      (row) => row.recipientGroup === "MENTOR" && classes.has(byId(STUDENT_LIST, row.studentId)?.studentGroupId ?? ""),
    );
  }
  const children = new Set(GUARDIAN_LINKS.filter((link) => link.guardianId === person.userId).map((link) => link.studentId));
  return person.persona === "guardian"
    ? FINDINGS.filter((row) => row.recipientGroup === "GUARDIAN" && children.has(row.studentId))
    : [];
}

export const absenceWatchRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/absence-watch", (context) => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    return context.person.persona === "admin" ? ABSENCE_WATCH_OVERVIEW : new Reply(403, { message: "Forbidden." });
  }),
  route("GET", "/api/v1/absence-watch/findings", (context) => {
    if (!context.person) return new Reply(401, { message: "Not authenticated." });
    if (context.person.persona === "student") return new Reply(403, { message: "Forbidden." });
    const recent = context.query.get("recent") === "1";
    return { findings: visible(context).filter((row) => recent || row.clearedOn === null), truncated: false };
  }),
];
