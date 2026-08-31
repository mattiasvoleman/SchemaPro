"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { UtensilsCrossed } from "lucide-react";
import { useLunchSettings, useSaveLunchSettings } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
}

const EMPTY_FORM: LunchForm = {
  lunchEnabled: false,
  lunchStartTime: "11:00",
  lunchEndTime: "13:00",
  lunchMinutes: "30",
  diningSeats: "",
  maxLessonsPerDayPerGroup: "",
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

/**
 * Lunch, and how many the dining hall seats.
 *
 * The seat count is what lets the solver stagger sittings instead of assuming
 * the whole school can eat at once. Without it a generated week looks fine and
 * puts four hundred children in a hall with room for a hundred and eighty.
 */
export function LunchSettingsCard() {
  const t = useTranslations("lunch");
  const tCommon = useTranslations("common");
  const { data: settings, isSuccess } = useLunchSettings();
  const save = useSaveLunchSettings();

  const [form, setForm] = useState<LunchForm>(EMPTY_FORM);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Only until the first fill: re-running on every render of the query would
    // throw away whatever the admin is in the middle of typing.
    if (!isSuccess || loaded) return;
    setLoaded(true);
    if (settings) {
      setForm({
        lunchEnabled: settings.lunchEnabled,
        lunchStartTime: toInputTime(settings.lunchStartTime),
        lunchEndTime: toInputTime(settings.lunchEndTime),
        lunchMinutes: String(settings.lunchMinutes),
        diningSeats: settings.diningSeats === null ? "" : String(settings.diningSeats),
        maxLessonsPerDayPerGroup:
          settings.maxLessonsPerDayPerGroup === null
            ? ""
            : String(settings.maxLessonsPerDayPerGroup),
      });
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

  const submit = async () => {
    try {
      await save.mutateAsync({
        lunchEnabled: form.lunchEnabled,
        lunchStartTime: form.lunchStartTime,
        lunchEndTime: form.lunchEndTime,
        // Sent as real numbers: the API runs with implicit conversion off, so
        // "30" is not 30 anywhere along the way.
        lunchMinutes: Number(form.lunchMinutes),
        diningSeats: optionalNumber(form.diningSeats),
        maxLessonsPerDayPerGroup: optionalNumber(form.maxLessonsPerDayPerGroup),
      });
      toast.success(tCommon("saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <div className="mt-8 rounded-lg border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <UtensilsCrossed className="size-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t("title")}</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t("hint")}</p>

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Switch
            id="lunch-enabled"
            checked={form.lunchEnabled}
            onCheckedChange={(checked) => patch({ lunchEnabled: checked })}
          />
          <Label htmlFor="lunch-enabled">{t("enabled")}</Label>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="lunch-start">{t("windowStart")}</Label>
            <Input
              id="lunch-start"
              type="time"
              step={QUARTER_HOUR_STEP}
              value={form.lunchStartTime}
              onChange={(event) => patch({ lunchStartTime: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lunch-end">{t("windowEnd")}</Label>
            <Input
              id="lunch-end"
              type="time"
              step={QUARTER_HOUR_STEP}
              value={form.lunchEndTime}
              onChange={(event) => patch({ lunchEndTime: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lunch-minutes">{t("minutes")}</Label>
            <Input
              id="lunch-minutes"
              type="number"
              min={15}
              max={120}
              step={15}
              value={form.lunchMinutes}
              onChange={(event) => patch({ lunchMinutes: event.target.value })}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="dining-seats">{t("seats")}</Label>
            <Input
              id="dining-seats"
              type="number"
              min={1}
              max={5000}
              placeholder={t("seatsPlaceholder")}
              value={form.diningSeats}
              onChange={(event) => patch({ diningSeats: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("seatsHint")}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="max-per-day">{t("maxPerDay")}</Label>
            <Input
              id="max-per-day"
              type="number"
              min={1}
              max={20}
              placeholder={t("maxPerDayPlaceholder")}
              value={form.maxLessonsPerDayPerGroup}
              onChange={(event) =>
                patch({ maxLessonsPerDayPerGroup: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">{t("maxPerDayHint")}</p>
          </div>
        </div>

        <Button onClick={() => void submit()} disabled={save.isPending}>
          {save.isPending ? tCommon("saving") : tCommon("save")}
        </Button>
      </div>
    </div>
  );
}
