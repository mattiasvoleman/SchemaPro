"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { useCrudMutations, useRooms } from "@/lib/queries";
import type { Room, RoomType } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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

const ROOM_TYPES: RoomType[] = [
  "CLASSROOM",
  "LABORATORY",
  "GYMNASIUM",
  "AUDITORIUM",
  "WORKSHOP",
  "OTHER",
];

interface RoomForm {
  name: string;
  code: string;
  capacity: string;
  type: RoomType;
  requiresApproval: boolean;
}

const EMPTY_FORM: RoomForm = {
  name: "",
  code: "",
  capacity: "",
  type: "CLASSROOM",
  requiresApproval: false,
};

export default function RoomsPage() {
  const t = useTranslations("rooms");
  const tCommon = useTranslations("common");
  const tTypes = useTranslations("roomTypes");
  const { data: rooms, isLoading } = useRooms();
  const mutations = useCrudMutations<{
    name: string;
    code?: string | null;
    capacity?: number | null;
    type?: RoomType;
    requiresApproval?: boolean;
  }>("/api/v1/rooms", [["rooms"]]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [deleting, setDeleting] = useState<Room | null>(null);
  const [form, setForm] = useState<RoomForm>(EMPTY_FORM);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (room: Room) => {
    setEditing(room);
    setForm({
      name: room.name,
      code: room.code ?? "",
      capacity: room.capacity !== null ? String(room.capacity) : "",
      type: room.type,
      requiresApproval: room.requiresApproval,
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const capacity = form.capacity.trim() === "" ? null : Number(form.capacity);
    const body = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      capacity: capacity !== null && Number.isFinite(capacity) ? capacity : null,
      type: form.type,
      requiresApproval: form.requiresApproval,
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
          <Button onClick={openCreate}>
            <Plus />
            {t("addRoom")}
          </Button>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !rooms || rooms.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title={tCommon("noResults")}
          description={t("empty")}
          action={
            <Button onClick={openCreate}>
              <Plus />
              {t("addRoom")}
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("name")}</TableHead>
                <TableHead>{tCommon("code")}</TableHead>
                <TableHead>{tCommon("type")}</TableHead>
                <TableHead>{tCommon("capacity")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rooms.map((room) => (
                <TableRow key={room.id}>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {room.name}
                      {room.requiresApproval ? (
                        <Badge variant="secondary">{t("approvalBadge")}</Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell>
                    {room.code ? <Badge variant="secondary">{room.code}</Badge> : "—"}
                  </TableCell>
                  <TableCell>{tTypes(room.type)}</TableCell>
                  <TableCell className="tabular-nums">{room.capacity ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(room)}
                      aria-label={tCommon("edit")}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleting(room)}
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
            <DialogTitle>{editing ? t("editRoom") : t("addRoom")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="room-name">{tCommon("name")}</Label>
              <Input
                id="room-name"
                value={form.name}
                placeholder={t("namePlaceholder")}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="room-code">
                  {tCommon("code")}{" "}
                  <span className="text-muted-foreground">({tCommon("optional")})</span>
                </Label>
                <Input
                  id="room-code"
                  value={form.code}
                  placeholder={t("codePlaceholder")}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="room-capacity">{tCommon("capacity")}</Label>
                <Input
                  id="room-capacity"
                  type="number"
                  min={1}
                  value={form.capacity}
                  onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tCommon("type")}</Label>
              <Select
                value={form.type}
                onValueChange={(value) => setForm({ ...form, type: value as RoomType })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROOM_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {tTypes(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="room-approval">{t("requiresApproval")}</Label>
                <p className="text-xs text-muted-foreground">{t("requiresApprovalHint")}</p>
              </div>
              <Switch
                id="room-approval"
                checked={form.requiresApproval}
                onCheckedChange={(checked) =>
                  setForm({ ...form, requiresApproval: checked })
                }
              />
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
