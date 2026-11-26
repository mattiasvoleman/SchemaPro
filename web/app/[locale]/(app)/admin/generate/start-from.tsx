"use client";

import { useEffect, useId, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { GitBranch } from "lucide-react";
import { useScheduleVersions } from "@/lib/queries";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { cn } from "@/lib/utils";
import type { StartDropReason, StartedFrom, StartFrom, StartSource } from "@/lib/start-from";

/*
 * UTGÅ FRÅN ETT SCHEMA (omgång 15, M9): where a run starts, and what it did with it.
 *
 * Two pieces behind one lazy import (generate/page.tsx): the card with the choice, and the sentence under a finished run. Neither is
 * drawn until it is needed, so a route near its bundle budget carries a state and a request field and not these.
 *
 * The choice is a school's, and it says what each answer means before it is made: from nothing lays the whole week and uses the
 * schedule that exists only as a hint; from a schedule holds each lesson where it was, lets go of what clashes with the week as it is
 * now and lays the rest. It is no lock, and the card says so, since a school that reads "hålls" as "låst" will not look for the lesson
 * that moved.
 */

/** Said in the order they are worth reading in. */
const DROP_ORDER: readonly StartDropReason[] = [
  "NO_SUCCESSOR",
  "NO_POST",
  "NOT_IN_WEEK",
  "OTHER_WEEKS",
  "AMBIGUOUS",
  "NOT_STARTABLE",
  "MORE_THAN_ASKED",
];

export interface StartFromCardProps {
  /** The year the run is for: its last year's schedule is on offer only when it was created from one. */
  year: { id: string; predecessorId: string | null };
  value: StartFrom | null;
  onChange: (value: StartFrom | null) => void;
  /** A run is going, or the reader cannot run: the choice is shown and not changed. */
  disabled: boolean;
}

export function StartFromCard({ year, value, onChange, disabled }: StartFromCardProps) {
  const t = useTranslations("generate");
  const locale = useLocale();
  const name = useId();
  const versionsQuery = useScheduleVersions(year.id);
  // Newest first, as the gateway lists them.
  const versions = versionsQuery.data ?? [];
  const source: StartSource | "NONE" = value?.source ?? "NONE";

  // The rollover's offer of last year's schedule links here with ?start=PREVIOUS_YEAR: taken once per page load, and only for a year that was
  // rolled from another, so that choosing another year later does not choose it again.
  const linked = useRef(false);
  useEffect(() => {
    if (linked.current) return;
    linked.current = true;
    if (year.predecessorId !== null && new URLSearchParams(window.location.search).get("start") === "PREVIOUS_YEAR") {
      onChange({ source: "PREVIOUS_YEAR" });
    }
    // Once, when the card first is drawn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const choose = (next: StartSource | "NONE") => {
    if (next === "NONE") onChange(null);
    else if (next === "VERSION") onChange({ source: next, versionId: value?.versionId ?? versions[0]?.id });
    else onChange({ source: next });
  };
  const date = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { dateStyle: "medium", timeStyle: "short" });

  const options: {
    key: StartSource | "NONE";
    label: string;
    body: string;
    unavailable?: string;
    extra?: React.ReactNode;
  }[] = [
    { key: "NONE", label: t("startNone"), body: t("startNoneBody") },
    { key: "CURRENT", label: t("startCurrent"), body: t("startCurrentBody") },
    {
      key: "PREVIOUS_YEAR",
      label: t("startPrevious"),
      body: t("startPreviousBody"),
      unavailable: year.predecessorId === null ? t("startPreviousNone") : undefined,
    },
    {
      key: "VERSION",
      label: t("startVersion"),
      body: t("startVersionBody"),
      // The versions are read before the choice is offered: a year with none has nothing to pick.
      unavailable: versionsQuery.isSuccess && versions.length === 0 ? t("startVersionNone") : undefined,
      extra:
        source === "VERSION" && versions.length > 0 ? (
          <label className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{t("startVersionPick")}</span>
            <NativeSelect
              className="w-auto max-w-full"
              value={value?.versionId ?? ""}
              disabled={disabled}
              onChange={(event) => onChange({ source: "VERSION", versionId: event.target.value })}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {t("startVersionOption", {
                    name: version.name,
                    date: date.format(new Date(version.createdAt)),
                    count: version.lessonCount,
                  })}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : null,
    },
  ];

  return (
    <SectionCard id="start-from" title={t("startTitle")} icon={GitBranch} description={t("startHint")}>
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="sr-only">{t("startTitle")}</legend>
        {options.map((option) => {
          const off = option.unavailable !== undefined;
          return (
            <label
              key={option.key}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 text-sm",
                source === option.key && "border-primary bg-primary/5",
                (off || disabled) && "cursor-not-allowed opacity-70",
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.key}
                checked={source === option.key}
                disabled={off || disabled}
                onChange={() => choose(option.key)}
                className="mt-1 accent-primary"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{option.label}</span>
                <span className="block text-muted-foreground">{option.body}</span>
                {off ? <span className="mt-1 block text-foreground">{option.unavailable}</span> : null}
                {option.extra}
              </span>
            </label>
          );
        })}
      </fieldset>
    </SectionCard>
  );
}

/**
 * What a finished run did with the schedule it was asked to start from, in the one sentence a school needs: how many lessons stayed
 * where they were, how many moved and how many were laid new, and what could not be used of the schedule and why. An engine that was
 * too old says that the week was laid from nothing, since the school asked for a start it did not get.
 */
export function StartedFromNote({ startedFrom }: { startedFrom: StartedFrom }) {
  const t = useTranslations("generate");
  const what =
    startedFrom.source === "VERSION" && startedFrom.versionName !== null
      ? t("startNoteSourceNamed", { name: startedFrom.versionName })
      : t(`startNoteSource.${startedFrom.source}`);
  // What could not be used of the schedule: said only when the engine was given it, and counted from the reasons themselves, which add up
  // to every lesson that was left out (an older engine was given none, and a sentence about lessons it never saw would be about nothing).
  const reasons =
    startedFrom.engine === "OLDER"
      ? []
      : DROP_ORDER.flatMap((reason) => {
          const count = startedFrom.dropped[reason] ?? 0;
          return count > 0 ? [t(`startDrop.${reason}`, { count })] : [];
        });
  const droppedTotal = DROP_ORDER.reduce((sum, reason) => sum + (startedFrom.dropped[reason] ?? 0), 0);
  const total = (startedFrom.held ?? 0) + (startedFrom.moved ?? 0) + (startedFrom.laid ?? 0);
  return (
    <div className="max-w-prose space-y-1 text-sm" data-testid="generate-started-from">
      {/* An engine that could not start from the schedule did not: the line says what was asked for, not that the week started from it. */}
      <p className="font-medium">{t(startedFrom.engine === "OLDER" ? "startNoteAsked" : "startNoteTitle", { what })}</p>
      {startedFrom.engine === "OLDER" ? (
        <p className="text-foreground">{t("startNoteOlder")}</p>
      ) : startedFrom.held === null || startedFrom.moved === null || startedFrom.laid === null ? (
        <p className="text-muted-foreground">{t("startNoteNoTimetable", { used: startedFrom.used })}</p>
      ) : (
        <p>{t("startNoteCounts", { total, held: startedFrom.held, moved: startedFrom.moved, laid: startedFrom.laid })}</p>
      )}
      {reasons.length > 0 ? (
        <p className="text-muted-foreground">
          {t("startNoteDropped", { count: droppedTotal, reasons: reasons.join("; ") })}
        </p>
      ) : null}
    </div>
  );
}
