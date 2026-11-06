"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SearchField } from "@/components/ui/search-field";
import { api } from "@/lib/api";
import { CRISIS_KEYS } from "@/lib/crisis-keys";
import type { FindTarget } from "@/lib/crisis-mine";
import type { MyAlarm, OtherPupilView } from "@/lib/crisis-types";

/*
 * "Hittat en elev som inte står på listan" (Krisläge): a teacher who meets a
 * pupil that is on none of their lists, in the corridor or the yard, says so
 * here, and the pupil is marked FOUND, "found with me", on one of the
 * teacher's groups, or on the alarm when the teacher has no group right now.
 * The administration then sees the pupil as found.
 *
 * THE PUPIL IS SEARCHED FOR ON THE SERVER, not picked from a list the page
 * holds: POST /crisis/mine/pupils answers at most 25 pupils of the school who
 * are on none of the teacher's lists, for a name or a class of at least two
 * characters. It is a POST so that what was typed is in the body and never in
 * a URL: the gateway logs and echoes the URLs it is asked for, and a pupil's
 * name does not belong in them. The school's pupils are therefore not in the list the teacher
 * is given, not in the poll, and not on the device. The search is typed with
 * a pause (SEARCH_DELAY_MS), keyed by what was typed (an answer to an earlier
 * word cannot overwrite the answer to this one), lives while the picker is
 * open and not a moment longer, and says so when there is no network: finding
 * a pupil needs one, marking the pupil does not (the mark is queued).
 *
 * Only FOUND is ever offered: the gateway refuses MISSING for a pupil who is
 * not on the group's list.
 *
 * Small on purpose, for the bundle and for a phone in a hand that is moving:
 * no dialog and no combobox. A button that opens a search box, a list of
 * buttons of 44 px, the arrow keys to move in it, Escape to close. Nothing is
 * marked until a result is pressed.
 */

/** The shortest search the gateway takes. */
const MIN_CHARS = 2;
/** The most it answers; a list of that many may have more behind it. */
const MOST_RESULTS = 25;
/** How long after the last key the search is sent. */
const SEARCH_DELAY_MS = 250;

/** The value after it has stood still for `ms`. */
function useAfterPause<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function FindOther({
  alarm,
  onFound,
}: {
  alarm: MyAlarm;
  /** Says the pupil was found, with the group (or the alarm); the page queues the mark. */
  onFound: (target: FindTarget, who: OtherPupilView) => void;
}) {
  const t = useTranslations("crisis");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState("");
  const [added, setAdded] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const results = useRef<HTMLUListElement>(null);

  // The group the pupil is found with: the lesson going on if there is one, else the first. A choice only when there
  // are several; with none the find is the alarm's own.
  const fallback = (alarm.calls.find((call) => call.basis === "LESSON") ?? alarm.calls[0])?.id ?? "";
  const callId = alarm.calls.some((call) => call.id === chosen) ? chosen : fallback;
  const target: FindTarget = callId ? { callId } : { alarmId: alarm.id };

  const typed = query.trim();
  const asked = useAfterPause(typed, SEARCH_DELAY_MS);
  const search = useQuery({
    queryKey: CRISIS_KEYS.search(alarm.id, asked),
    enabled: open && asked.length >= MIN_CHARS,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    // The signal ends a search that has been overtaken by the next one, rather than leaving it to finish.
    queryFn: ({ signal }) => api.post<OtherPupilView[]>("/api/v1/crisis/mine/pupils", { alarmId: alarm.id, q: asked }, signal),
  });
  // Pupils already found by this teacher are no longer to be found.
  const taken = new Set([...alarm.calls.flatMap((call) => call.foundHere ?? []), ...(alarm.foundFree ?? [])].map((one) => one.studentId));
  const matches = (search.data ?? []).filter((one) => !taken.has(one.studentId));
  // What is shown is the answer to what is in the box; while they differ it is being asked.
  const waiting = typed.length >= MIN_CHARS && (asked !== typed || search.isFetching);

  const close = () => {
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  };
  const pick = (one: OtherPupilView) => {
    onFound(target, one);
    setAdded(`${one.firstName} ${one.lastName}`.trim());
    close();
  };
  const buttons = () => Array.from(results.current?.querySelectorAll("button") ?? []);
  const move = (event: React.KeyboardEvent, from: number) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    buttons()[from + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <Button
        ref={trigger}
        type="button"
        variant="outline"
        className="h-auto min-h-11 w-full whitespace-normal py-2 text-base sm:w-auto"
        aria-expanded={open}
        aria-controls={`find-other-${alarm.id}`}
        onClick={() => {
          if (open) close();
          else {
            setAdded("");
            setOpen(true);
          }
        }}
      >
        {t("teacher.findOther")}
      </Button>
      <p role="status" className="text-sm">
        {added ? t("teacher.findOtherAdded", { name: added }) : null}
      </p>
      {open ? (
        <div
          id={`find-other-${alarm.id}`}
          className="space-y-3"
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
        >
          <p className="text-sm text-muted-foreground">{t("teacher.findOtherHint")}</p>
          {alarm.calls.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor={`find-other-call-${alarm.id}`}>{t("teacher.findOtherCall")}</Label>
              <NativeSelect id={`find-other-call-${alarm.id}`} className="h-11 max-w-sm text-base" value={callId} onChange={(event) => setChosen(event.target.value)}>
                {alarm.calls.map((call) => (
                  <option key={call.id} value={call.id}>
                    {call.groupName}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <SearchField
            id={`find-other-search-${alarm.id}`}
            label={t("teacher.findOtherSearch")}
            value={query}
            onValueChange={setQuery}
            autoFocus
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "Enter") {
                event.preventDefault();
                buttons()[0]?.focus();
              }
            }}
          />
          {typed.length < MIN_CHARS ? (
            <p className="text-sm text-muted-foreground">{t("teacher.findOtherType")}</p>
          ) : waiting ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t("teacher.findOtherSearching")}
            </p>
          ) : search.isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <span>{t("teacher.findOtherOffline")}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void search.refetch()}>
                {t("teacher.tryAgain")}
              </Button>
            </div>
          ) : matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("teacher.findOtherNone")}</p>
          ) : (
            <>
              <ul ref={results} className="space-y-1" aria-label={t("teacher.findOtherResults")}>
                {matches.map((one, index) => {
                  const name = `${one.firstName} ${one.lastName}`.trim();
                  return (
                    <li key={one.studentId}>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 w-full justify-between gap-3 px-3 text-base"
                        aria-label={t("markFoundFor", { name: one.className ? `${name} (${one.className})` : name })}
                        onClick={() => pick(one)}
                        onKeyDown={(event) => move(event, index)}
                      >
                        <span className="min-w-0 truncate">{name}</span>
                        {one.className ? <span className="shrink-0 text-sm font-normal text-muted-foreground">{one.className}</span> : null}
                      </Button>
                    </li>
                  );
                })}
              </ul>
              {(search.data ?? []).length >= MOST_RESULTS ? (
                <p className="text-sm text-muted-foreground">{t("teacher.findOtherMore", { shown: MOST_RESULTS })}</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
