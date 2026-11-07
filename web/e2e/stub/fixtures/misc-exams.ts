import type { Exam, ExamRoom, ExamSettings, InvigilatorCounterRow } from "../../../lib/exam-types";
import { KIND, uid } from "../sessions";
import { addDays, THIS_MONDAY } from "./calendar";
import { GROUPS, ROOM_LIST, ROOMS, SUBJECTS, TEACHERS, YEAR } from "./world";

/**
 * Prov och skrivsalar (/admin/activities/exams): the planner is off, as a school has it
 * until it turns it on; two rooms are skrivsalar; one exam is laid and one is
 * not, with the reason the last run gave. Reads only, as the suites scan pages.
 * A teacher with a protected identity is on no list, as the gateway leaves them.
 */

export const EXAM_SETTINGS: ExamSettings = {
  enabled: false,
  maxPerClassPerDay: 1,
  maxPerClassPerWeek: 3,
  writersPerInvigilator: 30,
  turnoverMinutes: 10,
  replacementSubject: { id: SUBJECTS.mentor.id, name: SUBJECTS.mentor.name },
};

const SEATS: Record<string, number> = { [ROOMS.r101.id]: 28, [ROOMS.gym.id]: 50 };

export const EXAM_ROOMS: ExamRoom[] = ROOM_LIST.map((room) => ({
  roomId: room.id,
  name: room.name,
  code: room.code,
  capacity: room.capacity,
  seats: SEATS[room.id] ?? null,
})).sort((a, b) => a.name.localeCompare(b.name, "sv"));

const WINDOW_FROM = addDays(THIS_MONDAY, 14);
const WINDOW_TO = addDays(THIS_MONDAY, 18);

const exam = (n: number, name: string, extra: Partial<Exam>): Exam => ({
  id: uid(KIND.misc, 9200 + n),
  academicYearId: YEAR.id,
  subjectId: SUBJECTS.ma.id,
  subjectName: SUBJECTS.ma.name,
  name,
  lengthMinutes: 80,
  writers: 28,
  windowKind: "WEEK",
  windowFrom: WINDOW_FROM,
  windowTo: WINDOW_TO,
  fixedStart: null,
  earliestStart: "08:30",
  latestEnd: "15:00",
  groups: [{ id: GROUPS.g7A.id, name: GROUPS.g7A.name }],
  version: "2026-09-01T08:00:00.000Z",
  plan: null,
  lastReason: null,
  ...extra,
});

export const EXAMS: Exam[] = [
  exam(1, "Matematik, algebra", {
    plan: {
      activityId: uid(KIND.misc, 9210),
      date: addDays(THIS_MONDAY, 15),
      start: "08:30",
      end: "09:50",
      sittings: [
        {
          roomId: ROOMS.r101.id,
          roomName: ROOMS.r101.name,
          writers: 28,
          invigilators: [{ teacherId: TEACHERS.bo.id, name: `${TEACHERS.bo.firstName} ${TEACHERS.bo.lastName}` }],
        },
      ],
    },
  }),
  exam(2, "Svenska, uppsats", {
    subjectId: SUBJECTS.sv.id,
    subjectName: SUBJECTS.sv.name,
    lengthMinutes: 120,
    writers: 55,
    groups: [
      { id: GROUPS.g7A.id, name: GROUPS.g7A.name },
      { id: GROUPS.g7B.id, name: GROUPS.g7B.name },
    ],
    lastReason: { code: "EXAM_NO_ROOM_SEATS", params: { writers: 55, seats: 50 }, at: "2026-09-02T09:00:00.000Z" },
  }),
];

export const EXAM_COUNTER: InvigilatorCounterRow[] = [
  { teacherId: TEACHERS.bo.id, name: `${TEACHERS.bo.firstName} ${TEACHERS.bo.lastName}`, passes: 1, minutes: 80 },
];
