"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useLunchSettings, useSaveLunchSettings } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

/** The solver's grid: 08:00-18:00 in quarter hours, and it rejects anything else. */
const QUARTER_HOUR_STEP = 15 * 60;

interface LunchForm {
  lunchEnabled: boolean;
  lunchStartTime: string;
  lunchEndTime: string;
  lunchMinutes: string;
  diningSeats: string;
  maxLessonsPerDayPerGroup: string;
  generatorKeepsTravelTime: boolean;
  generatorKeepsPupilGapsDown: boolean;
}

const EMPTY_FORM: LunchForm = {
  lunchEnabled: false,
  lunchStartTime: "11:00",
  lunchEndTime: "13:00",
  lunchMinutes: "30",
  diningSeats: "",
  maxLessonsPerDayPerGroup: "",
  // Off until the school turns it on: Restid i generatorn.
  generatorKeepsTravelTime: false,
  // Off until the school turns it on: Elevernas håltimmar.
  generatorKeepsPupilGapsDown: false,
};

/**
 * "11:00" for an `<input type="time">`, whatever shape the API is sending.
 *
 * The comment here used to claim the value arrived as PostgreSQL's "11:00:00"
 * and took the first five characters on that basis. It arrived as
 * "1970-01-01T11:00:00.000Z" — Prisma reads a `@db.Time` as a `Date` and the
 * endpoint returned the row unserialised — so the slice produced "1970-", the
 * input refused it ("does not conform to the required format"), and the form
 * drew its start and end EMPTY on every load.
 *
 * The API sends HH:MM now, so the slice is no longer what makes this work. It
 * stays as a narrow guard against the seconds PostgreSQL would add if the
 * serialisation were ever bypassed, and the timestamp shape is rejected outright
 * rather than silently truncated into something that looks like a time.
 *
 * Exported only to be tested. Through the rendered card the two outcomes are
 * indistinguishable — jsdom reports an invalid `type="time"` value as "" just
 * as it reports an empty one — so a test that went through the DOM passed
 * whether the guard was there or not.
 */
export function toInputTime(value: string): string {
  if (!/^\d{2}:\d{2}/.test(value)) return "";
  return value.slice(0, 5);
}

/**
 * Legacy rules from before this card existed.
 *
 * They lived in `localStorage` under one administrator's browser, which is why
 * this card exists at all: a colleague pressing "generera" ran under different
 * rules and nothing said so. Read once, to fill the form — never saved on the
 * reader's behalf. The stored blob carries `lunchEnabled`, which never reached
 * the server, so a school that deliberately switched lunch off would otherwise
 * have it switched back on by a migration that only looked at the times.
 */
function legacyForm(): Partial<LunchForm> | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem("schemapro.scheduleRules");
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const text = (value: unknown) =>
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : undefined;

    return {
      ...(typeof parsed.lunchEnabled === "boolean"
        ? { lunchEnabled: parsed.lunchEnabled }
        : {}),
      ...(text(parsed.lunchStart) ? { lunchStartTime: text(parsed.lunchStart) } : {}),
      ...(text(parsed.lunchEnd) ? { lunchEndTime: text(parsed.lunchEnd) } : {}),
      ...(text(parsed.lunchMinutes) ? { lunchMinutes: text(parsed.lunchMinutes) } : {}),
      ...(text(parsed.maxPerDay)
        ? { maxLessonsPerDayPerGroup: text(parsed.maxPerDay) }
        : {}),
    };
  } catch {
    // A blob from an older build, or none at all. Defaults are a fine answer.
    return null;
  }
}

/** The fields a saved form is compared on, so Save can wait for a change. */
const FORM_KEYS = Object.keys(EMPTY_FORM) as (keyof LunchForm)[];

/**
 * Skolregler: lunch, how many the dining hall seats, and the most lessons a
 * day. Hard rules for the whole school, rendered as the section
 * #skolregler on Tillgänglighet — the anchor Generera schema and
 * Lunchsittningar link to.
 *
 * The seat count is what lets the solver stagger sittings instead of assuming
 * the whole school can eat at once. Without it a generated week looks fine and
 * puts four hundred children in a hall with room for a hundred and eighty.
 *
 * NOTHING CAN BE SAVED BEFORE THE SCHOOL'S OWN RULES HAVE ARRIVED. The card
 * used to draw the form on its defaults while the request was in flight, with
 * Save enabled: a press in that second PUT lunch switched off, no seat limit
 * and no daily cap over whatever the school had set, and the refetch then
 * showed the defaults as if they had always been the rules. So the form is not drawn
 * until it is filled, a failed fetch says so instead of falling back to the
 * defaults, and Save waits for both the fill and a change.
 */
