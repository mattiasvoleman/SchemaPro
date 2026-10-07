"use client";

// Three open questions asked of a schedule that is already laid.
//
// Every other page here is about a lesson: create it, move it, publish it. This
// one has no lesson in hand. It asks the schedule itself when a set of people
// and rooms is free at once, where the håltimmar are, and who is free at a
// given moment — the three things somebody finslipar a timetable with.
//
// It is a separate route on purpose. /admin/timetable already measures 180.7KB
// against a 190KB budget, and none of this belongs inside the create-lesson
// dialog anyway; the questions are asked while looking at the whole week, not
// while placing one lesson.
//
// No endpoint and no migration: every answer is computed in the browser from
// data the client already holds for the grid (lib/gaps.ts, which in turn
// delegates every "busy" verdict to lib/conflicts.ts). Nothing here may grow a
// second opinion about what occupies a class, a teacher or a room.
//
// Accessibility is part of the feature, not a pass over it. Concretely: every
// result is text in reading order, counts are announced through a live region
// when a search completes, and colour never carries meaning alone — a long gap
// says "lång".
//
// CONTRAST, MEASURED. Every pair below was computed from the HSL tokens in
// app/globals.css and rounded to 8-bit the way a browser paints them. Light
// theme first, then dark:
//
//   foreground on background      18.69 / 16.36   AAA
//   foreground on card            18.69 / 15.43   AAA
//   secondary-fg on secondary     16.12 / 13.19   AAA — the plain badge
//   accent-fg on accent            9.74 /  7.33   AAA — the parity badge
//   focus ring on background       6.18 /  4.63   over SC 1.4.11's 3:1
//   muted-fg as a control border   4.83 /  6.54   over SC 1.4.11's 3:1
//   primary-fg on primary          6.18 /  5.12   AA, NOT AAA — at rest
//   the same pair on :hover        5.31 /  4.34   BELOW AA in dark
//
// So: AAA for every piece of text this page writes, and AA for the two submit
// buttons AT REST. Their hover state falls to 4.34:1 in dark, under AA's 4.5
// floor — a real failure, and not one this page can honestly fix alone: it is
// `bg-primary/90` from the shared Button, so every button in the product paints
// it. Recorded here rather than rounded away, and worth raising as its own
// change against components/ui/button.tsx.
//
// These buttons are `bg-primary` — the product's brand button. Reaching 7:1
// there needs --primary at 56% lightness or lower in light and 77% or higher
// in dark, which repaints every button in the product and is not one page's
// call. The number is written down rather than rounded up, because an AAA
// claim that is not true tells the owner a box is ticked while a reader with
// low vision is shut out.
//
// `muted-foreground` (4.83 / 6.54 — AA, not AAA) is kept off this page as
// text: PageHeader's subtitle slot and EmptyState's description slot are left
// empty and the same sentences are written as our own paragraphs, and the
// results table's headers, which TableHead paints muted by default, are
// overridden back to `foreground`. It does appear twice as non-text, where the
// bar is 3:1 and it clears — the empty-state icon (4.40 / 5.28), and the
// border this page draws on its own boxed controls (see CONTROL below). That
// border is ours because the shared `border-input` measures 1.27 / 1.40
// against the page, under SC 1.4.11's 3:1, which is a control with no visible
// edge. Product-wide, and older than this page.
//
// Not claimed: 1.4.8 (measure and line spacing are set, but the app offers no
// user-chosen colours) and 3.1.5 (reading level never measured). Nothing here
// has met a real screen reader or axe: the route is behind a Supabase session
// and e2e/a11y.spec.ts scans public routes only.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarSearch, Hourglass, UserSearch } from "lucide-react";
import {
  useActiveYear,
  useConstraints,
  useGroupMemberships,
  useGroups,
  useLunchSettings,
  useMasterLessons,
  usePeople,
  useRequirements,
  useRooms,
  useFrameTimes,
} from "@/lib/queries";
import { buildGroupConflictMap, buildPupilBufferMap, toPlacement } from "@/lib/conflicts";
import { buildGradeSpans } from "@/lib/grade-span";
import {
  DEFAULT_MINIMUM_GAP_MINUTES,
  findFreeWindows,
  findIdleGaps,
  lunchWindowOf,
  whoIsFree,
  type GapReport,
  type IdleGap,
  type ScheduleData,
} from "@/lib/gaps";
import type { LessonRecurrence } from "@/lib/types";
import { timeToMinutes } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Lengths worth searching for, in minutes — a Swedish lesson and its neighbours. */
const FREE_LENGTHS = [30, 40, 45, 60, 80, 90, 120];

/** Where "a hole" starts being worth reporting rather than being a rast. */
const GAP_MINIMUMS = [15, 30, 45, 60];

const WEEK_OPTIONS: LessonRecurrence[] = ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"];

