"use client";

// Lov och studiedagar — the days the läsår has but the timetable does not.
//
// Every other planning page here describes teaching: which subjects, which
// groups, how many lessons a week. This one describes its absence, and it is
// the piece the hours arithmetic was missing. lib/teaching-hours.ts counted
// whole calendar weeks because nothing in the app knew a week could be a lov,
// and read roughly 8-10 weeks high across a Swedish läsår; SchoolBreak closed
// that hole and this is where an administrator fills it in.
//
// SAVING A LOV DELETES PUBLISHED LESSONS, AND THIS PAGE SAYS SO OUT LOUD.
//
// That is the whole reason the create and update calls are not plain CRUD.
// Entering a sportlov throws away a week of pupils' calendar lessons; the
// endpoint answers with how many it took (src/resources/school-breaks.service.ts,
// removeLessonsInside) and the count is printed in a live region that stays on
// screen. Three cheaper designs were rejected:
//
//   * a toast alone — sonner dismisses itself after a few seconds, and "42
//     lektioner togs bort" is not a thing to say once and let scroll away;
//   * saying nothing and letting the calendar show it — an absent lesson looks
//     exactly like a lesson nobody ever scheduled, so the deletion would be
//     discovered by a teacher standing in an empty classroom;
//   * a confirm step that names the count first — the count cannot be known
//     before the write, because the same three protection rules (future, still
//     SCHEDULED, no attendance) are applied inside the transaction. A dialog
//     guessing at it would be a second opinion, and the wrong one.
//
// The toast is kept as well, because it is what fires when focus is inside the
// dialog that just closed; the panel is what is still there afterwards.
//
// WHAT AN EDIT CANNOT DO is put lessons back. Narrowing a lov from a week to a
// day, or from the whole school to åk 9, does not restore what the wider
// version deleted — they were rows, not a view. The dialog says that before it
// saves, which is the only place it can be said.
//
// CONTRAST, MEASURED. Recomputed from the HSL tokens in app/globals.css rather
// than copied from a neighbouring page's comment, rounded to 8-bit the way a
// browser paints them. Light theme first, then dark:
//
//   foreground on background       18.69 / 16.36   AAA — intro, hints, labels
//   foreground on card             18.69 / 15.43   AAA — every table cell
//   foreground on muted            17.00 / 13.19   AAA — the dialog's warning
//   secondary-fg on secondary      16.12 / 13.19   AAA — the "Lov" badge
//   foreground on card (outline)   18.69 / 15.43   AAA — the "Studiedag" badge
//   destructive on card             4.80 /  4.59   over 4.5 — the notice icon
//   muted-fg on the muted circle    4.40 /  5.28   see below — empty state
//   border on card                  1.27 /  1.23   carries nothing, see below
//
// So AAA for every piece of text this page writes. `muted-foreground` is kept
// off it as text entirely, the way admin/gaps does: PageHeader's subtitle slot
// and EmptyState's description slot are left empty and the same sentences are
// written as our own paragraphs, and TableHead's muted default is overridden
// back to `foreground`. The token measures 4.83 / 6.17 on card — AA, and short
// of 7:1 — and it is the product's secondary text colour on every page there
// is, so moving it is a palette change rather than this file's business.
//
// `text-destructive` appears exactly once, on the removal notice's
// TriangleAlert, and it is on `bg-card` rather than `bg-muted` for a measured
// reason: the same token is 4.36 / 3.92 on muted, which fails. That is what
// decided the notice's background. A destructive TINT for the notice
// (`bg-destructive/10` with a `border-destructive/30`) was tried and dropped —
// the border measures 1.60 / 1.43, a graphical object below 3:1 doing no work,
// and the alarm belongs to the sentence rather than to a colour. The row's bin
// icon is NOT red either; see the comment on it for the three states that
// decided that.
//
// The empty-state icon is the shared component's `muted-foreground` on its
// muted circle. 4.40 in light is under 4.5 and above SC 1.4.11's 3:1; it is
// decoration beside a heading that says the same thing, and it is
// components/ui/empty-state.tsx, painted product-wide. Recorded rather than
// rounded up. `border` at 1.27 / 1.23 is likewise decoration throughout — the
// table and the notice are already marked off by their fill.
//
// Nothing here has met a real screen reader or axe: the route is behind a
// Supabase session and e2e/a11y.spec.ts scans public routes only.
//
// TILLGODORÄKNAD TID SITS NEXT TO THE DAYS IT USUALLY BELONGS TO. A
// friluftsdag is most often entered here as a lov for åk 7–9 — the timetable
// stops, nothing is published — and then the school decides whether the day
// counts as undervisningstid: Skolinspektionen's finding is that most schools
// never have. Each break row offers "Räkna tid för dagen", which opens the
// credit dialog on that day (components/timplan/credit-dialog.tsx, fetched
// with lazy() the first time), and a credit dated inside a break is said
// under it ("Räknas som 300 min Idrott och hälsa, åk 7–9"). The section
// below the table lists every credit of the year, whether or not a lov
// covers its day. Credits are dated, so they stay with their year; the
// rollover carries the lov and not the decisions.

