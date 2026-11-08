"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { useAnalysisActions, useCostRates, useSchoolParts } from "@/lib/analysis-queries";
import { spanLabel } from "@/lib/analysis";
import { COST_CATEGORIES, type CostCategory, type SchoolPart, type SchoolPartInput } from "@/lib/analysis-types";
import { profileDecides } from "@/lib/admin-areas";
import { ApiError } from "@/lib/api";
import { useProfile, useReadOnly } from "@/components/profile-context";
import { useAnalysisText } from "@/components/analysis/use-analysis-text";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

const GRADES = Array.from({ length: 10 }, (_, index) => index);

const EMPTY: SchoolPartInput = { name: "", account: "", gradeFrom: 0, gradeTo: 3 };

/**
 * Skoldelar (kostnadsställen with a konto and their årskurser) and the school's
 * cost of an hour per personalkategori. Every administrator reads both; making,
 * changing and removing is a decision (rektor, full), as the gateway's @Decides
 * and the database's arms ask, and anybody else is told who decides.
 *
 * A rate is a category's, never a person's: no salary is stored, and nothing on
 * this card names anyone.
 */
export function SettingsPanel() {
  const { t, number, category } = useAnalysisText();
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const me = useProfile().profile;
  const decides = profileDecides(me?.adminProfile === undefined ? "FULL" : me.adminProfile) && !readOnly;
  const parts = useSchoolParts();
  const rates = useCostRates();
  const actions = useAnalysisActions();

  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<SchoolPartInput>(EMPTY);
  const [removing, setRemoving] = useState<SchoolPart | null>(null);
  const [rateDraft, setRateDraft] = useState<Partial<Record<CostCategory, string>>>({});

  const fail = (error: unknown) =>
    toast.error(error instanceof ApiError || error instanceof Error ? error.message : tCommon("error"));

  const savePart = async () => {
    if (actions.createPart.isPending || actions.updatePart.isPending) return;
    try {
      if (editing === null) await actions.createPart.mutateAsync(form);
      else await actions.updatePart.mutateAsync({ id: editing, ...form });
      toast.success(t("settings.parts.saved"));
      setEditing(null);
      setForm(EMPTY);
    } catch (error) {
      fail(error);
    }
  };

  const removePart = async () => {
    if (!removing) return;
    try {
      await actions.removePart.mutateAsync(removing.id);
      toast.success(t("settings.parts.removed"));
    } catch (error) {
      fail(error);
    } finally {
      setRemoving(null);
    }
  };

  const saveRate = async (one: CostCategory) => {
    const text = (rateDraft[one] ?? "").replace(",", ".").trim();
    const value = Number(text);
    if (text === "" || !Number.isFinite(value) || value < 0 || value > 100_000) {
      toast.error(t("settings.rates.invalid"));
      return;
    }
    try {
      await actions.putRate.mutateAsync({ category: one, hourlyCost: Math.round(value * 100) / 100 });
      setRateDraft((current) => ({ ...current, [one]: undefined }));
      toast.success(t("settings.rates.saved", { category: category(one) }));
    } catch (error) {
      fail(error);
    }
  };

  const removeRate = async (one: CostCategory) => {
    try {
      await actions.removeRate.mutateAsync(one);
      setRateDraft((current) => ({ ...current, [one]: undefined }));
      toast.success(t("settings.rates.removed", { category: category(one) }));
    } catch (error) {
      fail(error);
    }
  };

  const valid = form.name.trim() !== "" && form.account.trim() !== "" && form.gradeFrom <= form.gradeTo;
  const gradeLabel = (grade: number): string => (grade === 0 ? t("settings.parts.preschool") : String(grade));

  return (
    <div className="space-y-4">
      <SectionCard id="analysis-parts" title={t("settings.parts.title")} description={t("settings.parts.description")}>
        {parts.isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : parts.isError || !parts.data ? (
          <LoadError variant="inline" title={t("settings.parts.loadFailed")} hint={t("loadFailedHint")} />
        ) : (
          <div className="space-y-4">
            {parts.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("settings.parts.empty")}</p>
            ) : (
              <TableCard caption={t("settings.parts.caption")} tableClassName="min-w-[32rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t("settings.parts.name")}</TableHead>
                    <TableHead scope="col">{t("settings.parts.account")}</TableHead>
                    <TableHead scope="col">{t("settings.parts.grades")}</TableHead>
                    <TableHead scope="col">
                      <span className="sr-only">{t("settings.parts.actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parts.data.map((part) => (
                    <TableRow key={part.id}>
                      <TableCell className="font-medium">{part.name}</TableCell>
                      <TableCell className="tabular-nums">{part.account}</TableCell>
                      <TableCell>{spanLabel(part)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2" data-writes-inert="DECIDES">
                          <Button
                            variant="outline"
                            size="sm"
                            data-writes="DECIDES"
                            disabled={!decides}
                            onClick={() => {
                              setEditing(part.id);
                              setForm({ name: part.name, account: part.account, gradeFrom: part.gradeFrom, gradeTo: part.gradeTo });
                            }}
                          >
                            {tCommon("edit")}
                          </Button>
                          <Button
                            variant="outline"
                            size="icon"
                            data-writes="DECIDES"
                            disabled={!decides}
                            aria-label={t("settings.parts.remove", { name: part.name })}
                            onClick={() => setRemoving(part)}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableCard>
            )}

            <fieldset className="space-y-3 border-t pt-4" data-writes-inert="DECIDES">
              <legend className="text-sm font-medium">{editing === null ? t("settings.parts.add") : t("settings.parts.edit")}</legend>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <FormField id="analysis-part-name" label={t("settings.parts.name")}>
                  <Input value={form.name} maxLength={100} disabled={!decides} onChange={(event) => setForm({ ...form, name: event.target.value })} />
                </FormField>
                <FormField id="analysis-part-account" label={t("settings.parts.account")} hint={t("settings.parts.accountHint")}>
                  <Input value={form.account} maxLength={30} disabled={!decides} onChange={(event) => setForm({ ...form, account: event.target.value })} />
                </FormField>
                <FormField id="analysis-part-from" label={t("settings.parts.from")}>
                  <NativeSelect value={form.gradeFrom} disabled={!decides} onChange={(event) => setForm({ ...form, gradeFrom: Number(event.target.value) })}>
                    {GRADES.map((grade) => (
                      <option key={grade} value={grade}>
                        {gradeLabel(grade)}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField id="analysis-part-to" label={t("settings.parts.to")}>
                  <NativeSelect value={form.gradeTo} disabled={!decides} onChange={(event) => setForm({ ...form, gradeTo: Number(event.target.value) })}>
                    {GRADES.map((grade) => (
                      <option key={grade} value={grade}>
                        {gradeLabel(grade)}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button data-writes="DECIDES" disabled={!decides || !valid || actions.createPart.isPending || actions.updatePart.isPending} onClick={() => void savePart()}>
                  {editing === null ? t("settings.parts.addButton") : tCommon("save")}
                </Button>
                {editing !== null ? (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                      setForm(EMPTY);
                    }}
                  >
                    {tCommon("cancel")}
                  </Button>
                ) : null}
              </div>
              {!decides ? <p className="text-sm text-muted-foreground">{t("settings.deciders")}</p> : null}
            </fieldset>
          </div>
        )}
      </SectionCard>

      <SectionCard id="analysis-rates" title={t("settings.rates.title")} description={t("settings.rates.description")}>
        {rates.isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-32 w-full" />
          </div>
        ) : rates.isError || !rates.data ? (
          <LoadError variant="inline" title={t("settings.rates.loadFailed")} hint={t("loadFailedHint")} />
        ) : (
          <div className="space-y-3" data-writes-inert="DECIDES">
            {COST_CATEGORIES.map((one) => {
              const stated = rates.data.find((rate) => rate.category === one);
              const draft = rateDraft[one];
              const shown = draft ?? (stated ? number(stated.hourlyCost, 2).replace(/\s/g, "") : "");
              return (
                <div key={one} className="flex flex-wrap items-end gap-3">
                  <FormField id={`analysis-rate-${one}`} label={category(one)} hint={t(`settings.rates.hint.${one}`)} className="min-w-64 flex-1">
                    <Input
                      inputMode="decimal"
                      value={shown}
                      placeholder={t("settings.rates.unset")}
                      disabled={!decides}
                      onChange={(event) => setRateDraft((current) => ({ ...current, [one]: event.target.value }))}
                    />
                  </FormField>
                  <span className="pb-2 text-sm text-muted-foreground">{t("settings.rates.unit")}</span>
                  <Button data-writes="DECIDES" disabled={!decides || draft === undefined || actions.putRate.isPending} onClick={() => void saveRate(one)}>
                    {tCommon("save")}
                  </Button>
                  <Button
                    variant="outline"
                    data-writes="DECIDES"
                    disabled={!decides || !stated || actions.removeRate.isPending}
                    onClick={() => void removeRate(one)}
                  >
                    {t("settings.rates.remove")}
                  </Button>
                </div>
              );
            })}
            {!decides ? <p className="text-sm text-muted-foreground">{t("settings.deciders")}</p> : null}
          </div>
        )}
      </SectionCard>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("settings.parts.confirmTitle", { name: removing?.name ?? "" })}
        description={t("settings.parts.confirmBody")}
        confirmLabel={tCommon("delete")}
        destructive
        loading={actions.removePart.isPending}
        onConfirm={() => void removePart()}
      />
    </div>
  );
}