/**
 * Every control this page owns that is a box rather than a fill: 44px tall,
 * with an edge you can see.
 *
 * The shared `border-input` measures 1.27:1 against the page in light and
 * 1.40:1 in dark — under the 3:1 SC 1.4.11 asks of the boundary that tells a
 * reader a control is there. A select trigger, a time field and an outline
 * button are identified by that boundary and nothing else, so this page draws
 * its own in muted-foreground (4.83 / 6.54). The filled submit buttons are
 * exempt: their own fill is 6.18 / 5.12 against the page, so the shape reads
 * without help. Not fixed in input.tsx / select.tsx / button.tsx, because
 * those three are the form controls of the entire product.
 */
const CONTROL = "h-11 border-muted-foreground";

/** How many reports section 2 shows before the reader has to ask for the rest. */
const IDLE_PAGE_SIZE = 10;

/**
 * The shortest ordinary lesson in a Swedish school, and therefore the unit a
 * håltimme is felt in: a hole shorter than one lesson is an awkward wait, one
 * as long as two is half a morning. The bands exist so the page can say "lång"
 * in words — a colour alone would tell a sighted reader something a screen
 * reader never hears.
 *
 * The band is read off idleMinutes, not off the wall clock: the same minutes
 * the per-report totals are counted in, and the only ones anybody actually
 * waits through. A 100-minute hole with lunch inside it is 70 minutes of
 * waiting. `lengthLegend` says so in as many words — the band and the sentence
 * that explains it have to agree, or the page states a rule and then breaks it
 * on the line above.
 */
const LESSON_MINUTES = 40;

type Severity = "short" | "medium" | "long";

function severityOf(idleMinutes: number): Severity {
  if (idleMinutes >= 2 * LESSON_MINUTES) return "long";
  if (idleMinutes >= LESSON_MINUTES) return "medium";
  return "short";
}

const SEVERITY_KEY: Record<Severity, string> = {
  short: "lengthShort",
  medium: "lengthMedium",
  long: "lengthLong",
};