import { Suspense, lazy, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarOff, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import {
  useAcademicYears,
  useGroups,
  useSchoolBreakActions,
  useSchoolBreaks,
  useSubjects,
} from "@/lib/queries";
import {
  creditsInside,
  useTimplanCreditActions,
  useTimplanCredits,
  type TimplanCredit,
} from "@/lib/timplan-credit-queries";
import type { BreakKind, SchoolBreak } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import { EmptyState } from "@/components/ui/empty-state";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const KINDS: BreakKind[] = ["HOLIDAY", "STAFF_DAY"];

/*
 * The credit dialog, fetched on its first open. A chunk that does not arrive
 * is caught by a DialogLoadBoundary, said in a toast, the dialog closed and
 * the lazy wrapper made again, so the next open fetches afresh rather than
 * the error climbing to the root (the app has no error.tsx).
 */
const lazyCreditDialog = () =>
  lazy(() => import("@/components/timplan/credit-dialog").then((module) => ({ default: module.CreditDialog })));
let CreditDialog = lazyCreditDialog();

/** The credit dialog's state: closed, or open on a credit or a day. */
interface CreditDialogState {
  open: boolean;
  editing: TimplanCredit | null;
  prefill: { name: string; date: string } | null;
}

/**
 * Whether the break carries a year span at all.
 *
 * One select rather than the Tabs pair admin/constraints uses for its
 * recurring/date choice: this page already mounts Select for the kind and both
 * year bounds, and a second Radix primitive on a route with a 190KB budget buys
 * nothing the same control does not.
 */
type Scope = "school" | "grades";

interface BreakForm {
  name: string;
  kind: BreakKind;
  startDate: string;
  endDate: string;
  scope: Scope;
  /** Held whatever the scope says; only SENT when `scope` is "grades". */
  minGradeLevel: number;
  maxGradeLevel: number;
}

const EMPTY_FORM: BreakForm = {
  name: "",
  kind: "HOLIDAY",
  startDate: "",
  endDate: "",
  scope: "school",
  // The lower stage, which is the span a studiedag most often covers. Only
  // reachable once somebody switches the scope away from "hela skolan", so
  // these are never sent by accident.
  minGradeLevel: 0,
  maxGradeLevel: 6,
};

/** What the last write did, kept on screen rather than in a toast. */
interface RemovalNotice {
  name: string;
  removed: number;
}

export default function BreaksPage() {
  const t = useTranslations("breaks");
  const tCommon = useTranslations("common");
  const tGrades = useTranslations("grades");

  const {
    data: years,
    isLoading: yearsLoading,
    isError: yearsFailed,
  } = useAcademicYears();
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  // The same fallback the timplan uses: the picker wins, then the active year,
  // then whatever the school has. A page that showed a different year from the
  // one whose hours it feeds would be worse than useless.
  const activeYearId =
    selectedYearId ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;

  const {
    data: breaks,
    isLoading: breaksLoading,
    isError: breaksFailed,
  } = useSchoolBreaks(activeYearId);

  const mutations = useSchoolBreakActions();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SchoolBreak | null>(null);
  const [deleting, setDeleting] = useState<SchoolBreak | null>(null);
  const [form, setForm] = useState<BreakForm>(EMPTY_FORM);
  const [notice, setNotice] = useState<RemovalNotice | null>(null);

  const { data: credits, isError: creditsFailed } = useTimplanCredits(activeYearId);
  const creditActions = useTimplanCreditActions();
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const [creditDialog, setCreditDialog] = useState<CreditDialogState>({
    open: false,
    editing: null,
    prefill: null,
  });
  // Mounted from its first open onward, so lazy() fetches nothing before it.
  const [creditDialogUsed, setCreditDialogUsed] = useState(false);
  const [creditDialogLoad, setCreditDialogLoad] = useState(0);
  const [deletingCredit, setDeletingCredit] = useState<TimplanCredit | null>(null);
  const openCredit = (editing: TimplanCredit | null, prefill: CreditDialogState["prefill"] = null) => {
    setCreditDialogUsed(true);
    setCreditDialog({ open: true, editing, prefill });
  };
  const sortedCredits = useMemo(
    () => [...(credits ?? [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1)),
    [credits],
  );
  const subjectById = useMemo(() => new Map((subjects ?? []).map((subject) => [subject.id, subject])), [subjects]);
  const yearGroups = useMemo(
    () => (groups ?? []).filter((group) => group.academicYearId === activeYearId),
    [groups, activeYearId],
  );

  const year = useMemo(
    () => years?.find((entry) => entry.id === activeYearId) ?? null,
    [years, activeYearId],
  );

  /**
   * The notice describes a write against the year it was made in. Left up while
   * the picker moves, "Sportlov sparat. 42 lektioner togs bort" would sit above
   * a list of a different läsår's lov and read as a claim about that one.
   */
  const pickYear = (value: string) => {
    setSelectedYearId(value);
    setNotice(null);
  };

  /**
   * Neither in flight nor given up.
   *
   * The same two gates admin/requirements grew, for the same reason and against
   * a smaller lie: an empty list here reads as "this school has no lov", which
   * is a claim about how the läsår is set up and one an admin would act on by
   * entering them all a second time. `isLoading` is `isPending && isFetching`,
   * so a query that has failed is data-less and NOT loading and would fall
   * straight through a loading check into the empty state.
   */
  const loading = yearsLoading || breaksLoading;
  const failed = yearsFailed || breaksFailed;

  /** "Åk 4–6", "Åk 5", or the whole school. */
  const gradeLabel = (schoolBreak: SchoolBreak): string => {
    const { minGradeLevel: min, maxGradeLevel: max } = schoolBreak;
    if (min === null || max === null) return t("gradeAll");
    return min === max
      ? tGrades("grade", { grade: min })
      : t("gradeRange", { min, max });
  };

  /** Whom a credit reaches: the whole school, an årskurs span, or one group. */
  const creditScopeLabel = (credit: TimplanCredit): string => {
    if (credit.studentGroupId !== null) {
      return yearGroups.find((group) => group.id === credit.studentGroupId)?.name ?? credit.studentGroupId;
    }
    const { minGradeLevel: min, maxGradeLevel: max } = credit;
    if (min === null || max === null) return t("gradeAll");
    return min === max ? tGrades("grade", { grade: min }) : t("gradeRange", { min, max });
  };
  /**
   * The credit's subject for the table: "Utan ämne" for none (Täckning's
   * word for the line), marked when it does not count. The dialog's long
   * "Inget ämne — räknas som undervisningstid" is a choice, not a label.
   */
  const creditSubjectLabel = (credit: TimplanCredit): string => {
    if (credit.subjectId === null) return t("credits.subjectNoneShort");
    const subject = subjectById.get(credit.subjectId);
    if (!subject) return "–";
    return subject.countsTowardTimplan === false ? `${subject.name} (${t("credits.notCounted")})` : subject.name;
  };
  /** The sentence under a lov: "Räknas som 300 min Idrott och hälsa, åk 7–9", or why it does not count. */
  const creditUnderBreak = (credit: TimplanCredit): string => {
    const scope = creditScopeLabel(credit);
    if (credit.subjectId === null) {
      return t("credits.countsAs", { minutes: credit.minutes, subject: t("credits.subjectNoneInline"), scope });
    }
    const subject = subjectById.get(credit.subjectId);
    if (subject?.countsTowardTimplan === false) {
      return t("credits.countsAsNotCounted", { minutes: credit.minutes, subject: subject.name, scope });
    }
    return t("credits.countsAs", { minutes: credit.minutes, subject: subject?.name ?? "–", scope });
  };

  const confirmDeleteCredit = async () => {
    if (!deletingCredit) return;
    try {
      await creditActions.remove.mutateAsync(deletingCredit.id);
      toast.success(tCommon("deleted"));
      setDeletingCredit(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  /**
   * "2026-10-26 – 2026-10-30", or a single date for a one-day studiedag.
   *
   * ISO throughout rather than a locale format. Both columns are DATE and both
   * arrive as YYYY-MM-DD from either door (lib/types.ts, SchoolBreak), so
   * printing them as they are cannot introduce the off-by-one-day that parsing
   * them into a Date and formatting them locally invites — which for a lov is
   * a week of lessons deleted one day out from the week that was meant.
   */
  const rangeLabel = (schoolBreak: SchoolBreak): string =>
    schoolBreak.startDate === schoolBreak.endDate
      ? schoolBreak.startDate
      : `${schoolBreak.startDate} – ${schoolBreak.endDate}`;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (schoolBreak: SchoolBreak) => {
    setEditing(schoolBreak);
    setForm({
      name: schoolBreak.name,
      kind: schoolBreak.kind,
      startDate: schoolBreak.startDate,
      endDate: schoolBreak.endDate,
      scope: schoolBreak.minGradeLevel === null ? "school" : "grades",
      minGradeLevel: schoolBreak.minGradeLevel ?? 0,
      maxGradeLevel: schoolBreak.maxGradeLevel ?? 6,
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    if (!activeYearId) return;
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      startDate: form.startDate,
      endDate: form.endDate,
      // All or nothing. The table CHECKs the pair and the service refuses half
      // of it, because "från åk 4" with no upper bound could mean 4-9 or could
      // be a form nobody finished — and the two differ by however many classes
      // lose a week of lessons.
      minGradeLevel: form.scope === "grades" ? form.minGradeLevel : null,
      maxGradeLevel: form.scope === "grades" ? form.maxGradeLevel : null,
    };
    try {
      const saved = editing
        ? await mutations.update.mutateAsync({ id: editing.id, ...body })
        : await mutations.create.mutateAsync({ academicYearId: activeYearId, ...body });
      // Read off the ANSWER, not off `body`: the name that goes into the
      // sentence is the one the row now holds, and the count is a fact only the
      // server had.
      setNotice({ name: saved.name, removed: saved.removedCalendarLessons });
      toast.success(editing ? tCommon("updated") : tCommon("created"));
      setDialogOpen(false);
    } catch (error) {
      // Whatever the API refused, in its own words — the range must fall inside
      // the läsår, and a copy of that rule here would be a second opinion that
      // goes stale. Same reasoning as admin/requirements' period fields.
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await mutations.remove.mutateAsync(deleting.id);
      // Cleared, not replaced: the panel says what a save removed, and removing
      // the lov does not put those lessons back. Leaving the old sentence up
      // next to a list the row has just left would read as if it did.
      setNotice(null);
      toast.success(tCommon("deleted"));
      setDeleting(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  /**
   * What can be sent at all. Ordering of the two dates is checked because a
   * backwards range is never what anybody meant and the answer is instant;
   * whether they fall inside the läsår is NOT checked here, on purpose (see
   * submit).
   */
  const formValid =
    form.name.trim() !== "" &&
    form.startDate !== "" &&
    form.endDate !== "" &&
    form.startDate <= form.endDate;

  const saving = mutations.create.isPending || mutations.update.isPending;

  return (
    <div>
      <PageHeader
        title={t("title")}
        actions={
          <>
            {years && years.length > 0 ? (
              <Select value={activeYearId ?? undefined} onValueChange={pickYear}>
                {/*
                  Its value is the year, so an unnamed trigger announces as
                  "2026/2027, combobox" beside an "Lägg till"-button — the same
                  problem the timplan's picker had, and the same fix.
                */}
                <SelectTrigger className="w-44" aria-label={t("yearLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button onClick={openCreate} disabled={!activeYearId}>
              <Plus />
              {t("addBreak")}
            </Button>
          </>
        }
      />

      {/*
        PageHeader's subtitle slot is muted-foreground (4.83 / 6.17 — AA, not
        AAA), so the standfirst is a paragraph of ours. max-w-prose caps the
        measure at about 65 characters and leading-relaxed gives the 1.5 line
        spacing AAA asks for; the app's default text-sm leading is 1.43.
      */}
      <p className="-mt-4 mb-4 max-w-prose text-sm leading-relaxed text-foreground">
        {t("intro")}
      </p>

      {/*
        Mounted from the first render, empty.

        A live region added to the DOM together with its text is not announced
        by most screen readers — the region has to be there for the change to be
        a change. aria-atomic because the sentence only means anything whole:
        "42" on its own is not an answer to anything.
      */}
      <div role="status" aria-live="polite" aria-atomic="true" className="mb-4">
        {notice ? (
          <div className="flex max-w-prose items-start gap-2.5 rounded-lg border bg-card px-4 py-3 text-sm leading-relaxed text-foreground">
            {notice.removed > 0 ? (
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            ) : null}
            <span>
              {notice.removed > 0
                ? t("removedLessons", { name: notice.name, count: notice.removed })
                : t("removedNone", { name: notice.name })}
            </span>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : failed ? (
        <>
          <EmptyState icon={TriangleAlert} title={t("loadFailed")} />
          <p className="mx-auto mt-3 max-w-prose text-center text-sm leading-relaxed text-foreground">
            {t("loadFailedHint")}
          </p>
        </>
      ) : !activeYearId ? (
        /*
          A claim about how the school is set up, and only true once the läsår
          list has actually answered and held nothing — both other ways of not
          knowing are taken above.
        */
        <EmptyState icon={CalendarOff} title={t("noYear")} />
      ) : !breaks || breaks.length === 0 ? (
        <>
          {/*
            Title only; EmptyState's description slot is muted-foreground. The
            hint is the honest half — an empty list is not neutral, it means the
            timplan is counting every calendar week as taught.
          */}
          <EmptyState icon={CalendarOff} title={tCommon("noResults")} />
          <p className="mx-auto mt-3 max-w-prose text-center text-sm leading-relaxed text-foreground">
            {t("empty")}
          </p>
        </>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            {/*
              Table navigation lands inside the grid, past the paragraph above
              that says what these rows do to the calendar.
            */}
            <caption className="sr-only">{t("tableCaption")}</caption>
            <TableHeader>
              {/*
                text-foreground on all of them: TableHead's own base class is
                text-muted-foreground, AA and short of the 7:1 this page holds
                to. Overridden here rather than in table.tsx, which every page
                in the product paints with.
              */}
              <TableRow>
                <TableHead scope="col" className="text-foreground">
                  {tCommon("name")}
                </TableHead>
                <TableHead scope="col" className="text-foreground">
                  {tCommon("type")}
                </TableHead>
                <TableHead scope="col" className="text-foreground">
                  {tCommon("date")}
                </TableHead>
                <TableHead scope="col" className="text-foreground">
                  {t("gradeSpan")}
                </TableHead>
                <TableHead scope="col" className="w-32 text-right text-foreground">
                  {tCommon("actions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/*
                In the order the query returned them, earliest first. Not
                re-sorted here: useSchoolBreaks orders by startDate and so does
                the API's own list, and a third opinion about the order is a
                third place for it to drift.
              */}
              {breaks.map((schoolBreak) => (
                <TableRow key={schoolBreak.id}>
                  <TableCell className="font-medium text-foreground">
                    {schoolBreak.name}
                    {creditsInside(sortedCredits, schoolBreak).map((credit) => (
                      <span key={credit.id} className="block text-xs font-normal leading-relaxed">
                        {creditUnderBreak(credit)}
                      </span>
                    ))}
                  </TableCell>
                  <TableCell>
                    {/*
                      The word is the label — "Lov" and "Studiedag" — so the
                      badge's colour is not carrying the distinction on its own.
                      secondary measures 16.12 / 13.19 and outline inherits
                      `foreground` on the card at 18.69 / 15.43.
                    */}
                    <Badge
                      variant={schoolBreak.kind === "HOLIDAY" ? "secondary" : "outline"}
                    >
                      {t(schoolBreak.kind === "HOLIDAY" ? "kindHoliday" : "kindStaffDay")}
                    </Badge>
                  </TableCell>
                  <TableCell className="tabular-nums text-foreground">
                    {rangeLabel(schoolBreak)}
                  </TableCell>
                  <TableCell className="text-foreground">
                    {gradeLabel(schoolBreak)}
                  </TableCell>
                  <TableCell className="text-right">
                    {/*
                      Both controls are icon-only, so both carry the row's name
                      as well as the verb — "Redigera" repeated down a column of
                      six lov names nothing.

                      NEITHER ICON IS PAINTED `text-destructive`, and dropping
                      it from the bin was a measurement rather than a taste.
                      At rest on the card the token is 4.80 / 4.59, which
                      clears the 4.5:1 a graphic is held to here — but a glyph
                      inherits currentColor through every state its ancestors
                      have, and this one has two: the row's own
                      `hover:bg-muted/50` takes it to 4.60 / 4.25 and the ghost
                      button's `hover:bg-accent` to 4.15 / 3.84. Both fail in
                      dark, on the control that deletes. Inherited, the bin is
                      `foreground` — 18.69 / 15.43 at rest, 17.90 / 14.30 on
                      the row, and `accent-foreground` at 9.79 / 7.33 once the
                      button lights up. The bin glyph and the aria-label carry
                      the meaning; the red was carrying emphasis only, and it
                      was carrying it at a contrast a reader with low vision
                      could not see. admin/constraints still paints its bin red
                      — same tokens, same three states, worth fixing there too.
                    */}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        openCredit(null, { name: schoolBreak.name, date: schoolBreak.startDate })
                      }
                      aria-label={t("credits.addForDayNamed", { name: schoolBreak.name })}
                      title={t("credits.addForDay")}
                    >
                      <Plus />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(schoolBreak)}
                      aria-label={t("editNamed", { name: schoolBreak.name })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleting(schoolBreak)}
                      aria-label={t("deleteNamed", { name: schoolBreak.name })}
                    >
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {activeYearId && !loading && !failed ? (
        <section aria-labelledby="credits-title" className="mt-8 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="credits-title" className="text-lg font-semibold text-foreground">
              {t("credits.title")}
            </h2>
            <Button variant="outline" onClick={() => openCredit(null)}>
              <Plus />
              {t("credits.add")}
            </Button>
          </div>
          <p className="max-w-prose text-sm leading-relaxed text-foreground">{t("credits.intro")}</p>
          {creditsFailed ? (
            <p className="text-sm text-foreground">{t("credits.loadFailed")}</p>
          ) : sortedCredits.length === 0 ? (
            <p className="text-sm text-foreground">{t("credits.empty")}</p>
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <caption className="sr-only">{t("credits.title")}</caption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="text-foreground">{tCommon("date")}</TableHead>
                    <TableHead scope="col" className="text-foreground">{tCommon("name")}</TableHead>
                    <TableHead scope="col" className="text-right text-foreground">{t("credits.minutes")}</TableHead>
                    <TableHead scope="col" className="text-foreground">{t("credits.subject")}</TableHead>
                    <TableHead scope="col" className="text-foreground">{t("credits.scope")}</TableHead>
                    <TableHead scope="col" className="text-foreground">{t("credits.note")}</TableHead>
                    <TableHead scope="col" className="w-24 text-right text-foreground">
                      {tCommon("actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedCredits.map((credit) => (
                    <TableRow key={credit.id}>
                      <TableCell className="tabular-nums text-foreground">{credit.date}</TableCell>
                      <TableCell className="font-medium text-foreground">{credit.name}</TableCell>
                      <TableCell className="text-right tabular-nums text-foreground">{credit.minutes}</TableCell>
                      <TableCell className="text-foreground">{creditSubjectLabel(credit)}</TableCell>
                      <TableCell className="text-foreground">{creditScopeLabel(credit)}</TableCell>
                      <TableCell className="max-w-64 text-foreground">{credit.note ?? ""}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openCredit(credit)}
                          aria-label={t("editNamed", { name: credit.name })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeletingCredit(credit)}
                          aria-label={t("deleteNamed", { name: credit.name })}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      ) : null}

      {creditDialogUsed && year ? (
        <DialogLoadBoundary
          key={creditDialogLoad}
          onError={(error) => {
            toast.error(error instanceof Error ? error.message : tCommon("error"));
            CreditDialog = lazyCreditDialog();
            setCreditDialog((current) => ({ ...current, open: false }));
            setCreditDialogUsed(false);
            setCreditDialogLoad((attempt) => attempt + 1);
          }}
        >
        <Suspense fallback={null}>
          <CreditDialog
            open={creditDialog.open}
            onOpenChange={(open) => setCreditDialog((current) => ({ ...current, open }))}
            year={year}
            breaks={breaks ?? []}
            subjects={subjects ?? []}
            groups={yearGroups}
            editing={creditDialog.editing}
            prefill={creditDialog.prefill}
          />
        </Suspense>
        </DialogLoadBoundary>
      ) : null}

      <ConfirmDialog
        open={deletingCredit !== null}
        onOpenChange={(open) => !open && setDeletingCredit(null)}
        title={tCommon("deleteConfirmTitle", { name: deletingCredit?.name ?? "" })}
        description={t("credits.deleteBody")}
        confirmLabel={tCommon("delete")}
        loading={creditActions.remove.isPending}
        onConfirm={confirmDeleteCredit}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editBreak") : t("addBreak")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="break-name">{tCommon("name")}</Label>
                <Input
                  id="break-name"
                  value={form.name}
                  placeholder={t("namePlaceholder")}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{tCommon("type")}</Label>
                <Select
                  value={form.kind}
                  onValueChange={(value) => setForm({ ...form, kind: value as BreakKind })}
                >
                  <SelectTrigger aria-label={tCommon("type")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {t(kind === "HOLIDAY" ? "kindHoliday" : "kindStaffDay")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="break-start">{t("startDate")}</Label>
                {/*
                  min/max are the läsår's own bounds, so the picker opens on the
                  right months instead of on today. They are an affordance and
                  not a check — the refusal still comes from the API, which is
                  the only place that knows the year the id names.
                */}
                <DateField
                  label={t("startDate")}
                  id="break-start"
                  min={year?.startDate}
                  max={year?.endDate}
                  value={form.startDate}
                  onChange={(value) => setForm({ ...form, startDate: value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="break-end">{t("endDate")}</Label>
                <DateField
                  label={t("endDate")}
                  id="break-end"
                  min={year?.startDate}
                  max={year?.endDate}
                  value={form.endDate}
                  onChange={(value) => setForm({ ...form, endDate: value })}
                />
              </div>
            </div>
            <p className="text-xs leading-relaxed text-foreground">{t("datesHint")}</p>

            <div className="space-y-2">
              <Label>{t("scope")}</Label>
              <Select
                value={form.scope}
                onValueChange={(value) => setForm({ ...form, scope: value as Scope })}
              >
                <SelectTrigger aria-label={t("scope")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="school">{t("scopeSchool")}</SelectItem>
                  <SelectItem value="grades">{t("scopeGrades")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/*
              Shown only for the narrowed scope, and that is where "hela skolan"
              lives — one field up, as the scope itself. `allowAll` inside the
              span would be a second way to say it, and the two could then
              disagree about a lov that deletes lessons.
            */}
            {form.scope === "grades" ? (
              <GradeSpanField
                label={t("gradeSpan")}
                fromLabel={t("gradeFromLabel")}
                toLabel={t("gradeToLabel")}
                min={form.minGradeLevel}
                max={form.maxGradeLevel}
                onChange={({ min, max }) =>
                  setForm({ ...form, minGradeLevel: min, maxGradeLevel: max })
                }
                hint={t("gradeHint")}
                // 7:1, as everything else this page prints small.
                hintClassName="text-xs leading-relaxed text-foreground"
              />
            ) : null}

            {/*
              Said before the save, because afterwards is too late for the half
              of it that cannot be undone. `bg-muted` with `text-foreground`
              measures 17.00 / 13.19 — the same box admin/requirements' import
              dialog uses for the sentence it must not let anybody miss.
            */}
            <p className="rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-foreground">
              {t("deletesWarning")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={submit} disabled={!formValid || saving}>
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tCommon("deleteConfirmTitle", { name: deleting?.name ?? "" })}
        // Not tCommon("deleteConfirmBody"). "Åtgärden kan inte ångras" is true
        // of the row and says nothing about the part that matters: taking the
        // lov away does not bring back the lessons entering it deleted.
        description={t("deleteBody")}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
