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
//   primary-fg on primary-hover    5.09 /  6.27   AA, NOT AAA — on :hover
//
// So: AAA for every piece of text this page writes, and AA for the two submit
// buttons, at rest and on hover. The hover used to be the shared Button's
// `bg-primary/90`, a fade into the page that fell to 4.34:1 in dark; the
// Button now hovers to the solid --primary-hover instead.
//
// These buttons are `bg-primary` — the product's brand button. Reaching 7:1
// there needs --primary at 56% lightness or lower in light and 77% or higher
// in dark, which repaints every button in the product and is not one page's
// call. The number is written down rather than rounded up, because an AAA
// claim that is not true tells the owner a box is ticked while a reader with
// low vision is shut out.
//
// `muted-foreground` (4.83 / 6.54 — AA, not AAA) is kept off this page as
// text: PageHeader's subtitle slot is left empty and the standfirst goes in
// its `intro` slot, which is foreground; EmptyState and LoadError are given
// `text-foreground` for their description; and the results table's headers,
// which TableHead paints muted by default, are overridden back to
// `foreground`. It does appear as non-text, where the bar is 3:1 and it
// clears — the empty-state icon (4.40 / 5.28), the three section icons that
// SectionCard draws before each h2 (4.83 / 6.17 on card; decorative, hidden
// from assistive tech), and the border this page draws on its own boxed
// controls (see CONTROL below). That
// border was drawn when the shared `border-input` (1.27 / 1.40 against the
// page, under SC 1.4.11's 3:1) was every control's edge. Fields now draw
// `border-input-strong` (3.49 / 3.80); the outline Button keeps the hairline.
//
// Not claimed: 1.4.8 (measure and line spacing are set, but the app offers no
// user-chosen colours) and 3.1.5 (reading level never measured). Nothing here
// has met a real screen reader or axe: the route is behind a Supabase session
// and e2e/a11y.spec.ts scans public routes only.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarRange, CalendarSearch, Hourglass, UserSearch } from "lucide-react";
import { Link } from "@/i18n/navigation";
import {
  useAcademicYears,
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
import { IDLE_MINIMUM_MINUTES, pupilMinutesOf } from "@/lib/candidates/idle";
import { usePlanningYear } from "@/lib/planning-year";
import { isProjectable, withProjectedHomes } from "@/lib/projected-rosters";
import type { LessonRecurrence } from "@/lib/types";
import { cn, timeToMinutes } from "@/lib/utils";
import { NextStep } from "@/components/layout/next-step";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import {
  PlanningYearPicker,
  ProjectedRostersBanner,
} from "@/components/schedule/planning-year";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
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
 * SC 1.4.11 asks 3:1 of the boundary that tells a reader a control is there.
 * The product's fields now draw `border-input-strong`, 3.49:1 against the
 * page in light and 3.80:1 in dark; the outline Button keeps the hairline
 * `border-input` at 1.27 / 1.40. This page draws one edge of its own on all
 * three kinds of box (a select trigger, a time field, the outline button), in
 * muted-foreground (4.83 / 6.54): it predates the shared fix, and it is still
 * the only visible edge the outline button has. The filled submit buttons are
 * exempt: their own fill is 6.18 / 5.12 against the page, so the shape reads
 * without help.
 */
const CONTROL = "h-11 border-muted-foreground";

/**
 * Every explanatory paragraph on the page: foreground, a 65-character measure,
 * and the 1.5 line spacing AAA asks for (text-sm's own leading is 1.43). The
 * three section descriptions take it too, over SectionCard's muted default.
 */
const PROSE = "max-w-prose leading-relaxed text-foreground";

/*
 * The free-time table sits inside its section, so it takes the inner-table
 * cells rather than a frame of its own: compact rows, the outer columns flush
 * with the card's padding. The heads stay text-foreground, not the recipe's
 * muted (see the docblock above).
 */
const TH = "h-auto py-1.5 pr-3 text-xs text-foreground";
const TD = "py-1.5 pr-3 text-foreground";

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
    <fieldset className="min-w-0 rounded-md border p-3">
      {/*
        Floated, so the legend sits inside the box as a sub-block's heading
        does, rather than notched into its top border. It still names the
        group: a floated <legend> is the fieldset's legend all the same.
      */}
      <legend className="float-left mb-1 w-full px-1 text-sm font-semibold text-foreground">{legend}</legend>
      {options.length === 0 ? (
        <p className="clear-both px-1 py-2 text-sm text-foreground">{emptyLabel}</p>
      ) : (
        <ul className="clear-both max-h-56 space-y-0.5 overflow-y-auto">
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

/**
 * A word-carrying badge: the shared Badge in its secondary (neutral
 * information) variant, 16.12 / 13.19. A week pattern other than every week
 * is lifted onto the accent tint (9.74 / 7.33) — still AAA in both themes —
 * because a lucka that holds only on odd weeks is the row a reader must not
 * take for an every-week one.
 */
function Tag({
  children,
  emphasis,
}: {
  children: React.ReactNode;
  emphasis?: boolean;
}) {
  return (
    <Badge
      variant="secondary"
      className={emphasis ? "bg-accent font-semibold text-accent-foreground" : undefined}
    >
      {children}
    </Badge>
  );
}

export default function GapsPage() {
  const t = useTranslations("gaps");
  const tDays = useTranslations("days");
  // The three parity values are the same three the lesson editor names, so
  // they are read from the same place rather than translated twice.
  const tTimetable = useTranslations("timetable");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");

  /*
   * The grundschema asked about: this year's, or next year's before its
   * activation — the same choice, and the same year, as /admin/timetable
   * (lib/planning-year.ts). Next year's classes have no home pupils until
   * then, so the people are read with the class the activation will give
   * each pupil it moves, exactly as the timetable reads them; otherwise next
   * year's håltimmar would be counted on this year's classes.
   */
  const planning = usePlanningYear();
  const year = planning.year;
  // For the state ladder only: usePlanningYear reads the same cached query.
  const years = useAcademicYears();
  const { data: lessons, isLoading, isError: lessonsFailed } = useMasterLessons(year?.id ?? null);
  const { data: constraints, isError: constraintsFailed } = useConstraints();
  const { data: groups, isError: groupsFailed } = useGroups();
  const { data: storedPeople, isError: peopleFailed } = usePeople();
  const people = useMemo(
    () => withProjectedHomes(storedPeople, planning.rosters),
    [storedPeople, planning.rosters],
  );
  const { data: rooms, isError: roomsFailed } = useRooms();
  const { data: memberships, isError: membershipsFailed } = useGroupMemberships();
  const { data: frameTimes, isError: frameTimesFailed } = useFrameTimes();
  const { data: lunchSettings, isError: lunchFailed } = useLunchSettings();
  // The timplan, for one thing only: the minutes the pupils are occupied
  // outside a lesson. The same query the timetable page reads its buffers from,
  // so the two pages cannot disagree about which minutes are taken.
  const { data: requirements, isError: requirementsFailed } = useRequirements(year?.id ?? null);
  /*
   * Every answer on the page is computed from all of these at once: a week
   * searched without its availability rules offers time a rule has closed, one
   * without the roster reports nobody idle. So any one that was never read
   * stops the page rather than letting it answer from part of the school — an
   * answer that looks like a result and is not one. Next year's class lists
   * count among them: without them its håltimmar would be this year's classes'.
   *
   * A refetch that fails over a read already in hand is a different fact: the
   * page still has the whole school, as last read, so it keeps answering and
   * says above the answers that they may be out of date (refetchFailed).
   */
  const reads: ReadonlyArray<readonly [boolean, unknown]> = [
    [years.isError, years.data],
    [planning.rostersFailed, planning.rosters ?? undefined],
    [lessonsFailed, lessons],
    [constraintsFailed, constraints],
    [groupsFailed, groups],
    [peopleFailed, storedPeople],
    [roomsFailed, rooms],
    [membershipsFailed, memberships],
    [frameTimesFailed, frameTimes],
    [lunchFailed, lunchSettings],
    [requirementsFailed, requirements],
  ];
  const anyFailed = reads.some(([failed, data]) => failed && data === undefined);
  const refetchFailed = reads.some(([failed, data]) => failed && data !== undefined);

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
    () => buildGroupConflictMap(studentGroupOf, memberships ?? [], groups),
    [studentGroupOf, memberships, groups],
  );
  /**
   * groupId -> the years it holds, so a GRADE_LEVEL rule can reach it.
   *
   * A teaching group has no year of its own, so it is derived from its members'
   * home classes — the same derivation the server does for the solver payload.
   * Without this the rule matches nothing and the search offers time a year
   * rule has closed; see lib/grade-span.ts.
   */
  //
  // In NIOARIG (grade-numbering.ts): every rule these spans meet here — year
  // rules, frames, lunch, rasts, room locks — is school-wide and stated so,
  // and a tioårig läsår's 10A is the 9 a "7–9" frame binds, as the solver
  // payload sends it.
  const gradeSpanOf = useMemo(
    () =>
      buildGradeSpans({
        // The shown year's groups only, as the server reads them: a home class
        // of another year (the active one, while the projection loads) would
        // lend a teaching group a grade in another numbering.
        groups: (groups ?? []).filter((group) => group.academicYearId === year?.id),
        membersByGroup: (memberships ?? []).reduce((map, row) => {
          const list = map.get(row.studentGroupId);
          if (list) list.push(row.studentId);
          else map.set(row.studentGroupId, [row.studentId]);
          return map;
        }, new Map<string, string[]>()),
        homeClassOf: studentGroupOf,
        numbering: year?.gradeNumbering,
      }),
    [groups, memberships, studentGroupOf, year?.id, year?.gradeNumbering],
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

  /** The shown year's groups: the schedule searched is that year's (see the timetable). */
  const yearGroups = useMemo(
    () => (groups ?? []).filter((group) => group.academicYearId === year?.id),
    [groups, year?.id],
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
        groups: yearGroups,
      }),
    [scheduleData, classIds, teacherOptions, lunchSettings, gapMinimum, yearGroups],
  );

  /*
   * The generator's number: the pupils' håltimmar of the whole school at the
   * generator's minimum, in idle pupil-minutes in the average week
   * (lib/candidates/idle.ts pupilMinutesOf). The engine counts the timetable
   * it lays to the same number (src/common/__fixtures__/pupil-gaps-cases.json),
   * and keeps it down when the school's Skolregler say so. Read off the reports
   * above when the reader has the minimum where the generator has it, and
   * counted once more when they do not: the reader's choice of what to list
   * must not move the number the generator is held to.
   */
  const generatorMinutes = useMemo(() => {
    const reports =
      Number(gapMinimum) === IDLE_MINIMUM_MINUTES
        ? gapReports
        : findIdleGaps({
            ...scheduleData,
            studentGroupIds: classIds,
            lunch: lunchSettings ?? null,
            minimumMinutes: IDLE_MINIMUM_MINUTES,
            groups: yearGroups,
          });
    return Math.round(pupilMinutesOf(reports));
  }, [gapMinimum, gapReports, scheduleData, classIds, lunchSettings, yearGroups]);
  const classPupils = useMemo(() => {
    const classes = new Set(classIds);
    return students.filter((student) => student.studentGroupId && classes.has(student.studentGroupId)).length;
  }, [students, classIds]);

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

  /**
   * One håltimme as words: the sentence (day, time, length, who, lunch), then
   * the week pattern when it is not every week, then the length band. The
   * last two are drawn as badges, but read as the same " · "-joined line the
   * row always was: the separators before them are sr-only, not dropped.
   */
  const gapParts = (gap: IdleGap, report: GapReport) => {
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
    return {
      sentence: parts.join(" · "),
      weeks: gap.weeks !== "ALL_WEEKS" ? tTimetable(RECURRENCE_KEY[gap.weeks]) : null,
      length: t(SEVERITY_KEY[severity]),
    };
  };

  const reportName = (report: GapReport): string =>
    labelOf.get(report.subjectId) ?? report.subjectId;

  /**
   * Another year's grundschema: every question asked so far was about this
   * one's, and its classes are not the other year's — a ticked 8A would be a
   * group the other week does not hold. The teachers and rooms stay ticked;
   * they are the school's, not a year's.
   */
  const chooseYear = (yearId: string) => {
    setPickedGroups(new Set());
    setFreeQuery(null);
    setWhoQuery(null);
    setWhoInvalid(false);
    setGapLimit(IDLE_PAGE_SIZE);
    setRevealedFrom(null);
    planning.choose(yearId);
  };

  /*
   * One header for every state, so the page does not change shape when the
   * schedule arrives. No subtitle: that slot is muted-foreground. The
   * standfirst goes in `intro`, which is foreground; max-w-prose caps the
   * measure at 65 characters and leading-relaxed gives the 1.5 line spacing
   * AAA asks for (the app's default text-sm leading is 1.43).
   *
   * The year choice is the timetable's own, and draws nothing until there
   * is a next year to plan. Its buttons are lifted to the 44px and the
   * visible edge every other control here has (see CONTROL).
   */
  const header = (
    <PageHeader
      title={t("title")}
      intro={<p className="leading-relaxed">{t("intro")}</p>}
      actions={
        <PlanningYearPicker
          {...planning}
          onChoose={chooseYear}
          className="[&>button]:h-11 [&>button]:border-muted-foreground"
        />
      }
    />
  );

  /*
   * Still on its way: the years, the one render usePlanningYear holds the
   * year back for, the week itself, or next year's class lists — without
   * which its håltimmar would be counted on this year's classes for as long
   * as the request takes.
   */
  const rostersPending =
    isProjectable(year, planning.active) && planning.rosters === null && !planning.rostersFailed;
  const pending =
    isLoading || years.isLoading || (planning.active !== null && year === null) || rostersPending;

  // Above whatever the page answers with, when a refetch failed under it.
  const refetchNotice = refetchFailed ? (
    <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
  ) : null;

  if (pending) {
    return (
      <Page>
        {header}
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      </Page>
    );
  }

  if (anyFailed) {
    return (
      <Page>
        {header}
        <LoadError
          title={t("loadFailed")}
          hint={t("loadFailedHint")}
          hintClassName="text-foreground"
          headingLevel={2}
        />
      </Page>
    );
  }

  if (!year) {
    // No active year: there is no grundschema to ask, and the way to one is
    // the Läsår page. Foreground hint, for the reason given below.
    return (
      <Page>
        {header}
        {refetchNotice}
        <EmptyState
          icon={CalendarRange}
          title={t("noYearTitle")}
          description={t("noYearHint")}
          descriptionClassName="text-foreground"
          headingLevel={2}
          action={
            <Button asChild variant="outline" className={CONTROL}>
              <Link href="/admin/years">{t("noYearAction")}</Link>
            </Button>
          }
        />
      </Page>
    );
  }

  if (placements.length === 0) {
    return (
      <Page>
        {header}
        {refetchNotice}
        {/*
          The hint in foreground, not EmptyState's muted default, which
          measures 4.83:1 light and 6.54:1 dark — AA, but short of the 7:1 this
          page holds itself to. Its icon is muted-foreground too (4.40 / 5.28
          on the muted circle), which is fine: a decorative graphic is held to
          SC 1.4.11's 3:1, not to 7:1.
        */}
        <EmptyState
          icon={CalendarSearch}
          title={t("empty")}
          description={t("emptyHint")}
          descriptionClassName="text-foreground"
          headingLevel={2}
          action={
            <Button asChild className="h-11">
              <Link href={year.isActive ? "/admin/generate" : `/admin/generate?year=${year.id}`}>
                {tNav("generate")}
              </Link>
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      {header}
      {refetchNotice}
      {/* Next year's grid: whose class lists the answers are counted on. */}
      <ProjectedRostersBanner
        year={year}
        active={planning.active}
        rosters={planning.rosters}
        failed={planning.rostersFailed}
      />

      {/*
        The three questions, each a section of its own with its h2 — the
        region a screen reader lists and a test finds by name. The card edges
        say they are three tasks; the page's own space-y-4 is enough between.
      */}
      <SectionCard
        id="gaps-free"
        title={t("freeTitle")}
        icon={CalendarSearch}
        description={t("freeHint")}
        descriptionClassName={PROSE}
      >
        <form onSubmit={submitFree} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
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

          {/* One filled button in the section, the search; Rensa is outline beside it. */}
          <FilterBar>
            <FilterField id="free-length" label={t("freeLength")} className="w-48">
              <Select value={freeLength} onValueChange={setFreeLength}>
                <SelectTrigger id="free-length" className={CONTROL}>
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
            </FilterField>
            <Button type="submit" className="h-11">
              {t("freeSearch")}
            </Button>
            <Button type="button" variant="outline" className={CONTROL} onClick={clearFree}>
              {t("freeClear")}
            </Button>
            {/* As tall as the controls, so the count sits level with their middle. */}
            <p className="flex h-11 items-center text-sm text-foreground">
              {t("freeSelected", { count: pickedCount })}
            </p>
          </FilterBar>
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
          /*
            text-foreground on all four heads: TableHead's own base class is
            text-muted-foreground, which is 4.83:1 light and 6.54:1 dark — AA,
            and short of the 7:1 the rest of this page holds to. The override
            is here rather than in table.tsx because that component is painted
            by every page in the product. On a phone the length gives way: the
            time beside it already says it.
          */
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">{t("freeCaption", { who: freeWho })}</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className={cn(TH, "pl-0")}>
                    {t("colDay")}
                  </TableHead>
                  <TableHead scope="col" className={TH}>
                    {t("colTime")}
                  </TableHead>
                  <TableHead scope="col" className={cn(TH, "hidden sm:table-cell")}>
                    {t("colLength")}
                  </TableHead>
                  <TableHead scope="col" className={cn(TH, "pr-0")}>
                    {t("colWeeks")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {freeWindows.map((window) => (
                  <TableRow
                    key={`${window.dayOfWeek}-${window.startMinutes}-${window.endMinutes}-${window.weeks}`}
                  >
                    <TableCell className={cn(TD, "pl-0 font-medium")}>
                      {tDays(String(window.dayOfWeek))}
                    </TableCell>
                    <TableCell className={cn(TD, "whitespace-nowrap tabular-nums")}>
                      {clock(window.startMinutes)}–{clock(window.endMinutes)}
                    </TableCell>
                    <TableCell className={cn(TD, "hidden whitespace-nowrap tabular-nums sm:table-cell")}>
                      {duration(t, window.endMinutes - window.startMinutes)}
                    </TableCell>
                    <TableCell className={cn(TD, "pr-0")}>
                      <Tag emphasis={window.weeks !== "ALL_WEEKS"}>
                        {tTimetable(RECURRENCE_KEY[window.weeks])}
                      </Tag>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        id="gaps-idle"
        title={t("idleTitle")}
        icon={Hourglass}
        description={t("idleHint")}
        descriptionClassName={PROSE}
      >
        {/* What the counting assumes, read before the counts. */}
        <div className={cn("space-y-2 text-sm", PROSE)}>
          <p>
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
          {pupilBuffers !== undefined && pupilBuffers.size > 0 && <p>{t("idlePupilTime")}</p>}
          <p>{t("lengthLegend")}</p>
          {/* The generator's number, and whether Generera is held to it. */}
          <p data-testid="generator-pupil-minutes">
            {t("generatorFigure", {
              minutes: generatorMinutes,
              perPupil: classPupils > 0 ? Math.round((generatorMinutes / classPupils) * 10) / 10 : 0,
            })}{" "}
            {lunchSettings?.generatorKeepsPupilGapsDown ? t("generatorFigureOn") : t("generatorFigureOff")}
          </p>
        </div>

        <FilterBar>
          <FilterField id="idle-minimum" label={t("idleMinimum")} className="w-48">
            <Select
              value={gapMinimum}
              onValueChange={(next) => {
                setGapMinimum(next);
                setGapLimit(IDLE_PAGE_SIZE);
                setRevealedFrom(null);
              }}
            >
              <SelectTrigger id="idle-minimum" className={CONTROL}>
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
          </FilterField>
          <FilterField id="idle-scope" label={t("idleScope")} className="w-56">
            <Select
              value={gapScope}
              onValueChange={(next) => {
                setGapScope(next as "ALL" | "STUDENT_GROUP" | "TEACHER");
                setGapLimit(IDLE_PAGE_SIZE);
                setRevealedFrom(null);
              }}
            >
              <SelectTrigger id="idle-scope" className={CONTROL}>
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
          </FilterField>
        </FilterBar>

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

        {shownReports.length > 0 ? (
          <div className="space-y-4">
            {shownReports.map((report, index) => (
              /*
                An <article> per class or teacher: each report stands on its
                own, and its h3 is the landing place for focus below. No card
                of its own — it already sits in one; the bordered list is the
                one box inside the section.
              */
              <article key={`${report.kind}-${report.subjectId}`} className="space-y-2">
                <div className="space-y-1">
                  <h3
                    // The landing place for focus after "Visa alla": the first report
                    // that was not there a moment ago. tabIndex -1 keeps it out of
                    // the tab order — this is a destination, not a stop — and the
                    // ring is on :focus rather than :focus-visible because the focus
                    // arrives programmatically and must still be seen.
                    ref={index === revealedFrom ? revealedRef : null}
                    tabIndex={index === revealedFrom ? -1 : undefined}
                    className="flex flex-wrap items-center gap-2 rounded-sm text-sm font-semibold text-card-foreground ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  >
                    {reportName(report)}
                    <Tag>{t(report.kind === "TEACHER" ? "kindTeacher" : "kindGroup")}</Tag>
                  </h3>
                  <p className="text-sm text-card-foreground">
                    {t("idleSummary", {
                      total: duration(t, report.totalMinutes),
                      worst: duration(t, report.worstMinutes),
                    })}
                  </p>
                </div>
                <ul className="divide-y rounded-md border">
                  {report.gaps.map((gap) => {
                    const line = gapParts(gap, report);
                    return (
                      <li
                        // Mirrors the row key findIdleGaps builds, lunch credit
                        // included. Two rows can share a day and an interval and
                        // differ only in how much of it lunch explains — dropping
                        // that from the key makes React treat them as one and one of
                        // the two silently disappears from the list.
                        key={`${gap.dayOfWeek}-${gap.startMinutes}-${gap.endMinutes}-${gap.weeks}-${gap.lunchMinutes}`}
                        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm tabular-nums text-card-foreground"
                      >
                        <span className="min-w-0">{line.sentence}</span>
                        {/*
                          The week pattern and the length band, as badges at the
                          row's end where the eye can run down them. The " · "
                          before each is kept for the ear: a screen reader hears
                          the line it always heard.
                        */}
                        <div className="flex flex-wrap items-center gap-1.5">
                          {line.weeks ? (
                            <>
                              <span className="sr-only"> · </span>
                              <Tag emphasis>{line.weeks}</Tag>
                            </>
                          ) : null}
                          <span className="sr-only"> · </span>
                          <Tag>{line.length}</Tag>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </article>
            ))}
          </div>
        ) : null}

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
      </SectionCard>

      <SectionCard
        id="gaps-who"
        title={t("whoTitle")}
        icon={UserSearch}
        description={t("whoHint")}
        descriptionClassName={PROSE}
      >
        <form onSubmit={submitWho} className="flex flex-wrap items-end gap-3">
          <FilterField id="who-day" label={t("whoDay")} className="w-44">
            <Select value={whoDay} onValueChange={setWhoDay}>
              <SelectTrigger id="who-day" className={CONTROL}>
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
          </FilterField>
          <FilterField id="who-start" label={t("whoStart")} className="w-36">
            <Input
              id="who-start"
              type="time"
              className={`${CONTROL} tabular-nums`}
              value={whoStart}
              onChange={(event) => setWhoStart(event.target.value)}
            />
          </FilterField>
          <FilterField id="who-end" label={t("whoEnd")} className="w-36">
            <Input
              id="who-end"
              type="time"
              className={`${CONTROL} tabular-nums`}
              value={whoEnd}
              onChange={(event) => setWhoEnd(event.target.value)}
            />
          </FilterField>
          <FilterField id="who-weeks" label={t("whoWeeks")} className="w-48">
            <Select
              value={whoWeeks}
              onValueChange={(next) => setWhoWeeks(next as LessonRecurrence)}
            >
              <SelectTrigger id="who-weeks" className={CONTROL}>
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
          </FilterField>
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
          <div className="grid gap-3 md:grid-cols-3">
            {(
              [
                { key: "whoGroups", ids: whoResult.studentGroupIds },
                { key: "whoTeachers", ids: whoResult.teacherIds },
                { key: "whoRooms", ids: whoResult.roomIds },
              ] as const
            ).map((column) => (
              // A sub-block of the section, not a card in a card.
              <div key={column.key} className="space-y-2 rounded-md border p-3">
                <h3 className="text-sm font-semibold text-card-foreground">
                  {t(column.key, { count: column.ids.length })}
                </h3>
                {column.ids.length === 0 ? (
                  <p className="text-sm text-card-foreground">{t("whoNoneOfKind")}</p>
                ) : (
                  <ul className="space-y-1">
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
      </SectionCard>

      {/* The manual's next step after the luckor. 44px like every control here. */}
      <div className="flex justify-end">
        <NextStep href="/admin/publishing" name={tNav("publishing")} className="h-11" />
      </div>
    </Page>
  );
}
