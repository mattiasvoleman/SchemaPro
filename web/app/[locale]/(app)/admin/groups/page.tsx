"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, Trash2, Users } from "lucide-react";
import {
  useAcademicYears,
  useCrudMutations,
  useGroups,
  usePeople,
} from "@/lib/queries";
import type { StudentGroup } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  academicYearId: string;
}

export default function GroupsPage() {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const tSetup = useTranslations("setup");
  const { data: groups, isLoading } = useGroups();
  const { data: years } = useAcademicYears();
  const { data: people } = usePeople();
  const mutations = useCrudMutations<{
    name: string;
    gradeLevel?: number | null;
    academicYearId: string;
  }>("/api/v1/student-groups", [["groups"]]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<StudentGroup | null>(null);
  const [deleting, setDeleting] = useState<StudentGroup | null>(null);
  const [form, setForm] = useState<GroupForm>({ name: "", gradeLevel: "", academicYearId: "" });

  const memberCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const person of people ?? []) {
      if (person.studentGroupId) {
        counts.set(person.studentGroupId, (counts.get(person.studentGroupId) ?? 0) + 1);
      }
    }
    return counts;
  }, [people]);

  const yearName = (id: string) => years?.find((year) => year.id === id)?.name ?? "—";
  const defaultYearId = years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? "";

  const openCreate = () => {
    setEditing(null);
    setForm({ name: "", gradeLevel: "", academicYearId: defaultYearId });
    setDialogOpen(true);
  };

  const openEdit = (group: StudentGroup) => {
    setEditing(group);
    setForm({
      name: group.name,
      gradeLevel: group.gradeLevel !== null ? String(group.gradeLevel) : "",
      academicYearId: group.academicYearId,
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const gradeLevel = form.gradeLevel.trim() === "" ? null : Number(form.gradeLevel);
    const body = {
      name: form.name.trim(),
      gradeLevel: gradeLevel !== null && Number.isFinite(gradeLevel) ? gradeLevel : null,
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
          <Button onClick={openCreate} disabled={!years || years.length === 0}>
            <Plus />
            {t("addGroup")}
          </Button>
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
              {groups.map((group) => (
                <TableRow key={group.id}>
                  <TableCell className="font-medium">
                    {group.name}
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
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editGroup") : t("addGroup")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
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