"use client";

import { useState } from "react";
import { MapPin, UserCheck } from "lucide-react";
import { useSchoolDayFree } from "@/lib/school-day-queries";
import {
  PRESETS,
  closedFor,
  defaultInterval,
  intervalError,
  staffDayOf,
  type FreeQuery,
  type FreeView,
  type RoomBusyCode,
  type TeacherBusyCode,
} from "@/lib/school-day";
import { toDateString } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Field } from "./toolbar";
import { useSchoolDayText } from "./use-school-day-text";

/**
 * Vem och vad är ledigt? A date and an interval, and the teachers and rooms
 * that nothing occupies the whole of it.
 *
 * "Free" is the gateway's answer, by the Vikarietavla's rules for occupied
 * (src/cover/cover-rules.ts), and this card says which rules decided, in one
 * sentence under every result, so that nobody has to guess what "ledig"
 * means. The rules that only matter when somebody is asked to cover (lunch,
 * rest, the daily cap, teaching in a row) are not part of it, and the card says
 * that too.
 *
 * A teacher is not told who is free (the answer has no teachers for them):
 * absence, uppdrag and rastvakt are not theirs to read, so a list made from
 * what they can read would call an absent colleague free. The card says why
 * instead of showing an empty list.
 *
 * The search is asked for, not run on every keystroke: a time typed in two
 * keystrokes would otherwise ask the gateway about 10:00–1:00.
 */
export function FreeFinder() {
  const { t } = useSchoolDayText();
  const [date, setDate] = useState(() => toDateString(new Date()));
  const [interval, setInterval] = useState(() => defaultInterval(new Date()));
  // What the last press asked for; null until the first.
  const [asked, setAsked] = useState<FreeQuery | null>(null);
  const problem = intervalError(interval.from, interval.to);
  const free = useSchoolDayFree(asked);

  const ask = (from: string, to: string) => setAsked({ date, from, to });

  return (
    <SectionCard id="school-day-free" title={t("free.title")} description={t("free.description")} className="print:hidden">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem) ask(interval.from, interval.to);
        }}
      >
        <Field id="school-day-free-date" label={t("free.date")}>
          <DateField id="school-day-free-date" value={date} onChange={setDate} className="w-40" />
        </Field>
        <Field id="school-day-free-from" label={t("free.from")}>
          <Input id="school-day-free-from" type="time" className="w-28" value={interval.from} onChange={(event) => setInterval({ ...interval, from: event.target.value })} />
        </Field>
        <Field id="school-day-free-to" label={t("free.to")}>
          <Input id="school-day-free-to" type="time" className="w-28" value={interval.to} onChange={(event) => setInterval({ ...interval, to: event.target.value })} />
        </Field>
        <Button type="submit" disabled={problem !== null}>
          {t("free.show")}
        </Button>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("free.presets")}>
          {PRESETS.map((preset) => (
            <Button
              key={preset.key}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setInterval({ from: preset.from, to: preset.to });
                ask(preset.from, preset.to);
              }}
            >
              {t(`free.preset.${preset.key}`, { from: preset.from, to: preset.to })}
            </Button>
          ))}
        </div>
      </form>
      {problem ? (
        <p className="text-sm text-destructive" role="alert">
          {t(`free.problem.${problem}`)}
        </p>
      ) : null}

      {asked === null ? null : free.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : free.isError || !free.data ? (
        <LoadError variant="inline" title={t("free.loadFailed")} hint={t("free.loadFailedHint")} />
      ) : (
        <FreeResult free={free.data} />
      )}
    </SectionCard>
  );
}

function FreeResult({ free }: { free: FreeView }) {
  const { t, dayLong, breakText } = useSchoolDayText();
  const closed = closedFor(free);
  const staffDay = staffDayOf(free);
  const asOf = t("free.asOf", { date: dayLong(free.date), from: free.from, to: free.to });
  const names = (codes: readonly string[], scope: "teacher" | "room") => codes.map((code) => t(`free.reason.${scope}.${code}`)).join(", ");

  return (
    <div className="space-y-3" aria-live="polite">
      <h3 className="text-sm font-medium">{asOf}</h3>
      {closed ? (
        <Notice tone="warning" title={t("free.closed")}>
          {breakText(closed)}
        </Notice>
      ) : (
        <>
          {staffDay ? <Notice>{t("free.staffDay", { name: staffDay.name })}</Notice> : null}
          <div className="grid gap-4 md:grid-cols-2">
            {free.teachers !== null ? (
              <FreeList
                icon={<UserCheck className="size-4" aria-hidden="true" />}
                title={t("free.teachers", { count: free.teachers.length })}
                empty={t("free.noTeachers")}
                names={free.teachers.map((one) => one.name)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("free.teachersWithheld")}</p>
            )}
            <FreeList
              icon={<MapPin className="size-4" aria-hidden="true" />}
              title={t("free.rooms", { count: free.rooms.length })}
              empty={t("free.noRooms")}
              names={free.rooms.map((one) => (one.code ? `${one.name} (${one.code})` : one.name))}
            />
          </div>
          {free.poolLeftOut > 0 ? <p className="text-sm text-muted-foreground">{t("free.poolLeftOut", { count: free.poolLeftOut })}</p> : null}
          {free.access.admin ? <NotFree free={free} /> : null}
        </>
      )}
      {/* Always: which rules decided, and which question is another one. */}
      <p className="text-sm text-muted-foreground">
        {[
          free.rules.teachers.length > 0 ? t("free.rulesTeachers", { rules: names(free.rules.teachers, "teacher") }) : null,
          t("free.rulesRooms", { rules: names(free.rules.rooms, "room") }),
        ]
          .filter(Boolean)
          .join(" ")}
      </p>
      {free.rules.teachers.length > 0 ? <p className="text-sm text-muted-foreground">{t("free.notIncluded")}</p> : null}
    </div>
  );
}

function FreeList({ icon, title, empty, names }: { icon: React.ReactNode; title: string; empty: string; names: string[] }) {
  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        {icon}
        {title}
      </h4>
      {names.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto" tabIndex={0} aria-label={title}>
          {names.map((name) => (
            <li key={name} className="rounded-md border bg-muted/40 px-2 py-0.5 text-xs">
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The administrators' list of who is not free and by which rule, closed until asked for. */
function NotFree({ free }: { free: FreeView }) {
  const { t } = useSchoolDayText();
  const teachers = free.busyTeachers ?? [];
  const rooms = free.busyRooms ?? [];
  const reason = (scope: "teacher" | "room", code: TeacherBusyCode | RoomBusyCode) => t(`free.reason.${scope}.${code}`);
  if (teachers.length + rooms.length === 0) return null;
  return (
    <details className="rounded-md border px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">{t("free.notFree", { count: teachers.length + rooms.length })}</summary>
      <div className="mt-2 grid gap-4 md:grid-cols-2">
        <ul className="space-y-1" aria-label={t("free.notFreeTeachers")}>
          {teachers.map((one) => (
            <li key={one.id}>
              {one.name}
              <span className="text-muted-foreground"> — {one.reasons.map((code) => reason("teacher", code)).join(", ")}</span>
            </li>
          ))}
        </ul>
        <ul className="space-y-1" aria-label={t("free.notFreeRooms")}>
          {rooms.map((one) => (
            <li key={one.id}>
              {one.name}
              <span className="text-muted-foreground"> — {one.reasons.map((code) => reason("room", code)).join(", ")}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
