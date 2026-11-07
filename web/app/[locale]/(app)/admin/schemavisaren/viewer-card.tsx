"use client";

/*
 * Schemavisaren's settings, "Vem och hur" (Schemavisarens lägen,
 * 20270118090000): who may look at the school's published timetable outside
 * Rastra, and how each kind of schedule is reached.
 *
 * WHO. Everyone who has a link or a code, or only a signed-in teacher or
 * administrator of the school. The viewer for staff is answered by a second
 * door of the gateway; to anyone else it is the one "not found".
 *
 * HOW, per kind (a class, a teaching group, a teacher, a pupil, a room):
 * Av, Lista (a list the visitor picks from) or Fritext-ID (shown only to the
 * one who holds or types the exact code; no list, so nothing to browse).
 * A pupil is never in a list: a list of pupils would be a register of where
 * they are, and the gateway refuses it (PUBLIC_STUDENTS_NOT_LISTED) — so the
 * option is not offered. A teacher can be shown only while the teacher is
 * named by signature or name (PUBLIC_TEACHERS_UNNAMED): the options are held
 * back until the display is chosen, and a display turned back to nothing while
 * teachers are shown is said before the save, not after the refusal.
 *
 * Everything is OFF by default, for staff, and a link opens nothing until its
 * kind is on. The page only SHOWS and SAVES these settings: what a link then
 * answers is the database's, and a person with a protected identity is never
 * shown whatever is set here.
 *
 * The teacher is shown as NOTHING by default: a signature is the school's own
 * short form (TeacherEmployments.signature, per läsår) and is never made up
 * on the page, so a school that wants signatures sets them first. The minimum
 * group size protects pupils: a teaching group of two is two named children.
 * Below it the group is shown as "Grupp" and gets no link.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { useUpdatePublicationSettings } from "@/lib/publication-queries";
import { publicationErrorText } from "@/lib/publication-messages";
import {
  VIEWER_KINDS,
  VIEWER_MODE_KEYS,
  type PublicationSettings,
  type PublicationSettingsInput,
  type TeacherDisplay,
  type ViewerAudience,
  type ViewerKind,
  type ViewerMode,
} from "@/lib/publication-types";
import { modesOf, teachersUnnamed, viewerIsOn } from "@/lib/viewer-modes";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Switch } from "@/components/ui/switch";

const AUDIENCES: ViewerAudience[] = ["EVERYONE", "STAFF"];
const DISPLAYS: TeacherDisplay[] = ["NONE", "SIGNATURE", "NAME"];
const MODES: ViewerMode[] = ["OFF", "LIST", "CODE"];

/**
 * One choice of a few, drawn as buttons that read as a row: native radios, so
 * the arrow keys, the group and the checked state are the browser's own, and
 * the look is the label's. No script of its own.
 */
