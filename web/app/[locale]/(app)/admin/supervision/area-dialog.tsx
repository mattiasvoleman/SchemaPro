"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import type { SupervisionArea } from "@/lib/supervision";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AreaBody } from "./use-supervision";

/** The select's stand-in for "no site", which a Select cannot hold as null. */
const NO_SITE = "none";

const EMPTY: AreaBody = {
  name: "",
  siteId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  duringRasts: true,
  duringLunch: false,
  guardsNeeded: 1,
  countsAsTeaching: false,
};

/** 0..10 whole rastvakter written as digits; undefined for anything else. */
export function guardsFromField(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d{1,2}$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed <= 10 ? parsed : undefined;
}

export interface AreaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The area edited; null adds one. */
  area: SupervisionArea | null;
  sites: readonly { id: string; name: string }[];
  saving: boolean;
  onSave: (body: AreaBody) => Promise<void>;
}

/**
 * Ett rastvaktsområde: its name, the skolområde it is on, whose breaks it is
 * watched in (the årskurser, rasts and lunch), how many rastvakter it needs
 * at once and whether a pass there counts as teaching. The gateway says
 * which breaks those are; the form only says what the school chose.
 *
 * The form is mounted with each opening (Radix unmounts a closed dialog's
 * content), so it starts from the area, or blank, in its first render.
 */
export function AreaDialog({ open, onOpenChange, ...rest }: AreaDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <AreaForm onOpenChange={onOpenChange} {...rest} />
      </DialogContent>
    </Dialog>
  );
}

const fromArea = (area: SupervisionArea | null): AreaBody =>
  area
    ? {
        name: area.name,
        siteId: area.siteId,
        minGradeLevel: area.minGradeLevel,
        maxGradeLevel: area.maxGradeLevel,
        duringRasts: area.duringRasts,
        duringLunch: area.duringLunch,
        guardsNeeded: area.guardsNeeded,
        countsAsTeaching: area.countsAsTeaching,
      }
    : EMPTY;

function AreaForm({ onOpenChange, area, sites, saving, onSave }: Omit<AreaDialogProps, "open">) {
  const t = useTranslations("supervision.areas");
  const tCommon = useTranslations("common");
  const [form, setForm] = useState<AreaBody>(() => fromArea(area));
  const [guards, setGuards] = useState(() => String(area?.guardsNeeded ?? 1));
  const [error, setError] = useState<string | null>(null);
  /** The gateway's refusal of the name (taken), said at the field until the name changes. */
  const [nameRefusal, setNameRefusal] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // A refused save focuses its field once the error is drawn beside it.
  const [focusRequest, setFocusRequest] = useState<{ id: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (focusRequest) formRef.current?.querySelector<HTMLElement>(`#${focusRequest.id}`)?.focus();
  }, [focusRequest]);

  const guardsNeeded = guardsFromField(guards);
  // Code points, as the table's char_length counts them.
  const nameLength = [...form.name.trim()].length;
  const nameError =
    nameLength === 0
      ? touched
        ? t("nameMissing")
        : undefined
      : nameLength > 60
        ? t("nameTooLong")
        : (nameRefusal ?? undefined);
  const valid = nameLength > 0 && nameLength <= 60 && guardsNeeded !== undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!valid || guardsNeeded === undefined) {
      // The first field that says why: the name, else the number.
      setFocusRequest({ id: nameLength === 0 || nameLength > 60 ? "supervision-area-name" : "supervision-area-guards" });
      return;
    }
    setError(null);
    try {
      await onSave({ ...form, name: form.name.trim(), guardsNeeded });
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "SUPERVISION_AREA_NAME_TAKEN") {
        setNameRefusal(t("errors.SUPERVISION_AREA_NAME_TAKEN"));
        setFocusRequest({ id: "supervision-area-name" });
        return;
      }
      setError(
        caught instanceof ApiError && caught.code && t.has(`errors.${caught.code}`)
          ? t(`errors.${caught.code}`)
          : caught instanceof Error
            ? caught.message
            : tCommon("error"),
      );
    }
  };

  return (
    <>
      <form ref={formRef} onSubmit={submit} noValidate>
        <DialogHeader>
          <DialogTitle>{area ? t("editTitle", { name: area.name }) : t("addTitle")}</DialogTitle>
          <DialogDescription>{t("dialogHint")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {error ? (
            <Notice tone="destructive" title={t("saveFailed")}>
              {error}
            </Notice>
          ) : null}
          <FormField id="supervision-area-name" label={t("name")} hint={t("nameHint")} error={nameError}>
            <Input
              value={form.name}
              required
              placeholder={t("namePlaceholder")}
              onChange={(event) => {
                setNameRefusal(null);
                setForm({ ...form, name: event.target.value });
              }}
            />
          </FormField>
          {sites.length > 0 ? (
            <FormField id="supervision-area-site" label={t("site")} optional>
              {(control) => (
                <Select
                  value={form.siteId ?? NO_SITE}
                  onValueChange={(value) => setForm({ ...form, siteId: value === NO_SITE ? null : value })}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SITE}>{t("noSite")}</SelectItem>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          ) : null}
          <GradeSpanField
            allowAll
            label={t("grades")}
            fromLabel={t("gradeFrom")}
            toLabel={t("gradeTo")}
            hint={t("gradesHint")}
            min={form.minGradeLevel}
            max={form.maxGradeLevel}
            onChange={(span) => setForm({ ...form, minGradeLevel: span.min, maxGradeLevel: span.max })}
          />
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="supervision-area-rasts">{t("duringRastsLabel")}</Label>
            <Switch
              id="supervision-area-rasts"
              checked={form.duringRasts}
              onCheckedChange={(checked) => setForm({ ...form, duringRasts: checked })}
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="space-y-1">
              <Label htmlFor="supervision-area-lunch">{t("duringLunchLabel")}</Label>
              <p id="supervision-area-lunch-hint" className="text-xs text-muted-foreground">
                {t("duringLunchHint")}
              </p>
            </div>
            <Switch
              id="supervision-area-lunch"
              aria-describedby="supervision-area-lunch-hint"
              checked={form.duringLunch}
              onCheckedChange={(checked) => setForm({ ...form, duringLunch: checked })}
            />
          </div>
          <FormField
            id="supervision-area-guards"
            label={t("guards")}
            hint={t("guardsHint")}
            error={guardsNeeded === undefined ? t("guardsInvalid") : undefined}
          >
            <Input
              inputMode="numeric"
              autoComplete="off"
              maxLength={2}
              className="w-24"
              value={guards}
              onChange={(event) => setGuards(event.target.value)}
            />
          </FormField>
          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="space-y-1">
              <Label htmlFor="supervision-area-teaching">{t("countsAsTeaching")}</Label>
              <p id="supervision-area-teaching-hint" className="text-xs text-muted-foreground">
                {t("countsAsTeachingHint")}
              </p>
            </div>
            <Switch
              id="supervision-area-teaching"
              aria-describedby="supervision-area-teaching-hint"
              checked={form.countsAsTeaching}
              onCheckedChange={(checked) => setForm({ ...form, countsAsTeaching: checked })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? tCommon("saving") : tCommon("save")}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
