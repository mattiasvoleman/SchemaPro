"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { MapPin, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useCrudMutations, useRooms , useRoomTypes } from "@/lib/queries";
import { LazyCsvImportDialog } from "@/components/import/lazy-csv-import-dialog";
import { CsvExportButton } from "@/components/import/csv-export-button";
import { roomTypesToCsv } from "@/lib/csv-export";
import { SCHOOL_STAGES, gradeRangeLabel, stageOf } from "@/lib/school-stages";
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

interface RoomForm {
  name: string;
  code: string;
  capacity: string;
  roomTypeId: string;
  /** "" = no limit; otherwise a stage key or "custom". */
  stage: string;
  minGradeLevel: string;
  maxGradeLevel: string;
  requiresApproval: boolean;
  building: string;
  floor: string;
}

const NO_LIMIT = "none";
const CUSTOM_RANGE = "custom";

const EMPTY_FORM: RoomForm = {
  name: "",
  code: "",
  capacity: "",
  roomTypeId: "",
  stage: NO_LIMIT,
  minGradeLevel: "",
  maxGradeLevel: "",
  requiresApproval: false,
  building: "",
  floor: "",
};

/** The range the database accepts, so the form refuses what the API would. */
const MIN_FLOOR = -5;
const MAX_FLOOR = 50;

/**
 * The floor a form describes: null when left empty, undefined when it is not
 * a floor at all.
 *
 * Empty is a real answer — "we have not said" — and must reach the API as
 * null rather than 0, because floor 0 is a floor and the optimisation would
 * count a walk from it to every room on floor 1.
 */
function floorFromForm(form: RoomForm): number | null | undefined {
  const value = form.floor.trim();
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= MIN_FLOOR && parsed <= MAX_FLOOR
    ? parsed
    : undefined;
}

/**
 * The year range a form describes.
 *
 * A preset writes both ends; "eget intervall" takes whatever the two fields
 * hold, with an empty field meaning "open at that end" rather than zero —
 * year 0 is förskoleklass and a real answer.
 */
