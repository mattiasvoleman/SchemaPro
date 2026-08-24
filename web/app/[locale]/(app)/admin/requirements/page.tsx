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
// The hours are honest about what they cannot see: there is no closure model
// anywhere in the app, so they count whole calendar weeks and lov is counted as
// taught. `hoursCaveat` says so on the page rather than here alone — a figure a
// rektor might put in a document has to carry its own footnote.
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
// Left alone, and worth raising on its own: three pieces of text this page did
// not gain today are still `muted-foreground` — the "Klass" heading and the
// member count on card (4.83 / 6.17) and the section headings on muted (4.40 /
// 5.28). AA in both themes, AAA in neither. That token is the product's own
// secondary text colour, painted on every page there is, so moving it is a
// change to the palette rather than to this file.

import { Fragment, useMemo, useState } from "react";
import { splitGroupsByKind } from "@/lib/group-sections";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Grid3x3, Plus, TriangleAlert } from "lucide-react";
import {
  useAcademicYears,
  useCrudMutations,
  useGroupMemberships,
  useGroups,
  usePeople,
  useRequirements,
  useSubjects,
} from "@/lib/queries";
import {
  annualMinutes,
  formatHours,
  peakLessonsPerWeek,
  peakLessonsPerWeekByKey,
  type YearBounds,
} from "@/lib/teaching-hours";
import type { LessonRecurrence, TeachingRequirement } from "@/lib/types";
import { subjectColor } from "@/lib/utils";
import { sortByName } from "@/lib/sorting";
import { PageHeader } from "@/components/layout/page-header";
import {
  RecurrenceFields,
  recurrenceBadge,
} from "@/components/schedule/recurrence-fields";
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

interface CellTarget {
  groupId: string;
  subjectId: string;
  existing: TeachingRequirement | null;
}

interface CellForm {
  lessonsPerWeek: string;
  minutesPerLesson: string;
  teacherId: string;
  coTeacherId: string;
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
   * `useRequirements` is disabled while activeYearId is null, and a disabled
   * query is not loading in react-query v5 (isLoading = isPending && isFetching)
   * — so a school with no läsår at all still falls through to the empty state
   * below instead of showing a skeleton forever.
   */
  const loading =
    yearsLoading ||
    subjectsLoading ||
    groupsLoading ||
    membershipsLoading ||
    requirementsLoading;

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
    requirementsFailed;

  const mutations = useCrudMutations<{
    academicYearId: string;
    subjectId: string;
    studentGroupId: string;
    teacherId?: string | null;
    coTeacherId?: string | null;
    lessonsPerWeek?: number;
    minutesPerLesson?: number;
    recurrence?: LessonRecurrence;
    startDate?: string | null;
    endDate?: string | null;
  }>("/api/v1/teaching-requirements", [["requirements", activeYearId ?? ""]]);

  const [cell, setCell] = useState<CellTarget | null>(null);
  const [form, setForm] = useState<CellForm>({
    lessonsPerWeek: "2",
    minutesPerLesson: "60",
    teacherId: NO_TEACHER,
    coTeacherId: NO_TEACHER,
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

  /** Group id -> teaching minutes across the whole year, for the last column. */
  const annualMinutesByGroup = useMemo(() => {
    const totals = new Map<string, number>();
    if (!yearBounds) return totals;
    for (const requirement of requirements ?? []) {
      totals.set(
        requirement.studentGroupId,
        (totals.get(requirement.studentGroupId) ?? 0) +
          annualMinutes(requirement, yearBounds),
      );
    }
    return totals;
  }, [requirements, yearBounds]);

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

  const teacherLabel = (id: string | null) => {
    if (!id) return null;
    const teacher = teachers.find((person) => person.id === id);
    return teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null;
  };

  const openCell = (groupId: string, subjectId: string) => {
    const existing = requirementIndex.get(`${groupId}:${subjectId}`) ?? null;
    setCell({ groupId, subjectId, existing });
    setForm({
      lessonsPerWeek: String(existing?.lessonsPerWeek ?? 2),
      minutesPerLesson: String(existing?.minutesPerLesson ?? 60),
      teacherId: existing?.teacherId ?? NO_TEACHER,
      coTeacherId: existing?.coTeacherId ?? NO_TEACHER,
      recurrence: existing?.recurrence ?? "ALL_WEEKS",
      startDate: existing?.startDate ?? "",
      endDate: existing?.endDate ?? "",
    });
  };

  const submit = async () => {
    if (!cell || !activeYearId) return;
    const lessonsPerWeek = Number(form.lessonsPerWeek);
    const minutesPerLesson = Number(form.minutesPerLesson);
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
    try {
      if (cell.existing) {
        await mutations.update.mutateAsync({
          id: cell.existing.id,
          lessonsPerWeek,
          minutesPerLesson,
          teacherId,
          coTeacherId,
          recurrence: form.recurrence,
          startDate,
          endDate,
        });
      } else {
        await mutations.create.mutateAsync({
          academicYearId: activeYearId,
          subjectId: cell.subjectId,
          studentGroupId: cell.groupId,
          teacherId,
          coTeacherId,
          lessonsPerWeek,
          minutesPerLesson,
          recurrence: form.recurrence,
          startDate,
          endDate,
        });
      }
      toast.success(tCommon("updated"));
      setCell(null);
    } catch (error) {
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

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          years && years.length > 0 ? (
            <Select
              value={activeYearId ?? undefined}
              onValueChange={(value) => setSelectedYearId(value)}
            >
              <SelectTrigger className="w-44">
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
          ) : null
        }
      />

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
          <p id="requirements-hours-caveat" className="mb-3 mt-1 text-xs text-foreground">
            {t("hoursCaveat")}
          </p>
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
                        colSpan={columns.length + 3}
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
                              !requirement
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
                                    })
                            }
                            onClick={() => openCell(group.id, subject.id)}
                            className={
                              requirement
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
                            {requirement ? (
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
                    <td className="sticky right-24 z-10 border-l bg-card px-3 py-2 text-right font-medium tabular-nums text-foreground">
                      {peakByGroup.get(group.id) ?? 0}
                    </td>
                    <td className="sticky right-0 z-10 min-w-24 max-w-24 border-l bg-card px-3 py-2 text-right font-medium tabular-nums text-foreground">
                      {formatHours(annualMinutesByGroup.get(group.id) ?? 0)}
                    </td>
                  </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

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
                      {teacher.firstName} {teacher.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                        {teacher.firstName} {teacher.lastName}
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
