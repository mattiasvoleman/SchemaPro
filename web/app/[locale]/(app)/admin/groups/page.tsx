"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Search, Trash2, Upload, UserPlus, Users } from "lucide-react";
import { LazyCsvImportDialog } from "@/components/import/lazy-csv-import-dialog";
import { CsvExportButton } from "@/components/import/csv-export-button";
import { classesToCsv, membershipsToCsv } from "@/lib/csv-export";
import {
  useAcademicYears,
  useCrudMutations,
  useGroupMembers,
  useGroupMemberships,
  useGroups,
  usePeople,
  useSetGroupMembers,
} from "@/lib/queries";
import type { StudentGroup } from "@/lib/types";
import { GROUP_WRITE_KEYS } from "@/lib/projected-rosters";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  buildGroupMemberNames,
  countGroupMembers,
} from "@/lib/group-sections";
import { filterByQuery, matchesQuery } from "@/lib/search";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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

interface GroupForm {
  name: string;
  gradeLevel: string;
  kind: "CLASS" | "TEACHING_GROUP";
  academicYearId: string;
}

export default function GroupsPage() {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const tSetup = useTranslations("setup");
  const tCsvImport = useTranslations("csvImport");
  const { data: groups, isLoading } = useGroups();
  const { data: years } = useAcademicYears();
  const { data: people } = usePeople();
  const mutations = useCrudMutations<{
    name: string;
    gradeLevel?: number | null;
    kind?: "CLASS" | "TEACHING_GROUP";
    academicYearId: string;
  }>("/api/v1/student-groups", GROUP_WRITE_KEYS);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<StudentGroup | null>(null);
  const [deleting, setDeleting] = useState<StudentGroup | null>(null);
  const [membersFor, setMembersFor] = useState<StudentGroup | null>(null);
  const [kindFilter, setKindFilter] = useState<"ALL" | "CLASS" | "TEACHING_GROUP">(
    "ALL",
  );
  const [search, setSearch] = useState("");
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [memberSearch, setMemberSearch] = useState("");
  const { data: currentMembers } = useGroupMembers(membersFor?.id ?? null);
  const { data: memberships } = useGroupMemberships();
  const setMembers = useSetGroupMembers();

  const students = useMemo(
    () =>
      (people ?? []).filter(
        (person) => person.role === "STUDENT" && person.isActive,
      ),
    [people],
  );

  const openMembers = (group: StudentGroup) => {
    setMemberSearch("");
    setMembersFor(group);
  };

  // Preload the checkbox state once the current membership arrives.
  const membersKey = (currentMembers ?? []).map((m) => m.id).join(",");
  useEffect(() => {
    if (membersFor) setMemberIds(new Set((currentMembers ?? []).map((m) => m.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membersFor?.id, membersKey]);

  const toggleMember = (id: string) => {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveMembers = async () => {
    if (!membersFor) return;
    try {
      const { count } = await setMembers.mutateAsync({
        groupId: membersFor.id,
        studentIds: [...memberIds],
      });
      toast.success(t("membersSaved", { count }));
      setMembersFor(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };
  const [form, setForm] = useState<GroupForm>({
    name: "",
    gradeLevel: "",
    kind: "CLASS",
    academicYearId: "",
  });

  // Sizes come from two different places depending on the kind of group —
  // see lib/group-sections.ts, where the rule and its tests live.
  const yearName = (id: string) => years?.find((year) => year.id === id)?.name ?? "—";

  // Group id → the people in it, so the search below can find a group by the
  // name of a student in it. See lib/group-sections.ts.
  const memberNames = useMemo(
    () => buildGroupMemberNames(people ?? [], memberships ?? []),
    [people, memberships],
  );

  const memberCounts = useMemo(
    () => countGroupMembers(people ?? [], memberships ?? []),
    [people, memberships],
  );

  const visibleGroups = useMemo(() => {
    const byKind = (groups ?? []).filter(
      (group) => kindFilter === "ALL" || group.kind === kindFilter,
    );
    // Searchable by group name, by year — "ma71 2026" narrows a name that
    // recurs across läsår — and by the names of its students, which is how an
    // admin answers "which teaching group is Alma in?".
    return filterByQuery(byKind, search, (group) => [
      group.name,
      yearName(group.academicYearId),
      ...(memberNames.get(group.id) ?? []).map((member) => member.name),
    ]);
  }, [groups, kindFilter, search, years, memberNames]);

  const defaultYearId = years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? "";

  /**
   * The students in this group that the current search matched — shown under
   * the group name so "which group is Alma in?" is answered on screen, not
   * merely implied by the row appearing.
   */
  const matchingMembers = (groupId: string) => {
    if (search.trim() === "") return [];
    return (memberNames.get(groupId) ?? []).filter((member) =>
      matchesQuery([member.name], search),
    );
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", gradeLevel: "", kind: "CLASS", academicYearId: defaultYearId });
    setDialogOpen(true);
  };

  const openEdit = (group: StudentGroup) => {
    setEditing(group);
    setForm({
      name: group.name,
      gradeLevel: group.gradeLevel !== null ? String(group.gradeLevel) : "",
      kind: group.kind,
      academicYearId: group.academicYearId,
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const gradeLevel = form.gradeLevel.trim() === "" ? null : Number(form.gradeLevel);
    const body = {
      name: form.name.trim(),
      gradeLevel: gradeLevel !== null && Number.isFinite(gradeLevel) ? gradeLevel : null,
      kind: form.kind,
      academicYearId: form.academicYearId,
    };
    try {
      if (editing) {
        await mutations.update.mutateAsync({ id: editing.id, ...body });
        toast.success(tCommon("updated"));
      } else {
        await mutations.create.mutateAsync(body);
        toast.success(tCommon("created"));
      }
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await mutations.remove.mutateAsync(deleting.id);
      toast.success(tCommon("deleted"));
      setDeleting(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <CsvExportButton
              exports={[
                {
                  kind: "classes",
                  build: () => classesToCsv(groups ?? []),
                  empty: !groups?.some((group) => group.kind === "CLASS"),
                },
                {
                  kind: "teachingGroups",
                  build: () =>
                    membershipsToCsv(groups ?? [], people ?? [], memberships ?? []),
                  empty: !memberships || memberships.length === 0,
                },
              ]}
            />
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload />
              {tCsvImport("button")}
            </Button>
            <Button onClick={openCreate} disabled={!years || years.length === 0}>
              <Plus />
              {t("addGroup")}
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !groups || groups.length === 0 ? (
        <EmptyState icon={Users} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <>
        <Tabs
          value={kindFilter}
          onValueChange={(value) => setKindFilter(value as typeof kindFilter)}
          className="mb-4"
        >
          <TabsList>
            <TabsTrigger value="ALL">{t("filterAll")}</TabsTrigger>
            <TabsTrigger value="CLASS">{t("kindClass")}</TabsTrigger>
            <TabsTrigger value="TEACHING_GROUP">{t("kindTeachingGroup")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative mb-4 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchPlaceholder")}
            aria-label={t("searchPlaceholder")}
            className="pl-9"
          />
        </div>
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("name")}</TableHead>
                <TableHead>{t("year")}</TableHead>
                <TableHead>{tCommon("students")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleGroups.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {tCommon("noResults")}
                  </TableCell>
                </TableRow>
              ) : null}
              {visibleGroups.map((group) => (
                <TableRow key={group.id}>
                  <TableCell className="font-medium">
                    {group.name}
                    {matchingMembers(group.id).length > 0 ? (
                      <div className="mt-0.5 text-xs font-normal text-muted-foreground">
                        {matchingMembers(group.id)
                          .slice(0, 3)
                          .map((member) => member.name)
                          .join(", ")}
                        {matchingMembers(group.id).length > 3
                          ? t("andMore", {
                              count: matchingMembers(group.id).length - 3,
                            })
                          : ""}
                      </div>
                    ) : null}
                    <Badge
                      variant={group.kind === "CLASS" ? "secondary" : "outline"}
                      className="mr-2"
                    >
                      {group.kind === "CLASS" ? t("kindClass") : t("kindTeachingGroup")}
                    </Badge>
                    {group.gradeLevel !== null ? (
                      <Badge variant="secondary" className="ml-2">
                        {group.gradeLevel}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>{yearName(group.academicYearId)}</TableCell>
                  <TableCell className="tabular-nums">
                    {memberCounts.get(group.id) ?? 0}
                  </TableCell>
                  <TableCell className="text-right">
                    {group.kind === "TEACHING_GROUP" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openMembers(group)}
                        aria-label={t("members")}
                        title={t("members")}
                      >
                        <UserPlus />
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(group)}
                      aria-label={tCommon("edit")}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleting(group)}
                      aria-label={tCommon("delete")}
                    >
                      <Trash2 className="text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editGroup") : t("addGroup")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="group-kind">{t("kindLabel")}</Label>
              <Select
                value={form.kind}
                onValueChange={(value) =>
                  setForm({ ...form, kind: value as GroupForm["kind"] })
                }
              >
                <SelectTrigger id="group-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CLASS">{t("kindClass")}</SelectItem>
                  <SelectItem value="TEACHING_GROUP">{t("kindTeachingGroup")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground">
                {form.kind === "CLASS" ? t("kindClassHelp") : t("kindTeachingGroupHelp")}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="group-name">{tCommon("name")}</Label>
                <Input
                  id="group-name"
                  value={form.name}
                  placeholder={t("namePlaceholder")}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="group-grade">
                  {tSetup("gradeLevel")}{" "}
                  <span className="text-muted-foreground">({tCommon("optional")})</span>
                </Label>
                <Input
                  id="group-grade"
                  type="number"
                  min={0}
                  max={12}
                  value={form.gradeLevel}
                  onChange={(e) => setForm({ ...form, gradeLevel: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t("year")}</Label>
              <Select
                value={form.academicYearId}
                onValueChange={(value) => setForm({ ...form, academicYearId: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(years ?? []).map((year) => (
                    <SelectItem key={year.id} value={year.id}>
                      {year.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={submit}
              disabled={
                form.name.trim().length === 0 ||
                form.academicYearId === "" ||
                mutations.create.isPending ||
                mutations.update.isPending
              }
            >
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={membersFor !== null} onOpenChange={(open) => !open && setMembersFor(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("membersTitle", { name: membersFor?.name ?? "" })}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t("membersHint")}</p>
          <Input
            placeholder={tCommon("search")}
            value={memberSearch}
            onChange={(event) => setMemberSearch(event.target.value)}
          />
          <div className="max-h-72 overflow-y-auto rounded-md border">
            {students
              .filter((student) =>
                `${student.firstName} ${student.lastName}`
                  .toLowerCase()
                  .includes(memberSearch.toLowerCase()),
              )
              .map((student) => (
                <label
                  key={student.id}
                  className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0 hover:bg-muted/50"
                >
                  <input
                    type="checkbox"
                    checked={memberIds.has(student.id)}
                    onChange={() => toggleMember(student.id)}
                  />
                  <span className="flex-1">
                    {student.firstName} {student.lastName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {groups?.find((g) => g.id === student.studentGroupId)?.name ?? ""}
                  </span>
                </label>
              ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMembersFor(null)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={saveMembers} disabled={setMembers.isPending}>
              {t("membersSave", { count: memberIds.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LazyCsvImportDialog
        kinds={["classes", "teachingGroups"]}
        open={importOpen}
        onOpenChange={setImportOpen}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tCommon("deleteConfirmTitle", { name: deleting?.name ?? "" })}
        description={tCommon("deleteConfirmBody")}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}