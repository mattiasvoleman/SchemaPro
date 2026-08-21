"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import {
  useConstraints,
  useCrudMutations,
  useGroups,
  usePeople,
  useRooms,
} from "@/lib/queries";
import type {
  AvailabilityConstraint,
  ConstraintResource,
  ConstraintType,
} from "@/lib/types";
import { formatTime } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { RoomPreferencesCard } from "@/components/schedule/room-preferences-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

const RESOURCES: ConstraintResource[] = ["TEACHER", "ROOM", "STUDENT_GROUP"];
const TYPES: ConstraintType[] = ["UNAVAILABLE", "PREFERRED_FREE", "PREFERRED_BUSY"];
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

interface ConstraintForm {
  resourceType: ConstraintResource;
  resourceId: string;
  mode: "recurring" | "date";
  dayOfWeek: string;
  date: string;
  startTime: string;
  endTime: string;
  type: ConstraintType;
  reason: string;
}

const EMPTY_FORM: ConstraintForm = {
  resourceType: "TEACHER",
  resourceId: "",
  mode: "recurring",
  dayOfWeek: "1",
  date: "",
  startTime: "08:00",
  endTime: "16:00",
  type: "UNAVAILABLE",
  reason: "",
};

export default function ConstraintsPage() {
  const t = useTranslations("constraints");
  const tCommon = useTranslations("common");
  const tTypes = useTranslations("constraintTypes");
  const tDays = useTranslations("days");
  const { data: constraints, isLoading } = useConstraints();
  const { data: people } = usePeople();
  const { data: rooms } = useRooms();
  const { data: groups } = useGroups();

  const mutations = useCrudMutations<{
    resourceType: ConstraintResource;
    userId?: string | null;
    roomId?: string | null;
    studentGroupId?: string | null;
    dayOfWeek?: number | null;
    date?: string | null;
    startTime: string;
    endTime: string;
    type: ConstraintType;
    reason?: string | null;
  }>("/api/v1/availability-constraints", [["constraints"]]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AvailabilityConstraint | null>(null);
  const [deleting, setDeleting] = useState<AvailabilityConstraint | null>(null);
  const [form, setForm] = useState<ConstraintForm>(EMPTY_FORM);

  const teachers = (people ?? []).filter((person) => person.role === "TEACHER");

  const resourceOptions = (resourceType: ConstraintResource) => {
    switch (resourceType) {
      case "TEACHER":
        return teachers.map((teacher) => ({
          id: teacher.id,
          label: `${teacher.firstName} ${teacher.lastName}`,
        }));
      case "ROOM":
        return (rooms ?? []).map((room) => ({ id: room.id, label: room.name }));
      case "STUDENT_GROUP":
        return (groups ?? []).map((group) => ({ id: group.id, label: group.name }));
    }
  };

  const resourceName = (constraint: AvailabilityConstraint): string => {
    if (constraint.userId) {
      const teacher = teachers.find((person) => person.id === constraint.userId);
      return teacher ? `${teacher.firstName} ${teacher.lastName}` : "—";
    }
    if (constraint.roomId) {
      return rooms?.find((room) => room.id === constraint.roomId)?.name ?? "—";
    }
    if (constraint.studentGroupId) {
      return groups?.find((group) => group.id === constraint.studentGroupId)?.name ?? "—";
    }
    return "—";
  };

  const resourceLabel = (resourceType: ConstraintResource): string => {
    switch (resourceType) {
      case "TEACHER":
        return t("resourceTeacher");
      case "ROOM":
        return t("resourceRoom");
      case "STUDENT_GROUP":
        return t("resourceGroup");
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (constraint: AvailabilityConstraint) => {
    setEditing(constraint);
    setForm({
      resourceType: constraint.resourceType,
      resourceId:
        constraint.userId ?? constraint.roomId ?? constraint.studentGroupId ?? "",
      mode: constraint.date ? "date" : "recurring",
      dayOfWeek: String(constraint.dayOfWeek ?? 1),
      date: constraint.date ?? "",
      startTime: formatTime(constraint.startTime),
      endTime: formatTime(constraint.endTime),
      type: constraint.type,
      reason: constraint.reason ?? "",
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      resourceType: form.resourceType,
      userId: form.resourceType === "TEACHER" ? form.resourceId : null,
      roomId: form.resourceType === "ROOM" ? form.resourceId : null,
      studentGroupId: form.resourceType === "STUDENT_GROUP" ? form.resourceId : null,
      dayOfWeek: form.mode === "recurring" ? Number(form.dayOfWeek) : null,
      date: form.mode === "date" ? form.date : null,
      startTime: form.startTime,
      endTime: form.endTime,
      type: form.type,
      reason: form.reason.trim() || null,
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

  const formValid =
    form.resourceId !== "" &&
    form.startTime < form.endTime &&
    (form.mode === "recurring" || form.date !== "");

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={openCreate}>
            <Plus />
            {t("addConstraint")}
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !constraints || constraints.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title={tCommon("noResults")}
          description={t("empty")}
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("resource")}</TableHead>
                <TableHead>{tCommon("name")}</TableHead>
                <TableHead>{t("day")}</TableHead>
                <TableHead>{tCommon("time")}</TableHead>
                <TableHead>{tCommon("type")}</TableHead>
                <TableHead>{t("reason")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {constraints.map((constraint) => (
                <TableRow key={constraint.id}>
                  <TableCell>
                    <Badge variant="secondary">{resourceLabel(constraint.resourceType)}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">{resourceName(constraint)}</TableCell>
                  <TableCell>
                    {constraint.date ??
                      (constraint.dayOfWeek !== null
                        ? tDays(String(constraint.dayOfWeek))
                        : "—")}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatTime(constraint.startTime)}–{formatTime(constraint.endTime)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={constraint.type === "UNAVAILABLE" ? "destructive" : "outline"}
                    >
                      {tTypes(constraint.type)}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-40 truncate text-muted-foreground">
                    {constraint.reason ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(constraint)}
                      aria-label={tCommon("edit")}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleting(constraint)}
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

      <RoomPreferencesCard />


      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editConstraint") : t("addConstraint")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t("resource")}</Label>
                <Select
                  value={form.resourceType}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      resourceType: value as ConstraintResource,
                      resourceId: "",
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RESOURCES.map((resource) => (
                      <SelectItem key={resource} value={resource}>
                        {resourceLabel(resource)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tCommon("name")}</Label>
                <Select
                  value={form.resourceId || undefined}
                  onValueChange={(value) => setForm({ ...form, resourceId: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {resourceOptions(form.resourceType).map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Tabs
              value={form.mode}
              onValueChange={(value) =>
                setForm({ ...form, mode: value as "recurring" | "date" })
              }
            >
              <TabsList className="w-full">
                <TabsTrigger value="recurring" className="flex-1">
                  {t("recurring")}
                </TabsTrigger>
                <TabsTrigger value="date" className="flex-1">
                  {t("specificDate")}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {form.mode === "recurring" ? (
              <div className="space-y-2">
                <Label>{t("day")}</Label>
                <Select
                  value={form.dayOfWeek}
                  onValueChange={(value) => setForm({ ...form, dayOfWeek: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS.map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {tDays(String(day))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="constraint-date">{tCommon("date")}</Label>
                <Input
                  id="constraint-date"
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="constraint-start">{t("startTime")}</Label>
                <Input
                  id="constraint-start"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="constraint-end">{t("endTime")}</Label>
                <Input
                  id="constraint-end"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tCommon("type")}</Label>
                <Select
                  value={form.type}
                  onValueChange={(value) => setForm({ ...form, type: value as ConstraintType })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {tTypes(type)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="constraint-reason">
                  {t("reason")}{" "}
                  <span className="text-muted-foreground">({tCommon("optional")})</span>
                </Label>
                <Input
                  id="constraint-reason"
                  value={form.reason}
                  placeholder={t("reasonPlaceholder")}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={submit}
              disabled={!formValid || mutations.create.isPending || mutations.update.isPending}
            >
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tCommon("deleteConfirmTitle", { name: deleting ? resourceName(deleting) : "" })}
        description={tCommon("deleteConfirmBody")}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
