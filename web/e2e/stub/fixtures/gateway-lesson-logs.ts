import type {
  ClassBook,
  HandedOverLesson,
  LessonLogEntry,
  LessonLogLesson,
  LessonLogText,
  SubstituteNoteText,
} from "../../../lib/lesson-log";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import type { Persona } from "../sessions";
import { NOW } from "./calendar";
import { ABSENCE_LIST, CALENDAR_LESSON_TEACHERS_WITH_COVER, DECISIONS } from "./cover-world";
import { attends, schoolClock } from "./gateway-family";
import { LESSON_LOGS, SUBSTITUTE_NOTES } from "./lesson-logs";
import {
  byId,
  CALENDAR_LESSONS,
  GROUP_LIST,
  MASTER_LESSONS,
  ROOM_LIST,
  SCHOOL,
  STUDENT_LIST,
  SUBJECT_LIST,
  TEACHER_LIST,
  TEACHERS,
} from "./world";

/**
 * Lektionslogg's gateway (src/lesson-log): the teacher's lesson page, the
 * pupil's and the teacher's own lessons over a range, and the klassbok.
 * The teacher persona is Anna, who teaches her lessons and covers Bo's
 * Thursday mathematics in 9A (cover-world.ts); the
 * administrator writes drift (the läsare is the admin persona too, and the
 * page hides the write by data-writes, as the real one does). No
 * administrator reads or writes a note to the substitute: the route admits
 * teachers alone, as the real one does.
 */

function refuse(context: GatewayContext, personas: Persona[]): Reply | null {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  if (!personas.includes(context.person.persona)) return new Reply(403, { message: "Forbidden resource" });
  return null;
}

type CalendarLesson = (typeof CALENDAR_LESSONS)[number];

/** Who is on each lesson now, the board's decisions applied (Anna covers Thursday's 9A for Bo). */
const TEACHER_ROWS = CALENDAR_LESSON_TEACHERS_WITH_COVER;

const nameOf = (id: string) => {
  const teacher = byId(TEACHER_LIST, id);
  return teacher ? `${teacher.firstName} ${teacher.lastName}` : "";
};

/** Who was away from each decided lesson: the absent teacher of the cover decision (cover-world.ts). */
const absentOf = (lessonId: string) =>
  DECISIONS.filter((decision) => decision.lessonId === lessonId).map(
    (decision) => ABSENCE_LIST.find((absence) => absence.id === decision.absenceId)?.userId,
  );

/** app.lesson_teacher_role for Anna: her own row on the lesson, or her absence a decision on it was made for. */
function annasRole(lesson: CalendarLesson): "REGULAR" | "SUBSTITUTE" | null {
  const rows = TEACHER_ROWS.filter((row) => row.calendarLessonId === lesson.id && row.teacherId === TEACHERS.anna.id);
  if (rows.some((row) => row.role !== "SUBSTITUTE") || absentOf(lesson.id).includes(TEACHERS.anna.id)) return "REGULAR";
  return rows.length > 0 ? "SUBSTITUTE" : null;
}

function lessonPage(context: GatewayContext): LessonLogLesson | Reply {
  const refused = refuse(context, ["teacher", "admin"]);
  if (refused) return refused;
  const lesson = byId(CALENDAR_LESSONS, context.params.id);
  if (!lesson) return new Reply(404, { message: "Lektionen finns inte.", code: "LESSON_NOT_FOUND" });
  const admin = context.person!.persona === "admin";
  const role = admin ? "ADMIN" : (annasRole(lesson) ?? "COLLEAGUE");
  const may = {
    writeLog: admin || role === "REGULAR" || role === "SUBSTITUTE",
    readNote: role === "REGULAR" || role === "SUBSTITUTE",
    writeNote: role === "REGULAR",
  };
  const master = byId(MASTER_LESSONS, lesson.masterLessonId);
  return {
    lesson: {
      id: lesson.id,
      date: lesson.date,
      start: schoolClock(lesson.startsAt),
      end: schoolClock(lesson.endsAt),
      status: lesson.status,
      subject: byId(SUBJECT_LIST, lesson.subjectId)?.name ?? "",
      subjectColor: byId(SUBJECT_LIST, lesson.subjectId)?.color ?? null,
      groups: [byId(GROUP_LIST, lesson.studentGroupId)?.name ?? "", ...(master?.extraGroupIds ?? []).map((id) => byId(GROUP_LIST, id)?.name ?? "")],
      room: byId(ROOM_LIST, lesson.roomId)?.name ?? null,
      teachers: TEACHER_ROWS.filter((row) => row.calendarLessonId === lesson.id).map((row) => ({
        name: nameOf(row.teacherId),
        role: row.role,
      })),
    },
    role,
    may,
    log: LESSON_LOGS.get(lesson.id) ?? null,
    note: may.readNote ? (SUBSTITUTE_NOTES.get(lesson.id) ?? null) : null,
  };
}

/** A PUT as the gateway answers it: the text as saved, stamped now. Accepted and forgotten, as the stub's writes are. */
function putLog(context: GatewayContext): { log: LessonLogText | null } | Reply {
  const refused = refuse(context, ["teacher", "admin"]);
  if (refused) return refused;
  const body = (context.body ?? {}) as { topic?: string | null; homework?: string | null };
  const topic = body.topic?.trim() || null;
  const homework = body.homework?.trim() || null;
  return { log: topic || homework ? { topic, homework, writtenBy: "Anna Lind", updatedAt: NOW } : null };
}

function putNote(context: GatewayContext): { note: SubstituteNoteText | null } | Reply {
  const refused = refuse(context, ["teacher"]);
  if (refused) return refused;
  const body = ((context.body ?? {}) as { body?: string | null }).body?.trim() || null;
  return { note: body ? { body, writtenBy: "Anna Lind", updatedAt: NOW } : null };
}

