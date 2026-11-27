import fixture from "../../src/calendar/__fixtures__/lesson-judge-cases.json";
import { clockOfMinutes, minutesOfClock } from "./requirement-placement-text";
import type { AvailabilityConstraint, LunchSitting, MasterLesson, StudentGroup } from "./types";
import type { FrameTime } from "./frame-times";

/*
 * THE JUDGE'S FALLFIL, IN THE WEB'S SHAPES (E1).
 *
 * src/calendar/__fixtures__/lesson-judge-cases.json holds small worlds and, for each, lessons dragged to new days and clocks with the
 * verdict of the gateway's real judge (scripts/test/probe-domaren.ts writes it). Tests only: the grid's mirror is held to the verdicts
 * (lesson-judge-mirror.contract.test.ts), and what the page offers after a refused drop is held to the drag's own judge
 * (app/.../admin/timetable/suggestions-and-the-drag.test.ts), both from the same worlds, built here once.
 */

export interface World {
  classes: { key: string; grade: number }[];
  teachers: string[];
  rooms: string[];
  subjects: string[];
  /** `class` is a class or a teaching group; `extra`, `participants` and the window are only in the richer worlds (probe-domaren.ts). */
  lessons: {
    key: string;
    class: string;
    subject: string;
    teacher: string;
    coTeacher?: string;
    room?: string;
    day: number;
    start: string;
    minutes: number;
    recurrence?: string;
    extra?: string[];
    participants?: string[];
    startDate?: string;
    endDate?: string;
  }[];
  unavailable: { kind: "teacher" | "room" | "class" | "grade"; key?: string; grades?: [number, number]; day: number; start: string; end: string }[];
  frames: { grades: [number, number]; start: string; end: string }[];
  meals: { class: string; day: number; start: string; end: string; startDate?: string; endDate?: string }[];
  /** The pupils, each in the class they name; the teaching groups of pupils; the rooms another school of the huvudman has borrowed. */
  pupils?: { key: string; class: string; inactive?: true }[];
  groups?: { key: string; members: string[] }[];
  loans?: { room: string; day: number; start: string; end: string }[];
}
export interface Case {
  name: string;
  world: number;
  drag: { lesson: string; day: number; start: string };
  verdict: { ok: boolean; reasons: string[] };
}

export const worlds = fixture.worlds as unknown as World[];
export const cases = fixture.cases as unknown as Case[];

export const lessonsOf = (world: World): MasterLesson[] =>
  world.lessons.map((lesson) => ({
    id: lesson.key,
    academicYearId: "y1",
    subjectId: lesson.subject,
    studentGroupId: lesson.class,
    teacherId: lesson.teacher,
    coTeacherId: lesson.coTeacher ?? null,
    roomId: lesson.room ?? null,
    dayOfWeek: lesson.day,
    startTime: `${lesson.start}:00`,
    endTime: `${clockOfMinutes(minutesOfClock(lesson.start) + lesson.minutes)}:00`,
    isLocked: false,
    isParked: false,
    recurrence: (lesson.recurrence ?? "ALL_WEEKS") as MasterLesson["recurrence"],
    startDate: lesson.startDate ?? null,
    endDate: lesson.endDate ?? null,
    extraGroupIds: lesson.extra ?? [],
    studentIds: lesson.participants ?? [],
  }));

export const constraintsOf = (world: World): AvailabilityConstraint[] =>
  world.unavailable.map((entry, index) => ({
    id: `c${index}`,
    resourceType: entry.kind === "teacher" ? "TEACHER" : entry.kind === "room" ? "ROOM" : entry.kind === "class" ? "STUDENT_GROUP" : "GRADE_LEVEL",
    userId: entry.kind === "teacher" ? entry.key! : null,
    roomId: entry.kind === "room" ? entry.key! : null,
    studentGroupId: entry.kind === "class" ? entry.key! : null,
    minGradeLevel: entry.kind === "grade" ? entry.grades![0] : null,
    maxGradeLevel: entry.kind === "grade" ? entry.grades![1] : null,
    dayOfWeek: entry.day,
    date: null,
    startTime: entry.start,
    endTime: entry.end,
    type: "UNAVAILABLE",
    reason: null,
  }));

export const groupsOf = (world: World): StudentGroup[] => [
  ...world.classes.map((entry) => ({ id: entry.key, academicYearId: "y1", name: entry.key, kind: "CLASS" as const, gradeLevel: entry.grade })),
  ...(world.groups ?? []).map((group) => ({ id: group.key, academicYearId: "y1", name: group.key, kind: "TEACHING_GROUP" as const, gradeLevel: null })),
];

/** Each pupil's home class, as the page holds it (use-schedule-engine.ts: the active pupils, studentId → class). Empty in the worlds that have no pupils. */
export const homeClassOf = (world: World): Map<string, string | null> => new Map((world.pupils ?? []).filter((pupil) => pupil.inactive !== true).map((pupil) => [pupil.key, pupil.class]));

/** The pupils as the page's people list holds them: in the home class they name, active unless they have left. */
export const peopleOf = (world: World) =>
  (world.pupils ?? []).map((pupil) => ({ id: pupil.key, role: "STUDENT" as const, isActive: pupil.inactive !== true, studentGroupId: pupil.class, firstName: pupil.key, lastName: "Elev" }));

/** The teaching groups' memberships, as the page reads them for the relation of groups that share pupils. */
export const membershipsOf = (world: World): Array<{ studentId: string; studentGroupId: string }> =>
  (world.groups ?? []).flatMap((group) => group.members.map((studentId) => ({ studentId, studentGroupId: group.key })));

export const framesOf = (world: World): FrameTime[] =>
  world.frames.map((frame, index) => ({
    id: `f${index}`,
    minGradeLevel: frame.grades[0],
    maxGradeLevel: frame.grades[1],
    dayOfWeek: null,
    startTime: frame.start,
    endTime: frame.end,
  })) as FrameTime[];

export const sittingsOf = (world: World): LunchSitting[] =>
  world.meals.map((meal, index) => ({
    id: `m${index}`,
    studentGroupId: meal.class,
    dayOfWeek: meal.day,
    startTime: `${meal.start}:00`,
    endTime: `${meal.end}:00`,
    headcount: 25,
    isGenerated: false,
    startDate: meal.startDate ?? null,
    endDate: meal.endDate ?? null,
  }));
