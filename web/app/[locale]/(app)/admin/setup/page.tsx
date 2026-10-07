"use client";

// Kom igång. The läsår step also opens "Timplan per årskurs" for each year
// (components/timplan/year-timplans-dialog.tsx): which lokal timplan every
// årskurs follows. A year created here already follows the school's newest
// decided plan in that plan's årskurser — the gateway attaches them in the
// same transaction — and the toast says so, so the admin knows where the
// targets came from and where to change them.
//
// The dialog is fetched on the click that opens it (React.lazy), and the
// reason is every other route, not this one. Measured 2026-10-07 (`npm run
// build`, scripts/bench/bundle-size.mjs, own JS gzip): imported statically,
// it put the Dialog and Select internals in this route's graph next to the
// (app) layout's, Turbopack re-sliced the layout's chunks, and EVERY app route
// grew 1.2 KB — /admin/timetable 189.4 → 190.6 against its 190 budget,
// /guardian 166.0 → 167.2. Lazy: this route 161.7 → 162.2, the layout's
// chunks untouched, and /admin/timetable 10 bytes heavier from a re-slice of
// three of its own chunks. (admin/timplan's header records the opposite case,
// where five lazy dialogs and no static one moved the layout instead.)

import { lazy, Suspense, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowRight,
  BookOpen,
  CalendarRange,
  Check,
  GraduationCap,
  MapPin,
  Plus,
  UserCheck,
  Users,
} from "lucide-react";
import { Link } from "@/i18n/navigation";
import {
  useAcademicYears,
  useCrudMutations,
  useGroups,
  usePeople,
  useRooms,
  useSubjects,
} from "@/lib/queries";
import { cn } from "@/lib/utils";
import { TIMPLAN_COVERAGE_KEYS, YEAR_TIMPLAN_KEYS } from "@/lib/year-timplan-keys";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const YearTimplansDialog = lazy(() =>
  import("@/components/timplan/year-timplans-dialog").then((module) => ({
    default: module.YearTimplansDialog,
  })),
);

type StepId = "year" | "subjects" | "rooms" | "groups" | "people";