function ownLessons(context: GatewayContext): { entries: LessonLogEntry[] } | Reply {
  const refused = refuse(context, ["student", "teacher"]);
  if (refused) return refused;
  const from = context.query.get("from") ?? "";
  const to = context.query.get("to") ?? "";
  const inRange = CALENDAR_LESSONS.filter((lesson) => lesson.date >= from && lesson.date <= to);
  if (context.person!.persona === "student") {
    const pupil = STUDENT_LIST.find((student) => student.id === context.person!.userId)!;
    return {
      entries: inRange
        .filter((lesson) => attends(pupil, lesson) && LESSON_LOGS.has(lesson.id))
        .map((lesson) => {
          const log = LESSON_LOGS.get(lesson.id)!;
          return { lessonId: lesson.id, topic: log.topic, homework: log.homework };
        }),
    };
  }
  const onLesson = (lesson: CalendarLesson) =>
    TEACHER_ROWS.some((row) => row.calendarLessonId === lesson.id && row.teacherId === TEACHERS.anna.id);
  return {
    entries: inRange
      .filter((lesson) => onLesson(lesson) && (LESSON_LOGS.has(lesson.id) || SUBSTITUTE_NOTES.has(lesson.id)))
      .map((lesson) => ({
        lessonId: lesson.id,
        topic: LESSON_LOGS.get(lesson.id)?.topic ?? null,
        homework: LESSON_LOGS.get(lesson.id)?.homework ?? null,
        substituteNote: SUBSTITUTE_NOTES.get(lesson.id)?.body ?? null,
      })),
  };
}

/** The lessons Anna handed over for an absence (none this week: her course day has no decision). */
function handedOver(context: GatewayContext): { lessons: HandedOverLesson[] } | Reply {
  const refused = refuse(context, ["teacher"]);
  if (refused) return refused;
  const from = context.query.get("from") ?? "";
  const to = context.query.get("to") ?? "";
  const mine = DECISIONS.filter((decision) => ABSENCE_LIST.find((absence) => absence.id === decision.absenceId)?.userId === TEACHERS.anna.id);
  return {
    lessons: mine.flatMap((decision) => {
      const lesson = byId(CALENDAR_LESSONS, decision.lessonId);
      if (!lesson || lesson.date < from || lesson.date > to) return [];
      return [
        {
          lessonId: lesson.id,
          date: lesson.date,
          startsAt: lesson.startsAt,
          endsAt: lesson.endsAt,
          subjectId: lesson.subjectId,
          studentGroupId: lesson.studentGroupId,
          roomId: lesson.roomId,
          status: lesson.status,
          decision: decision.decision,
          noted: SUBSTITUTE_NOTES.has(lesson.id),
        },
      ];
    }),
  };
}

function classBook(context: GatewayContext): ClassBook | Reply {
  const refused = refuse(context, ["teacher", "admin"]);
  if (refused) return refused;
  const group = byId(GROUP_LIST, context.query.get("groupId"));
  if (!group) return new Reply(404, { message: "Klassen finns inte.", code: "CLASS_BOOK_GROUP_NOT_FOUND" });
  const from = context.query.get("from") ?? "";
  const to = context.query.get("to") ?? "";
  const pupils = group.kind === "CLASS" ? STUDENT_LIST.filter((student) => student.isActive && student.studentGroupId === group.id) : [];
  const lessons = CALENDAR_LESSONS.filter((lesson) => lesson.date >= from && lesson.date <= to)
    .flatMap((lesson) => {
      const master = byId(MASTER_LESSONS, lesson.masterLessonId);
      const own = lesson.studentGroupId === group.id || (master?.extraGroupIds ?? []).includes(group.id);
      const attending = own ? null : pupils.filter((pupil) => attends(pupil, lesson)).length;
      return own || (attending ?? 0) > 0 ? [{ lesson, attending }] : [];
    })
    .sort((a, b) => a.lesson.startsAt.localeCompare(b.lesson.startsAt));
  return {
    school: SCHOOL.name,
    group: { id: group.id, name: group.name, kind: group.kind },
    from,
    to,
    timezone: "Europe/Stockholm",
    pupils: pupils.length,
    lessons: lessons.map(({ lesson, attending }) => ({
      id: lesson.id,
      date: lesson.date,
      start: schoolClock(lesson.startsAt),
      end: schoolClock(lesson.endsAt),
      status: lesson.status,
      subject: byId(SUBJECT_LIST, lesson.subjectId)?.name ?? "",
      groups: [byId(GROUP_LIST, lesson.studentGroupId)?.name ?? ""],
      room: byId(ROOM_LIST, lesson.roomId)?.name ?? null,
      teachers: TEACHER_ROWS.filter((row) => row.calendarLessonId === lesson.id).map((row) => ({
        name: nameOf(row.teacherId),
        substitute: row.role === "SUBSTITUTE",
      })),
      topic: LESSON_LOGS.get(lesson.id)?.topic ?? null,
      homework: LESSON_LOGS.get(lesson.id)?.homework ?? null,
      attending,
    })),
  };
}

export const lessonLogRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/lesson-logs", ownLessons),
  route("GET", "/api/v1/lesson-logs/handed-over", handedOver),
  route("GET", "/api/v1/lesson-logs/class-book", classBook),
  route("GET", "/api/v1/lesson-logs/lessons/:id", lessonPage),
  route("PUT", "/api/v1/lesson-logs/lessons/:id", putLog),
  route("PUT", "/api/v1/lesson-logs/lessons/:id/substitute-note", putNote),
];
