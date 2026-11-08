"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useMealActions, useMealSettings } from "@/lib/meal-counts-queries";
import { changeOf, formOf, formProblem, letterPossible, type MealSettings, type MealSettingsForm } from "@/lib/meal-counts";
import { useMealsText } from "@/components/meals/use-meals-text";
import { useReadOnly } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

/**
 * The cut-off, the kitchen's address and the switch for the daily letter. Off until an administrator
 * turns it on, per school; it needs an hour and one address, which the form says before it asks the
 * gateway. One Save writes what differs. A läsare (Läsbehörighet) sees the fields set and cannot change them.
 * The page says what the letter holds, because turning it on starts a mail: counts and the names of
 * classes, never a pupil.
 */
export function SettingsCard() {
  const { t } = useMealsText();
  const settings = useMealSettings();

  return (
    <SectionCard id="meals-settings" title={t("settings.title")} description={t("settings.description")} className="print:hidden">
      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : settings.isError || !settings.data ? (
        <LoadError variant="inline" title={t("settings.loadFailed")} hint={t("settings.loadFailedHint")} />
      ) : (
        // Keyed by what is stored, so the fields start from a save's answer and not from the one before it.
        <SettingsForm key={JSON.stringify(settings.data)} stored={settings.data} />
      )}
    </SectionCard>
  );
}

function SettingsForm({ stored }: { stored: MealSettings }) {
  const { t, long } = useMealsText();
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const { updateSettings } = useMealActions();
  const [form, setForm] = useState<MealSettingsForm>(() => formOf(stored));
  const problem = formProblem(form);
  const change = changeOf(form, stored);
  const dirty = Object.keys(change).length > 0;
  const possible = letterPossible(form);

  const save = async () => {
    // One save at a time; a press meanwhile does nothing.
    if (updateSettings.isPending || problem !== null || !dirty) return;
    try {
      await updateSettings.mutateAsync(change);
      toast.success(t("settings.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2" data-writes-inert="DRIFT">
        <FormField
          id="meals-cutoff"
          label={t("settings.cutoffLabel")}
          hint={t("settings.cutoffHint")}
          error={problem === "cutoff" ? t("settings.problem.cutoff") : undefined}
        >
          <Input
            type="time"
            step={60}
            value={form.cutoff}
            disabled={readOnly}
            onChange={(event) => setForm({ ...form, cutoff: event.target.value })}
          />
        </FormField>
        <FormField
          id="meals-email"
          label={t("settings.emailLabel")}
          hint={t("settings.emailHint")}
          error={problem === "email" ? t("settings.problem.email") : undefined}
        >
          <Input
            type="email"
            inputMode="email"
            autoComplete="off"
            maxLength={254}
            value={form.email}
            disabled={readOnly}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </FormField>
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-3" data-writes-inert="DRIFT">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="meals-letter">{t("settings.letterLabel")}</Label>
          <p id="meals-letter-hint" className={problem === "letter" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {problem === "letter"
              ? t("settings.problem.letter")
              : form.enabled
                ? t("settings.letterOn", { time: form.cutoff })
                : possible
                  ? t("settings.letterOff")
                  : t("settings.letterNeeds")}
          </p>
        </div>
        <Switch
          id="meals-letter"
          checked={form.enabled}
          disabled={readOnly || (!form.enabled && !possible)}
          aria-describedby="meals-letter-hint"
          onCheckedChange={(on) => setForm({ ...form, enabled: on })}
        />
      </div>

      <p className="text-sm text-muted-foreground">{t("settings.privacy")}</p>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <p className="text-sm text-muted-foreground">
          {stored.lastLetterOn ? t("settings.lastLetter", { date: long(stored.lastLetterOn) }) : t("settings.noLetterYet")}
        </p>
        <Button type="submit" disabled={readOnly || !dirty || problem !== null || updateSettings.isPending} data-writes="DRIFT">
          {t("settings.save")}
        </Button>
      </div>
    </form>
  );
}
