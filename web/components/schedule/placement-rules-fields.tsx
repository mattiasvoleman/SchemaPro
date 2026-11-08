"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import type { PlacementRuleMode } from "@/lib/types";

/** The four per-day limits of the rule Salar och byggnader per dag, in the order they are drawn. */
export const LIMIT_FIELDS = [
  ["maxClassRoomsPerDay", "classRoom"],
  ["maxTeacherRoomsPerDay", "teacherRoom"],
  ["maxClassBuildingsPerDay", "classBuilding"],
  ["maxTeacherBuildingsPerDay", "teacherBuilding"],
] as const;

export type LimitField = (typeof LIMIT_FIELDS)[number][0];

/** The form's side of Placeringsregler: numbers as typed, "" for no limit. */
export interface PlacementValues {
  placementEdgeMode: PlacementRuleMode;
  placementEdgeWeight: string;
  placementPlacesMode: PlacementRuleMode;
  placementPlacesWeight: string;
  placementSharedMode: PlacementRuleMode;
  placementSharedWeight: string;
  maxClassRoomsPerDay: string;
  maxTeacherRoomsPerDay: string;
  maxClassBuildingsPerDay: string;
  maxTeacherBuildingsPerDay: string;
}

/** What is wrong with the values, for the fields to say; the card decides it. */
export interface PlacementErrors {
  edgeWeight: boolean;
  placesWeight: boolean;
  sharedWeight: boolean;
  /** Per limit: typed, but not a whole number in 1..20. */
  limits: Record<LimitField, boolean>;
  /** The rule is on and not one limit is set, so it has nothing to hold. */
  noLimit: boolean;
}

const MODES: PlacementRuleMode[] = ["OFF", "SOFT", "HARD"];

/**
 * Rules 1 and 2 are Av or Mjuk until a hard one has been measured on a large
 * school: a hard rule 1 cost 4.5 times the first timetable with eight workers
 * and a hard rule 2 2.8 to 3.6 times, the same track as the hard
 * sammanhängande undervisning that was dropped for its cost. The API refuses
 * HARD for them (PLACEMENT_EDGE_HARD_NOT_OFFERED, PLACEMENT_PLACES_HARD_NOT_OFFERED),
 * the database does too (…_off_or_soft_check) and the engine still builds
 * them; this is the card's half. Only Delade salar keeps all three.
 */
const SOFT_ONLY_MODES: PlacementRuleMode[] = ["OFF", "SOFT"];

/**
 * One choice of three, drawn as buttons that read as a row: native radios, so
 * the arrow keys, the group and the checked state are the browser's own.
 */
