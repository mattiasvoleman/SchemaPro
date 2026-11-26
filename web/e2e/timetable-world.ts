import type { Page } from "@playwright/test";
import { KIND, STUB_ORIGIN, uid } from "./stub/sessions";
import { SUBJECT_LIST, TEACHERS, YEAR } from "./stub/fixtures/world";

/**
 * A school of the size the board is built for, laid so that nothing double-books:
 * 40 classes of 20 lessons a week is 800 lessons, 30 teachers and 30 rooms, which
 * is what /admin/timetable shows an administrator with the filters empty (the
 * combined view draws every lesson of the year at once). Deterministic.
 *
 *   class c, day d, lesson j (0..3):  slot (c + d + 2j) mod 8, from 08:00 in hours
 *
 * so a class has four lessons a day two hours apart, and at any day and slot there
 * are 20 lessons: their teachers and rooms are 20 of the 30, told apart by the order
 * they are laid in and shifted by day and slot, so that every teacher has gaps. The week is not a good timetable, and is not meant to be one: it is the
 * number of cards, lanes and neighbours that the grid has to draw and to check.
 */

export const CLASSES = 40;
export const PER_CLASS = 20;
export const TEACHER_POOL = 30;
export const ROOM_POOL = 30;
const LETTERS = "ABCDEFGHIJKLM";

export interface LoadLesson {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string;
  roomId: string;
  dayOfWeek: number;
  startMinutes: number;
}

export function loadWorld() {
  const classes = Array.from({ length: CLASSES }, (_, index) => ({
    id: uid(KIND.group, 500 + index),
    name: `${7 + (index % 3)}${LETTERS[Math.floor(index / 3)]}`,
    gradeLevel: 7 + (index % 3),
  }));
  const teachers = Array.from({ length: TEACHER_POOL }, (_, index) => ({
    id: uid(KIND.user, 600 + index),
    firstName: `Lärare${index}`,
    lastName: `Efternamn${index}`,
  }));
  const rooms = Array.from({ length: ROOM_POOL }, (_, index) => ({ id: uid(KIND.room, 600 + index), name: `Sal ${300 + index}` }));
  // Not Idrott och hälsa: it is a subject with a room of its own kind and a change of clothes either side of it, and the board
  // marks a lesson of it as a clash wherever a class has no hall.
  const subjects = SUBJECT_LIST.filter((subject) => subject.name !== "Idrott och hälsa");

  const lessons: LoadLesson[] = [];
  const laid = new Map<string, number>();
  classes.forEach((klass, c) => {
    for (let day = 1; day <= 5; day++) {
      for (let j = 0; j < 4; j++) {
        const slot = (c + day + 2 * j) % 8;
        const key = `${day}:${slot}`;
        const rank = laid.get(key) ?? 0;
        laid.set(key, rank + 1);
        lessons.push({
          id: uid(KIND.masterLesson, 1000 + lessons.length),
          subjectId: subjects[(c + day + j) % subjects.length]!.id,
          studentGroupId: klass.id,
          teacherId: teachers[(rank + day * 7 + slot * 3) % TEACHER_POOL]!.id,
          roomId: rooms[(rank + day * 11 + slot * 5) % ROOM_POOL]!.id,
          dayOfWeek: day,
          startMinutes: 480 + slot * 60,
        });
      }
    }
  });
  return { classes, teachers, rooms, lessons };
}

export type LoadWorld = ReturnType<typeof loadWorld>;

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;

/**
 * Tells the browser the school is this one: the lessons, the classes, the teachers and the rooms
 * are answered as the world has them, and what else the page reads is the stub's own. The year is
 * the stub's (the lessons name it).
 */
export async function serveLoadWorld(page: Page, world: LoadWorld, delays: { read?: number } = {}) {
  await page.route(`${STUB_ORIGIN}/rest/v1/MasterLessons*`, async (route) => {
    // Only the grid's own read of the year's lessons; a HEAD or a count has no rows to give.
    if (route.request().method() !== "GET") return route.continue();
    if (delays.read) await new Promise((resolve) => setTimeout(resolve, delays.read));
    const rows = world.lessons.map((lesson) => ({
      id: lesson.id,
      academicYearId: YEAR.id,
      subjectId: lesson.subjectId,
      studentGroupId: lesson.studentGroupId,
      teacherId: lesson.teacherId,
      coTeacherId: null,
      roomId: lesson.roomId,
      dayOfWeek: lesson.dayOfWeek,
      startTime: clock(lesson.startMinutes),
      endTime: clock(lesson.startMinutes + 60),
      isLocked: false,
      isParked: false,
      fromPlacement: false,
      recurrence: "ALL_WEEKS",
      startDate: null,
      endDate: null,
      extraGroups: [],
      participants: [],
    }));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) });
  });

  // A school with no rule in the way of a drop: no ramtid, no lunch, no closed hours and no rast. The rules
  // the stub's own school has are the ones its few lessons were written to keep, and 800 lessons are not.
  for (const table of ["FrameTimes", "AvailabilityConstraints", "Rasts", "LunchSittings", "LunchServings", "TeacherWorkRules"]) {
    await page.route(`${STUB_ORIGIN}/rest/v1/${table}*`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", headers: { "content-range": "*/0" }, body: "[]" })
        : route.continue(),
    );
  }

  const plus = (path: string, make: (template: Record<string, unknown>) => Array<Record<string, unknown>>) =>
    page.route(`${STUB_ORIGIN}${path}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const rows = (await response.json()) as Array<Record<string, unknown>>;
      await route.fulfill({ response, body: JSON.stringify([...rows, ...make(rows[0] ?? {})]) });
    });

  await plus("/rest/v1/StudentGroups*", (template) =>
    world.classes.map((klass) => ({ ...template, id: klass.id, name: klass.name, kind: "CLASS", gradeLevel: klass.gradeLevel, halfOfId: null })),
  );
  await plus("/rest/v1/Rooms*", (template) => world.rooms.map((room) => ({ ...template, id: room.id, name: room.name, code: room.name })));
  await page.route(`${STUB_ORIGIN}/api/v1/users*`, async (route) => {
    if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== "/api/v1/users") return route.continue();
    const response = await route.fetch();
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    const anna = rows.find((row) => row.id === TEACHERS.anna.id) ?? rows[0]!;
    await route.fulfill({
      response,
      body: JSON.stringify([
        ...rows,
        ...world.teachers.map((teacher) => ({
          ...anna,
          id: teacher.id,
          firstName: teacher.firstName,
          lastName: teacher.lastName,
          email: `${teacher.firstName.toLowerCase()}@exempelskolan.example`,
        })),
      ]),
    });
  });
}