function Segmented({
  name,
  labelledBy,
  describedBy,
  options,
  value,
  onChange,
}: {
  name: string;
  labelledBy: string;
  describedBy?: string;
  options: { value: ViewerMode; label: string; disabled?: boolean }[];
  value: ViewerMode;
  onChange: (value: ViewerMode) => void;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-describedby={describedBy} className="flex shrink-0 flex-wrap gap-1.5">
      {options.map((option) => (
        <label key={option.value} className="relative">
          <input
            type="radio"
            className="peer sr-only"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="block cursor-pointer rounded-md border border-input-strong px-3 py-1.5 text-sm peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:cursor-not-allowed peer-disabled:opacity-50">
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}

export function ViewerCard({ settings }: { settings: PublicationSettings }) {
  const t = useTranslations("schemavisaren");
  const tErrors = useTranslations("schemavisaren.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const update = useUpdatePublicationSettings();
  const [changes, setChanges] = useState<PublicationSettingsInput>({});
  const [problem, setProblem] = useState<string | null>(null);
  const value = <K extends keyof PublicationSettingsInput>(key: K) =>
    (changes[key] ?? settings[key]) as PublicationSettings[K];
  const minSize = value("publicMinGroupSize");
  const sizeValid = Number.isInteger(minSize) && minSize >= 3 && minSize <= 30;
  const effective = { ...settings, ...changes } as PublicationSettings;
  // The refusal the gateway would make (PUBLIC_TEACHERS_UNNAMED), said before the save.
  const unnamed = teachersUnnamed(effective);
  const namedTeacher = value("publicTeacherDisplay") !== "NONE";
  const set = (patch: PublicationSettingsInput) => setChanges((previous) => ({ ...previous, ...patch }));

  const save = async () => {
    setProblem(null);
    try {
      await update.mutateAsync(changes);
      setChanges({});
      toast.success(t("saved"));
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <SectionCard
      id="viewer-who"
      title={t("whoTitle")}
      description={t("whoBody")}
      descriptionClassName="max-w-prose"
      footer={
        <>
          <p className="mr-auto self-center text-xs text-muted-foreground">{t("effectDelay")}</p>
          <Button
            onClick={save}
            disabled={Object.keys(changes).length === 0 || !sizeValid || unnamed || update.isPending}
            data-writes="PUBLICERING"
          >
            {update.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                {tCommon("saving")}
              </>
            ) : (
              tCommon("save")
            )}
          </Button>
        </>
      }
    >
      <fieldset className="space-y-2" data-writes-inert="PUBLICERING">
        <legend className="mb-2 text-sm font-medium">{t("audienceLabel")}</legend>
        {AUDIENCES.map((audience) => (
          <label key={audience} className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
            <input
              type="radio"
              name="viewer-audience"
              value={audience}
              className="mt-0.5 size-4 shrink-0"
              checked={value("viewerAudience") === audience}
              onChange={() => set({ viewerAudience: audience })}
              aria-describedby={`viewer-audience-${audience}-hint`}
            />
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm font-medium">{t(`audience.${audience}`)}</span>
              <span id={`viewer-audience-${audience}-hint`} className="block text-xs text-muted-foreground">
                {t(`audienceHint.${audience}`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="space-y-2">
        <h3 id="viewer-modes-title" className="text-sm font-medium">
          {t("modesLabel")}
        </h3>
        <dl className="max-w-prose space-y-1 text-xs text-muted-foreground">
          {MODES.map((mode) => (
            <div key={mode} className="flex gap-1">
              <dt className="shrink-0 font-medium text-foreground">{t(`mode.${mode}`)}:</dt>
              <dd>{t(`modeHint.${mode}`)}</dd>
            </div>
          ))}
        </dl>
        <ul className="space-y-2">
          {VIEWER_KINDS.map((kind: ViewerKind) => {
            const key = VIEWER_MODE_KEYS[kind];
            const locked = kind === "TEACHER" && !namedTeacher;
            return (
              <li
                key={kind}
                className="space-y-2 rounded-md border p-3 sm:flex sm:items-start sm:justify-between sm:gap-4 sm:space-y-0"
                data-writes-inert="PUBLICERING"
              >
                <div className="min-w-0 space-y-1">
                  <p id={`mode-${kind}-label`} className="text-sm font-medium">
                    {t(`kinds.${kind}`)}
                  </p>
                  <p id={`mode-${kind}-hint`} className="max-w-prose text-xs text-muted-foreground">
                    {t(`kindHint.${kind}`)}
                    {locked ? ` ${t("teacherLocked")}` : ""}
                  </p>
                </div>
                <Segmented
                  name={`viewer-mode-${kind}`}
                  labelledBy={`mode-${kind}-label`}
                  describedBy={`mode-${kind}-hint`}
                  value={value(key)}
                  onChange={(mode) => set({ [key]: mode })}
                  options={modesOf(kind).map((mode) => ({
                    value: mode,
                    label: t(`mode.${mode}`),
                    // A teacher can be shown only while named; "Av" is always open, to turn them off again.
                    disabled: locked && mode !== "OFF",
                  }))}
                />
              </li>
            );
          })}
        </ul>
        {viewerIsOn(effective) ? null : <p className="text-sm text-muted-foreground">{t("noneShown")}</p>}
      </div>

      <div className="grid max-w-xl gap-4 sm:grid-cols-2 [&>*]:min-w-0" data-writes-inert="PUBLICERING">
        <FormField
          id="viewer-display"
          label={t("teacherDisplay")}
          hint={t("teacherDisplayHint")}
          error={unnamed ? t("teachersUnnamed") : undefined}
        >
          <NativeSelect
            value={value("publicTeacherDisplay")}
            onChange={(event) => set({ publicTeacherDisplay: event.target.value as TeacherDisplay })}
          >
            {DISPLAYS.map((display) => (
              <option key={display} value={display}>
                {t(`display.${display}`)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id="viewer-min-size" label={t("minGroupSize")} hint={t("minGroupSizeHint")}>
          <Input
            type="number"
            min={3}
            max={30}
            className="tabular-nums"
            value={String(minSize)}
            onChange={(event) => set({ publicMinGroupSize: Number(event.target.value) })}
          />
        </FormField>
      </div>

      {/* The whole row: its label presses the switch as well. */}
      <div className="flex items-start justify-between gap-4 rounded-md border p-3" data-writes-inert="PUBLICERING">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="viewer-show-meals">{t("showMeals")}</Label>
          <p id="viewer-show-meals-hint" className="text-xs text-muted-foreground">
            {t("showMealsHint")}
          </p>
        </div>
        <Switch
          id="viewer-show-meals"
          checked={value("publicShowMeals")}
          onCheckedChange={(checked) => set({ publicShowMeals: checked })}
          aria-describedby="viewer-show-meals-hint"
        />
      </div>
      {problem ? <Notice tone="destructive">{problem}</Notice> : null}
    </SectionCard>
  );
}
