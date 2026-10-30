import type { useTranslations } from "next-intl";
import { toast } from "sonner";
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
import type { Audience } from "@/lib/lesson-audience";
import type { AcademicYear, MasterLesson, Person, Room, Subject } from "@/lib/types";

/*
 * The grundschema's two files, ICS and PDF, built here and fetched when one is
 * picked under Fler åtgärder.
 *
 * Neither is needed to SHOW the week: the school asks for a file. lib/ics.ts
 * and lib/pdf.ts were already imported at the press, and this moves the rows
 * that feed them the same distance, out of the page's first load.
 */

type Translator = ReturnType<typeof useTranslations>;

/** What the page has on screen, as the files say it. */
export interface TimetableExportInput {
  /** The "timetable" namespace. */
  t: Translator;
  tDays: Translator;
  year: AcademicYear | null;
  /** The lessons the filters show, the tray left out. */
  lessons: MasterLesson[];
  subjectById: Map<string, Subject>;
  teacherById: Map<string, Person>;
  roomById: Map<string, Room>;
  groupLabel: (lesson: MasterLesson) => string;
  shareLabelOf: (lesson: MasterLesson) => string | null;
  audienceByLesson: Map<string, Audience>;
  /** The class in view when exactly one is, by name; "" otherwise. */
  onlyGroupName: string;
}

function toHHMM(time: string): string {
  return time.slice(0, 5);
}

/** "Utkast – ej publicerat" when the grid is an unpublished draft (lib/publication-draft-notice.ts). */
async function draftNotice({ t, year }: TimetableExportInput): Promise<string | null> {
  if (!year) return null;
  const { draftPendingFor } = await import("@/lib/publication-draft-notice");
  return (await draftPendingFor(year.id)) ? t("draftExportNotice") : null;
}

export async function exportIcs(input: TimetableExportInput): Promise<void> {
  const { t, year, lessons, subjectById, teacherById, roomById, groupLabel, shareLabelOf } = input;
  if (!year) return;
  const [{ buildIcs, downloadIcs }, notice] = await Promise.all([import("@/lib/ics"), draftNotice(input)]);
  const ics = buildIcs(
    lessons.map((lesson) => {
      const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : null;
      return {
        id: lesson.id,
        dayOfWeek: lesson.dayOfWeek,
        startTime: toHHMM(lesson.startTime),
        endTime: toHHMM(lesson.endTime),
        summary: [
          subjectById.get(lesson.subjectId)?.name ?? "",
          groupLabel(lesson),
        ]
          .filter(Boolean)
          .join(" — "),
        location: lesson.roomId
          ? (roomById.get(lesson.roomId)?.name ?? undefined)
          : undefined,
        // The fraction belongs here too. A calendar entry is one block on a
        // phone whether four pupils or fourteen are in it, and the subscriber
        // cannot see the grid's badge.
        description:
          [
            teacher ? `${teacher.firstName} ${teacher.lastName}` : null,
            shareLabelOf(lesson)
              ? t("sharePupils", {
                  attending: input.audienceByLesson.get(lesson.id)!.attending,
                  total: input.audienceByLesson.get(lesson.id)!.cohortSize,
                  group: input.onlyGroupName,
                })
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        // Without these a subscriber sees slöjd every week when it runs
        // every other, and a spring course all through the autumn.
        recurrence: lesson.recurrence,
        startDate: lesson.startDate,
        endDate: lesson.endDate,
      };
    }),
    {
      calendarName: notice ? `${t("title")} (${notice})` : t("title"),
      yearStart: year.startDate,
      yearEnd: year.endDate,
    },
  );
  downloadIcs("timetable.ics", ics);
  toast.success(t("icsExported", { count: lessons.length }));
}

export async function exportPdf(input: TimetableExportInput): Promise<void> {
  const { t, tDays, year, lessons, subjectById, teacherById, roomById, groupLabel, shareLabelOf } = input;
  const [{ exportTimetablePdf }, notice] = await Promise.all([import("@/lib/pdf"), draftNotice(input)]);
  await exportTimetablePdf({
    title: t("title"),
    subtitle: [year?.name, notice].filter(Boolean).join(" · ") || undefined,
    dayNames: [1, 2, 3, 4, 5, 6, 7].map((day) => tDays(String(day))),
    columnLabels: {
      time: t("editStart"),
      subject: t("addSubject"),
      group: t("addGroup"),
      teacher: t("editTeacher"),
      room: t("editRoom"),
    },
    lessons: lessons.map((lesson) => {
      const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : null;
      const coTeacher = lesson.coTeacherId
        ? teacherById.get(lesson.coTeacherId)
        : null;
      return {
        dayOfWeek: lesson.dayOfWeek,
        startTime: toHHMM(lesson.startTime),
        endTime: toHHMM(lesson.endTime),
        subject: subjectById.get(lesson.subjectId)?.name ?? "",
        group: [groupLabel(lesson), shareLabelOf(lesson)]
          .filter(Boolean)
          .join(" "),
        teacher: [
          teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null,
          coTeacher ? `${coTeacher.firstName[0]}. ${coTeacher.lastName}` : null,
        ]
          .filter(Boolean)
          .join(" + "),
        room: lesson.roomId ? (roomById.get(lesson.roomId)?.name ?? "") : "",
        // A/B-veckor: "udda", "jämna", "period", as the grid's own card says.
        weeks: recurrenceBadge(lesson, t) ?? undefined,
      };
    }),
  });
}
