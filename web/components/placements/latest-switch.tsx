"use client";

import { useTranslations } from "next-intl";

/*
 * "Visa senaste schemat": the week's switch for the lessons the last Generera laid, drawn pale behind the cards (ghost-layer.tsx). A native
 * checkbox: a switch component is code the route has no bytes for, and a checkbox is what a screen reader says "checkbox, checked" about.
 * Off, nothing is read. On, it says what it is showing, or why it shows nothing: no class, teacher or room is picked, the schedule is on
 * its way or did not come, or the school's schedule has nothing for what is picked.
 */
export type LatestState = "loading" | "failed" | "ready";

export function LatestSwitch({
  on,
  onChange,
  picked,
  state,
  count,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** A class, a teacher or a room is picked: the schedule is drawn for what is picked and for nothing else. */
  picked: boolean;
  state: LatestState;
  /** How many lessons are drawn. */
  count: number;
}) {
  const t = useTranslations("placementWeek.latest");
  const said = !picked ? t("needsFilter") : state === "loading" ? t("loading") : state === "failed" ? t("failed") : count === 0 ? t("none") : t("shown", { count });
  return (
    <div className="mb-3" data-testid="placement-latest">
      <label className="inline-flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={on}
          onChange={(event) => onChange(event.target.checked)}
          aria-describedby="placement-latest-hint"
          className="size-4 accent-primary"
        />
        {t("label")}
      </label>
      <p id="placement-latest-hint" className="mt-1 text-xs text-muted-foreground">
        {t("hint")}
      </p>
      {on ? (
        <p role="status" className="mt-1 text-sm" data-testid="placement-latest-said">
          {said}
        </p>
      ) : null}
    </div>
  );
}
