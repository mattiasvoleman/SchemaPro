import { Reply, route, type GatewayRoute } from "../gateway-routes";

/**
 * Krisläge as the gateway answers it (src/crisis/crisis.controller.ts).
 *
 * By default for a school where no alarm has ever been started: the settings
 * as a school that has set nothing has them, no alarm in the lists, and none
 * for a teacher. So /admin/crisis opens on its start panel and /teacher/crisis
 * on its empty state, which is what the signed-in scan (a11y-app.spec.ts) reads.
 *
 * With the scenario "crisis-open" (x-stub-scenario, e2e/signed-in.ts
 * askForScenario) a live evacuation is going: one group with every kind of
 * pupil, one in a break, one nobody answers for, and the group of pupils who
 * are on no lesson's list (basis NO_LESSON, the gateway's Swedish stand-in
 * names, nobody to answer for it). The teacher has the first two groups, one
 * pupil found with them who is on another list, and the school's other
 * pupils to pick from. An alarm that is going is a
 * state the one world does not hold, because a page that reads it would
 * change every other page's counts; crisis.a11y.spec.ts asks for it by name.
 */

export const OPEN_SCENARIO = "crisis-open";

const STARTED = "2027-01-12T09:14:00.000Z";
const AT = (minutes: number) => new Date(Date.parse(STARTED) + minutes * 60_000).toISOString();
const ALARM_ID = "00000000-0000-4000-8000-0000000c1001";

const pupil = (id: string, firstName: string, lastName: string, status: string, markedAt: string | null = null) => ({
  studentId: id,
  firstName,
  lastName,
  status,
  priorAbsentSource: status === "ABSENT_BEFORE" ? "ATTENDANCE" : null,
  markedAt,
  markedBy: markedAt ? "Anna Berg" : null,
});

const counts = (pupils: Array<{ status: string }>) => ({
  pupils: pupils.length,
  found: pupils.filter((one) => one.status === "FOUND").length,
  missing: pupils.filter((one) => one.status === "MISSING").length,
  absentBefore: pupils.filter((one) => one.status === "ABSENT_BEFORE").length,
  unreported: pupils.filter((one) => one.status === "UNREPORTED").length,
});

const SEVEN_A = [
  pupil("00000000-0000-4000-8000-0000000c2001", "Ines", "Ek", "FOUND", AT(3)),
  pupil("00000000-0000-4000-8000-0000000c2002", "Jamal", "Ali", "MISSING", AT(4)),
  pupil("00000000-0000-4000-8000-0000000c2003", "Klara", "Nyman", "UNREPORTED"),
  pupil("00000000-0000-4000-8000-0000000c2004", "Leo", "Berg", "ABSENT_BEFORE"),
];
const EIGHT_B = [pupil("00000000-0000-4000-8000-0000000c2005", "Olle", "Lind", "UNREPORTED")];
const NINE_C = [
  pupil("00000000-0000-4000-8000-0000000c2006", "Rut", "Ek", "UNREPORTED"),
  pupil("00000000-0000-4000-8000-0000000c2007", "Sam", "Ek", "UNREPORTED"),
];

const AFTER_SCHOOL = [
  pupil("00000000-0000-4000-8000-0000000c2008", "Tove", "Åberg", "UNREPORTED"),
  pupil("00000000-0000-4000-8000-0000000c2009", "Ulf", "Nord", "ABSENT_BEFORE"),
];

