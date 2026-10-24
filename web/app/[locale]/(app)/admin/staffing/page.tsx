"use client";

// Tjänstefördelningen: who carries how many minutes a week, against what.
//
// Every leader allocates teaching to teachers BEFORE it timetables and shows
// Soll/Ist — Skola24's Tjänst %/*Planerad tjänst, Untis' Plan/week and Percent
// of target, Lectio's one bar per teacher. This page is that layer for
// SchemaPro. The numbers come from GET /staffing/load (computed by the gateway
// in one RLS transaction).
//
// A WORKSPACE SINCE FAS 2, not a report. An unstaffed row is staffed from the
// "Obemannade rader" panel (Föreslå lärare: the gateway's ranking, one click
// assigns), a row is handed on from the teacher's drawer, and the drawer holds
// the teacher's uppdrag. Every one of those writes is a PATCH of the
// timplanspost's teacherId, which the gateway checks against the policy in
// the write's own transaction: WARN saves and comes back with `warnings`,
// shown where the click was (the panel, the drawer's card), naming the row;
// REFUSE is a 409 shown there too. The matrix itself stays read-only — a cell sums several groups,
// so it cannot say which row a click would mean.
//
// TWO TOGGLES, BOTH ABOUT WHAT A NUMBER MEANS. Standardvecka / Toppvecka
// because "minutes per week" is two numbers the moment a school has an
// odd-week slöjd or a term course, and Skola24 changed its own definition in
// 2025-12 over exactly that; both are shown rather than one chosen. Minuter /
// % av anställning because the second is the SCB figure (tjänsteomfattning
// per ämne) a rektor fills into the Pedagogisk personal return every October,
// and reading it off a minutes matrix by hand is how it comes out wrong.
//
// THE EMPTY RIKTMÄRKE IS A STATE, NOT AN ERROR. The agreement fixes no weekly
// teaching measure, so a school that has not chosen one gets every row as
// NO_TARGET and a notice pointing at the settings card — never a default of
// 1 080 slipped in, which would be a number nobody chose.
//
// LAST YEAR, WHEN THERE IS ONE (staffing Fas 5). A year rolled from another
// gets a third toggle, "Matris | Jämför med förra läsåret": per teacher, last
// year's tjänst and counted minutes beside this year's (year-comparison.tsx).
// And a year rolled WITHOUT its tjänster — before Fas 5, or with the wizard's
// switch off — gets one notice offering to carry them from the predecessor
// (staffing-carry-dialog.tsx), shown only while this year has no post and no
// uppdrag at all and last year has at least one of either: a school that
// rolls but never enters tjänster is not nagged forever, and one that has
// started by hand is not told to start over. Both are React.lazy, as the drawer is.
//
// A PROPOSAL, WHEN ASKED FOR (staffing Fas 4). "Föreslå bemanning" in the
// header opens staffing-proposal-dialog.tsx, React.lazy like the rest: the
// engine proposes a lead for the rows to be staffed, the admin applies what
// they keep, and undoes from the toast. /admin/generate's staffing line links
// here with #propose, which opens it once the report has drawn. A school that
// never presses the button reads and writes exactly what it did before.
//
// The settings card lives on THIS page, behind the settings button, rather
// than on tillgänglighet beside the lunch card it is built like: the lunch
// card's reader is the solver, this card's only reader is the matrix above
// it, and the notice about the missing riktmärke has to be able to point at
// the field without a page change. See staffing-policy-card.tsx.

import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Grid3x3, Settings2, Sparkles, Users } from "lucide-react";
import { Link } from "@/i18n/navigation";
import {
  useAcademicYears,
  useGroups,
  usePeople,
  useRequirements,
  useSubjects,
} from "@/lib/queries";
import {
  useStaffingLoad,
  useStaffingPolicy,
  useTeacherDuties,
  useTeacherEmployments,
  useTeacherQualifications,
} from "@/lib/staffing-queries";
import { travelOf } from "@/lib/staffing-travel";
import { sharesByRequirement, useRequirementShares } from "@/lib/requirement-shares";
import { kpis, type UnitView, type WeekView } from "@/lib/staffing-view";
import { NextStep } from "@/components/layout/next-step";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { YearSelect } from "@/components/schedule/year-select";
import { BottlenecksPanel } from "@/components/staffing/bottlenecks-panel";
import { StaffingMatrix } from "@/components/staffing/staffing-matrix";
import { UnstaffedPanel } from "@/components/staffing/unstaffed-panel";
import { StaffingPolicyCard } from "@/components/staffing/staffing-policy-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfile } from "@/components/profile-context";
import { profileDecides } from "@/lib/admin-areas";

