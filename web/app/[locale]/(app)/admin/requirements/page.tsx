"use client";

import { Fragment, useMemo, useState } from "react";
import { splitGroupsByKind } from "@/lib/group-sections";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Grid3x3, Plus } from "lucide-react";
import {
  useAcademicYears,
  useCrudMutations,
  useGroupMemberships,
  useGroups,
  usePeople,
  useRequirements,
  useSubjects,
} from "@/lib/queries";
import type { TeachingRequirement } from "@/lib/types";
import { subjectColor } from "@/lib/utils";
import { sortByName } from "@/lib/sorting";
import { PageHeader } from "@/components/layout/page-header";
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
}

export default function RequirementsPage() {
  const t = useTranslations("requirements");
  const tCommon = useTranslations("common");
  const { data: years } = useAcademicYears();
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const activeYearId =
    selectedYearId ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;

  const { data: subjects, isLoading: subjectsLoading } = useSubjects();
  const { data: groups } = useGroups();
  const { data: people } = usePeople();
  const { data: memberships } = useGroupMemberships();
  const { data: requirements } = useRequirements(activeYearId);

  const mutations = useCrudMutations<{
    academicYearId: string;
    subjectId: string;
    studentGroupId: string;
    teacherId?: string | null;
    coTeacherId?: string | null;
    lessonsPerWeek?: number;
    minutesPerLesson?: number;
  }>("/api/v1/teaching-requirements", [["requirements", activeYearId ?? ""]]);

  const [cell, setCell] = useState<CellTarget | null>(null);
  const [form, setForm] = useState<CellForm>({
    lessonsPerWeek: "2",
    minutesPerLesson: "60",
    teacherId: NO_TEACHER,
    coTeacherId: NO_TEACHER,
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

  const totalWeekly = useMemo(
    () => (requirements ?? []).reduce((sum, r) => sum + r.lessonsPerWeek, 0),
    [requirements],
  );

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
    try {
      if (cell.existing) {
        await mutations.update.mutateAsync({
          id: cell.existing.id,
          lessonsPerWeek,
          minutesPerLesson,
          teacherId,
          coTeacherId,
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

      {subjectsLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !activeYearId ? (
        <EmptyState icon={Grid3x3} title={tCommon("noResults")} description={t("noYear")} />
      ) : yearGroups.length === 0 || !subjects || subjects.length === 0 ? (
        <EmptyState icon={Grid3x3} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            {t("totalWeekly", { count: totalWeekly })}
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
              <thead>
                <tr className="border-b">
                  <th className="sticky left-0 top-0 z-30 bg-card px-3 py-2.5 text-left font-medium text-muted-foreground">
                    {tCommon("group")}
                  </th>
                  {columns.map((subject) => (
                    <th
                      key={subject.id}
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
                </tr>
              </thead>
              <tbody>
                {sections.map((section) => (
                  <Fragment key={section.kind}>
                    <tr className="border-b bg-muted/40">
                      <td
                        colSpan={columns.length + 1}
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
                    <td className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
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
                    </td>
                    {columns.map((subject) => {
                      const requirement = requirementIndex.get(`${group.id}:${subject.id}`);
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
                            aria-label={t("cellLabel", {
                              group: group.name,
                              subject: subject.name,
                            })}
                            onClick={() => openCell(group.id, subject.id)}
                            className={
                              requirement
                                ? "mx-auto flex h-10 w-full min-w-16 flex-col items-center justify-center rounded-md bg-accent/70 text-accent-foreground transition-colors hover:bg-accent"
                                : "mx-auto flex h-10 w-full min-w-16 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-muted hover:text-muted-foreground"
                            }
                          >
                            {requirement ? (
                              <>
                                <span className="text-sm font-semibold tabular-nums">
                                  {requirement.lessonsPerWeek}×{requirement.minutesPerLesson}
                                </span>
                                {teacherLabel(requirement.teacherId) ? (
                                  <span className="max-w-24 truncate text-[10px] leading-tight text-muted-foreground">
                                    {teacherLabel(requirement.teacherId)}
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
