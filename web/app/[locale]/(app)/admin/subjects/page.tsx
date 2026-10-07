"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { BookOpen, Pencil, Plus, Trash2, Upload } from "lucide-react";
import {
  useCrudMutations,
  useNationalTimplans,
  useSubjects,
  useRoomTypes,
  useRoomTypeActions,
} from "@/lib/queries";
import type { NationalSubject, RoomType, Subject } from "@/lib/types";
import { sectionNationalSubjects } from "@/lib/national-subjects";
import { LazyCsvImportDialog } from "@/components/import/lazy-csv-import-dialog";
import { subjectsToCsv } from "@/lib/csv-export";
import { CsvExportButton } from "@/components/import/csv-export-button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SubjectForm {
  name: string;
  code: string;
  color: string;
  requiredRoomTypeId: string;
  /** A NationalSubject.code, or OUTSIDE_TIMPLAN for null. */
  nationalCode: string;
  countsTowardTimplan: boolean;
}

const ANY_ROOM = "__any__";
const ADD_NEW = "__add__";
/**
 * The null option of the national-code picker. A Radix Select cannot hold an
 * empty string as a value, so "outside the timplan" needs a sentinel the same
 * way "any room" does; it is turned back into null at the API boundary.
 */
const OUTSIDE_TIMPLAN = "__outside__";

const EMPTY_FORM: SubjectForm = {
  name: "",
  code: "",
  color: "#6366f1",
  requiredRoomTypeId: ANY_ROOM,
  nationalCode: OUTSIDE_TIMPLAN,
  // On by default: the flag exists for the few subjects that are NOT teaching
  // time (Mentorstid, Resurs), and a new subject is a taught one until said
  // otherwise — which is also the column's own default.
  countsTowardTimplan: true,
};

/** "Matematik (MA)" — the statute's name with the code the CSV column takes. */
const nationalLabel = (subject: NationalSubject) => `${subject.name} (${subject.code})`;