export function LunchSettingsCard() {
  const t = useTranslations("lunch");
  const tCommon = useTranslations("common");
  const { data: settings, isSuccess, isError } = useLunchSettings();
  const save = useSaveLunchSettings();

  const [form, setForm] = useState<LunchForm>(EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);
  /**
   * The form as the server holds it, to tell a change from none. Null when the
   * school has no row yet: then even the untouched defaults (or the legacy
   * rules read from localStorage) are something to save, and Save stays open.
   */
  const [baseline, setBaseline] = useState<LunchForm | null>(null);
  // Whether the API this page read names the travel switch. One from before
  // it refuses the key outright (forbidNonWhitelisted), so a save leaves the
  // key out unless the API named it or the admin turned it on: a web that
  // reaches the browsers before the API does still saves the lunch.
  const [apiKnowsTravel, setApiKnowsTravel] = useState(false);
  // The same for the pupils' håltimmar: an API that never named the switch
  // refuses it, so it is sent only once the API has, or once it is turned on.
  const [apiKnowsPupilGaps, setApiKnowsPupilGaps] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    // Only until the first fill: re-running on every render of the query would
    // throw away whatever the admin is in the middle of typing.
    if (!isSuccess || loaded) return;
    setLoaded(true);
    if (settings) {
      const filled: LunchForm = {
        lunchEnabled: settings.lunchEnabled,
        lunchStartTime: toInputTime(settings.lunchStartTime),
        lunchEndTime: toInputTime(settings.lunchEndTime),
        lunchMinutes: String(settings.lunchMinutes),
        diningSeats: settings.diningSeats === null ? "" : String(settings.diningSeats),
        maxLessonsPerDayPerGroup:
          settings.maxLessonsPerDayPerGroup === null
            ? ""
            : String(settings.maxLessonsPerDayPerGroup),
        // `?? false`: an API from before the switch sends no such field, and
        // reads as the rule it is then — off.
        generatorKeepsTravelTime: settings.generatorKeepsTravelTime ?? false,
        generatorKeepsPupilGapsDown: settings.generatorKeepsPupilGapsDown ?? false,
      };
      setForm(filled);
      setBaseline(filled);
      setApiKnowsTravel(settings.generatorKeepsTravelTime !== undefined);
      setApiKnowsPupilGaps(settings.generatorKeepsPupilGapsDown !== undefined);
      return;
    }
    setForm({ ...EMPTY_FORM, ...legacyForm() });
  }, [isSuccess, loaded, settings]);

  const patch = (change: Partial<LunchForm>) =>
    setForm((previous) => ({ ...previous, ...change }));

  const optionalNumber = (value: string): number | null => {
    const trimmed = value.trim();
    return trimmed === "" ? null : Number(trimmed);
  };

  const changed =
    baseline === null || FORM_KEYS.some((key) => form[key] !== baseline[key]);

  const submit = async () => {
    const sent = form;
    setSaveError(null);
    try {
      await save.mutateAsync({
        lunchEnabled: sent.lunchEnabled,
        lunchStartTime: sent.lunchStartTime,
        lunchEndTime: sent.lunchEndTime,
        // Sent as real numbers: the API runs with implicit conversion off, so
        // "30" is not 30 anywhere along the way.
        lunchMinutes: Number(sent.lunchMinutes),
        diningSeats: optionalNumber(sent.diningSeats),
        maxLessonsPerDayPerGroup: optionalNumber(sent.maxLessonsPerDayPerGroup),
        ...(apiKnowsTravel || sent.generatorKeepsTravelTime
          ? { generatorKeepsTravelTime: sent.generatorKeepsTravelTime }
          : {}),
        ...(apiKnowsPupilGaps || sent.generatorKeepsPupilGapsDown
          ? { generatorKeepsPupilGapsDown: sent.generatorKeepsPupilGapsDown }
          : {}),
      });
      setBaseline(sent);
      // `updated`, not `saved`: this called a key that has never existed in
      // either locale, so every successful save threw MISSING_MESSAGE instead
      // of confirming anything. `common.updated` already reads "Sparad", and it
      // is what every other page in the app says here.
      toast.success(tCommon("updated"));
    } catch (error) {
      // Beside the form rather than in a toast: the fields still hold what
      // did not save, and the sentence has to stay next to them until the
      // admin has read it — with what still applies, which a toast has no
      // room to say.
      setSaveError(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <SectionCard
      id="skolregler"
      title={t("rulesTitle")}
      description={`${t("rulesIntro")} ${t("hint")}`}
      footer={
        // Drawn, disabled, while the rules load, so the card does not grow a
        // button under the admin's pointer; gone when they cannot be read.
        loaded || !isError ? (
          <Button data-writes="PLANERING" onClick={() => void submit()} disabled={!loaded || save.isPending || !changed}>
            {save.isPending ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                {tCommon("saving")}
              </>
            ) : (
              tCommon("save")
            )}
          </Button>
        ) : null
      }
    >
      {loaded ? (
        // The rules as they stand are the reading; a profile that does not
        // write planering (lunch-settings.controller.ts @Area) is not offered
        // the fields, and Spara is hidden from it.
        <div data-writes-inert="PLANERING" className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="lunch-enabled">{t("enabled")}</Label>
            <Switch
              id="lunch-enabled"
              checked={form.lunchEnabled}
              onCheckedChange={(checked) => patch({ lunchEnabled: checked })}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3 [&>*]:min-w-0">
            <FormField id="lunch-start" label={t("windowStart")}>
              <Input
                type="time"
                step={QUARTER_HOUR_STEP}
                value={form.lunchStartTime}
                onChange={(event) => patch({ lunchStartTime: event.target.value })}
              />
            </FormField>
            <FormField id="lunch-end" label={t("windowEnd")}>
              <Input
                type="time"
                step={QUARTER_HOUR_STEP}
                value={form.lunchEndTime}
                onChange={(event) => patch({ lunchEndTime: event.target.value })}
              />
            </FormField>
            <FormField id="lunch-minutes" label={t("minutes")}>
              <Input
                type="number"
                min={15}
                max={120}
                step={15}
                value={form.lunchMinutes}
                onChange={(event) => patch({ lunchMinutes: event.target.value })}
              />
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <FormField id="dining-seats" label={t("seats")} hint={t("seatsHint")}>
              <Input
                type="number"
                min={1}
                max={5000}
                placeholder={t("seatsPlaceholder")}
                value={form.diningSeats}
                onChange={(event) => patch({ diningSeats: event.target.value })}
              />
            </FormField>
            <FormField id="max-per-day" label={t("maxPerDay")} hint={t("maxPerDayHint")}>
              <Input
                type="number"
                min={1}
                max={20}
                placeholder={t("maxPerDayPlaceholder")}
                value={form.maxLessonsPerDayPerGroup}
                onChange={(event) =>
                  patch({ maxLessonsPerDayPerGroup: event.target.value })
                }
              />
            </FormField>
          </div>

          {/* Restid i generatorn. The walks themselves, and which room
              stands on which site, are set on the rooms page; this only says
              whether the generator keeps them. */}
          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="space-y-1">
              <Label htmlFor="generator-keeps-travel">{t("travel")}</Label>
              <p id="generator-keeps-travel-hint" className="text-sm text-muted-foreground">
                {t("travelHint")}
              </p>
            </div>
            <Switch
              id="generator-keeps-travel"
              aria-describedby="generator-keeps-travel-hint"
              checked={form.generatorKeepsTravelTime}
              onCheckedChange={(checked) => patch({ generatorKeepsTravelTime: checked })}
            />
          </div>

          {/* Elevernas håltimmar: the generator keeps the pupils' idle time
              down, counted as the Håltimmar page counts it. */}
          <div className="flex items-start justify-between gap-4 rounded-md border p-3">
            <div className="space-y-1">
              <Label htmlFor="generator-keeps-pupil-gaps">{t("pupilGaps")}</Label>
              <p id="generator-keeps-pupil-gaps-hint" className="text-sm text-muted-foreground">
                {t("pupilGapsHint")}
              </p>
            </div>
            <Switch
              id="generator-keeps-pupil-gaps"
              aria-describedby="generator-keeps-pupil-gaps-hint"
              checked={form.generatorKeepsPupilGapsDown}
              onCheckedChange={(checked) => patch({ generatorKeepsPupilGapsDown: checked })}
            />
          </div>

          {saveError !== null ? (
            <Notice tone="destructive" title={t("saveFailed")}>
              {saveError} {t("saveFailedHint")}
            </Notice>
          ) : null}
        </div>
      ) : isError ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      )}
    </SectionCard>
  );
}
