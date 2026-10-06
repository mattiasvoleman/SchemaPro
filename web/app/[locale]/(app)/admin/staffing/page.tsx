"use client";

// Tjänstefördelningen: who carries how many minutes a week, against what.
//
// Every leader allocates teaching to teachers BEFORE it timetables and shows
// Soll/Ist — Skola24's Tjänst %/*Planerad tjänst, Untis' Plan/week and Percent
// of target, Lectio's one bar per teacher. This page is that layer for
// SchemaPro, read-only in this phase: the numbers come from GET /staffing/load
// (computed by the gateway in one RLS transaction) and nothing on the matrix
// writes a requirement. Staffing still happens in the timplan's own dialog,
// which now shows a behörighet badge and the minutes left per candidate from
// the same report.
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
// The settings card lives on THIS page, behind the settings button, rather
// than on tillgänglighet beside the lunch card it is built like: the lunch
// card's reader is the solver, this card's only reader is the matrix above
// it, and the notice about the missing riktmärke has to be able to point at
// the field without a page change. See staffing-policy-card.tsx.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Grid3x3, Settings2, TriangleAlert, Users } from "lucide-react";
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
  useTeacherEmployments,
  useTeacherQualifications,
} from "@/lib/staffing-queries";
import { kpis, type UnitView, type WeekView } from "@/lib/staffing-view";
import { PageHeader } from "@/components/layout/page-header";
import { StaffingMatrix } from "@/components/staffing/staffing-matrix";
import { StaffingPolicyCard } from "@/components/staffing/staffing-policy-card";
import { TeacherDrawer } from "@/components/staffing/teacher-drawer";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function StaffingPage() {
  const t = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const { data: years, isLoading: yearsLoading, isError: yearsFailed } = useAcademicYears();
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const activeYearId =
    selectedYearId ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;
  const activeYear = years?.find((year) => year.id === activeYearId) ?? null;

  const { data: report, isLoading: reportLoading, isError: reportFailed } =
    useStaffingLoad(activeYearId);
  const { data: policy } = useStaffingPolicy();
  const { data: subjects, isLoading: subjectsLoading, isError: subjectsFailed } = useSubjects();
  const { data: people } = usePeople();
  const { data: groups } = useGroups();
  const { data: requirements } = useRequirements(activeYearId);
  const { data: employments } = useTeacherEmployments(activeYearId);
  const { data: qualifications } = useTeacherQualifications();

  const [week, setWeek] = useState<WeekView>("standard");
  const [unit, setUnit] = useState<UnitView>("minutes");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openTeacherId, setOpenTeacherId] = useState<string | null>(null);

  /**
   * One gate for every query a NUMBER is printed from — the report and the
   * subjects that name its columns. People, groups and requirements only feed
   * names and tooltips, and a late name is quiet where a late number is a
   * zero stated confidently (see admin/requirements for the argument).
   */
  const loading = yearsLoading || reportLoading || subjectsLoading;
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

  const figures = report ? kpis(report) : null;
  const noTarget = policy !== undefined && (policy === null || policy.fullTimeTeachingMinutesPerWeek === null);

  const openSettings = () => {
    setSettingsOpen(true);
    // After the card has mounted, bring it into view: the notice sits above
    // the matrix and the card below it.
    window.setTimeout(() => {
      document.getElementById("staffing-policy")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 0);
  };

  const openTeacher = openTeacherId ? personOf.get(openTeacherId) : undefined;
  const openLoad = report?.teachers.find((row) => row.userId === openTeacherId);

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            {years && years.length > 0 ? (
              <Select value={activeYearId ?? undefined} onValueChange={setSelectedYearId}>
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
        <Skeleton className="h-64 w-full" />
      ) : failed ? (
        <EmptyState icon={TriangleAlert} title={t("loadFailed")} description={t("loadFailedHint")} />
      ) : !activeYearId || !activeYear || !report ? (
        <EmptyState icon={Grid3x3} title={tCommon("noResults")} description={t("noYear")} />
      ) : (
        <div className="space-y-4">
          {noTarget ? (
            // foreground on muted: 17.00 / 13.19, AAA — the notice is a state
            // the whole page is in, not an error, so it is not painted red.
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-muted px-4 py-3 text-sm text-foreground"
            >
              <div>
                <p className="font-medium">{t("noTargetTitle")}</p>
                <p>{t("noTargetBody")}</p>
              </div>
              <Button variant="outline" size="sm" onClick={openSettings}>
                {t("noTargetAction")}
              </Button>
            </div>
          ) : null}

          {figures ? (
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border bg-card p-4">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("kpiUnstaffed")}
                </dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{figures.unstaffed}</dd>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("kpiUnqualified")}
                </dt>
                {figures.unqualified === null ? (
                  <dd className="mt-1 text-sm text-foreground" title={t("kpiUnqualifiedNotRecordedHint")}>
                    {t("kpiUnqualifiedNotRecorded")}
                  </dd>
                ) : (
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">{figures.unqualified}</dd>
                )}
              </div>
              <div className="rounded-lg border bg-card p-4">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("kpiOverTarget")}
                </dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums">{figures.overTarget}</dd>
              </div>
            </dl>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
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
          </div>
          <p className="text-xs text-foreground">
            {week === "peak" ? t("weekHintPeak") : t("weekHintStandard")}
            {unit === "percent" ? ` ${t("unitHintPercent")}` : ""}
          </p>

          {report.teachers.length === 0 ? (
            <EmptyState icon={Users} title={tCommon("noResults")} description={t("empty")} />
          ) : (
            <StaffingMatrix
              report={report}
              subjects={subjects ?? []}
              requirements={requirements ?? []}
              groupName={groupName}
              teacherName={teacherName}
              week={week}
              unit={unit}
              onOpenTeacher={setOpenTeacherId}
            />
          )}

          <section className="rounded-lg border bg-card p-4" aria-labelledby="staffing-unstaffed">
            <h2 id="staffing-unstaffed" className="font-semibold">
              {t("unstaffedTitle")}
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">{t("unstaffedHint")}</p>
            {report.unstaffedRequirements.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("unstaffedEmpty")}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {report.unstaffedRequirements.map((row) => (
                  <li key={row.requirementId}>
                    <Link href="/admin/requirements" className="hover:underline">
                      {t("unstaffedRow", {
                        group: row.groupName,
                        subject: row.subjectName,
                        minutes: row.minutesPerWeek,
                      })}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {settingsOpen ? <StaffingPolicyCard /> : null}
        </div>
      )}

      {openTeacher && activeYearId && activeYear ? (
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
        />
      ) : null}
    </div>
  );
}