/**
 * The drawer is click-opened, so it is React's lazy() — not next/dynamic,
 * whose loader runtime costs 1.4KB of its own (see admin/people). Measured
 * 2026-10-07 with Fas 2's cards in it (uppdrag, timplansposter, the ranked
 * suggestions): 188.0KB own JS static, 175.6KB lazy, and no other route moved
 * by more than ±0.1KB — so the re-slicing P1 paid for a lazy dialog did not
 * happen here. Nothing lazy is reachable during SSR: no teacher is open on
 * the first render.
 */
const TeacherDrawer = lazy(() =>
  import("@/components/staffing/teacher-drawer").then((module) => ({
    default: module.TeacherDrawer,
  })),
);

/**
 * Click-opened like the drawer: the carry, and last year beside this one.
 * Measured 2026-10-07 against fa4a3d6's 176.5KB own JS: the two lazy imports,
 * the toggle, the notice and the predecessor's employments query cost the
 * page 0.5KB (177.0KB); the dialog, the summary, the comparison and its join
 * load on the click. The two uppdrag reads the notice gained after review
 * (a school with uppdrag but no tjänster) left it at 177.0KB.
 */
const StaffingCarryDialog = lazy(() =>
  import("./staffing-carry-dialog").then((module) => ({ default: module.StaffingCarryDialog })),
);
const YearComparison = lazy(() =>
  import("./year-comparison").then((module) => ({ default: module.YearComparison })),
);
/**
 * Föreslå bemanning (staffing Fas 4), click-opened like the carry: the
 * dialog, its two mutations and the selection arithmetic load on the click.
 */
const StaffingProposalDialog = lazy(() =>
  import("./staffing-proposal-dialog").then((module) => ({ default: module.StaffingProposalDialog })),
);

type PageView = "matrix" | "compare";

/** The hash /admin/generate links with to open Föreslå bemanning. */
const PROPOSE_HASH = "propose";