/** Minutes since midnight as "HH:MM". */
function clock(minutes: number): string {
  const hours = String(Math.floor(minutes / 60)).padStart(2, "0");
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

interface Option {
  id: string;
  label: string;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** "1 h 20 min", "2 h", "45 min" — never a bare number of minutes. */
function duration(t: Translate, minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t("durationMinutes", { minutes });
  if (rest === 0) return t("durationHoursOnly", { hours });
  return t("durationHours", { hours, minutes: rest });
}

const RECURRENCE_KEY: Record<LessonRecurrence, string> = {
  ALL_WEEKS: "recurrenceAll",
  ODD_WEEKS: "recurrenceOdd",
  EVEN_WEEKS: "recurrenceEven",
};

function toggle(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * A checkbox list, because a multi-select has to be readable and operable
 * without sight or a mouse. The row — not the box — is the target: it is
 * 44px tall and clicking anywhere in it toggles, which is what makes the
 * control usable on a phone as well as with a screen reader.
 */
function BodyPicker({
  legend,
  emptyLabel,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  emptyLabel: string;
  options: Option[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="rounded-md border p-3">
      <legend className="px-1 text-sm font-semibold text-foreground">{legend}</legend>
      {options.length === 0 ? (
        <p className="px-1 py-2 text-sm text-foreground">{emptyLabel}</p>
      ) : (
        <ul className="max-h-56 space-y-0.5 overflow-y-auto">
          {options.map((option) => (
            <li key={option.id}>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm text-foreground hover:bg-muted">
                <input
                  type="checkbox"
                  // ring-offset-background, not Tailwind's default offset,
                  // which is a hard-coded #fff — a white halo round every box
                  // on an almost-black page. Button and SelectTrigger both set
                  // it; this was the one control that did not.
                  className="h-5 w-5 shrink-0 accent-primary ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  checked={selected.has(option.id)}
                  onChange={() => onToggle(option.id)}
                />
                <span>{option.label}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** A word-carrying badge. Both palettes below measure ≥7:1 in both themes. */
function Tag({
  children,
  emphasis,
}: {
  children: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <span
      className={
        emphasis
          ? "inline-flex items-center rounded-md bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground"
          : "inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
      }
    >
      {children}
    </span>
  );
}

export default function GapsPage() {
  const t = useTranslations("gaps");
  const tDays = useTranslations("days");
  // The three parity values are the same three the lesson editor names, so
  // they are read from the same place rather than translated twice.
  const tTimetable = useTranslations("timetable");

  const { activeYear } = useActiveYear();
  const { data: lessons, isLoading } = useMasterLessons(activeYear?.id ?? null);
  const { data: constraints } = useConstraints();
  const { data: groups } = useGroups();
  const { data: people } = usePeople();
  const { data: rooms } = useRooms();
  const { data: memberships } = useGroupMemberships();
  const { data: frameTimes } = useFrameTimes();
  const { data: lunchSettings } = useLunchSettings();
  // The timplan, for one thing only: the minutes the pupils are occupied
  // outside a lesson. The same query the timetable page reads its buffers from,
  // so the two pages cannot disagree about which minutes are taken.
  const { data: requirements } = useRequirements(activeYear?.id ?? null);

  // -------------------------------------------------------------------
  // The bodies, and the schedule they are asked about
  // -------------------------------------------------------------------

  const teachers = useMemo(
    () =>
      // Inactive staff are left out everywhere on this page: an answer to "who
      // can take Wednesday at ten" that names somebody who has left the school
      // is worse than a short list.
      (people ?? []).filter((person) => person.role === "TEACHER" && person.isActive),
    [people],
  );
  const students = useMemo(
    () => (people ?? []).filter((person) => person.role === "STUDENT" && person.isActive),
    [people],
  );
  const studentGroupOf = useMemo(
    () => new Map(students.map((student) => [student.id, student.studentGroupId])),
    [students],
  );
  const groupConflicts = useMemo(
    () => buildGroupConflictMap(studentGroupOf, memberships ?? []),
    [studentGroupOf, memberships],
  );
  /**
   * groupId -> the years it holds, so a GRADE_LEVEL rule can reach it.
   *
   * A teaching group has no year of its own, so it is derived from its members'
   * home classes — the same derivation the server does for the solver payload.
   * Without this the rule matches nothing and the search offers time a year
   * rule has closed; see lib/grade-span.ts.
   */
  const gradeSpanOf = useMemo(
    () =>
      buildGradeSpans({
        groups: groups ?? [],
        membersByGroup: (memberships ?? []).reduce((map, row) => {
          const list = map.get(row.studentGroupId);
          if (list) list.push(row.studentId);
          else map.set(row.studentGroupId, [row.studentId]);
          return map;
        }, new Map<string, string[]>()),
        homeClassOf: studentGroupOf,
      }),
    [groups, memberships, studentGroupOf],
  );
  /**
   * (class, subject) → the minutes the class is occupied outside the lesson.
   *
   * Undefined while the timplan is in flight rather than an empty map, for the
   * reason the frames and the roster are: an empty map is a school where nobody
   * changes for anything, and reading "not loaded yet" as that reports holes the
   * children are standing in the omklädningsrummet through.
   */
  const pupilBuffers = useMemo(
    () => (requirements ? buildPupilBufferMap(requirements) : undefined),
    [requirements],
  );
  // Wrapped rather than passed by reference: toPlacement takes the pupil-buffer
  // map as its second argument, which `map` would fill with the array index.
  const placements = useMemo(
    () => (lessons ?? []).map((lesson) => toPlacement(lesson, pupilBuffers)),
    [lessons, pupilBuffers],
  );

  const scheduleData: ScheduleData = useMemo(
    () => ({
      placements,
      constraints: constraints ?? [],
      groupConflicts,
      // studentGroupOf and memberships travel together: the two of them are
      // the roster, and findIdleGaps counts a hole per pupil off it. Sending
      // only the first says every pupil sits in their home class and nothing
      // else, which loses every elective — the fourteen of 7A who are idle
      // while the other sixteen are in Ma71 would be reported as nobody.
      studentGroupOf,
      gradeSpanOf,
      // Undefined while the query is in flight, and that is the right value to
      // pass on: an empty array is a school with no ramtider, where every hour
      // is inside the day, and reading "not loaded yet" as that offers time a
      // frame has closed for as long as the request takes.
      frameTimes,
      // `undefined` while the query is in flight, never `[]`. An empty array is
      // a complete roster that happens to hold nobody, and findIdleGaps reads
      // it as one: it switches to the per-pupil reading and finds no pupils, so
      // every class reports no håltimmar at all. Absent instead means "no
      // roster known", which falls back to the whole-group reading — the old
      // answer, coarser but never wrong in that direction.
      memberships,
    }),
    // gradeSpanOf and frameTimes belong here for the same reason the rest do:
    // both arrive from queries that resolve after the first render, and a memo
    // that does not name them keeps answering with the empty week it was built
    // from — the search would report time as free until something else on the
    // page happened to change.
    [
      placements,
      constraints,
      groupConflicts,
      studentGroupOf,
      gradeSpanOf,
      frameTimes,
      memberships,
    ],
  );

  /** The active year's groups: the schedule searched is the active year's (see the timetable). */
  const yearGroups = useMemo(
    () => (groups ?? []).filter((group) => group.academicYearId === activeYear?.id),
    [groups, activeYear?.id],
  );
  const groupOptions: Option[] = useMemo(
    () => yearGroups.map((group) => ({ id: group.id, label: group.name })),
    [yearGroups],
  );
  const teacherOptions: Option[] = useMemo(
    () =>
      teachers.map((teacher) => ({
        id: teacher.id,
        label: `${teacher.firstName} ${teacher.lastName}`,
      })),
    [teachers],
  );
  const roomOptions: Option[] = useMemo(
    () => (rooms ?? []).map((room) => ({ id: room.id, label: room.name })),
    [rooms],
  );
  const labelOf = useMemo(
    () => new Map([...groupOptions, ...teacherOptions, ...roomOptions].map((o) => [o.id, o.label])),
    [groupOptions, teacherOptions, roomOptions],
  );

  /**
   * Monday–Friday plus any weekday the school actually teaches on. Widened
   * rather than replaced: a Saturday school must not lose its weekdays, and a
   * school with an empty Wednesday still wants Wednesday offered as free.
   */
  const searchDays = useMemo(
    () =>
      [...new Set([1, 2, 3, 4, 5, ...placements.map((p) => p.dayOfWeek)])].sort(
        (a, b) => a - b,
      ),
    [placements],
  );

  /**
   * The school day, widened to hold every lesson. findFreeWindows defaults to
   * 08:00–17:00; a school with a 07:30 first period would otherwise be told its
   * own first slot does not exist.
   */
  const daySpan = useMemo(() => {
    let start = 8 * 60;
    let end = 17 * 60;
    for (const placement of placements) {
      start = Math.min(start, placement.startMinutes);
      end = Math.max(end, placement.endMinutes);
    }
    return { start, end };
  }, [placements]);

  // -------------------------------------------------------------------
  // 1. Ledig tid
  // -------------------------------------------------------------------

  const [pickedGroups, setPickedGroups] = useState<ReadonlySet<string>>(new Set());
  const [pickedTeachers, setPickedTeachers] = useState<ReadonlySet<string>>(new Set());
  const [pickedRooms, setPickedRooms] = useState<ReadonlySet<string>>(new Set());
  const [freeLength, setFreeLength] = useState("60");

  /**
   * The search runs on submit, not on every checkbox. Not for speed — it
   * measures 2ms — but because the result count is announced out loud, and a
   * live region that fires on every keystroke is noise rather than help.
   */
  const [freeQuery, setFreeQuery] = useState<{
    groupIds: string[];
    teacherIds: string[];
    roomIds: string[];
    minimumMinutes: number;
  } | null>(null);

  const freeWindows = useMemo(() => {
    if (!freeQuery) return null;
    return findFreeWindows({
      ...scheduleData,
      studentGroupIds: freeQuery.groupIds,
      teacherIds: freeQuery.teacherIds,
      roomIds: freeQuery.roomIds,
      minimumMinutes: freeQuery.minimumMinutes,
      days: searchDays,
      dayStartMinutes: daySpan.start,
      dayEndMinutes: daySpan.end,
    });
  }, [freeQuery, scheduleData, searchDays, daySpan]);

  const freeWho = freeQuery
    ? [...freeQuery.groupIds, ...freeQuery.teacherIds, ...freeQuery.roomIds]
        .map((id) => labelOf.get(id) ?? id)
        .join(", ")
    : "";
  const freeEmptySelection = freeQuery !== null && freeWho === "";

  const submitFree = (event: React.FormEvent) => {
    event.preventDefault();
    setFreeQuery({
      groupIds: [...pickedGroups],
      teacherIds: [...pickedTeachers],
      roomIds: [...pickedRooms],
      minimumMinutes: Number(freeLength),
    });
  };

  const clearFree = () => {
    setPickedGroups(new Set());
    setPickedTeachers(new Set());
    setPickedRooms(new Set());
    setFreeQuery(null);
  };

  const pickedCount = pickedGroups.size + pickedTeachers.size + pickedRooms.size;

  // -------------------------------------------------------------------
  // 2. Håltimmar
  // -------------------------------------------------------------------

  const [gapMinimum, setGapMinimum] = useState(String(DEFAULT_MINIMUM_GAP_MINUTES));
  const [gapScope, setGapScope] = useState<"ALL" | "STUDENT_GROUP" | "TEACHER">("ALL");
  const [gapLimit, setGapLimit] = useState<number | null>(IDLE_PAGE_SIZE);

  /**
   * Index of the first report the reader has just uncovered, or null.
   *
   * "Visa alla" unmounts itself: its own click makes the condition that renders
   * it false. Focus then falls to <body>, which drops a keyboard reader at the
   * top of the document — three sections above the list they just expanded —
   * and the live region above says nothing, because the count it reports is
   * the same before and after. So the first uncovered report takes focus, and
   * the region changes from "showing the ten heaviest" to "showing all 42".
   */
  const [revealedFrom, setRevealedFrom] = useState<number | null>(null);
  const revealedRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (revealedFrom === null) return;
    revealedRef.current?.focus();
  }, [revealedFrom]);

  /**
   * Only home classes, not teaching groups. A pupil sits in exactly one class;
   * Ma71 is the same pupils under another name, and because the conflict map
   * makes the two share every busy minute, reporting both would count the same
   * håltimme twice and rank a school's own duplicates above its worst days.
   */
  const classIds = useMemo(
    () => yearGroups.filter((group) => group.kind === "CLASS").map((group) => group.id),
    [yearGroups],
  );

  const lunchWindow = useMemo(() => lunchWindowOf(lunchSettings), [lunchSettings]);

  // The one question here worth memoising per data change rather than per
  // render: the whole school at once measures ~50ms.
  const gapReports = useMemo(
    () =>
      findIdleGaps({
        ...scheduleData,
        studentGroupIds: classIds,
        teacherIds: teacherOptions.map((option) => option.id),
        lunch: lunchSettings ?? null,
        minimumMinutes: Number(gapMinimum),
      }),
    [scheduleData, classIds, teacherOptions, lunchSettings, gapMinimum],
  );

  const visibleReports = useMemo(
    () =>
      gapScope === "ALL"
        ? gapReports
        : gapReports.filter((report) => report.kind === gapScope),
    [gapReports, gapScope],
  );
  const shownReports =
    gapLimit === null ? visibleReports : visibleReports.slice(0, gapLimit);
  const idleTruncated = shownReports.length < visibleReports.length;

  // -------------------------------------------------------------------
  // 3. Vem är ledig då?
  // -------------------------------------------------------------------

  const [whoDay, setWhoDay] = useState("3");
  const [whoStart, setWhoStart] = useState("10:00");
  const [whoEnd, setWhoEnd] = useState("11:00");
  const [whoWeeks, setWhoWeeks] = useState<LessonRecurrence>("ALL_WEEKS");
  const [whoQuery, setWhoQuery] = useState<{
    dayOfWeek: number;
    startMinutes: number;
    endMinutes: number;
    weeks: LessonRecurrence;
  } | null>(null);
  const [whoInvalid, setWhoInvalid] = useState(false);

  const whoResult = useMemo(() => {
    if (!whoQuery) return null;
    return whoIsFree({
      ...scheduleData,
      dayOfWeek: whoQuery.dayOfWeek,
      startMinutes: whoQuery.startMinutes,
      endMinutes: whoQuery.endMinutes,
      weeks: whoQuery.weeks,
      studentGroupIds: groupOptions.map((option) => option.id),
      teacherIds: teacherOptions.map((option) => option.id),
      roomIds: roomOptions.map((option) => option.id),
    });
  }, [whoQuery, scheduleData, groupOptions, teacherOptions, roomOptions]);

  const submitWho = (event: React.FormEvent) => {
    event.preventDefault();
    const startMinutes = timeToMinutes(whoStart);
    const endMinutes = timeToMinutes(whoEnd);
    // A backwards interval overlaps nothing, so the module would answer it with
    // "everybody is free" — an answer that looks like a result and is not one.
    if (endMinutes <= startMinutes) {
      setWhoInvalid(true);
      setWhoQuery(null);
      return;
    }
    setWhoInvalid(false);
    setWhoQuery({
      dayOfWeek: Number(whoDay),
      startMinutes,
      endMinutes,
      weeks: whoWeeks,
    });
  };

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  const gapLine = (gap: IdleGap, report: GapReport): string => {
    const severity = severityOf(gap.idleMinutes);
    const parts = [
      `${tDays(String(gap.dayOfWeek))} ${clock(gap.startMinutes)}–${clock(gap.endMinutes)}`,
      duration(t, gap.minutes),
    ];
    // "14 av 30 elever lediga" — the clause that makes the row actionable.
    // Half a class idle while the other half is in an elective is a hole worth
    // moving something into; the whole class idle is a different problem. A
    // teacher is one person and not a roster, so studentCount is 0 there and
    // the clause is left off rather than printed as "1 av 1".
    if (report.studentCount > 0 && gap.idleStudents > 0) {
      parts.push(
        t("idleStudents", { free: gap.idleStudents, total: report.studentCount }),
      );
    }
    if (gap.lunchMinutes > 0) {
      parts.push(t("idleLunch", { minutes: duration(t, gap.lunchMinutes) }));
    }
    if (gap.weeks !== "ALL_WEEKS") {
      parts.push(tTimetable(RECURRENCE_KEY[gap.weeks]));
    }
    parts.push(t(SEVERITY_KEY[severity]));
    return parts.join(" · ");
  };

  const reportName = (report: GapReport): string =>
    labelOf.get(report.subjectId) ?? report.subjectId;

  if (isLoading) {
    return (
      <div>
        <PageHeader title={t("title")} />
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    );
  }

  if (placements.length === 0) {
    return (
      <div>
        <PageHeader title={t("title")} />
        {/*
          Title only. EmptyState's `description` slot renders in
          muted-foreground, which measures 4.83:1 light and 6.54:1 dark — AA,
          but short of the 7:1 this page holds itself to — so the hint is
          written out here instead. Its icon is muted-foreground too (4.40 /
          5.28 on the muted circle), which is fine: a decorative graphic is
          held to SC 1.4.11's 3:1, not to 7:1.
        */}
        <EmptyState icon={CalendarSearch} title={t("empty")} />
        <p className="mx-auto mt-3 max-w-prose text-center text-sm leading-relaxed text-foreground">
          {t("emptyHint")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <PageHeader title={t("title")} />
      {/*
        PageHeader's own subtitle slot is muted-foreground for the same reason,
        so the standfirst is a paragraph of ours. max-w-prose caps the measure
        at 65 characters and leading-relaxed gives the 1.5 line spacing AAA
        asks for; the app's default text-sm leading is 1.43.
      */}
      <p className="-mt-4 max-w-prose text-base leading-relaxed text-foreground">
        {t("intro")}
      </p>

      {/* ---------------- 1. Ledig tid ---------------- */}
      <section aria-labelledby="free-heading" className="space-y-4">
        <h2 id="free-heading" className="flex items-center gap-2 text-xl font-semibold">
          <CalendarSearch className="h-5 w-5 shrink-0" aria-hidden="true" />
          {t("freeTitle")}
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-foreground">{t("freeHint")}</p>

        <form onSubmit={submitFree} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <BodyPicker
              legend={t("freeGroups")}
              emptyLabel={t("noneAvailable")}
              options={groupOptions}
              selected={pickedGroups}
              onToggle={(id) => setPickedGroups((current) => toggle(current, id))}
            />
            <BodyPicker
              legend={t("freeTeachers")}
              emptyLabel={t("noneAvailable")}
              options={teacherOptions}
              selected={pickedTeachers}
              onToggle={(id) => setPickedTeachers((current) => toggle(current, id))}
            />
            <BodyPicker
              legend={t("freeRooms")}
              emptyLabel={t("noneAvailable")}
              options={roomOptions}
              selected={pickedRooms}
              onToggle={(id) => setPickedRooms((current) => toggle(current, id))}
            />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-48 space-y-2">
              <Label htmlFor="free-length">{t("freeLength")}</Label>
              <Select value={freeLength} onValueChange={setFreeLength}>
                <SelectTrigger id="free-length" className={CONTROL} aria-label={t("freeLength")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREE_LENGTHS.map((minutes) => (
                    <SelectItem
                      key={minutes}
                      value={String(minutes)}
                      className="min-h-11 py-2"
                    >
                      {duration(t, minutes)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" className="h-11">
              {t("freeSearch")}
            </Button>
            <Button type="button" variant="outline" className={CONTROL} onClick={clearFree}>
              {t("freeClear")}
            </Button>
            <p className="text-sm text-foreground">{t("freeSelected", { count: pickedCount })}</p>
          </div>
        </form>

        {/*
          The live region is mounted from the first render, empty. A region
          added to the DOM together with its text is not announced by most
          screen readers — only a change inside an existing one is.
        */}
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium text-foreground">
          {freeEmptySelection
            ? t("freeNobody")
            : freeWindows === null
              ? ""
              : freeWindows.length === 0
                ? t("freeNone", {
                    minutes: duration(t, freeQuery?.minimumMinutes ?? 0),
                    who: freeWho,
                  })
                : t("freeCount", { count: freeWindows.length, who: freeWho })}
        </p>

        {freeWindows !== null && freeWindows.length > 0 ? (
          <Table>
            <caption className="sr-only">{t("freeCaption", { who: freeWho })}</caption>
            <TableHeader>
              {/*
                text-foreground on all four: TableHead's own base class is
                text-muted-foreground, which is 4.83:1 light and 6.54:1 dark —
                AA, and short of the 7:1 the rest of this page holds to. The
                override is here rather than in table.tsx because that
                component is painted by every page in the product.
              */}
              <TableRow>
                <TableHead scope="col" className="text-foreground">
                  {t("colDay")}
                </TableHead>
                <TableHead scope="col" className="text-foreground">
                  {t("colTime")}
                </TableHead>
                <TableHead scope="col" className="text-foreground">
                  {t("colLength")}
                </TableHead>
                <TableHead scope="col" className="text-foreground">
                  {t("colWeeks")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {freeWindows.map((window) => (
                <TableRow
                  key={`${window.dayOfWeek}-${window.startMinutes}-${window.endMinutes}-${window.weeks}`}
                >
                  <TableCell className="text-foreground">
                    {tDays(String(window.dayOfWeek))}
                  </TableCell>
                  <TableCell className="text-foreground">
                    {clock(window.startMinutes)}–{clock(window.endMinutes)}
                  </TableCell>
                  <TableCell className="text-foreground">
                    {duration(t, window.endMinutes - window.startMinutes)}
                  </TableCell>
                  <TableCell>
                    <Tag emphasis={window.weeks !== "ALL_WEEKS"}>
                      {tTimetable(RECURRENCE_KEY[window.weeks])}
                    </Tag>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </section>

      {/* ---------------- 2. Håltimmar ---------------- */}
      <section aria-labelledby="idle-heading" className="space-y-4">
        <h2 id="idle-heading" className="flex items-center gap-2 text-xl font-semibold">
          <Hourglass className="h-5 w-5 shrink-0" aria-hidden="true" />
          {t("idleTitle")}
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-foreground">{t("idleHint")}</p>
        <p className="max-w-prose text-sm leading-relaxed text-foreground">
          {lunchWindow
            ? t("idleLunchWindow", {
                start: clock(lunchWindow.startMinutes),
                end: clock(lunchWindow.endMinutes),
                minutes: duration(t, lunchWindow.minutes),
              })
            : t("idleLunchOff")}
        </p>
        {/*
          Only when the school has actually written ombyte or dusch on a
          timplanspost. The map holds the rows carrying a number and nothing
          else, so it is empty at nearly every school — and a sentence about a
          rule nobody has set would be one more line to read past on a page that
          already asks three questions. When the rule DOES exist it has to be
          said: the report is then quietly not reporting holes an administrator
          can see on the grid, and silence about that reads as a missing row.
        */}
        {pupilBuffers !== undefined && pupilBuffers.size > 0 && (
          <p className="max-w-prose text-sm leading-relaxed text-foreground">
            {t("idlePupilTime")}
          </p>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-48 space-y-2">
            <Label htmlFor="idle-minimum">{t("idleMinimum")}</Label>
            <Select
              value={gapMinimum}
              onValueChange={(next) => {
                setGapMinimum(next);
                setGapLimit(IDLE_PAGE_SIZE);
                setRevealedFrom(null);
              }}
            >
              <SelectTrigger id="idle-minimum" className={CONTROL} aria-label={t("idleMinimum")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GAP_MINIMUMS.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)} className="min-h-11 py-2">
                    {duration(t, minutes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-56 space-y-2">
            <Label htmlFor="idle-scope">{t("idleScope")}</Label>
            <Select
              value={gapScope}
              onValueChange={(next) => {
                setGapScope(next as "ALL" | "STUDENT_GROUP" | "TEACHER");
                setGapLimit(IDLE_PAGE_SIZE);
                setRevealedFrom(null);
              }}
            >
              <SelectTrigger id="idle-scope" className={CONTROL} aria-label={t("idleScope")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL" className="min-h-11 py-2">
                  {t("idleScopeAll")}
                </SelectItem>
                <SelectItem value="STUDENT_GROUP" className="min-h-11 py-2">
                  {t("idleScopeGroups")}
                </SelectItem>
                <SelectItem value="TEACHER" className="min-h-11 py-2">
                  {t("idleScopeTeachers")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/*
          The second sentence is what makes expanding the list audible: the
          count alone is the same before and after, so a region carrying only
          it would announce nothing when eighty more reports appear. It is
          rendered only when the list is long enough to be cut, so a school
          with four reports is not told it is seeing all four.
        */}
        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium text-foreground">
          {visibleReports.length === 0
            ? t("idleNone", { minutes: duration(t, Number(gapMinimum)) })
            : visibleReports.length > IDLE_PAGE_SIZE
              ? `${t("idleCount", { count: visibleReports.length })} ${
                  idleTruncated
                    ? t("idleShowingSome", { shown: shownReports.length })
                    : t("idleShowingAll", { count: visibleReports.length })
                }`
              : t("idleCount", { count: visibleReports.length })}
        </p>
        <p className="max-w-prose text-sm leading-relaxed text-foreground">{t("lengthLegend")}</p>

        {shownReports.map((report, index) => (
          <article
            key={`${report.kind}-${report.subjectId}`}
            className="rounded-lg border bg-card p-4"
          >
            <h3
              // The landing place for focus after "Visa alla": the first report
              // that was not there a moment ago. tabIndex -1 keeps it out of
              // the tab order — this is a destination, not a stop — and the
              // ring is on :focus rather than :focus-visible because the focus
              // arrives programmatically and must still be seen.
              ref={index === revealedFrom ? revealedRef : null}
              tabIndex={index === revealedFrom ? -1 : undefined}
              className="flex flex-wrap items-center gap-2 text-base font-semibold text-card-foreground ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            >
              {reportName(report)}
              <Tag>{t(report.kind === "TEACHER" ? "kindTeacher" : "kindGroup")}</Tag>
            </h3>
            <p className="mt-1 text-sm text-card-foreground">
              {t("idleSummary", {
                total: duration(t, report.totalMinutes),
                worst: duration(t, report.worstMinutes),
              })}
            </p>
            <ul className="mt-3 space-y-1.5">
              {report.gaps.map((gap) => (
                <li
                  // Mirrors the row key findIdleGaps builds, lunch credit
                  // included. Two rows can share a day and an interval and
                  // differ only in how much of it lunch explains — dropping
                  // that from the key makes React treat them as one and one of
                  // the two silently disappears from the list.
                  key={`${gap.dayOfWeek}-${gap.startMinutes}-${gap.endMinutes}-${gap.weeks}-${gap.lunchMinutes}`}
                  className="text-sm text-card-foreground"
                >
                  {gapLine(gap, report)}
                </li>
              ))}
            </ul>
          </article>
        ))}

        {idleTruncated ? (
          <Button
            type="button"
            variant="outline"
            className={CONTROL}
            onClick={() => {
              setRevealedFrom(shownReports.length);
              setGapLimit(null);
            }}
          >
            {t("idleShowAll", { count: visibleReports.length })}
          </Button>
        ) : null}
      </section>

      {/* ---------------- 3. Vem är ledig då? ---------------- */}
      <section aria-labelledby="who-heading" className="space-y-4">
        <h2 id="who-heading" className="flex items-center gap-2 text-xl font-semibold">
          <UserSearch className="h-5 w-5 shrink-0" aria-hidden="true" />
          {t("whoTitle")}
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-foreground">{t("whoHint")}</p>

        <form onSubmit={submitWho} className="flex flex-wrap items-end gap-3">
          <div className="w-44 space-y-2">
            <Label htmlFor="who-day">{t("whoDay")}</Label>
            <Select value={whoDay} onValueChange={setWhoDay}>
              <SelectTrigger id="who-day" className={CONTROL} aria-label={t("whoDay")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {searchDays.map((day) => (
                  <SelectItem key={day} value={String(day)} className="min-h-11 py-2">
                    {tDays(String(day))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="w-36 space-y-2">
            <Label htmlFor="who-start">{t("whoStart")}</Label>
            <Input
              id="who-start"
              type="time"
              className={CONTROL}
              value={whoStart}
              onChange={(event) => setWhoStart(event.target.value)}
            />
          </div>
          <div className="w-36 space-y-2">
            <Label htmlFor="who-end">{t("whoEnd")}</Label>
            <Input
              id="who-end"
              type="time"
              className={CONTROL}
              value={whoEnd}
              onChange={(event) => setWhoEnd(event.target.value)}
            />
          </div>
          <div className="w-48 space-y-2">
            <Label htmlFor="who-weeks">{t("whoWeeks")}</Label>
            <Select
              value={whoWeeks}
              onValueChange={(next) => setWhoWeeks(next as LessonRecurrence)}
            >
              <SelectTrigger id="who-weeks" className={CONTROL} aria-label={t("whoWeeks")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEK_OPTIONS.map((weeks) => (
                  <SelectItem key={weeks} value={weeks} className="min-h-11 py-2">
                    {tTimetable(RECURRENCE_KEY[weeks])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" className="h-11">
            {t("whoSearch")}
          </Button>
        </form>

        <p role="status" aria-live="polite" aria-atomic="true" className="text-sm font-medium text-foreground">
          {whoInvalid
            ? t("whoInvalid")
            : whoResult === null || whoQuery === null
              ? ""
              : t("whoCount", {
                  groups: whoResult.studentGroupIds.length,
                  teachers: whoResult.teacherIds.length,
                  rooms: whoResult.roomIds.length,
                  day: tDays(String(whoQuery.dayOfWeek)),
                  start: clock(whoQuery.startMinutes),
                  end: clock(whoQuery.endMinutes),
                })}
        </p>

        {whoResult !== null ? (
          <div className="grid gap-4 md:grid-cols-3">
            {(
              [
                { key: "whoGroups", ids: whoResult.studentGroupIds },
                { key: "whoTeachers", ids: whoResult.teacherIds },
                { key: "whoRooms", ids: whoResult.roomIds },
              ] as const
            ).map((column) => (
              <div key={column.key} className="rounded-lg border bg-card p-4">
                <h3 className="text-base font-semibold text-card-foreground">
                  {t(column.key, { count: column.ids.length })}
                </h3>
                {column.ids.length === 0 ? (
                  <p className="mt-2 text-sm text-card-foreground">{t("whoNoneOfKind")}</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {column.ids.map((id) => (
                      <li key={id} className="text-sm text-card-foreground">
                        {labelOf.get(id) ?? id}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
