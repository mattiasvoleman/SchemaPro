"use client";

// The timplan, which is now a period as well as a rate.
//
// A requirement used to say only "three lessons a week of 60 minutes". A school
// does not work that way: NO is read for one term, elevens val alternates odd
// and even weeks, a språkval starts after höstlovet. Those requirements now
// carry their own recurrence and start/end dates (schema.prisma:
// TeachingRequirement), and this page is where they are entered.
//
// Which makes a plain sum of lessonsPerWeek actively wrong. Two requirements of
// two lessons a week that never share a week are not four lessons in any week,
// and a half-year requirement is not worth a full year of teaching. So the
// header states TWO numbers instead — the busiest single week, which is what
// has to fit in a weekly grid, and the total teaching time over the year, which
// is what a timplan is actually checked against. Both come from
// lib/teaching-hours.ts; nothing here does the arithmetic a second time.
//
// Those two are school-wide, and a school-wide peak answers no question about a
// class: forty lessons across ten classes fit in a week that four lessons in
// one class do not. So each row carries the same pair for its own group — the
// heaviest week THAT group has, in its own week rather than the school's, and
// the hours it is taught over the year. They are the last two columns, pinned
// to the right for the same reason the group name is pinned to the left.
//
// THE HOURS NOW SUBTRACT LOV, and this paragraph used to say the opposite —
// flatly, because nothing in the app knew a week could be a lov and every
// figure here read roughly 8-10 weeks high across a Swedish läsår. SchoolBreak
// closed that hole; admin/breaks is where a school enters its lov and
// studiedagar, and this page loads them for the picked year and hands them to
// `annualMinutes` together with each group's own gradeLevel — a studiedag for
// lågstadiet must not shorten årskurs 9's year.
//
// The grade is why the closures are applied PER GROUP and not once to a total.
// A group with no gradeLevel of its own — a nivågrupp, a språkval — is inside
// no span at all, so a grade-narrowed break leaves it alone; see closesForGrade
// in lib/teaching-hours.ts for why that direction of error is the honest one.
//
// `peakLessonsPerWeek` is deliberately left alone. A lov week holds no lessons
// and must not be allowed to drag the busiest week down: the peak asks whether
// a week's lessons fit in the grid at all, which is a yes/no about capacity.
// The library's own header says so at weeksInPeriod, and this is the caller
// that would be tempted.
//
// What is left is an estimate, structurally and not for want of care: a
// requirement carries lessonsPerWeek and no weekday, so nothing can know
// whether the studiedag fell on one of its lesson days. `hoursCaveat` says that
// on the page rather than here alone — a figure a rektor might put in a
// document has to carry its own footnote, and so does the table's caption,
// which a reader arriving by table navigation is the only text they see.
//
// MÅL MODE (P2) lays the year's lokal timplan over the class rows: each cell
// "planerat / mål" in standardvecka minutes with the line's signed
// difference, a total column and a classes' total row in min/vecka and hours,
// a Täckning pill per class linking to /admin/timplan/tackning, and a line in
// the cell dialog saying what the plan asks and what the typed post gives.
// The figures are lib/timplan-planned.ts's — the gateway's own arithmetic —
// and the code lives in components/timplan/requirements-target.tsx, loaded on
// the first press of the toggle, because this route had 2.9 KB of its budget
// left. Its tones and their contrast are measured in that file's header.
// What each TEACHER carries per subject is not here: the tjänstefördelning
// (/admin/staffing, /teacher/tjanst) already states it.
//
// CONTRAST, MEASURED. Computed from the HSL tokens in app/globals.css, rounded
// to 8-bit the way a browser paints them, and blended where a token is painted
// through an alpha. Light theme first, then dark:
//
//   foreground on background        18.69 / 16.36   AAA — the two summary lines
//   foreground on card              18.69 / 15.43   AAA — both summary columns
//   accent-fg on accent/70 on card  10.21 /  7.82   AAA — a filled cell at rest
//   accent-fg on accent (:hover)     9.79 /  7.33   AAA — the same cell hovered
//   muted-fg on card                 4.83 /  6.17   AA  — the empty cell's plus
//   foreground on muted (:hover)    17.00 / 13.19   AAA — the same plus hovered
//
// The filled cell paints `bg-accent/70` over the card, so the badge and the
// teacher line are measured against that blend, not against `accent` itself.
// The teacher line used to be `text-muted-foreground` on it: 4.36 in light,
// under AA, never mind AAA. It now inherits `accent-foreground` like the rest
// of the cell — the size and weight already carry the hierarchy the colour was
// doing badly.
//
// The last two rows are the ones this review used to leave out, and they were
// the worst on the page. The plus in an EMPTY cell was `text-muted-foreground/40`
// with `hover:text-muted-foreground`, and a lucide glyph inherits currentColor,
// so the 40% blend is what actually got painted: #c6c6ca on white and #47474c
// on the card, measuring 1.70 in light and 2.01 in dark. That is under the 3:1
// floor WCAG 2.1 puts on graphical objects (1.4.11), never mind text — and an
// empty cell is not decoration, it is the only affordance saying a group can be
// given this subject. Hover fixed nothing either: muted-fg on muted is 4.40 in
// light, still short. The alpha is gone; the rest state is the plain token and
// hover goes to `foreground`, which also gives the hover somewhere to travel
// now that the opacity no longer does that job.
//
// Rest is AA and not AAA, deliberately. 7:1 would need `foreground` at rest,
// which paints a full-strength plus into every empty square of a matrix whose
// whole point is which squares are filled — and AAA's 7:1 is a TEXT threshold
// (1.4.6); a 16px icon is a graphical object, whose own bar is 3:1. 4.83/6.17
// clears both by a margin. Anything past that is the muted-foreground token
// itself, which is the palette-wide question the paragraph below already flags.
//
// The header gained an export button, an import button and a named year
// picker, and the import dialog gained the sentence saying an import never
// deletes. Recomputed the same way rather than assumed from the rows above:
//
//   foreground on background        18.69 / 16.36   AAA — both button labels
//   accent-fg on accent (:hover)     9.79 /  7.33   AAA — either one hovered
//   foreground on muted             17.00 / 13.19   AAA — the dialog's notice
//   foreground/50 on background      3.49 /  4.65   see below — export at rest
//                                                   with nothing to export
//
// `variant="outline"` paints `bg-background` and inherits `foreground`, so the
// labels land on the first row and their hover on the second — the same two
// numbers the filled cell already uses, because `accent` is an opaque token
// and the button does not blend it. The dialog's notice is `text-foreground`
// on `bg-muted`; a `border-border` outline around it was dropped rather than
// added, because that line measures 1.15:1 on the fill and the fill already
// marks the box off, so it would have been a graphical object below 3:1 doing
// no work.
//
// The last row is the disabled export button, and it does NOT clear 4.5:1 in
// light. It is `disabled:opacity-50` from components/ui/button.tsx, which
// blends the label to #89898b on white. WCAG 2.1 exempts an inactive control
// from 1.4.3 and 1.4.11 outright, and the greying IS the affordance — a
// disabled button at full strength is a button people click. Left as it is
// because moving it means changing `disabled:opacity-50` for every disabled
// button in the product, which is the same palette-wide question as the
// paragraph below; noted here so the next reader does not have to measure it
// again to find that out.
//
// Left alone, and worth raising on its own: three pieces of text this page did
// not gain today are still `muted-foreground` — the "Klass" heading and the
// member count on card (4.83 / 6.17) and the section headings on muted (4.40 /
// 5.28). AA in both themes, AAA in neither. That token is the product's own
// secondary text colour, painted on every page there is, so moving it is a
// change to the palette rather than to this file.

