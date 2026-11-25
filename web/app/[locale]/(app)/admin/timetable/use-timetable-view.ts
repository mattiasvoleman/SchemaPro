import { useMemo, useCallback } from "react";
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
import type { MasterLesson } from "@/lib/types";
import { timeToMinutes, subjectColor } from "@/lib/utils";
import { rastWindows } from "@/lib/rasts";
import { type Audience, audienceFor, showsFraction } from "@/lib/lesson-audience";
import { teacherIdsOf, toPlacement, pupilBufferOf } from "@/lib/conflicts";
import { mealDayFormatter, mealWeeksOf } from "@/lib/lunch-window";
import { type TimetableLesson, type LessonChange } from "@/components/schedule/timetable-grid";
import type { BlockKit } from "@/components/schedule/block-cards";
import type { useTranslations } from "next-intl";
import { type GroupBy, minutesToHHMM } from "./timetable-helpers";
import type { TimetableReads } from "./use-timetable-reads";
import type { ScheduleEngine } from "./use-schedule-engine";

type Translator = ReturnType<typeof useTranslations>;

/**
 * What the grid shows: the filtered lessons, their labels, the lunch and rast bands behind them, the
 * tray and the resource boards of the "group by" view.
 */
export function useTimetableView(inputs: Pick<TimetableReads, "lunchSittings" | "rasts" | "lessons" | "rooms" | "groups"> & Pick<ScheduleEngine, "yearGroups" | "gradeSpanOf" | "rosterIndex" | "groupById" | "pupilBuffers" | "subjectById" | "teacherById" | "roomById" | "conflictMap" | "remoteEditors" | "validateChange" | "teachers"> & {
  /** What each clashing card says, in words (use-conflict-notes.ts): absent until the module that makes them has come. */
  conflictNotes?: ReadonlyMap<string, string>;
  t: Translator;
  locale: string;
  tLunch: Translator;
  onlyGroup: string | null;
  groupFilters: string[];
  teacherFilters: string[];
  roomFilters: string[];
  blockKit: BlockKit | null;
  groupBy: GroupBy;
}) {
  const { lunchSittings, rasts, lessons, rooms, groups, yearGroups, gradeSpanOf, rosterIndex, groupById, pupilBuffers, subjectById, teacherById, roomById, conflictMap, remoteEditors, validateChange, teachers, conflictNotes, t, locale, tLunch, onlyGroup, groupFilters, teacherFilters, roomFilters, blockKit, groupBy } = inputs;
  const groupSections = useMemo(() => {
    const named = (group: { id: string; name: string }) => ({ id: group.id, name: group.name });
    // The schedule on screen is one year's, so its groups are the filter's:
    // another year's 8A (next year's, after a rollover) has no lesson here
    // and would only stand beside this year's under one name.
    const shown = yearGroups;
    return [
      {
        label: t("filterKindClasses"),
        options: shown.filter((group) => group.kind === "CLASS").map(named),
      },
      {
        label: t("filterKindTeachingGroups"),
        options: shown.filter((group) => group.kind !== "CLASS").map(named),
      },
    ];
  }, [yearGroups, t]);

  /**
   * "Lunch", and the weeks it holds when it holds only some: a class that eats
   * at another time in another part of the läsår has a band for each, and the
   * label is what tells them apart.
   */
  const mealDay = useMemo(() => mealDayFormatter(locale), [locale]);
  const mealLabel = useCallback(
    (sitting: { startDate: string | null; endDate: string | null }): string => {
      const weeks = mealWeeksOf(sitting, mealDay);
      if (weeks === null) return tLunch("bandLabel");
      return weeks.kind === "between"
        ? tLunch("bandLabelBetween", { from: weeks.from, to: weeks.to })
        : weeks.kind === "from"
          ? tLunch("bandLabelFrom", { from: weeks.from })
          : tLunch("bandLabelTo", { to: weeks.to });
    },
    [mealDay, tLunch],
  );

  /**
   * The lunch drawn behind the lessons — but ONLY when one class is in view.
   *
   * A sitting belongs to a group. The default view is every group at once, and
   * a stripe across that grid would say "everyone eats at 11:40" when the whole
   * point of the flow is that they do not. Shown for a single group and hidden
   * otherwise is the honest reading; the flow as a whole is on its own page.
   */
  const lunchBands = useMemo(() => {
    if (onlyGroup === null) return undefined;
    const meals = (lunchSittings ?? [])
      .filter((sitting) => sitting.studentGroupId === onlyGroup)
      .map((sitting) => ({
        id: sitting.id,
        dayOfWeek: sitting.dayOfWeek,
        startMinutes: timeToMinutes(sitting.startTime),
        endMinutes: timeToMinutes(sitting.endTime),
        label: mealLabel(sitting),
        // Every meal can be moved — touching one makes it the school's — and
        // only one the school placed can be removed: the solver's own is
        // replaced by the next run, and removing it would leave the day blank.
        movable: true,
        handPlaced: !sitting.isGenerated,
        moveLabel: t("lunchMove"),
        removeLabel: sitting.isGenerated ? undefined : t("lunchRemove"),
      }));

    /*
     * The class's rasts, drawn the same way and for a sharper reason.
     *
     * This lands one commit BEFORE the engine obeys them, and that order is the
     * safety mechanism: a school declaring rasts across its existing
     * hand-placed lessons sees the collisions here, while they are still
     * something to look at, rather than as an INFEASIBLE on the next
     * generation run.
     *
     * Resolved through lib/rasts.ts rather than by filtering rows, because an
     * every-day row and a weekday row that overlaps it are two rows and one
     * day: the band has to show what the pair MEANS.
     */
    const span = gradeSpanOf.get(onlyGroup);
    const breaks = [1, 2, 3, 4, 5].flatMap((dayOfWeek) =>
      rastWindows(rasts ?? [], span, dayOfWeek).map((window) => ({
        id: `${window.id}:${dayOfWeek}`,
        dayOfWeek,
        startMinutes: window.startMinutes,
        endMinutes: window.endMinutes,
        label: window.name,
      })),
    );

    return [...meals, ...breaks];
  }, [lunchSittings, rasts, gradeSpanOf, onlyGroup, mealLabel, t]);

  /**
   * lessonId → what this lesson means for the class in view. Empty for "all".
   *
   * Resolved ONCE here rather than inside toGridLesson, which runs for every
   * card on every frame of a drag; the cards only ever read this map.
   */
  const audienceByLesson = useMemo(() => {
    const map = new Map<string, Audience>();
    if (onlyGroup === null) return map;
    for (const lesson of lessons ?? []) {
      const audience = audienceFor(lesson, onlyGroup, rosterIndex);
      if (audience) map.set(lesson.id, audience);
    }
    return map;
  }, [lessons, onlyGroup, rosterIndex]);

  /**
   * The lessons that reach ANY of the chosen groups, by id.
   *
   * The same reach `audienceByLesson` works out for one class — a lesson filed
   * under 4ma1 holds 4.1's pupils — asked of each chosen group in turn. Its
   * own memo rather than a widening of that one, because the two answer
   * different questions: this one is "is it shown", which four classes can
   * answer together, and that one is "what does it MEAN for the class in
   * view", which they cannot.
   */
  const shownGroups = useMemo(() => {
    const shown = new Set<string>();
    if (groupFilters.length === 0) return shown;
    for (const lesson of lessons ?? []) {
      if (groupFilters.some((groupId) => audienceFor(lesson, groupId, rosterIndex))) {
        shown.add(lesson.id);
      }
    }
    return shown;
  }, [lessons, groupFilters, rosterIndex]);

  const filtered = useMemo(
    () =>
      (lessons ?? []).filter(
        (lesson) =>
          // Not the tray. `filtered` feeds the grid, the boards and both
          // exports, and a parked lesson belongs on none of them.
          !lesson.isParked &&
          // Every lesson holding one of this class's pupils, not only the ones
          // filed under its name: 4.1's maths is filed under 4ma1, and the
          // pupils in it already saw it on their own phones — the RLS policy
          // calendar_lessons_teaching_group_select grants exactly that — while
          // the administrator filtering to 4.1 did not.
          (groupFilters.length === 0 || shownGroups.has(lesson.id)) &&
          // Both teachers. A lesson somebody only CO-taught was missing from
          // their own view — the filter asked a name question where the data
          // is a set.
          (teacherFilters.length === 0 ||
            teacherIdsOf(toPlacement(lesson)).some((id) => teacherFilters.includes(id))) &&
          // A lesson with no room is in none of the rooms picked, which is the
          // honest reading of "show me what is in the slöjd rooms".
          (roomFilters.length === 0 ||
            (lesson.roomId !== null && roomFilters.includes(lesson.roomId))),
      ),
    [lessons, groupFilters, teacherFilters, roomFilters, shownGroups],
  );

  /**
   * Every class in the room, by name — "4.2 + 4.1".
   *
   * Shared by the card, the ICS and the PDF because they were three copies of
   * one sentence and only the card's was ever corrected. A subscriber to 4.1's
   * calendar got "Idrott — 4.2" with nothing saying 4.1 was in the hall too.
   */
  const groupLabel = useCallback(
    (lesson: Pick<MasterLesson, "studentGroupId" | "extraGroupIds">) =>
      [
        groupById.get(lesson.studentGroupId)?.name,
        ...lesson.extraGroupIds.map((id) => groupById.get(id)?.name),
      ]
        .filter(Boolean)
        .join(" + "),
    [groupById],
  );

  /** "2/4" when the class in view is only partly here, else nothing. */
  const shareLabelOf = useCallback(
    (lesson: MasterLesson) => {
      const audience = audienceByLesson.get(lesson.id);
      if (!audience || !showsFraction(audience)) return null;
      return `${audience.attending}/${audience.cohortSize}`;
    },
    [audienceByLesson],
  );

  /**
   * "Eleverna upptagna 07:50–09:20: 10 min ombyte före, 20 min dusch och ombyte
   * efter" — or nothing at all, which is every lesson at nearly every school.
   *
   * The wording is the API's own (master-lessons.service.ts, ombyteOf), because
   * the 409 an admin may read next says the same thing about the same minutes
   * and two spellings of one rule is one too many. The SPAN is here and not
   * there: the grid's reader is looking at a rectangle and needs to know how far
   * past it the class is gone, which is exactly what the rectangle cannot show.
   */
  const pupilTimeNoteOf = useCallback(
    (lesson: MasterLesson): string | undefined => {
      const buffer = pupilBufferOf(pupilBuffers, lesson);
      if (!buffer) return undefined;
      const sides = [
        buffer.minutesBefore > 0
          ? t("pupilTimeBefore", { minutes: buffer.minutesBefore })
          : null,
        buffer.minutesAfter > 0
          ? t("pupilTimeAfter", { minutes: buffer.minutesAfter })
          : null,
      ].filter((side): side is string => side !== null);
      if (sides.length === 0) return undefined;
      return t("pupilTime", {
        start: minutesToHHMM(timeToMinutes(lesson.startTime) - buffer.minutesBefore),
        end: minutesToHHMM(timeToMinutes(lesson.endTime) + buffer.minutesAfter),
        detail: sides.join(", "),
      });
    },
    [pupilBuffers, t],
  );

  const toGridLesson = useCallback(
    (lesson: MasterLesson): TimetableLesson => {
      const subject = subjectById.get(lesson.subjectId);
      const group = groupById.get(lesson.studentGroupId);
      const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : undefined;
      const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
      const audience = audienceByLesson.get(lesson.id);
      return {
        id: lesson.id,
        dayOfWeek: lesson.dayOfWeek,
        startMinutes: timeToMinutes(lesson.startTime),
        endMinutes: timeToMinutes(lesson.endTime),
        title: subject?.name ?? "",
        subtitle: [
          [
            // The classes by NAME. "+1" told a reader that some other class was
            // in the room without telling them which, and the one thing worth
            // knowing about a shared lesson is who you are sharing it with.
            groupLabel(lesson),
            lesson.studentIds.length > 0 ? `⊕${lesson.studentIds.length}` : null,
          ]
            .filter(Boolean)
            .join(" "),
          teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null,
          lesson.fromPlacement ? t("placedMark") : null,
        ]
          .filter(Boolean)
          .join(" · "),
        room: room?.name,
        color: subjectColor(lesson.subjectId, subject?.color),
        locked: lesson.isLocked,
        recurrenceNote: recurrenceBadge(lesson, t) ?? undefined,
        conflicted: conflictMap.has(lesson.id),
        conflictNote: conflictNotes?.get(lesson.id),
        // Hover text only — the rectangle keeps showing the teaching time. A
        // buffer the grid shows nowhere makes the refusal of the next slot look
        // like a bug in the grid.
        pupilTimeNote: pupilTimeNoteOf(lesson),
        remoteEditor: remoteEditors.get(lesson.id),
        // Only when the class is PARTLY here. "28/28" on every one of a class's
        // own lessons is noise on the common case, and a lesson that names the
        // class holds all of it but those a replacing group takes off (SvA7's
        // on 7A's svenska, "24/28") — showsFraction is the library's rule.
        ...(audience && showsFraction(audience)
          ? {
              share: `${audience.attending}/${audience.cohortSize}`,
              shareLabel: t("sharePupils", {
                attending: audience.attending,
                total: audience.cohortSize,
                group: onlyGroup ? (groupById.get(onlyGroup)?.name ?? "") : "",
              }),
            }
          : {}),
      };
    },
    [
      subjectById,
      groupById,
      teacherById,
      roomById,
      conflictMap,
      conflictNotes,
      remoteEditors,
      audienceByLesson,
      onlyGroup,
      groupLabel,
      pupilTimeNoteOf,
      t,
    ],
  );

  const gridLessons: TimetableLesson[] = useMemo(
    () => (blockKit ? blockKit.grid(filtered, toGridLesson) : filtered.map(toGridLesson)),
    [filtered, toGridLesson, blockKit],
  );
  const validateGridChange = useCallback(
    (id: string, change: LessonChange) =>
      blockKit ? blockKit.validate(id, change, validateChange) : validateChange(id, change),
    [blockKit, validateChange],
  );

  /** The tray: lessons set aside, in the order they were lifted. */
  const parked = useMemo(() => (lessons ?? []).filter((lesson) => lesson.isParked), [lessons]);

  /**
   * A lesson as a reader names it — "Matematik · 4.1 · K. Ek · A12".
   *
   * The edit dialog used to open on "Justera lektion" and nothing else, so
   * an administrator with three maths lessons on Tuesday had to remember which
   * one they had clicked. The same line names a card on the tray.
   */
  const lessonName = useCallback(
    (lesson: MasterLesson): string => {
      const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : undefined;
      const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
      return [
        subjectById.get(lesson.subjectId)?.name,
        groupLabel(lesson),
        teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null,
        room?.name,
      ]
        .filter(Boolean)
        .join(" · ");
    },
    [subjectById, groupLabel, teacherById, roomById],
  );

  /** Resource lanes when the "group by" view is active. */
  const resourceBoards = useMemo(() => {
    if (groupBy === "none") return null;
    const boards: Array<{ key: string; label: string; lessons: TimetableLesson[] }> = [];
    const push = (key: string, label: string, match: (l: MasterLesson) => boolean) => {
      const matching = filtered.filter(match);
      if (matching.length > 0) {
        // A parallel block's lessons named as on the grid (block-cards.tsx).
        const drawn = blockKit ? blockKit.grid(matching, toGridLesson) : matching.map(toGridLesson);
        boards.push({ key, label, lessons: drawn });
      }
    };
    if (groupBy === "teacher") {
      for (const teacher of teachers) {
        push(
          teacher.id,
          `${teacher.firstName} ${teacher.lastName}`,
          (l) => teacherIdsOf(toPlacement(l)).includes(teacher.id),
        );
      }
      // "No teacher at all", which is not the same as "no primary teacher".
      // This lane used to catch a lesson carrying only a coTeacherId and file
      // it here — actively mis-filed, not merely absent from its own lane.
      push(
        "__none__",
        t("noTeacher"),
        (l) => teacherIdsOf(toPlacement(l)).length === 0,
      );
    } else if (groupBy === "room") {
      for (const room of rooms ?? []) {
        push(room.id, room.name, (l) => l.roomId === room.id);
      }
      push("__none__", t("noRoom"), (l) => l.roomId === null);
    } else {
      for (const group of groups ?? []) {
        push(group.id, group.name, (l) => l.studentGroupId === group.id);
      }
    }
    return boards;
  }, [groupBy, filtered, toGridLesson, teachers, rooms, groups, t, blockKit]);

  return { groupSections, lunchBands, audienceByLesson, filtered, groupLabel, shareLabelOf, toGridLesson, gridLessons, validateGridChange, parked, lessonName, resourceBoards };
}
