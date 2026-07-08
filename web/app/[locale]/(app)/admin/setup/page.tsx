"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowRight,
  BookOpen,
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
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  }>("/api/v1/academic-years", [["academicYears"]]);
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
  const [yearForm, setYearForm] = useState({
    name: "",
    startDate: "",
    endDate: "",
    isActive: true,
  });
  const [quickName, setQuickName] = useState("");

  const addYear = async () => {
    try {
      await yearMutations.create.mutateAsync({
        name: yearForm.name.trim(),
        startDate: yearForm.startDate,
        endDate: yearForm.endDate,
        isActive: yearForm.isActive,
      });
      toast.success(tCommon("created"));
      setYearForm({ name: "", startDate: "", endDate: "", isActive: true });
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
      href: "/admin/requirements",
      items: (years ?? []).map(
        (year) => `${year.name}${year.isActive ? " ✓" : ""}`,
      ),
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
                  <Input
                    id="year-start"
                    type="date"
                    value={yearForm.startDate}
                    onChange={(e) => setYearForm({ ...yearForm, startDate: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="year-end">{t("endDate")}</Label>
                  <Input
                    id="year-end"
                    type="date"
                    value={yearForm.endDate}
                    onChange={(e) => setYearForm({ ...yearForm, endDate: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={yearForm.isActive}
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