function ModeChoice({
  name,
  value,
  describedBy,
  modes = MODES,
  onChange,
}: {
  name: string;
  value: PlacementRuleMode;
  describedBy: string;
  /** The choices offered; all three unless a rule is offered in fewer. */
  modes?: PlacementRuleMode[];
  onChange: (mode: PlacementRuleMode) => void;
}) {
  const t = useTranslations("placementRules");
  return (
    <div className="flex flex-wrap gap-1.5">
      {modes.map((mode) => (
        <label key={mode} className="relative">
          <input
            type="radio"
            className="peer sr-only"
            name={name}
            value={mode}
            checked={value === mode}
            aria-describedby={describedBy}
            onChange={() => onChange(mode)}
          />
          <span className="block cursor-pointer rounded-md border border-input-strong px-3 py-1.5 text-sm peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background">
            {t(`mode.${mode}`)}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * Placeringsregler on Skolregler: three rules, each Av / Mjuk / Hård, and a
 * weight only while the rule is Mjuk. State, validation and saving are the
 * card's (lunch-settings-card.tsx); this draws the values it is handed.
 */
export function PlacementRulesFields({
  values,
  errors,
  markedSubjects,
  onChange,
}: {
  values: PlacementValues;
  errors: PlacementErrors;
  /** Subjects with a box ticked, or null while the list is not known. */
  markedSubjects: number | null;
  onChange: (change: Partial<PlacementValues>) => void;
}) {
  const t = useTranslations("placementRules");

  const weight = (
    id: string,
    key: "placementEdgeWeight" | "placementPlacesWeight" | "placementSharedWeight",
    wrong: boolean,
    hint = t("weightHint"),
  ) => (
    <FormField
      id={id}
      label={t("weight")}
      hint={hint}
      error={wrong ? t("weightInvalid") : undefined}
      className="max-w-sm"
    >
      <Input
        type="number"
        min={1}
        max={1000}
        step={1}
        className="max-w-28"
        value={values[key]}
        onChange={(event) => onChange({ [key]: event.target.value })}
      />
    </FormField>
  );

  return (
    <section aria-labelledby="placement-rules-title" className="space-y-3 border-t pt-4">
      <div className="space-y-2">
        <h3 id="placement-rules-title" className="text-sm font-semibold">
          {t("title")}
        </h3>
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        <dl className="max-w-prose space-y-1 text-sm text-muted-foreground">
          {MODES.map((mode) => (
            <div key={mode} className="flex gap-1">
              <dt className="shrink-0 font-medium text-foreground">{t(`mode.${mode}`)}:</dt>
              <dd>{t(`modeHint.${mode}`)}</dd>
            </div>
          ))}
        </dl>
      </div>

      <fieldset className="space-y-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("edge.title")}</legend>
        <p id="placement-edge-hint" className="text-sm text-muted-foreground">
          {t("edge.hint")}
        </p>
        <p id="placement-edge-hard-hint" className="text-sm text-muted-foreground">
          {t("edge.hardHint")}
        </p>
        <ModeChoice
          name="placement-edge-mode"
          value={values.placementEdgeMode}
          describedBy="placement-edge-hint placement-edge-hard-hint"
          modes={SOFT_ONLY_MODES}
          onChange={(mode) => onChange({ placementEdgeMode: mode })}
        />
        {values.placementEdgeMode === "SOFT"
          ? weight("placement-edge-weight", "placementEdgeWeight", errors.edgeWeight)
          : null}
        <p className="text-sm">
          {markedSubjects === null ? null : <>{t("edge.count", { count: markedSubjects })} </>}
          <Link href="/admin/subjects" className="underline underline-offset-2">
            {t("edge.link")}
          </Link>
        </p>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("places.title")}</legend>
        <p id="placement-places-hint" className="text-sm text-muted-foreground">
          {t("places.hint")}
        </p>
        <p id="placement-places-hard-hint" className="text-sm text-muted-foreground">
          {t("places.hardHint")}
        </p>
        <ModeChoice
          name="placement-places-mode"
          value={values.placementPlacesMode}
          describedBy="placement-places-hint placement-places-hard-hint"
          modes={SOFT_ONLY_MODES}
          onChange={(mode) => onChange({ placementPlacesMode: mode })}
        />
        {values.placementPlacesMode === "SOFT"
          ? weight("placement-places-weight", "placementPlacesWeight", errors.placesWeight)
          : null}
        <div className="space-y-1.5">
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            {LIMIT_FIELDS.map(([key, label]) => (
              <FormField
                key={key}
                id={`placement-limit-${label}`}
                label={t(`limit.${label}`)}
                error={errors.limits[key] ? t("limitInvalid") : undefined}
              >
                <Input
                  type="number"
                  min={1}
                  max={20}
                  step={1}
                  placeholder={t("limitPlaceholder")}
                  aria-describedby={
                    errors.noLimit ? "placement-limits-hint placement-limits-error" : "placement-limits-hint"
                  }
                  {...(errors.noLimit ? { "aria-invalid": true } : {})}
                  value={values[key]}
                  onChange={(event) => onChange({ [key]: event.target.value })}
                />
              </FormField>
            ))}
          </div>
          <p id="placement-limits-hint" className="text-xs text-muted-foreground">
            {t("limitsHint")}
          </p>
          {errors.noLimit ? (
            <p id="placement-limits-error" className="text-xs text-destructive">
              {t("limitsMissing")}
            </p>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{t("shared.title")}</legend>
        <p id="placement-shared-hint" className="text-sm text-muted-foreground">
          {t("shared.hint")}
        </p>
        <ModeChoice
          name="placement-shared-mode"
          value={values.placementSharedMode}
          describedBy="placement-shared-hint"
          onChange={(mode) => onChange({ placementSharedMode: mode })}
        />
        {values.placementSharedMode === "SOFT"
          ? weight("placement-shared-weight", "placementSharedWeight", errors.sharedWeight, t("shared.weightHint"))
          : null}
      </fieldset>
    </section>
  );
}