import { Fragment, useEffect, useMemo, useState } from "react";
import { splitGroupsByKind } from "@/lib/group-sections";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Grid3x3, Plus, TriangleAlert, Upload } from "lucide-react";
import {
  useAcademicYears,
  useCrudMutations,
  useGroupMemberships,
  useGroups,
  usePeople,
  useRequirements,
  useSchoolBreaks,
  useSubjects,
} from "@/lib/queries";
import { useStaffingLoad, useTeacherQualifications } from "@/lib/staffing-queries";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import { requirementsToCsv } from "@/lib/csv";
import { buildGradeSpans } from "@/lib/grade-span";
import { candidateQualification, candidateRemaining } from "@/lib/staffing-candidates";
import { CandidateBadge } from "@/components/staffing/candidate-badge";
import { RefusalNotice, WarningsNotice } from "@/components/staffing/staffing-notices";
import {
  refusalText,
  staffingRefusal,
  type StaffingRefusal,
} from "@/lib/staffing-warnings";
import type { MessageLookup } from "@/lib/engine-message";
import { CsvExportButton } from "@/components/import/csv-export-button";
import { LazyCsvImportDialog } from "@/components/import/lazy-csv-import-dialog";
import {
  annualMinutes,
  formatHours,
  peakLessonsPerWeek,
  peakLessonsPerWeekByKey,
  type YearBounds,
} from "@/lib/teaching-hours";
import type { LessonRecurrence, StaffingWarning, TeachingRequirement } from "@/lib/types";
import type { TargetSources } from "@/lib/requirements-target";
import type { TargetState } from "@/components/timplan/requirements-target";
import { subjectColor } from "@/lib/utils";
import { sortByName } from "@/lib/sorting";
import { PageHeader } from "@/components/layout/page-header";
import { RecurrenceFields } from "@/components/schedule/recurrence-fields";
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NO_TEACHER = "__none__";

/**
 * Mål mode's code, fetched the first time the toggle is pressed. A bare
 * `import()` kept in state rather than React.lazy, because the mode is
 * several components and a data host, not one; and not next/dynamic, whose
 * loader costs 1.4 KB of its own. See components/timplan/requirements-target.tsx
 * for why the route cannot carry it statically.
 */
type TargetModule = typeof import("@/components/timplan/requirements-target");
const loadTargetModule = () => import("@/components/timplan/requirements-target");

/**
 * Whether a pupil buffer field holds something the API will take: an integer
 * from 0 to 60, the bounds CreateTeachingRequirementDto and the column's own
 * CHECK both state. An emptied field reads as 0, which is what it means.
 */
function bufferInRange(value: string): boolean {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= 60;
}

/**
 * Whether a load-percentage field holds a charge the API will take: an integer
 * from 0 to 200, the bounds the DTO and the column's CHECK state
 * (TeachingRequirements_teacher_load_percent_is_sane).
 *
 * Unlike a buffer, an EMPTIED field is not read as 0. Zero is a real and rare
 * answer here — the row costs this teacher nothing — and a field cleared on
 * the way to typing 50 must not be saved as that by accident. So empty is
 * simply not yet a value, and the save button waits.
 */
function loadPercentInRange(value: string): boolean {
  if (value.trim() === "") return false;
  const percent = Number(value);
  return Number.isInteger(percent) && percent >= 0 && percent <= 200;
}

interface CellTarget {
  groupId: string;
  subjectId: string;
  existing: TeachingRequirement | null;
}

interface CellForm {
  lessonsPerWeek: string;
  minutesPerLesson: string;
  /**
   * The pupils' own extra time, held as text like every other number in this
   * dialog — an emptied `<input type="number">` reads as "", and storing that
   * as a number would make the field unclearable.
   */
  minutesBefore: string;
  minutesAfter: string;
  teacherId: string;
  coTeacherId: string;
  /** "Räknas för lärare (%)", as text for the reason the buffers are. */
  teacherLoadPercent: string;
  coTeacherLoadPercent: string;
  recurrence: LessonRecurrence;
  /** "" for the academic year's own boundary — the shape RecurrenceFields speaks. */
  startDate: string;
  endDate: string;
}

