"use client";

import { useEffect, useState, type FormEvent } from "react";
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
 */
export function AreaDialog({ open, onOpenChange, area, sites, saving, onSave }: AreaDialogProps) {
  const t = useTranslations("supervision.areas");
  const tCommon = useTranslations("common");
  const [form, setForm] = useState<AreaBody>(EMPTY);
  const [guards, setGuards] = useState("1");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (area) {
      setForm({
        name: area.name,
        siteId: area.siteId,
        minGradeLevel: area.minGradeLevel,
        maxGradeLevel: area.maxGradeLevel,
        duringRasts: area.duringRasts,
        duringLunch: area.duringLunch,
        guardsNeeded: area.guardsNeeded,
        countsAsTeaching: area.countsAsTeaching,
      });
      setGuards(String(area.guardsNeeded));
    } else {
      setForm(EMPTY);
      setGuards("1");
    }
  }, [open, area]);

  const guardsNeeded = guardsFromField(guards);
  const valid = form.name.trim() !== "" && guardsNeeded !== undefined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || guardsNeeded === undefined) return;
    setError(null);
    try {
      await onSave({ ...form, name: form.name.trim(), guardsNeeded });
      onOpenChange(false);
    } catch (caught) {
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} noValidate>
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
            <FormField id="supervision-area-name" label={t("name")}>
              <Input
                value={form.name}
                required
                maxLength={60}
                placeholder={t("namePlaceholder")}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
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
            <Button type="submit" disabled={!valid || saving}>
              {saving ? tCommon("saving") : tCommon("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
