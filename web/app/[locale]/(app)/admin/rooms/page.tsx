"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { MapPin, Pencil, Plus, Trash2, Upload } from "lucide-react";
import { useCrudMutations, useRooms, useRoomTypes } from "@/lib/queries";
import { LazyCsvImportDialog } from "@/components/import/lazy-csv-import-dialog";
import { CsvExportButton } from "@/components/import/csv-export-button";
import { roomTypesToCsv } from "@/lib/csv-export";
import { SCHOOL_STAGES, gradeRangeLabel, stageOf } from "@/lib/school-stages";
import type { Room, RoomType } from "@/lib/types";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { RowActions } from "@/components/ui/row-actions";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
  const { data: roomTypes, isError: roomTypesFailed } = useRoomTypes();
  const roomTypeById = useMemo(
    () => new Map((roomTypes ?? []).map((rt: RoomType) => [rt.id, rt] as const)),
    [roomTypes],
  );
  const { data: rooms, isLoading, isError } = useRooms();
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
    <Page>
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
            <Button data-writes="PLANERING" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload />
              {tCsvImport("button")}
            </Button>
            <Button data-writes="PLANERING" onClick={openCreate}>
              <Plus />
              {t("addRoom")}
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !rooms || rooms.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title={t("emptyTitle")}
          description={t("empty")}
          headingLevel={2}
          action={
            <Button data-writes="PLANERING" onClick={openCreate}>
              <Plus />
              {t("addRoom")}
            </Button>
          }
        />
      ) : (
        <>
          {roomTypesFailed ? (
            // The Typ column is read from the room types, a list of its own: a
            // dash there would claim the rooms have no type.
            <LoadError variant="inline" title={t("typesFailed")} hint={t("typesFailedHint")} />
          ) : null}
          <TableCard caption={t("tableCaption")}>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("name")}</TableHead>
                <TableHead>{tCommon("code")}</TableHead>
                <TableHead>{tCommon("type")}</TableHead>
                <TableHead className="text-right">{tCommon("capacity")}</TableHead>
                <TableHead>{t("stageColumn")}</TableHead>
                <TableHead>{t("placeColumn")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rooms.map((room) => {
                const type = roomTypeById.get(room.roomTypeId ?? "")?.name ?? null;
                const stage = gradeRangeLabel(room.minGradeLevel, room.maxGradeLevel, (key) =>
                  t(`stages.${key}`),
                );
                const place = placeLabel(room, (value) => t("floorShort", { floor: value }));
                return (
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
                      {room.code ? <Badge variant="secondary">{room.code}</Badge> : <Empty />}
                    </TableCell>
                    <TableCell>{type ?? <Empty />}</TableCell>
                    <TableCell className="text-right tabular-nums">{room.capacity ?? <Empty />}</TableCell>
                    <TableCell>{stage ?? <Empty />}</TableCell>
                    <TableCell>{place === "—" ? <Empty /> : place}</TableCell>
                    <TableCell className="text-right">
                      {/* Both actions write: RowActions takes no attribute, so the wrapper carries it. */}
                      <div data-writes="PLANERING" className="contents">
                        <RowActions
                          name={room.name}
                          actions={[
                            {
                              label: tCommon("edit"),
                              icon: Pencil,
                              ariaLabel: tCommon("editNamed", { name: room.name }),
                              onSelect: () => openEdit(room),
                            },
                            {
                              label: tCommon("delete"),
                              icon: Trash2,
                              ariaLabel: tCommon("deleteNamed", { name: room.name }),
                              onSelect: () => setDeleting(room),
                            },
                          ]}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </TableCard>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editRoom") : t("addRoom")}</DialogTitle>
            <DialogDescription>{t("dialogHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <FormField id="room-name" label={tCommon("name")}>
              <Input
                value={form.name}
                placeholder={t("namePlaceholder")}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="room-code" label={tCommon("code")} optional>
                <Input
                  value={form.code}
                  placeholder={t("codePlaceholder")}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </FormField>
              <FormField id="room-capacity" label={tCommon("capacity")}>
                <Input
                  type="number"
                  min={1}
                  value={form.capacity}
                  onChange={(e) => setForm({ ...form, capacity: e.target.value })}
                />
              </FormField>
            </div>
            <FormField id="room-type" label={tCommon("type")}>
              {(control) => (
                <Select
                  value={form.roomTypeId}
                  onValueChange={(value) => setForm({ ...form, roomTypeId: value })}
                >
                  <SelectTrigger {...control}>
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
              )}
            </FormField>
            <FormField id="room-stage" label={t("stageLabel")} hint={t("stageHint")}>
              {(control) => (
                <Select
                  value={form.stage}
                  onValueChange={(value) => setForm({ ...form, stage: value })}
                >
                  <SelectTrigger {...control}>
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
              )}
            </FormField>

            {form.stage === CUSTOM_RANGE ? (
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <FormField id="room-min-grade" label={t("stageFrom")}>
                  <Input
                    type="number"
                    min={0}
                    max={12}
                    value={form.minGradeLevel}
                    onChange={(e) => setForm({ ...form, minGradeLevel: e.target.value })}
                  />
                </FormField>
                <FormField id="room-max-grade" label={t("stageTo")}>
                  <Input
                    type="number"
                    min={0}
                    max={12}
                    value={form.maxGradeLevel}
                    onChange={(e) => setForm({ ...form, maxGradeLevel: e.target.value })}
                  />
                </FormField>
              </div>
            ) : null}

            {/* One hint for the pair, read by both fields; the floor's own rule
                sits under the floor, where the wrong value was typed. */}
            <div className="space-y-1.5">
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <FormField id="room-building" label={t("building")} optional>
                  <Input
                    value={form.building}
                    maxLength={60}
                    placeholder={t("buildingPlaceholder")}
                    aria-describedby="room-place-hint"
                    onChange={(e) => setForm({ ...form, building: e.target.value })}
                  />
                </FormField>
                <FormField
                  id="room-floor"
                  label={t("floor")}
                  optional
                  error={floor === undefined ? t("floorInvalid") : undefined}
                >
                  <Input
                    type="number"
                    step={1}
                    min={MIN_FLOOR}
                    max={MAX_FLOOR}
                    value={form.floor}
                    placeholder={t("floorPlaceholder")}
                    aria-describedby="room-place-hint"
                    onChange={(e) => setForm({ ...form, floor: e.target.value })}
                  />
                </FormField>
              </div>
              <p id="room-place-hint" className="text-xs text-muted-foreground">
                {t("placeHint")}
              </p>
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
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
    </Page>
  );
}

/** An empty cell: the em dash, muted, so it reads as "nothing here" and not as data. */
function Empty() {
  return <span className="text-muted-foreground">—</span>;
}