const call = (id: string, groupName: string, pupils: ReturnType<typeof pupil>[], extra: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-0000000c30${id}`,
  lessonId: null,
  basis: "LESSON",
  groupName,
  subjectName: "Matematik",
  roomName: "Sal 12",
  lessonStartsAt: AT(-14),
  lessonEndsAt: AT(36),
  completedAt: null,
  counts: counts(pupils),
  pupils,
  ...extra,
});

const ANNA = { userId: "00000000-0000-4000-8000-0000000c4001", name: "Anna Berg", role: "LEAD", answeredAt: AT(3) };
const BO = { userId: "00000000-0000-4000-8000-0000000c4002", name: "Bo Ek", role: "ASSISTANT", answeredAt: null };
const CIA = { userId: "00000000-0000-4000-8000-0000000c4003", name: "Cia Dahl", role: "LEAD", answeredAt: null };

const CALLS = [
  call("00", "Ej i lektion just nu", AFTER_SCHOOL, {
    lessonId: null,
    basis: "NO_LESSON",
    subjectName: "Ingen lektion pågår",
    roomName: null,
    lessonStartsAt: STARTED,
    lessonEndsAt: STARTED,
    uncovered: true,
    teachers: [],
  }),
  call("01", "7A", SEVEN_A, { uncovered: false, teachers: [ANNA, BO] }),
  call("02", "8B", EIGHT_B, { basis: "NEXT_LESSON", subjectName: "Engelska", uncovered: false, teachers: [CIA] }),
  call("03", "9C", NINE_C, { roomName: null, uncovered: true, teachers: [{ userId: null, name: null, role: "LEAD", answeredAt: null }] }),
];

const ALARM = {
  id: ALARM_ID,
  kind: "EVACUATION",
  mode: "LIVE",
  startedAt: STARTED,
  startedBy: "Rut Rektor",
  endedAt: null,
  endedBy: null,
  autoEnded: false,
  endNote: null,
  guardiansNotifiedAt: null,
};

const SUMMARY = {
  ...ALARM,
  unlisted: AFTER_SCHOOL.length,
  calls: CALLS.length,
  callsComplete: 0,
  counts: counts([...AFTER_SCHOOL, ...SEVEN_A, ...EIGHT_B, ...NINE_C]),
  teachers: 3,
  teachersAnswered: 1,
};

const other = (id: string, firstName: string, lastName: string, className: string | null) => ({
  studentId: `00000000-0000-4000-8000-0000000c5${id}`,
  firstName,
  lastName,
  className,
});

const MINE = {
  asOf: AT(6),
  alarms: [
    {
      ...ALARM,
      calls: [
        {
          ...CALLS[1]!,
          colleagues: ["Bo Ek"],
          teachers: undefined,
          uncovered: undefined,
          foundHere: [{ ...other("001", "Vera", "Sund", "9A"), markedAt: AT(5) }],
        },
        { ...CALLS[2]!, colleagues: [], teachers: undefined, uncovered: undefined, foundHere: [] },
      ],
      // Every pupil of the school who is on none of the teacher's lists (here: the other groups', and the after-school pupils).
      others: [
        other("001", "Vera", "Sund", "9A"),
        other("002", "Wilmer", "Ek", "9A"),
        other("003", "Yrsa", "Lund", "6B"),
        ...[...NINE_C, ...AFTER_SCHOOL].map((one) => ({ studentId: one.studentId, firstName: one.firstName, lastName: one.lastName, className: null })),
      ],
    },
  ],
};

export const crisisRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/crisis/settings", () => ({
    startProfiles: ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION"],
    notifyGuardiansAfter: false,
  })),
  route("GET", "/api/v1/crisis/alarms", ({ scenario }) => (scenario === OPEN_SCENARIO ? [SUMMARY] : [])),
  route("GET", "/api/v1/crisis/alarms/:id", ({ scenario, params }) =>
    scenario === OPEN_SCENARIO && params.id === ALARM_ID
      ? { alarm: SUMMARY, calls: CALLS }
      : new Reply(404, { message: "Larmet finns inte.", code: "CRISIS_ALARM_NOT_FOUND" }),
  ),
  route("GET", "/api/v1/crisis/mine", ({ scenario }) =>
    scenario === OPEN_SCENARIO ? MINE : { asOf: new Date().toISOString(), alarms: [] },
  ),
];