export default function RequirementsPage() {
  const t = useTranslations("requirements");
  const tCommon = useTranslations("common");
  // The period controls and their badge live in the `timetable` namespace,
  // because the master timetable said "udda veckor" first and a requirement
  // that means the same thing must not be given a second wording here.
  const tTimetable = useTranslations("timetable");
  const tCsvImport = useTranslations("csvImport");
  // The candidate badge's words live with the tjänstefördelning that
  // computes them, so the dialog and the matrix name a behörighet the same.
  const tStaffing = useTranslations("staffing");
  // A STAFF_* refusal is the engine catalogue's sentence (lib/staffing-warnings.ts),
  // so the dialog and the staffing workspace word the same 409 the same way.
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const {
    data: years,
    isLoading: yearsLoading,
    isError: yearsFailed,
  } = useAcademicYears();
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const activeYearId =
    selectedYearId ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;

  const {
    data: subjects,
    isLoading: subjectsLoading,
    isError: subjectsFailed,
  } = useSubjects();
  const {
    data: groups,
    isLoading: groupsLoading,
    isError: groupsFailed,
  } = useGroups();
  const { data: people } = usePeople();
  const {
    data: memberships,
    isLoading: membershipsLoading,
    isError: membershipsFailed,
  } = useGroupMemberships();
  const {
    data: requirements,
    isLoading: requirementsLoading,
    isError: requirementsFailed,
  } = useRequirements(activeYearId);
  /**
   * The year's lov, which the hours are measured against.
   *
   * `closures` is optional in lib/teaching-hours.ts and omitting it reproduces
   * the old calendar-week figure exactly — which is precisely the trap that
   * module's header warns about: a caller that forgets the breaks gets the
   * overestimate back without a word. So this query is gated below alongside
   * the others rather than left to arrive late. An empty list is a real answer
   * (a school that has entered no lov) and reads the same as the old behaviour,
   * honestly this time.
   */
  const {
    data: breaks,
    isLoading: breaksLoading,
    isError: breaksFailed,
  } = useSchoolBreaks(activeYearId);
  /**
   * What the cell dialog says beside each candidate: the behörighet they hold
   * for the row and the minutes they have left to their mål, from the same
   * report /admin/staffing draws its matrix from. NEITHER is in the loading
   * gate below. A badge that arrives late is quiet, like a late teacher
   * initial — the dialog says nothing about a candidate until it knows,
   * and the matrix holds no number of its own that depends on them. And a
   * school that has recorded no behörighet at all gets no badge rather than
   * "saknar behörighet" on every name (lib/staffing-candidates.ts).
   */
  const { data: loadReport } = useStaffingLoad(activeYearId);
  const { data: qualifications } = useTeacherQualifications();

  /**
   * One gate for every query this page prints a NUMBER from.
   *
   * `subjectsLoading` used to hold it alone, and the other caches are not
   * year-scoped — ["subjects"], ["groups"], ["groupMemberships"] are warm the
   * moment an admin has been on any other admin page, while ["requirements",
   * yearId] refetches on every move of the year picker. So the ordinary case
   * was the whole matrix drawn against `requirements === undefined`: every row
   * read "0 h" and the header read "0 lektioner den tyngsta veckan · 0 h
   * undervisning per läsår", in the same weight as a real measurement. A zero
   * that means "not fetched" is indistinguishable from a zero that means
   * "nothing is taught here", and the second is a finding a rektor would act
   * on. The skeleton is the honest answer while we do not know yet.
   *
   * `memberships` is in here for the same reason and not for the table's sake:
   * without it every teaching group reads "0 elever" in destructive red, which
   * is the page accusing the school of an empty group it does not have.
   *
   * `people` is deliberately NOT in here. It is the school's largest table and
   * all it feeds is the teacher initials inside a filled cell — a cell that has
   * not drawn its teacher line yet asserts nothing, it is merely quiet, and
   * holding the entire timplan back on the staff register to avoid a late
   * "H. Nilsson" would be the worse trade.
   *
   * `breaks` earns its place here on the same rule and it is the subtlest of
   * them: a lov list that has not arrived yet is not a school without lov, it
   * is a page that does not know — and the difference is 8-10 weeks of teaching
   * on every row. Unlike a missing requirement this one does not read as zero,
   * which is worse: it reads as a plausible, confident, too-high number.
   *
   * `useRequirements` and `useSchoolBreaks` are both disabled while activeYearId
   * is null, and a disabled query is not loading in react-query v5 (isLoading =
   * isPending && isFetching) — so a school with no läsår at all still falls
   * through to the empty state below instead of showing a skeleton forever.
   */
  const loading =
    yearsLoading ||
    subjectsLoading ||
    groupsLoading ||
    membershipsLoading ||
    requirementsLoading ||
    breaksLoading;

  /*
   * The same gate for the other way of not knowing.
   *
   * `isLoading` is `isPending && isFetching`, and a query that has failed is
   * neither — after `retry: 1` gives up it settles on
   * `{ data: undefined, isLoading: false, isError: true }` and falls straight
   * through the skeleton into the table. So closing the loading path alone left
   * the identical lie on the error path: a dead network printed "0 lektioner
   * den tyngsta veckan · 0 h undervisning per läsår" and a "0 h" on every row,
   * in the same weight as a measurement, and a rektor reading it has no way to
   * tell. It is the worse of the two, because loading resolves on its own and
   * this does not.
   *
   * A skeleton would be the wrong answer here — it promises something is
   * coming. This says what happened and leaves the year picker reachable, so
   * moving it refetches without a full reload.
   */
  const failed =
    yearsFailed ||
    subjectsFailed ||
    groupsFailed ||
    membershipsFailed ||
    requirementsFailed ||
    // A dead breaks query would otherwise print the pre-lov overestimate under
    // a caveat that now promises the lov are deducted — a wrong number under a
    // sentence swearing it is right.
    breaksFailed;

  const mutations = useCrudMutations<{
    academicYearId: string;
    subjectId: string;
    studentGroupId: string;
    teacherId?: string | null;
    coTeacherId?: string | null;
    lessonsPerWeek?: number;
    minutesPerLesson?: number;
    minutesBefore?: number;
    minutesAfter?: number;
    teacherLoadPercent?: number;
    coTeacherLoadPercent?: number;
    recurrence?: LessonRecurrence;
    startDate?: string | null;
    endDate?: string | null;
  }>("/api/v1/teaching-requirements", [
    ["requirements", activeYearId ?? ""],
    // A save that names or changes a teacher moves their load and the
    // candidate badges this dialog draws from it; without these the badge
    // would read the minutes from before the save.
    [...STAFFING_KEYS.load],
    [...STAFFING_KEYS.unstaffed],
    [...STAFFING_KEYS.suggestions],
  ]);
  /**
   * What the policy said about the last save, in the two shapes it can say it.
   *
   * A REFUSE is a 409 and nothing was written, so it belongs INSIDE the
   * dialog, next to the fields the admin has to change — the dialog stays
   * open with their input intact. A WARN saved the row, so the dialog closes
   * like any save and the sentence moves to a banner above the matrix, where
   * it stays until dismissed: it names a limit the admin may want to undo
   * against, which a toast would take away after four seconds.
   */
  const [refusal, setRefusal] = useState<StaffingRefusal | null>(null);
  const [savedWarnings, setSavedWarnings] = useState<{
    label: string;
    warnings: StaffingWarning[];
  } | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  /**
   * Mål: every class cell as "planerat / mål" against the lokal timplan the
   * year attaches to its årskurs. Off by default — the matrix is where posts
   * are entered, and the mode costs a fetch of the year's plans and a module
   * of its own. `targetState` is what the module's host last computed; it is
   * cleared with the toggle so a stale view never paints a cell.
   */
  const [targetMode, setTargetMode] = useState(false);
  const [targetModule, setTargetModule] = useState<TargetModule | null>(null);
  const [targetState, setTargetState] = useState<TargetState | null>(null);
  useEffect(() => {
    if (!targetMode || targetModule) return;
    let live = true;
    loadTargetModule().then(
      (module) => live && setTargetModule(module),
      () => {
        if (!live) return;
        setTargetMode(false);
        toast.error(tCommon("error"));
      },
    );
    return () => {
      live = false;
    };
  }, [targetMode, targetModule, tCommon]);
  const [cell, setCell] = useState<CellTarget | null>(null);
  const [form, setForm] = useState<CellForm>({
    lessonsPerWeek: "2",
    minutesPerLesson: "60",
    minutesBefore: "0",
    minutesAfter: "0",
    teacherId: NO_TEACHER,
    coTeacherId: NO_TEACHER,
    teacherLoadPercent: "100",
    coTeacherLoadPercent: "100",
    recurrence: "ALL_WEEKS",
    startDate: "",
    endDate: "",
  });

  const teachers = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER" && person.isActive),
    [people],
  );

  const yearGroups = useMemo(
    () => (groups ?? []).filter((group) => group.academicYearId === activeYearId),
    [groups, activeYearId],
  );

  /**
   * Group id → the årskurser its pupils sit in, for the behörighet badge.
   *
   * The same derivation the gateway's load report and the gaps page use
   * (lib/grade-span.ts): members' home classes first, the group's own year
   * second, no entry where neither is known — and a group with no entry is
   * covered by any behörighet in the subject, which is the report's rule too,
   * so the badge here and the matrix's unqualified list cannot disagree about
   * a row. Built from `yearGroups` and not every group the school has, for the
   * reason gradeLevelByGroup is: two läsår may both own a "7A".
   */
  const gradeSpanOf = useMemo(() => {
    const homeClassOf = new Map<string, string | null>();
    for (const person of people ?? []) {
      if (person.role === "STUDENT") homeClassOf.set(person.id, person.studentGroupId);
    }
    const membersByGroup = new Map<string, string[]>();
    for (const row of memberships ?? []) {
      const list = membersByGroup.get(row.studentGroupId);
      if (list) list.push(row.studentId);
      else membersByGroup.set(row.studentGroupId, [row.studentId]);
    }
    return buildGradeSpans({ groups: yearGroups, membersByGroup, homeClassOf });
  }, [yearGroups, memberships, people]);

  // Two sections rather than one alphabetical wall — see lib/group-sections.ts
  // for why, and for the tests that pin the ordering and the counts.
  const { sections, memberCounts } = useMemo(
    () => splitGroupsByKind(yearGroups, memberships ?? []),
    [yearGroups, memberships],
  );

  const requirementIndex = useMemo(() => {
    const map = new Map<string, TeachingRequirement>();
    for (const requirement of requirements ?? []) {
      map.set(`${requirement.studentGroupId}:${requirement.subjectId}`, requirement);
    }
    return map;
  }, [requirements]);

  /**
   * The year every period is measured inside.
   *
   * Taken from the year picker rather than from `useActiveYear`, because an
   * admin planning next autumn switches the picker and expects every number on
   * the page to follow — a requirement dated inside 2027/28 is worth nothing at
   * all when measured against 2026/27, and silently showing it against the
   * active year would be the wrong answer stated confidently.
   */
  const yearBounds = useMemo<YearBounds | null>(() => {
    const year = years?.find((entry) => entry.id === activeYearId);
    return year ? { startDate: year.startDate, endDate: year.endDate } : null;
  }, [years, activeYearId]);

  /**
   * Group id -> årskurs, for deciding which lov reach which row.
   *
   * Built from `yearGroups` and not from every group the school has: two läsår
   * may both own a "7A", and a map built from the whole list would take
   * whichever came last — then apply a prao for åk 9 to a class that is in åk 7
   * this year.
   */
  const gradeLevelByGroup = useMemo(() => {
    const grades = new Map<string, number | null>();
    for (const group of yearGroups) grades.set(group.id, group.gradeLevel);
    return grades;
  }, [yearGroups]);

  /**
   * Group id -> teaching minutes across the whole year, for the last column.
   *
   * The year's lov go in here and nowhere else. Per group rather than once over
   * the total, because a break may carry a year span: a studiedag for
   * lågstadiet takes a fifth of that week from åk 3 and nothing at all from
   * åk 9, and a single school-wide subtraction cannot express that.
   *
   * A group the map cannot name reads as `null`, which is "no particular
   * grade" — school-wide lov still apply to it, year-narrowed ones do not.
   * That is the same reading a teaching group with no årskurs of its own gets,
   * and it is the direction that never invents teaching time it has not
   * measured.
   */
  const annualMinutesByGroup = useMemo(() => {
    const totals = new Map<string, number>();
    if (!yearBounds) return totals;
    for (const requirement of requirements ?? []) {
      totals.set(
        requirement.studentGroupId,
        (totals.get(requirement.studentGroupId) ?? 0) +
          annualMinutes(
            requirement,
            yearBounds,
            breaks,
            gradeLevelByGroup.get(requirement.studentGroupId) ?? null,
          ),
      );
    }
    return totals;
  }, [requirements, yearBounds, breaks, gradeLevelByGroup]);

  /**
   * Group id -> lessons in that group's own heaviest week.
   *
   * Its own, not a slice of the school's: 7A's worst week and 8B's need not be
   * the same week, and taking the school's peak week and reading each group out
   * of it would understate every group that peaks elsewhere. The library keys
   * it per group for exactly that reason and walks the year once per key.
   *
   * A group with requirements that all miss the year comes back as 0 rather
   * than missing, so the column never silently falls back to the `?? 0` below
   * and calls a mistake an empty week.
   */
  const peakByGroup = useMemo(
    () =>
      yearBounds
        ? peakLessonsPerWeekByKey(
            requirements ?? [],
            yearBounds,
            (requirement) => requirement.studentGroupId,
          )
        : new Map<string, number>(),
    [requirements, yearBounds],
  );

  /**
   * What replaced a flat sum of lessonsPerWeek.
   *
   * That sum stopped being true the moment requirements grew periods: it counts
   * an ODD_WEEKS course and an EVEN_WEEKS one as sharing a week they never
   * share, and a half-term course as if it ran to June. `peakWeekly` is what
   * the heaviest week of the year actually holds — the figure that says whether
   * the timplan fits into a week at all — and `annualTotal` is the teaching all
   * of it adds up to.
   *
   * Both are school-wide, the same scope the old total had. The figure to check
   * a single class's week against is per group, and it lives in the table with
   * the other per-group figure — a third number on this line would make the
   * sentence a table, and the table is right there.
   *
   * NO LOV COME OFF EITHER PEAK, and `peakLessonsPerWeek` takes no closures to
   * hand them to. A lov week holds no lessons, so letting it pull the busiest
   * week down would answer "does this fit in a week" with the average of the
   * weeks it does not have to fit in. The hours are the figure lov belong to.
   */
  const peakWeekly = useMemo(
    () => (yearBounds ? peakLessonsPerWeek(requirements ?? [], yearBounds) : 0),
    [requirements, yearBounds],
  );

  const annualTotal = useMemo(() => {
    let total = 0;
    for (const minutes of annualMinutesByGroup.values()) total += minutes;
    return total;
  }, [annualMinutesByGroup]);

  /**
   * What Mål mode computes from, all of it already on this page. Memoised on
   * the queries' own data, because the module walks every pupil of the school
   * and must not run again on a re-render that changed nothing. Null until
   * the roster has answered: without it every class would read as having no
   * pupils, and "covered" would be judged on the class's own posts alone.
   */
  const targetSources = useMemo<Omit<TargetSources, "attachments" | "plans"> | null>(
    () =>
      yearBounds && people && memberships && subjects
        ? {
            year: yearBounds,
            closures: breaks ?? [],
            subjects,
            groups: yearGroups,
            requirements: requirements ?? [],
            people,
            memberships,
          }
        : null,
    [yearBounds, breaks, subjects, yearGroups, requirements, people, memberships],
  );
  const target =
    targetMode && targetModule && targetState?.status === "ready"
      ? { module: targetModule, ...targetState }
      : null;

  const teacherLabel = (id: string | null) => {
    if (!id) return null;
    const teacher = teachers.find((person) => person.id === id);
    return teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null;
  };

  const openCell = (groupId: string, subjectId: string) => {
    const existing = requirementIndex.get(`${groupId}:${subjectId}`) ?? null;
    setCell({ groupId, subjectId, existing });
    setRefusal(null);
    setForm({
      lessonsPerWeek: String(existing?.lessonsPerWeek ?? 2),
      minutesPerLesson: String(existing?.minutesPerLesson ?? 60),
      minutesBefore: String(existing?.minutesBefore ?? 0),
      minutesAfter: String(existing?.minutesAfter ?? 0),
      teacherId: existing?.teacherId ?? NO_TEACHER,
      coTeacherId: existing?.coTeacherId ?? NO_TEACHER,
      teacherLoadPercent: String(existing?.teacherLoadPercent ?? 100),
      coTeacherLoadPercent: String(existing?.coTeacherLoadPercent ?? 100),
      recurrence: existing?.recurrence ?? "ALL_WEEKS",
      startDate: existing?.startDate ?? "",
      endDate: existing?.endDate ?? "",
    });
  };

  const submit = async () => {
    if (!cell || !activeYearId) return;
    const lessonsPerWeek = Number(form.lessonsPerWeek);
    const minutesPerLesson = Number(form.minutesPerLesson);
    // Always sent, never omitted. Both are plain integers on the requirement
    // with a default of 0 — there is no "leave it alone" value to express the
    // way an emptied date has — so a field cleared back to nothing has to
    // arrive as the 0 it means, or an admin could never take a shower buffer
    // off again. `Number("")` is 0, which is exactly that reading.
    const minutesBefore = Number(form.minutesBefore);
    const minutesAfter = Number(form.minutesAfter);
    const teacherId = form.teacherId === NO_TEACHER ? null : form.teacherId;
    const coTeacherId =
      form.coTeacherId === NO_TEACHER || form.coTeacherId === form.teacherId
        ? null
        : form.coTeacherId;
    // An emptied date field is sent as an explicit null, not omitted. The DTO
    // reads undefined as "leave it alone" and null as "clear it back to the
    // year's own boundary" (UpdateTeachingRequirementDto), so omitting it would
    // make an admin unable to undo a period once entered.
    //
    // Nothing checks the order of the two dates or their fit inside the year
    // before sending. assertPeriodFitsYear already does both and names the
    // field it rejected, and that answer reaches the admin through the toast
    // below — a copy of the rule here would be a second opinion about the same
    // question, and the copy is the one that goes stale.
    const startDate = form.startDate === "" ? null : form.startDate;
    const endDate = form.endDate === "" ? null : form.endDate;
    // Always sent, like the buffers: a column with a default and no "leave it
    // alone" value. An unchanged 100 costs the gateway one policy read, and it
    // asks nothing new of an unchanged teacher (staffing-checks.ts only asks
    // the behörighet question of a NEW teacher, and the mål question only of a
    // write that adds minutes).
    const teacherLoadPercent = Number(form.teacherLoadPercent);
    const coTeacherLoadPercent = Number(form.coTeacherLoadPercent);
    const label = `${groupOf(cell.groupId)?.name ?? ""} · ${subjectOf(cell.subjectId)?.name ?? ""}`;
    setRefusal(null);
    try {
      let saved: unknown;
      if (cell.existing) {
        saved = await mutations.update.mutateAsync({
          id: cell.existing.id,
          lessonsPerWeek,
          minutesPerLesson,
          minutesBefore,
          minutesAfter,
          teacherId,
          coTeacherId,
          teacherLoadPercent,
          coTeacherLoadPercent,
          recurrence: form.recurrence,
          startDate,
          endDate,
        });
      } else {
        saved = await mutations.create.mutateAsync({
          academicYearId: activeYearId,
          subjectId: cell.subjectId,
          studentGroupId: cell.groupId,
          teacherId,
          coTeacherId,
          lessonsPerWeek,
          minutesPerLesson,
          minutesBefore,
          minutesAfter,
          teacherLoadPercent,
          coTeacherLoadPercent,
          recurrence: form.recurrence,
          startDate,
          endDate,
        });
      }
      // StaffedRequirement: the row plus `warnings`, always present from this
      // gateway. Read defensively all the same — an older build answers with
      // the bare row, and that must read as "nothing to say", not crash.
      const warnings = (saved as { warnings?: StaffingWarning[] } | null)?.warnings ?? [];
      setSavedWarnings(warnings.length > 0 ? { label, warnings } : null);
      toast.success(tCommon("updated"));
      setCell(null);
    } catch (error) {
      const refused = staffingRefusal(error);
      if (refused) {
        setRefusal(refused);
        return;
      }
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };


  const removeCell = async () => {
    if (!cell?.existing) return;
    try {
      await mutations.remove.mutateAsync(cell.existing.id);
      toast.success(tCommon("deleted"));
      setCell(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  /**
   * The columns, in the order of the label they actually carry.
   *
   * `useSubjects` sorts by name, which is right for every dropdown — those show
   * names. This header shows the CODE, and sorting one string while displaying
   * another reads as no order at all: the school's own list came out
   * "EN IDH MA MU NO SO SL SV", because Slöjd sorts after SO by name while the
   * eye is reading SL against SO.
   *
   * Sorted here rather than in the hook, because the hook feeds both views and
   * each is alphabetical in what it shows. The cells below iterate this same
   * array — a header ordered one way and cells another would silently file
   * every lesson under the wrong subject.
   */
  const columns = useMemo(
    () => sortByName(subjects ?? [], (subject) => subject.code ?? subject.name),
    [subjects],
  );

  const subjectOf = (id: string) => subjects?.find((subject) => subject.id === id);
  const groupOf = (id: string) => yearGroups.find((group) => group.id === id);

  /**
   * The timplan on screen, as the file the importer reads back.
   *
   * `requirements` is already the picked year's — `useRequirements(activeYearId)`
   * is keyed on it — so the export follows the year picker without filtering
   * anything a second time. An admin who switches to next autumn and exports
   * gets next autumn, which is the only reading of the button that is not a
   * trap.
   *
   * The groups handed over are `yearGroups` rather than every group the school
   * has: two läsår may both own a "7A", and the id-to-name map would then be
   * built from whichever came last in the list.
   */
  const exportCsv = () =>
    requirementsToCsv(requirements ?? [], yearGroups, subjects ?? [], people ?? []);

  /**
   * Nothing to export is one reason to disable the button. An unanswered
   * `usePeople` is the other, and it is not the same thing at all: a teacher
   * the roster cannot name makes requirementsToCsv DROP the row rather than
   * write a blank teacher cell (a blank means "no teacher" to the importer,
   * and the import updates). While the roster is in flight that silently
   * empties the file of every requirement that has a teacher — a plausible
   * looking CSV missing most of the school. This page deliberately does not
   * hold the matrix back on `people` (see the loading gate above), so the wait
   * is paid here, on the one control that cannot survive it.
   */
  const exportEmpty =
    (requirements ?? []).length === 0 ||
    people === undefined ||
    // Same argument as `people`, for the two lookups a row cannot be written
    // without: requirementsToCsv skips any row whose group or subject it cannot
    // name, so a subjects query that failed or has not answered turns the whole
    // export into a header line with nothing under it — a file that looks like
    // a school with an empty timplan rather than like a page that did not
    // finish loading.
    subjects === undefined ||
    groups === undefined;

  /**
   * One candidate as the picker shows them: the name, then the behörighet badge
   * for THIS cell's subject and group and the minutes left to their mål.
   *
   * The same line in both pickers, because a medlärare is held to the same
   * behörighet as the lärare and counts fully toward their own mål (the
   * report's co-teacher rule). Inside SelectItemText, so the trigger repeats
   * it for the chosen teacher and the option's accessible name carries the
   * words — nothing is said by colour alone.
   */
  const candidateLine = (teacher: { id: string; firstName: string; lastName: string }) => {
    if (!cell || !yearBounds) return `${teacher.firstName} ${teacher.lastName}`;
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>
          {teacher.firstName} {teacher.lastName}
        </span>
        <CandidateBadge
          qualification={candidateQualification(
            qualifications ?? [],
            teacher.id,
            cell.subjectId,
            gradeSpanOf.get(cell.groupId) ?? null,
            yearBounds,
          )}
          remaining={candidateRemaining(loadReport, teacher.id)}
        />
      </span>
    );
  };

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            {years && years.length > 0 ? (
              <Select
                value={activeYearId ?? undefined}
                onValueChange={(value) => setSelectedYearId(value)}
              >
                {/*
                  The picker decides what every figure on the page means, and
                  it sits among two buttons now rather than alone — a trigger
                  announcing only "2026/2027" leaves a screen-reader user to
                  guess which of the three controls they are on.
                */}
                <SelectTrigger className="w-44" aria-label={t("yearLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((year) => (
                    <SelectItem key={year.id} value={year.id}>
                      {year.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {/*
              A toggle, so `aria-pressed` says which mode the matrix is in; the
              label stays "Mål" in both states, as a toggle's name must.
            */}
            <Button
              variant={targetMode ? "default" : "outline"}
              aria-pressed={targetMode}
              disabled={!activeYearId}
              onClick={() => {
                setTargetMode((on) => !on);
                setTargetState(null);
              }}
            >
              {t("target.toggle")}
            </Button>
            {/*
              Export before import, as on admin/subjects and admin/groups. Both
              carry their own text label, so neither needs an aria-label — an
              icon-only button here would be the third unnamed control in a
              row.
            */}
            <CsvExportButton
              exports={[{ kind: "requirements", build: exportCsv, empty: exportEmpty }]}
            />
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload />
              {tCsvImport("button")}
            </Button>
          </>
        }
      />

      {savedWarnings ? (
        <div className="mb-4">
          <WarningsNotice
            context={savedWarnings.label}
            warnings={savedWarnings.warnings}
            onDismiss={() => setSavedWarnings(null)}
          />
        </div>
      ) : null}

      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : failed ? (
        <EmptyState
          icon={TriangleAlert}
          title={t("loadFailed")}
          description={t("loadFailedHint")}
        />
      ) : !activeYearId ? (
        /*
          "Skapa och aktivera ett läsår först" is a statement about how the
          school is set up, and it used to be printed while ["academicYears"]
          was still in flight — telling an admin who has three läsår that they
          have none. Both ways of not knowing are now taken above it: still in
          flight goes to the skeleton, gave up goes to the branch before this
          one. What is left is the one state the sentence is true in — `years`
          arrived and held nothing.
        */
        <EmptyState icon={Grid3x3} title={tCommon("noResults")} description={t("noYear")} />
      ) : yearGroups.length === 0 || !subjects || subjects.length === 0 ? (
        <EmptyState icon={Grid3x3} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <>
          {/*
            Both figures move when the year picker moves and when any cell is
            saved, and neither redraw shifts focus — so a screen reader would
            otherwise never learn that the number it just heard has changed.
            `aria-atomic` because the sentence only means anything whole: "3"
            announced alone is not an answer to anything.
          */}
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-describedby="requirements-hours-caveat"
            className="text-sm font-medium text-foreground"
          >
            {t("summary", {
              lessons: peakWeekly,
              hours: formatHours(annualTotal),
            })}
          </p>
          {/*
            Which footnote is true depends on whether the school has entered any
            lov, and that is not a detail. `hoursCaveat` states that holidays are
            deducted; for a school with an empty admin/breaks — which is every
            school until someone fills it in, and the default state of the
            feature — nothing is deducted and the figure is the old one, reading
            8-10 weeks high under a sentence promising it does not. That is the
            precise silent overstatement this whole change was made to remove,
            so the empty case says so and points at the page that fixes it.

            Empty is not the same as absent here: `loading` and `failed` above
            already hold the whole table back, so reaching this line means the
            list arrived and genuinely held nothing.
          */}
          <p id="requirements-hours-caveat" className="mb-3 mt-1 text-xs text-foreground">
            {(breaks ?? []).length > 0 ? t("hoursCaveat") : t("hoursCaveatNoBreaks")}
          </p>
          {targetMode && targetModule && activeYearId ? (
            <targetModule.TargetHost
              academicYearId={activeYearId}
              sources={targetSources}
              onState={setTargetState}
            />
          ) : targetMode ? (
            <p role="status" className="mb-3 text-sm text-foreground">
              {t("target.loading")}
            </p>
          ) : null}
          {/*
            Its own scroll area, not the page's.

            The subject row has to stay visible while an admin scrolls through
            a hundred groups — ticking a cell without seeing its column is how
            a lesson lands on the wrong subject. `position: sticky` resolves
            against the nearest scrolling ancestor, and `overflow-x: auto`
            already makes this element one (the spec computes overflow-y to
            auto alongside it), so a sticky header only works if this container
            is also what scrolls vertically. Hence the height cap and
            overflow-auto rather than page scrolling.
          */}
          <div className="max-h-[70vh] overflow-auto rounded-lg border bg-card">
            <table className="w-full text-sm">
              {/*
                The caption carries the caveat as well as the name, because a
                reader who lands on the hours column by table navigation never
                passes the paragraph above that explains it.
              */}
              <caption className="sr-only">{t("tableCaption")}</caption>
              <thead>
                <tr className="border-b">
                  <th
                    scope="col"
                    className="sticky left-0 top-0 z-30 bg-card px-3 py-2.5 text-left font-medium text-muted-foreground"
                  >
                    {tCommon("group")}
                  </th>
                  {columns.map((subject) => (
                    <th
                      key={subject.id}
                      scope="col"
                      className="sticky top-0 z-20 border-l bg-card px-2 py-2.5 text-center"
                    >
                      <div className="flex flex-col items-center gap-1">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: subjectColor(subject.id, subject.color) }}
                        />
                        <span className="max-w-24 truncate text-xs font-medium">
                          {subject.code ?? subject.name}
                        </span>
                      </div>
                    </th>
                  ))}
                  {/*
                    Pinned to the right for the same reason the group column is
                    pinned to the left: a school with a dozen subjects scrolls
                    this table sideways, and a total you have to scroll away
                    from the row to read is a total nobody checks. z-30 so it
                    wins over both sticky axes where they meet, exactly as the
                    left-hand corner does.
                  */}
                  {/*
                    Two pinned columns, so each figure keeps a header of its
                    own. Stacking them in one cell would have saved the width,
                    but a screen reader moving across the row would then hear
                    "86 h · 2" under a single heading, and the reading of the
                    second number is the whole thing that makes it useful.

                    The offset is load-bearing: this column sits exactly the
                    hours column's width from the edge, so `right-24` here and
                    the width there are the same 6rem and have to move
                    together.

                    MEASURED, because reasoning got it wrong. `w-24` was the
                    first attempt and it does not hold: `width` on a cell in an
                    auto-layout table is a suggestion, and the browser shrank
                    the column to its content — 78px for "1234 h" — leaving an
                    18px gap between the two pinned columns with the subjects
                    scrolling visibly through it. `min-w-24` is honoured
                    exactly, and `max-w-24` is the other half of the guard:
                    without it a long enough total widens the column and the
                    peak slides UNDER it instead, which is the worse failure.
                    Checked in a browser at both ends — "1234 h" and "12345 h"
                    both give a 96px column and a zero gap.

                    Nothing is pinned to the peak column's own left edge, so it
                    needs no width of its own and is not given a class that
                    would not hold anyway.
                  */}
                  {target ? (
                    <th
                      scope="col"
                      className="sticky top-0 z-20 border-l bg-card px-3 py-2.5 text-right font-medium text-foreground"
                    >
                      {t("target.totalHeader")}
                    </th>
                  ) : null}
                  <th
                    scope="col"
                    className="sticky right-24 top-0 z-30 border-l bg-card px-3 py-2.5 text-right font-medium text-foreground"
                  >
                    {t("peakHeader")}
                  </th>
                  <th
                    scope="col"
                    className="sticky right-0 top-0 z-30 min-w-24 max-w-24 border-l bg-card px-3 py-2.5 text-right font-medium text-foreground"
                  >
                    {t("hoursHeader")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => (
                  <Fragment key={section.kind}>
                    <tr className="border-b bg-muted/40">
                      <td
                        // group column + every subject + peak + hours. A
                        // colSpan short of the row leaves the section label
                        // ending mid-table with a gap where the totals are.
                        colSpan={columns.length + (target ? 4 : 3)}
                        className="bg-muted px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      >
                        {/*
                          The label sticks, not the cell: a cell spanning the
                          whole table is already at x=0, so making it sticky
                          does nothing and the text scrolls away with the
                          columns.
                        */}
                        <span className="sticky left-3 inline-block">
                          {section.kind === "CLASS"
                            ? t("classesSection")
                            : t("teachingGroupsSection")}{" "}
                          ({section.groups.length})
                        </span>
                      </td>
                    </tr>
                    {section.groups.map((group) => (
                  <tr key={group.id} className="border-b last:border-0">
                    {/*
                      A `th scope="row"`, not a `td`: it is what pairs "58 h" in
                      the last column with the group it belongs to when a screen
                      reader reads the row. `text-left` and `font-medium` are
                      spelled out because Tailwind's preflight does not reset
                      th's centred bold default — the cell looked the same as a
                      td only by accident before.
                    */}
                    <th
                      scope="row"
                      className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium"
                    >
                      <span>{group.name}</span>
                      {target && section.kind === "CLASS" && target.view.summary(group.id) ? (
                        <target.module.CoveragePill
                          summary={target.view.summary(group.id)!}
                          academicYearId={activeYearId}
                          groupName={group.name}
                        />
                      ) : null}
                      {section.kind === "TEACHING_GROUP" ? (
                        <span
                          className={
                            (memberCounts.get(group.id) ?? 0) === 0
                              ? "ml-2 text-xs font-normal text-destructive"
                              : "ml-2 text-xs font-normal text-muted-foreground"
                          }
                        >
                          {t("memberCount", { count: memberCounts.get(group.id) ?? 0 })}
                        </span>
                      ) : null}
                    </th>
                    {columns.map((subject) => {
                      const requirement = requirementIndex.get(`${group.id}:${subject.id}`);
                      // The same badge the master timetable prints on a lesson,
                      // from the same function — "udda" here and "udda" there
                      // have to be the same word, and a second implementation
                      // is how they stop being.
                      const badge = requirement
                        ? recurrenceBadge(requirement, tTimetable)
                        : null;
                      // Mål mode paints a CLASS cell from the timplan's line,
                      // including a cell with no post that the plan asks for
                      // ("0 / 180"). A teaching group has no årskurs and so no
                      // target of its own: its cells stay as they are.
                      const targetCell =
                        target && section.kind === "CLASS"
                          ? target.view.cell(group.id, subject.id)
                          : null;
                      const targetSentence =
                        targetCell && target
                          ? target.module.cellSentence(t, targetCell, target.input)
                          : null;
                      return (
                        <td key={subject.id} className="border-l p-1 text-center">
                          <button
                            type="button"
                            // Names the cell for a screen reader, which read
                            // only "3×60" or nothing at all before — and binds
                            // the cell to its column, so a header ordered one
                            // way and cells another can be caught by a test
                            // rather than by a school teaching the wrong
                            // subject for a term.
                            //
                            // An aria-label REPLACES the cell's contents, so
                            // everything the cell shows has to be said here or
                            // it is said to nobody: the load, and the badge
                            // that is the only sign the requirement does not
                            // run the whole year. Two whole sentences rather
                            // than one with a fragment glued on, so a
                            // translator sees what is being said.
                            aria-label={
                              (!requirement
                                ? t("cellLabel", {
                                    group: group.name,
                                    subject: subject.name,
                                  })
                                : badge
                                  ? t("cellLabelPeriod", {
                                      group: group.name,
                                      subject: subject.name,
                                      lessons: requirement.lessonsPerWeek,
                                      minutes: requirement.minutesPerLesson,
                                      note: badge,
                                    })
                                  : t("cellLabelSet", {
                                      group: group.name,
                                      subject: subject.name,
                                      lessons: requirement.lessonsPerWeek,
                                      minutes: requirement.minutesPerLesson,
                                    })) + (targetSentence ? `. ${targetSentence}` : "")
                            }
                            onClick={() => openCell(group.id, subject.id)}
                            className={
                              targetCell && target
                                ? target.module.targetCellClass(targetCell.tone)
                                : requirement
                                ? // min-h rather than h: a badged cell needs a
                                  // third line, and clipping the badge would
                                  // hide the very thing it exists to show.
                                  "mx-auto flex min-h-10 w-full min-w-16 flex-col items-center justify-center rounded-md bg-accent/70 text-accent-foreground transition-colors hover:bg-accent"
                                : // No alpha on the icon colour. `/40` blended
                                  // muted-foreground down to #c6c6ca on white
                                  // and #47474c on the dark card — 1.70:1 and
                                  // 2.01:1, under even the 3:1 that WCAG 2.1
                                  // asks of a graphical object, on the only
                                  // control that says a subject can be added
                                  // here. The token undiluted measures 4.83 /
                                  // 6.17, and hover moves to `foreground`
                                  // (17.00 / 13.19) so the hover still reads
                                  // as a change now that the opacity is not
                                  // doing that work. See the file header.
                                  "mx-auto flex h-10 w-full min-w-16 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            }
                          >
                            {targetCell && target ? (
                              <target.module.TargetCellBody cell={targetCell} />
                            ) : requirement ? (
                              <>
                                <span className="text-sm font-semibold tabular-nums">
                                  {requirement.lessonsPerWeek}×{requirement.minutesPerLesson}
                                </span>
                                {teacherLabel(requirement.teacherId) ? (
                                  <span className="max-w-24 truncate text-[10px] leading-tight">
                                    {teacherLabel(requirement.teacherId)}
                                  </span>
                                ) : null}
                                {badge ? (
                                  <span className="max-w-24 truncate text-[10px] font-semibold uppercase leading-tight tracking-wide">
                                    {badge}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <Plus className="h-4 w-4" />
                            )}
                          </button>
                        </td>
                      );
                    })}
                    {target ? (
                      <td className="border-l bg-card px-3 py-2 text-right font-medium tabular-nums text-foreground">
                        <target.module.GroupTotalCell summary={target.view.summary(group.id)} />
                      </td>
                    ) : null}
                    <td className="sticky right-24 z-10 border-l bg-card px-3 py-2 text-right font-medium tabular-nums text-foreground">
                      {peakByGroup.get(group.id) ?? 0}
                    </td>
                    <td className="sticky right-0 z-10 min-w-24 max-w-24 border-l bg-card px-3 py-2 text-right font-medium tabular-nums text-foreground">
                      {formatHours(annualMinutesByGroup.get(group.id) ?? 0)}
                    </td>
                  </tr>
                    ))}
                    {/*
                      Mål mode's subject totals, over the classes and under
                      them: a teaching group's minutes reach pupils of several
                      classes and no target of their own, so adding them here
                      would count one pupil's språkval against every class.
                    */}
                    {target && section.kind === "CLASS" ? (
                      <tr className="border-b bg-muted/40">
                        <th
                          scope="row"
                          className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-medium text-foreground"
                        >
                          {t("target.totalsRow")}
                        </th>
                        {columns.map((subject) => (
                          <td key={subject.id} className="border-l px-1 py-2 text-center text-foreground">
                            <target.module.SubjectTotalCell
                              total={target.view.subjectTotals.get(subject.id)}
                            />
                          </td>
                        ))}
                        <td className="border-l px-3 py-2 text-right font-medium tabular-nums text-foreground">
                          <target.module.GroupTotalCell summary={null} total={target.view.total} />
                        </td>
                        <td className="sticky right-24 z-10 border-l bg-muted" />
                        <td className="sticky right-0 z-10 min-w-24 max-w-24 border-l bg-muted" />
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/*
        Only the timplan, though the dialog can offer a list: every other kind
        has a page of its own, and an import of elever launched from here would
        land somewhere the admin cannot see the result.
      */}
      <LazyCsvImportDialog
        kinds={["requirements"]}
        // The year the matrix, the hours and the export are all showing. Left
        // to itself the dialog would find the ACTIVE year instead, which is a
        // different year the moment someone plans ahead.
        academicYearId={activeYearId}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      <Dialog open={cell !== null} onOpenChange={(open) => !open && setCell(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {cell
                ? `${groupOf(cell.groupId)?.name ?? ""} · ${subjectOf(cell.subjectId)?.name ?? ""}`
                : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="req-lessons">{t("lessonsPerWeek")}</Label>
                <Input
                  id="req-lessons"
                  type="number"
                  min={1}
                  max={20}
                  value={form.lessonsPerWeek}
                  onChange={(e) => setForm({ ...form, lessonsPerWeek: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="req-minutes">{t("minutesPerLesson")}</Label>
                <Input
                  id="req-minutes"
                  type="number"
                  min={15}
                  max={240}
                  step={5}
                  value={form.minutesPerLesson}
                  onChange={(e) => setForm({ ...form, minutesPerLesson: e.target.value })}
                />
              </div>
            </div>
            {/*
              Mål mode's line under the two numbers it reads: what the
              timplan asks of this class in this subject, and what the post
              as typed gives. It follows the fields (and the period below)
              as they change, before anything is saved.
            */}
            {cell && target ? (
              <target.module.TargetHint
                input={target.input}
                groupId={cell.groupId}
                subjectId={cell.subjectId}
                fields={form}
              />
            ) : null}
            {/*
              The pupils' own time, on the row BELOW the lesson's own length and
              not beside it — the pair above says how long the teaching is, and
              these two say how long the class is gone. Bounds are the API's
              (0..60, CreateTeachingRequirementDto) so a number the database
              would refuse never leaves the dialog, and step={5} because a
              school types 10 or 15 minutes of ombyte, never 13.

              Each input carries its own hint. The two say different things —
              ombyte before, dusch and ombyte after — and the sentence that
              matters most is in the second one: only the children are
              occupied, which is the whole reason this is not a longer lesson.
            */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="req-minutes-before">{t("minutesBefore")}</Label>
                <Input
                  id="req-minutes-before"
                  type="number"
                  min={0}
                  max={60}
                  step={5}
                  value={form.minutesBefore}
                  onChange={(e) => setForm({ ...form, minutesBefore: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t("minutesBeforeHint")}</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="req-minutes-after">{t("minutesAfter")}</Label>
                <Input
                  id="req-minutes-after"
                  type="number"
                  min={0}
                  max={60}
                  step={5}
                  value={form.minutesAfter}
                  onChange={(e) => setForm({ ...form, minutesAfter: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{t("minutesAfterHint")}</p>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tCommon("teacher")}</Label>
              <Select
                value={form.teacherId}
                onValueChange={(value) => setForm({ ...form, teacherId: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEACHER}>{tCommon("notAssigned")}</SelectItem>
                  {teachers.map((teacher) => (
                    <SelectItem key={teacher.id} value={teacher.id}>
                      {candidateLine(teacher)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{tStaffing("candidateHint")}</p>
            </div>
            <div className="space-y-2">
              <Label>{t("coTeacher")}</Label>
              <Select
                value={form.coTeacherId}
                onValueChange={(value) => setForm({ ...form, coTeacherId: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEACHER}>{tCommon("notAssigned")}</SelectItem>
                  {teachers
                    .filter((teacher) => teacher.id !== form.teacherId)
                    .map((teacher) => (
                      <SelectItem key={teacher.id} value={teacher.id}>
                        {candidateLine(teacher)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("coTeacherHint")}</p>
            </div>
            {/*
              The master timetable's own period control, reused rather than
              rebuilt. It writes its three fields straight onto the form, the
              way admin/timetable's create dialog does — a second picker here
              would be a second place for "udda veckor" to mean something
              slightly different.
              `idPrefix` keeps its label/input pairs unique; "req" because this
              dialog can be open while nothing else is.
            */}
            <RecurrenceFields
              idPrefix="req"
              value={{
                recurrence: form.recurrence,
                startDate: form.startDate,
                endDate: form.endDate,
              }}
              onChange={(next) => setForm({ ...form, ...next })}
            />
            {/*
              Avancerat: what each teacher is CHARGED of this row in
              tjänstefördelningen — Skola24's "Justera längd för lärare (%)".
              Folded away because nearly every row is 100/100 and a school
              that never needs it should never have to read it; opened from
              the start on a row that already carries something else, so a
              stored 50 is never hidden behind a click.

              A native <details>: keyboard and screen-reader behaviour for
              free, and no state of our own to keep in step with the cell. The
              key re-mounts it per cell so the initial `open` is read afresh.
            */}
            <details
              key={cell ? `${cell.groupId}:${cell.subjectId}` : "none"}
              open={
                (cell?.existing?.teacherLoadPercent ?? 100) !== 100 ||
                (cell?.existing?.coTeacherLoadPercent ?? 100) !== 100
              }
              className="rounded-md border px-3 py-2"
            >
              <summary className="cursor-pointer text-sm font-medium">{t("advanced")}</summary>
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="req-teacher-load">{t("teacherLoadPercent")}</Label>
                    <Input
                      id="req-teacher-load"
                      type="number"
                      min={0}
                      max={200}
                      step={5}
                      value={form.teacherLoadPercent}
                      aria-invalid={!loadPercentInRange(form.teacherLoadPercent)}
                      aria-describedby="req-load-hint"
                      onChange={(e) => setForm({ ...form, teacherLoadPercent: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="req-co-teacher-load">{t("coTeacherLoadPercent")}</Label>
                    <Input
                      id="req-co-teacher-load"
                      type="number"
                      min={0}
                      max={200}
                      step={5}
                      value={form.coTeacherLoadPercent}
                      aria-invalid={!loadPercentInRange(form.coTeacherLoadPercent)}
                      aria-describedby="req-load-hint"
                      onChange={(e) => setForm({ ...form, coTeacherLoadPercent: e.target.value })}
                    />
                  </div>
                </div>
                <p id="req-load-hint" className="text-xs text-muted-foreground">
                  {loadPercentInRange(form.teacherLoadPercent) &&
                  loadPercentInRange(form.coTeacherLoadPercent)
                    ? t("loadPercentHint")
                    : t("loadPercentInvalid")}
                </p>
              </div>
            </details>
            {refusal ? <RefusalNotice text={refusalText(tEngine, refusal)} /> : null}
          </div>
          <DialogFooter className="sm:justify-between">
            {cell?.existing ? (
              <Button
                variant="destructive"
                onClick={removeCell}
                disabled={mutations.remove.isPending}
              >
                {tCommon("delete")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCell(null)}>
                {tCommon("cancel")}
              </Button>
              <Button
                onClick={submit}
                disabled={
                  Number(form.lessonsPerWeek) < 1 ||
                  Number(form.minutesPerLesson) < 15 ||
                  // The buffers are capped in the database as well as in the
                  // DTO, so an out-of-range number would come back as a 400
                  // about a column the admin did not name. `min`/`max` on the
                  // input only constrain the spinner — a typed 90 passes them.
                  !bufferInRange(form.minutesBefore) ||
                  !bufferInRange(form.minutesAfter) ||
                  !loadPercentInRange(form.teacherLoadPercent) ||
                  !loadPercentInRange(form.coTeacherLoadPercent) ||
                  mutations.create.isPending ||

                  mutations.update.isPending
                }
              >
                {tCommon("save")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