export default function StaffingPage() {
  const t = useTranslations("staffing");
  const tNav = useTranslations("nav");
  const { data: years, isLoading: yearsLoading, isError: yearsFailed } = useAcademicYears();
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  // ?year= from /admin/generate's links, which plan a rolled year not yet
  // activated, read once after mount as lib/planning-year.ts reads it (not
  // with useSearchParams, which would opt the route out of static rendering).
  // No year until it is read, so the active year's report is never fetched
  // to be thrown away — nor #propose opened on it.
  const [linked, setLinked] = useState<{ id: string | null } | null>(null);
  useEffect(() => setLinked({ id: new URLSearchParams(window.location.search).get("year") }), []);
  const linkedYearId = years?.some((year) => year.id === linked?.id) ? linked!.id : null;
  const activeYearId =
    linked === null
      ? null
      : (selectedYearId ?? linkedYearId ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null);
  const activeYear = years?.find((year) => year.id === activeYearId) ?? null;
  /** The year this one was rolled from, when the list holds it. */
  const predecessor = years?.find((year) => year.id === activeYear?.predecessorId) ?? null;

  const { data: report, isLoading: reportLoading, isError: reportFailed } =
    useStaffingLoad(activeYearId);
  const { data: policy } = useStaffingPolicy();
  const { data: subjects, isLoading: subjectsLoading, isError: subjectsFailed } = useSubjects();
  const { data: people } = usePeople();
  const { data: groups } = useGroups();
  const { data: requirements } = useRequirements(activeYearId);
  // Delade lektioner: each post's shares beside it, from the gateway, so the
  // matrix's groups and a teacher's card name the posts they take lessons of.
  const { data: shareRows, isError: sharesFailed } = useRequirementShares(activeYearId);
  const sharesOfPost = useMemo(() => sharesByRequirement(shareRows), [shareRows]);
  const sharedRequirements = useMemo(
    () =>
      (requirements ?? []).map((row) => (sharesOfPost.has(row.id) ? { ...row, shares: sharesOfPost.get(row.id) } : row)),
    [requirements, sharesOfPost],
  );
  const { data: employments } = useTeacherEmployments(activeYearId);
  const { data: predecessorEmployments } = useTeacherEmployments(predecessor?.id ?? null);
  const { data: duties } = useTeacherDuties(predecessor ? activeYearId : null);
  const { data: predecessorDuties } = useTeacherDuties(predecessor?.id ?? null);
  const { data: qualifications } = useTeacherQualifications();

  const [week, setWeek] = useState<WeekView>("standard");
  const [unit, setUnit] = useState<UnitView>("minutes");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openTeacherId, setOpenTeacherId] = useState<string | null>(null);
  const [chosenView, setView] = useState<PageView>("matrix");
  const [carryOpen, setCarryOpen] = useState(false);
  const me = useProfile().profile;
  const decides = profileDecides(me?.adminProfile === undefined ? "FULL" : me.adminProfile);
  /**
   * Open, and mounted: the dialog stays mounted once opened, because the
   * applied toast's Ångra calls into it after it has closed.
   */
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposeMounted, setProposeMounted] = useState(false);
  const openPropose = () => {
    setProposeMounted(true);
    setProposeOpen(true);
  };
  const view: PageView = predecessor ? chosenView : "matrix";
  /**
   * Rolled without its tjänster: no post and no uppdrag here, some of either
   * last year (C10) — a school that keeps uppdrag but no tjänster is offered
   * it too, and a year that got one uppdrag (carried, or by hand) is not
   * offered a second run, which would bring back an uppdrag deleted since.
   */
  // Carrying tjänster is rektor's or a full administrator's (Roller i skolan).
  const offerCarry =
    decides &&
    predecessor !== null &&
    employments?.length === 0 &&
    duties?.length === 0 &&
    (predecessorEmployments?.length ?? 0) + (predecessorDuties?.length ?? 0) > 0;

  /**
   * One gate for every query a NUMBER is printed from — the report and the
   * subjects that name its columns. People, groups and requirements only feed
   * names and tooltips, and a late name is quiet where a late number is a
   * zero stated confidently (see admin/requirements for the argument).
   */
  const loading = linked === null || yearsLoading || reportLoading || subjectsLoading;
  const failed = yearsFailed || reportFailed || subjectsFailed;

  const personOf = useMemo(() => new Map((people ?? []).map((person) => [person.id, person])), [people]);
  const teacherName = (userId: string) => {
    const person = personOf.get(userId);
    if (person) return `${person.firstName} ${person.lastName}`;
    // A row the roster cannot name yet, or a teacher RLS hides: the
    // signature is the next best handle, and the id's head the last.
    const signature = employments?.find((row) => row.userId === userId)?.signature;
    return signature ?? userId.slice(0, 8);
  };
  const groupName = (groupId: string) =>
    groups?.find((group) => group.id === groupId)?.name ?? "—";
  /** The läsår's own groups: two years may both own a "7A". */
  const yearGroups = useMemo(
    () => (groups ?? []).filter((group) => group.academicYearId === activeYearId),
    [groups, activeYearId],
  );

  /*
   * A link INTO the page (/admin/generate's "N saknar" → #unstaffed) names a
   * section that only exists once the report has drawn. Next handles the hash
   * when the segment commits — over the skeleton — finds no target and gives
   * the hash up for good, so the admin landed at the top with the panel below
   * the whole matrix. Once, when the report first arrives: scroll there and
   * put focus on it, so a keyboard reader starts where the link said.
   */
  const hashHandled = useRef(false);
  useEffect(() => {
    if (!report || hashHandled.current) return;
    hashHandled.current = true;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    // /admin/generate's "Föreslå bemanning": a dialog, not a section.
    if (id === PROPOSE_HASH) {
      setProposeMounted(true);
      setProposeOpen(true);
      return;
    }
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  }, [report]);

  const figures = report ? kpis(report) : null;
  const noTarget = policy !== undefined && (policy === null || policy.fullTimeTeachingMinutesPerWeek === null);

  const openSettings = () => {
    setSettingsOpen(true);
    // After the card has mounted, bring it into view: the notice sits above
    // the matrix and the card below it.
    window.setTimeout(() => {
      // Smooth only for people who have not asked for less motion: CSS's
      // reduced-motion rule cannot reach a scroll started from script.
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      document
        .getElementById("staffing-policy")
        ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }, 0);
  };

  const openTeacher = openTeacherId ? personOf.get(openTeacherId) : undefined;
  const openLoad = report?.teachers.find((row) => row.userId === openTeacherId);

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <YearSelect value={activeYearId} label={t("yearLabel")} onValueChange={setSelectedYearId} />
            {/* Its first write is the proposal (optimization's areas); applying it is planering's too. */}
            <Button
              variant="outline"
              onClick={openPropose}
              disabled={!report || !activeYearId}
              data-writes="SCHEMALAGGNING DRIFT"
            >
              <Sparkles />
              {t("proposal.open")}
            </Button>
            <Button
              variant="outline"
              onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettings())}
              aria-expanded={settingsOpen}
              aria-controls="staffing-policy"
            >
              <Settings2 />
              {t("settings")}
            </Button>
          </>
        }
      />

      {loading ? (
        <Skeleton className="h-96 w-full" aria-busy="true" />
      ) : failed ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !activeYearId || !activeYear || !report ? (
        <EmptyState
          icon={Grid3x3}
          title={t("noYearTitle")}
          description={t("noYear")}
          headingLevel={2}
          action={
            <Button asChild variant="outline">
              <Link href="/admin/years">{t("noYearAction")}</Link>
            </Button>
          }
        />
      ) : (
        <>
          {noTarget ? (
            // foreground on muted: 17.00 / 13.19, AAA — the notice is a state
            // the whole page is in, not an error, so it is not painted red.
            <Notice
              title={t("noTargetTitle")}
              action={
                <Button variant="outline" size="sm" onClick={openSettings}>
                  {t("noTargetAction")}
                </Button>
              }
            >
              {t("noTargetBody")}
            </Notice>
          ) : null}

          {sharesFailed ? (
            // The matrix and the cards still read the rows; only the lessons
            // other teachers take of them are missing, which is said.
            <Notice tone="warning" title={t("sharesFailed")} />
          ) : null}

          {offerCarry && predecessor ? (
            <Notice
              title={t("carry.noticeTitle", { year: predecessor.name })}
              action={
                <Button variant="outline" size="sm" onClick={() => setCarryOpen(true)}>
                  {t("carry.noticeAction")}
                </Button>
              }
            >
              {t("carry.noticeBody", { year: activeYear.name, source: predecessor.name })}
            </Notice>
          ) : null}

          {figures ? (
            <KpiStrip>
              <KpiTile label={t("kpiUnstaffed")} value={figures.unstaffed} />
              {/* "Not recorded", never 0: a school that has entered no behörighet has not
                  zero unqualified assignments, it has no answer yet. */}
              <KpiTile
                label={t("kpiUnqualified")}
                value={figures.unqualified}
                fallback={t("kpiUnqualifiedNotRecorded")}
                title={figures.unqualified === null ? t("kpiUnqualifiedNotRecordedHint") : undefined}
              />
              <KpiTile label={t("kpiOverTarget")} value={figures.overTarget} />
              <KpiTile
                label={t("kpiBottlenecks")}
                value={figures.bottlenecks}
                fallback={t("kpiUnqualifiedNotRecorded")}
                title={figures.bottlenecks === null ? t("kpiBottlenecksNotComputedHint") : undefined}
              />
            </KpiStrip>
          ) : null}

          {/* The view toggles are filters on what the matrix shows: a FilterBar,
              each TabsList named by its aria-label. */}
          <FilterBar>
            {predecessor ? (
              <Tabs value={view} onValueChange={(value) => setView(value as PageView)}>
                <TabsList aria-label={t("compare.toggle")}>
                  <TabsTrigger value="matrix">{t("compare.matrix")}</TabsTrigger>
                  <TabsTrigger value="compare">{t("compare.withLastYear")}</TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
            {view === "matrix" ? (
              <>
                <Tabs value={week} onValueChange={(value) => setWeek(value as WeekView)}>
                  <TabsList aria-label={t("weekToggle")}>
                    <TabsTrigger value="standard">{t("weekStandard")}</TabsTrigger>
                    <TabsTrigger value="peak">{t("weekPeak")}</TabsTrigger>
                  </TabsList>
                </Tabs>
                <Tabs value={unit} onValueChange={(value) => setUnit(value as UnitView)}>
                  <TabsList aria-label={t("unitToggle")}>
                    <TabsTrigger value="minutes">{t("unitMinutes")}</TabsTrigger>
                    <TabsTrigger value="percent">{t("unitPercent")}</TabsTrigger>
                  </TabsList>
                </Tabs>
              </>
            ) : null}
          </FilterBar>
          {view === "matrix" ? (
            <p className="text-xs text-muted-foreground">
              {week === "peak" ? t("weekHintPeak") : t("weekHintStandard")}
              {unit === "percent"
                ? ` ${t(report.loadModel === "FACTOR" ? "unitHintPercentFactor" : "unitHintPercent")}`
                : ""}
            </p>
          ) : null}

          {view === "compare" && predecessor ? (
            <Suspense fallback={<Skeleton className="h-48 w-full" aria-busy="true" />}>
              <YearComparison
                thisYear={{ name: activeYear.name, teachers: report.teachers }}
                predecessor={predecessor}
                teacherName={teacherName}
              />
            </Suspense>
          ) : report.teachers.length === 0 ? (
            <EmptyState icon={Users} title={t("emptyTitle")} description={t("empty")} headingLevel={2} />
          ) : (
            <StaffingMatrix
              report={report}
              subjects={subjects ?? []}
              requirements={sharedRequirements}
              groupName={groupName}
              teacherName={teacherName}
              week={week}
              unit={unit}
              onOpenTeacher={setOpenTeacherId}
            />
          )}

          <UnstaffedPanel
            rows={report.unstaffedRequirements}
            teacherName={teacherName}
            sharesOf={(id) => sharesOfPost.get(id) ?? []}
          />

          <BottlenecksPanel report={report} />

          {settingsOpen ? <StaffingPolicyCard /> : null}
        </>
      )}

      {/* The manual's chain forward: who teaches is set, now when they can. */}
      <div className="flex justify-end">
        <NextStep href="/admin/constraints" name={tNav("constraints")} />
      </div>

      {carryOpen && activeYear ? (
        <Suspense fallback={null}>
          <StaffingCarryDialog
            year={activeYear}
            onOpenChange={(open) => !open && setCarryOpen(false)}
            teacherName={teacherName}
          />
        </Suspense>
      ) : null}

      {proposeMounted && report && activeYearId && activeYear ? (
        <Suspense fallback={null}>
          <StaffingProposalDialog
            key={activeYearId}
            open={proposeOpen}
            onOpenChange={setProposeOpen}
            academicYearId={activeYearId}
            academicYearName={activeYear.name}
            teachersWithTarget={
              report.teachers.filter((row) => (row.targetMinutesPerWeek ?? 0) > 0).length
            }
            teachersTotal={report.teachers.length}
            qualificationsRecorded={report.qualificationsRecorded}
            policy={policy}
            teacherName={teacherName}
            groupName={groupName}
            subjectName={(subjectId) => subjects?.find((subject) => subject.id === subjectId)?.name ?? "—"}
            onOpenSettings={openSettings}
          />
        </Suspense>
      ) : null}

      {openTeacher && activeYearId && activeYear ? (
        <Suspense fallback={null}>
          <TeacherDrawer
            key={openTeacher.id}
            open
            onOpenChange={(open) => !open && setOpenTeacherId(null)}
            teacher={openTeacher}
            load={openLoad}
            unqualified={(report?.unqualifiedAssignments ?? []).filter(
              (row) => row.userId === openTeacher.id,
            )}
            employment={employments?.find((row) => row.userId === openTeacher.id) ?? null}
            qualifications={qualifications?.filter((row) => row.userId === openTeacher.id)}
            policy={policy}
            subjects={subjects ?? []}
            academicYearId={activeYearId}
            academicYearName={activeYear.name}
            requirements={sharedRequirements}
            groups={yearGroups}
            teacherName={teacherName}
            loadModel={report?.loadModel ?? "MINUTES"}
            travel={travelOf(report, openTeacher.id)}
            personName={(userId) => {
              const person = personOf.get(userId);
              return person ? `${person.firstName} ${person.lastName}` : null;
            }}
          />
        </Suspense>
      ) : null}
    </Page>
  );
}