export default function SetupPage() {
  const t = useTranslations("setup");
  const tCommon = useTranslations("common");

  const { data: years } = useAcademicYears();
  const { data: subjects } = useSubjects();
  const { data: rooms } = useRooms();
  const { data: groups } = useGroups();
  const { data: people } = usePeople();

  const yearMutations = useCrudMutations<{
    name: string;
    startDate: string;
    endDate: string;
    isActive?: boolean;
  }>("/api/v1/academic-years", [
    ["academicYears"],
    // A new year follows the newest decided plan from its first answer.
    [...YEAR_TIMPLAN_KEYS.all],
    [...TIMPLAN_COVERAGE_KEYS.all],
  ]);
  const subjectMutations = useCrudMutations<{ name: string }>("/api/v1/subjects", [
    ["subjects"],
  ]);
  const roomMutations = useCrudMutations<{ name: string; capacity?: number | null }>(
    "/api/v1/rooms",
    [["rooms"]],
  );
  const groupMutations = useCrudMutations<{ name: string; academicYearId: string }>(
    "/api/v1/student-groups",
    [["groups"]],
  );

  const activeYear = years?.find((year) => year.isActive) ?? null;

  const steps: Array<{
    id: StepId;
    label: string;
    icon: typeof GraduationCap;
    done: boolean;
    count: number;
  }> = [
    {
      id: "year",
      label: t("stepYear"),
      icon: GraduationCap,
      done: activeYear !== null,
      count: years?.length ?? 0,
    },
    {
      id: "subjects",
      label: t("stepSubjects"),
      icon: BookOpen,
      done: (subjects?.length ?? 0) > 0,
      count: subjects?.length ?? 0,
    },
    {
      id: "rooms",
      label: t("stepRooms"),
      icon: MapPin,
      done: (rooms?.length ?? 0) > 0,
      count: rooms?.length ?? 0,
    },
    {
      id: "groups",
      label: t("stepGroups"),
      icon: Users,
      done: (groups?.length ?? 0) > 0,
      count: groups?.length ?? 0,
    },
    {
      id: "people",
      label: t("stepPeople"),
      icon: UserCheck,
      done: (people?.length ?? 0) > 1,
      count: people?.length ?? 0,
    },
  ];

  const firstIncomplete = steps.find((step) => !step.done)?.id ?? "people";
  const [activeStep, setActiveStep] = useState<StepId | null>(null);
  const currentStep = activeStep ?? firstIncomplete;
  const allDone = steps.every((step) => step.done);

  // --- quick-add form state ---------------------------------------------------
  // isActive null = the default, which depends on whether the school already
  // has a läsår. The first one is active; a later one is not, because handing
  // the flag to a new, empty year leaves every pupil in a class of a year that
  // is no longer the active one — the schedule, the attendance rosters and the
  // pupil's own view all follow the active year. Next year normally comes from
  // Rulla vidare on /admin/years, and becomes active there, with its pupils.
  const [yearForm, setYearForm] = useState<{
    name: string;
    startDate: string;
    endDate: string;
    isActive: boolean | null;
  }>({
    name: "",
    startDate: "",
    endDate: "",
    isActive: null,
  });
  const hasYears = (years?.length ?? 0) > 0;
  const yearIsActive = yearForm.isActive ?? !hasYears;
  const [quickName, setQuickName] = useState("");
  const [timplanYearId, setTimplanYearId] = useState<string | null>(null);

  const addYear = async () => {
    try {
      const created = (await yearMutations.create.mutateAsync({
        name: yearForm.name.trim(),
        startDate: yearForm.startDate,
        endDate: yearForm.endDate,
        isActive: yearIsActive,
      })) as { name?: string; timplans?: { planName: string }[] } | undefined;
      toast.success(tCommon("created"));
      const attached = created?.timplans ?? [];
      if (attached.length > 0) {
        toast.info(
          t("yearTimplansDefaulted", {
            year: created?.name ?? yearForm.name.trim(),
            plan: attached[0].planName,
            count: attached.length,
          }),
        );
      }
      setYearForm({ name: "", startDate: "", endDate: "", isActive: null });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const quickAdd = async (step: StepId) => {
    const name = quickName.trim();
    if (!name) return;
    try {
      if (step === "subjects") {
        await subjectMutations.create.mutateAsync({ name });
      } else if (step === "rooms") {
        await roomMutations.create.mutateAsync({ name });
      } else if (step === "groups" && activeYear) {
        await groupMutations.create.mutateAsync({ name, academicYearId: activeYear.id });
      }
      toast.success(tCommon("created"));
      setQuickName("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const stepMeta: Record<
    StepId,
    { title: string; hint: string; href: string; items: string[] }
  > = {
    year: {
      title: t("yearTitle"),
      hint: t("yearHint"),
      href: "/admin/years",
      // Listed as rows of their own below the form, each with its
      // "Timplan per årskurs" button, rather than as badges.
      items: [],
    },
    subjects: {
      title: t("subjectsTitle"),
      hint: t("subjectsHint"),
      href: "/admin/subjects",
      items: (subjects ?? []).map((subject) => subject.name),
    },
    rooms: {
      title: t("roomsTitle"),
      hint: t("roomsHint"),
      href: "/admin/rooms",
      items: (rooms ?? []).map((room) => room.name),
    },
    groups: {
      title: t("groupsTitle"),
      hint: t("groupsHint"),
      href: "/admin/groups",
      items: (groups ?? []).map((group) => group.name),
    },
    people: {
      title: t("peopleTitle"),
      hint: t("peopleHint"),
      href: "/admin/people",
      items: [],
    },
  };

  const meta = stepMeta[currentStep];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* Stepper */}
      <ol className="mb-6 flex flex-wrap items-center gap-2">
        {steps.map((step, index) => (
          <li key={step.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveStep(step.id)}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                currentStep === step.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : step.done
                    ? "border-success/40 bg-success/10 text-success"
                    : "text-muted-foreground hover:bg-muted",
              )}
            >
              {step.done && currentStep !== step.id ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <step.icon className="h-3.5 w-3.5" />
              )}
              {step.label}
              <Badge
                variant={currentStep === step.id ? "secondary" : "outline"}
                className="px-1.5 py-0 text-[10px]"
              >
                {step.count}
              </Badge>
            </button>
            {index < steps.length - 1 ? (
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            ) : null}
          </li>
        ))}
      </ol>

      <Card>
        <CardHeader>
          <CardTitle>{meta.title}</CardTitle>
          <CardDescription>{meta.hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {currentStep === "year" ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="year-name">{t("yearName")}</Label>
                  <Input
                    id="year-name"
                    placeholder={t("yearNamePlaceholder")}
                    value={yearForm.name}
                    onChange={(e) => setYearForm({ ...yearForm, name: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="year-start">{t("startDate")}</Label>
                  <DateField
                    label={t("startDate")}
                    id="year-start"
                    value={yearForm.startDate}
                    onChange={(value) => setYearForm({ ...yearForm, startDate: value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="year-end">{t("endDate")}</Label>
                  <DateField
                    label={t("endDate")}
                    id="year-end"
                    value={yearForm.endDate}
                    onChange={(value) => setYearForm({ ...yearForm, endDate: value })}
                  />
                </div>
              </div>
              {hasYears ? (
                <p className="text-sm text-muted-foreground">
                  {t("yearExistsHint")}{" "}
                  <Link href="/admin/years" className="font-medium text-primary underline-offset-4 hover:underline">
                    {t("yearsLink")}
                  </Link>
                </p>
              ) : null}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={yearIsActive}
                    onCheckedChange={(checked) =>
                      setYearForm({ ...yearForm, isActive: checked })
                    }
                  />
                  {t("active")}
                </label>
                <Button
                  onClick={addYear}
                  disabled={
                    yearForm.name.trim() === "" ||
                    yearForm.startDate === "" ||
                    yearForm.endDate === "" ||
                    yearForm.startDate >= yearForm.endDate ||
                    yearMutations.create.isPending
                  }
                >
                  <Plus />
                  {tCommon("create")}
                </Button>
              </div>
              {(years ?? []).length > 0 ? (
                <ul className="divide-y rounded-md border">
                  {(years ?? []).map((year) => (
                    <li key={year.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                      <span className="font-medium">
                        {year.name}
                        {year.isActive ? (
                          <Badge variant="secondary" className="ml-2">
                            {t("active")}
                          </Badge>
                        ) : null}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setTimplanYearId(year.id)}
                        aria-label={t("yearTimplansFor", { year: year.name })}
                      >
                        <CalendarRange />
                        {t("yearTimplansButton")}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : currentStep === "people" ? (
            <Button asChild>
              <Link href="/admin/people">
                {t("stepPeople")}
                <ArrowRight />
              </Link>
            </Button>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void quickAdd(currentStep);
              }}
            >
              <Input
                value={quickName}
                onChange={(e) => setQuickName(e.target.value)}
                placeholder={tCommon("name")}
              />
              <Button
                type="submit"
                disabled={
                  quickName.trim() === "" || (currentStep === "groups" && !activeYear)
                }
              >
                <Plus />
                {tCommon("add")}
              </Button>
            </form>
          )}

          {meta.items.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {meta.items.map((item) => (
                <Badge key={item} variant="secondary">
                  {item}
                </Badge>
              ))}
            </div>
          ) : null}

          <div className="border-t pt-4">
            <Button asChild variant="ghost" size="sm">
              <Link href={meta.href}>
                {tCommon("edit")}
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Suspense fallback={null}>
        {timplanYearId !== null ? (
          <YearTimplansDialog
            open
            onOpenChange={(open) => !open && setTimplanYearId(null)}
            years={years ?? []}
            initialYearId={timplanYearId}
          />
        ) : null}
      </Suspense>

      {allDone ? (
        <Card className="mt-6 border-success/40 bg-success/5">
          <CardContent className="flex items-center justify-between gap-4 pt-6">
            <div className="flex items-center gap-3">
              <Check className="h-5 w-5 text-success" />
              <span className="text-sm font-medium">{t("done")}</span>
            </div>
            <Button asChild>
              <Link href="/admin/requirements">
                {t("goToRequirements")}
                <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