export default function SubjectsPage() {
  const t = useTranslations("subjects");
  const tCommon = useTranslations("common");
  const tCsvImport = useTranslations("csvImport");
  const { data: subjects, isLoading } = useSubjects();
  const mutations = useCrudMutations<{
    name: string;
    code?: string | null;
    color?: string | null;
    requiredRoomTypeId?: string | null;
    nationalCode?: string | null;
    countsTowardTimplan?: boolean;
  }>("/api/v1/subjects", [["subjects"]]);

  const { data: roomTypes } = useRoomTypes();
  const roomTypeActions = useRoomTypeActions();
  const nationalTimplans = useNationalTimplans();
  const nationalSections = sectionNationalSubjects(nationalTimplans.data?.subjects ?? []);
  const nationalByCode = new Map(
    (nationalTimplans.data?.subjects ?? []).map((subject) => [subject.code, subject]),
  );
  /**
   * Exports what is on screen, in the importer's own format, so the file can
   * be edited and uploaded straight back.
   */
  const exportCsv = () => {
    const named = (id: string | null) =>
      id ? (roomTypes?.find((type) => type.id === id)?.name ?? "") : "";
    return subjectsToCsv(subjects ?? [], named);
  };

  const [creatingType, setCreatingType] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");

  const [importOpen, setImportOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Subject | null>(null);
  const [deleting, setDeleting] = useState<Subject | null>(null);
  const [form, setForm] = useState<SubjectForm>(EMPTY_FORM);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (subject: Subject) => {
    setEditing(subject);
    setForm({
      name: subject.name,
      code: subject.code ?? "",
      color: subject.color ?? "#6366f1",
      requiredRoomTypeId: subject.requiredRoomTypeId ?? ANY_ROOM,
      nationalCode: subject.nationalCode ?? OUTSIDE_TIMPLAN,
      countsTowardTimplan: subject.countsTowardTimplan,
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      name: form.name.trim(),
      code: form.code.trim() || null,
      color: form.color,
      requiredRoomTypeId:
        form.requiredRoomTypeId === ANY_ROOM ? null : form.requiredRoomTypeId,
      // Sent on every save, null included: an absent key keeps the old
      // mapping, and "Utanför timplanen" is a decision, not an omission.
      nationalCode: form.nationalCode === OUTSIDE_TIMPLAN ? null : form.nationalCode,
      countsTowardTimplan: form.countsTowardTimplan,
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
                  kind: "subjects",
                  build: exportCsv,
                  empty: !subjects || subjects.length === 0,
                },
              ]}
            />
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload />
              {tCsvImport("button")}
            </Button>
            <Button onClick={openCreate}>
              <Plus />
              {t("addSubject")}
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
      ) : !subjects || subjects.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title={tCommon("noResults")}
          description={t("empty")}
          action={
            <Button onClick={openCreate}>
              <Plus />
              {t("addSubject")}
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
                <TableHead>{t("nationalCode")}</TableHead>
                <TableHead>{tCommon("color")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {subjects.map((subject) => (
                <TableRow key={subject.id}>
                  <TableCell className="font-medium">{subject.name}</TableCell>
                  <TableCell>
                    {subject.code ? <Badge variant="secondary">{subject.code}</Badge> : "—"}
                  </TableCell>
                  <TableCell>
                    {/*
                      The badge is the mitigation the design names for the
                      one mapping mistake that looks like a deficit: a school
                      that mapped Svenska and forgot SvA sees the gap here,
                      on the row, before any coverage page says "under mål".
                    */}
                    <span className="inline-flex flex-wrap items-center gap-1">
                      {subject.nationalCode ? (
                        <Badge
                          variant="outline"
                          className="px-1.5 py-0 font-mono text-[11px]"
                          title={
                            nationalByCode.get(subject.nationalCode)?.name ?? undefined
                          }
                        >
                          {subject.nationalCode}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                      {subject.countsTowardTimplan ? null : (
                        <Badge variant="warning" className="px-1.5 py-0 text-[11px]">
                          {t("notTeachingTime")}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className="inline-block h-4 w-4 rounded-full border align-middle"
                      style={{ backgroundColor: subject.color ?? "#6366f1" }}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(subject)}
                      aria-label={tCommon("edit")}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setDeleting(subject)}
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
            <DialogTitle>{editing ? t("editSubject") : t("addSubject")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="subject-name">{tCommon("name")}</Label>
              <Input
                id="subject-name"
                value={form.name}
                placeholder={t("namePlaceholder")}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="subject-code">
                  {tCommon("code")}{" "}
                  <span className="text-muted-foreground">({tCommon("optional")})</span>
                </Label>
                <Input
                  id="subject-code"
                  value={form.code}
                  placeholder={t("codePlaceholder")}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="subject-color">{tCommon("color")}</Label>
                <Input
                  id="subject-color"
                  type="color"
                  className="h-9 w-full p-1"
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>
                {t("requiredRoomType")}{" "}
                <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Select
                value={form.requiredRoomTypeId}
                onValueChange={(value) => {
                  // The picker doubles as the place to coin a missing type,
                  // which is where an administrator actually notices one is
                  // missing: while saying "Slöjd needs a slöjdsal".
                  if (value === ADD_NEW) {
                    setCreatingType(true);
                    return;
                  }
                  setForm({ ...form, requiredRoomTypeId: value });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY_ROOM}>{t("anyRoomType")}</SelectItem>
                  {(roomTypes ?? []).map((roomType: RoomType) => (
                    <SelectItem key={roomType.id} value={roomType.id}>
                      {roomType.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={ADD_NEW}>{t("addRoomType")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("requiredRoomTypeHint")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="subject-national-code">{t("nationalCode")}</Label>
              <Select
                value={form.nationalCode}
                onValueChange={(value) => setForm({ ...form, nationalCode: value })}
              >
                <SelectTrigger id="subject-national-code">
                  {/*
                    The shown value is computed here rather than left to the
                    selected item's text: while the statute document is still
                    loading (or failed to), no item matches a stored code, and
                    Radix would then show an EMPTY trigger — which for a mapped
                    subject reads as "Utanför timplanen". The bare code is the
                    honest fallback until the names arrive.
                  */}
                  <SelectValue>
                    {form.nationalCode === OUTSIDE_TIMPLAN
                      ? t("nationalCodeNone")
                      : (() => {
                          const known = nationalByCode.get(form.nationalCode);
                          return known ? nationalLabel(known) : form.nationalCode;
                        })()}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={OUTSIDE_TIMPLAN}>{t("nationalCodeNone")}</SelectItem>
                  {nationalSections.map((section) =>
                    section.group === null ? (
                      section.options.map((option) => (
                        <SelectItem key={option.code} value={option.code}>
                          {nationalLabel(option)}
                        </SelectItem>
                      ))
                    ) : (
                      // One section per ämnesgrupp, the group itself first:
                      // lågstadiet teaches NO as one subject and maps to the
                      // group, högstadiet teaches Kemi and maps to the child.
                      <SelectGroup key={section.group.code}>
                        <SelectLabel>{section.group.name}</SelectLabel>
                        {section.options.map((option) => (
                          <SelectItem key={option.code} value={option.code}>
                            {nationalLabel(option)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ),
                  )}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {nationalTimplans.isError ? t("nationalCodeUnavailable") : t("nationalCodeHint")}
              </p>
            </div>
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="subject-counts-toward-timplan">{t("countsTowardTimplan")}</Label>
                <p className="text-xs text-muted-foreground">{t("countsTowardTimplanHint")}</p>
              </div>
              <Switch
                id="subject-counts-toward-timplan"
                checked={form.countsTowardTimplan}
                onCheckedChange={(checked) => setForm({ ...form, countsTowardTimplan: checked })}
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

      {/* Coining a room type without leaving the subject form. */}
      <Dialog open={creatingType} onOpenChange={setCreatingType}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("addRoomType")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-room-type">{t("roomTypeName")}</Label>
            <Input
              id="new-room-type"
              value={newTypeName}
              onChange={(event) => setNewTypeName(event.target.value)}
              placeholder={t("roomTypePlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreatingType(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              disabled={!newTypeName.trim() || roomTypeActions.create.isPending}
              onClick={async () => {
                try {
                  const created = (await roomTypeActions.create.mutateAsync({
                    name: newTypeName.trim(),
                  })) as RoomType;
                  // Select what was just created, so the administrator is back
                  // exactly where they were interrupted.
                  setForm({ ...form, requiredRoomTypeId: created.id });
                  setNewTypeName("");
                  setCreatingType(false);
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : tCommon("error"),
                  );
                }
              }}
            >
              {tCommon("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <LazyCsvImportDialog
        kinds={["subjects"]}
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