function gradeRangeFromForm(form: RoomForm): {
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
} {
  if (form.stage === NO_LIMIT) return { minGradeLevel: null, maxGradeLevel: null };

  const preset = SCHOOL_STAGES.find((stage) => stage.key === form.stage);
  if (preset) {
    return {
      minGradeLevel: preset.minGradeLevel,
      maxGradeLevel: preset.maxGradeLevel,
    };
  }

  const parse = (value: string) => {
    if (value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    minGradeLevel: parse(form.minGradeLevel),
    maxGradeLevel: parse(form.maxGradeLevel),
  };
}

/**
 * "Hus A · plan 2", "plan 2", "Hus A" or "—".
 *
 * Floor 0 is tested against null, not for truthiness: a ground floor called 0
 * is a place, and dropping it would show the room as unplaced.
 */
function placeLabel(room: Room, floorLabel: (floor: number) => string): string {
  const parts = [room.building, room.floor !== null ? floorLabel(room.floor) : null].filter(
    (part): part is string => part !== null && part !== "",
  );
  return parts.length > 0 ? parts.join(" · ") : "—";
}

export default function RoomsPage() {
  const t = useTranslations("rooms");
  const tCsvImport = useTranslations("csvImport");
  const tCommon = useTranslations("common");
  const { data: roomTypes } = useRoomTypes();
  const roomTypeById = useMemo(
    () => new Map((roomTypes ?? []).map((rt: RoomType) => [rt.id, rt] as const)),
    [roomTypes],
  );
  const { data: rooms, isLoading } = useRooms();
  const mutations = useCrudMutations<{
    name: string;
    code?: string | null;
    capacity?: number | null;
    roomTypeId?: string | null;
    requiresApproval?: boolean;
    building?: string | null;
    floor?: number | null;
  }>("/api/v1/rooms", [["rooms"]]);

  const [importOpen, setImportOpen] = useState(false);
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
      stage:
        room.minGradeLevel === null && room.maxGradeLevel === null
          ? NO_LIMIT
          : (stageOf(room.minGradeLevel, room.maxGradeLevel)?.key ?? CUSTOM_RANGE),
      minGradeLevel: room.minGradeLevel !== null ? String(room.minGradeLevel) : "",
      maxGradeLevel: room.maxGradeLevel !== null ? String(room.maxGradeLevel) : "",
      roomTypeId: room.roomTypeId ?? "",
      requiresApproval: room.requiresApproval,
      building: room.building ?? "",
      floor: room.floor !== null ? String(room.floor) : "",
    });
    setDialogOpen(true);
  };

  const floor = floorFromForm(form);

  const submit = async () => {
    if (floor === undefined) return;
    const capacity = form.capacity.trim() === "" ? null : Number(form.capacity);
    const body = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      capacity: capacity !== null && Number.isFinite(capacity) ? capacity : null,
      roomTypeId: form.roomTypeId === "" ? null : form.roomTypeId,
      ...gradeRangeFromForm(form),
      requiresApproval: form.requiresApproval,
      // Sent on every save, emptied ones included: leaving the key out would
      // keep the old building when a school clears the field.
      building: form.building.trim() || null,
      floor,
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
                  kind: "roomTypes",
                  build: () => roomTypesToCsv(roomTypes ?? []),
                  empty: !roomTypes || roomTypes.length === 0,
                },
              ]}
            />
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload />
              {tCsvImport("button")}
            </Button>
            <Button onClick={openCreate}>
              <Plus />
              {t("addRoom")}
            </Button>
          </>
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
                <TableHead>{t("stageColumn")}</TableHead>
                <TableHead>{t("placeColumn")}</TableHead>
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
                  <TableCell>
                    {roomTypeById.get(room.roomTypeId ?? "")?.name ?? "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">{room.capacity ?? "—"}</TableCell>
                  <TableCell>
                    {gradeRangeLabel(room.minGradeLevel, room.maxGradeLevel, (key) =>
                      t(`stages.${key}`),
                    ) ?? "—"}
                  </TableCell>
                  <TableCell>
                    {placeLabel(room, (value) => t("floorShort", { floor: value }))}
                  </TableCell>
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
                value={form.roomTypeId}
                onValueChange={(value) => setForm({ ...form, roomTypeId: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(roomTypes ?? []).map((roomType: RoomType) => (
                    <SelectItem key={roomType.id} value={roomType.id}>
                      {roomType.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="room-stage">{t("stageLabel")}</Label>
              <Select
                value={form.stage}
                onValueChange={(value) => setForm({ ...form, stage: value })}
              >
                <SelectTrigger id="room-stage" aria-label={t("stageLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_LIMIT}>{t("stageNone")}</SelectItem>
                  {SCHOOL_STAGES.map((stage) => (
                    <SelectItem key={stage.key} value={stage.key}>
                      {t(`stages.${stage.key}`)}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_RANGE}>{t("stageCustom")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("stageHint")}</p>
            </div>

            {form.stage === CUSTOM_RANGE ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="room-min-grade">{t("stageFrom")}</Label>
                  <Input
                    id="room-min-grade"
                    type="number"
                    min={0}
                    max={12}
                    value={form.minGradeLevel}
                    onChange={(e) => setForm({ ...form, minGradeLevel: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="room-max-grade">{t("stageTo")}</Label>
                  <Input
                    id="room-max-grade"
                    type="number"
                    min={0}
                    max={12}
                    value={form.maxGradeLevel}
                    onChange={(e) => setForm({ ...form, maxGradeLevel: e.target.value })}
                  />
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="room-building">
                    {t("building")}{" "}
                    <span className="text-muted-foreground">({tCommon("optional")})</span>
                  </Label>
                  <Input
                    id="room-building"
                    value={form.building}
                    maxLength={60}
                    placeholder={t("buildingPlaceholder")}
                    onChange={(e) => setForm({ ...form, building: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="room-floor">
                    {t("floor")}{" "}
                    <span className="text-muted-foreground">({tCommon("optional")})</span>
                  </Label>
                  <Input
                    id="room-floor"
                    type="number"
                    step={1}
                    min={MIN_FLOOR}
                    max={MAX_FLOOR}
                    value={form.floor}
                    placeholder={t("floorPlaceholder")}
                    aria-invalid={floor === undefined}
                    onChange={(e) => setForm({ ...form, floor: e.target.value })}
                  />
                </div>
              </div>
              {floor === undefined ? (
                <p className="text-xs text-destructive">{t("floorInvalid")}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("placeHint")}</p>
              )}
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
                floor === undefined ||
                mutations.create.isPending ||
                mutations.update.isPending
              }
            >
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LazyCsvImportDialog
        kinds={["roomTypes"]}
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
