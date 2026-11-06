"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SearchField } from "@/components/ui/search-field";
import type { MyAlarm, OtherPupilView } from "@/lib/crisis-types";

/*
 * "Hittat en elev som inte står på listan" (Krisläge): a teacher who meets a
 * pupil that is on none of their lists, in the corridor or the yard, says so
 * here, and the pupil is marked FOUND, "found with me", on one of the
 * teacher's groups. The administration then sees the pupil as found.
 *
 * The pupil is picked from the alarm's `others` (every pupil of the school
 * who is on none of the teacher's lists; up to a thousand names, kept offline
 * with the lists) by typing a name or a class. Only FOUND is ever offered
 * here: the gateway refuses MISSING for a pupil who is not on the group's list.
 *
 * Small on purpose, for the bundle and for a phone in a hand that is moving:
 * no dialog and no combobox. A button that opens a search box, a list of at
 * most RESULT_LIMIT buttons of 44 px, the arrow keys to move in it, Escape to
 * close. Nothing is marked until a result is pressed.
 */

/** The results drawn: a thousand names would be a thousand buttons for a screen reader to read. */
const RESULT_LIMIT = 50;

/** Case and accents folded away, so that "ake" finds "Åke" on a keyboard without the letter. */
const fold = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function FindOther({
  alarm,
  onFound,
}: {
  alarm: MyAlarm;
  /** Says the pupil was found with the group (the page queues the mark). */
  onFound: (callId: string, studentId: string) => void;
}) {
  const t = useTranslations("crisis");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState("");
  const [added, setAdded] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const results = useRef<HTMLUListElement>(null);

  // The group the pupil is found with: the lesson going on if there is one, else the first. A choice only when there are several.
  const fallback = (alarm.calls.find((call) => call.basis === "LESSON") ?? alarm.calls[0])?.id ?? "";
  const callId = alarm.calls.some((call) => call.id === chosen) ? chosen : fallback;

  // Pupils already found with this teacher are no longer to be found.
  const taken = useMemo(() => new Set(alarm.calls.flatMap((call) => (call.foundHere ?? []).map((one) => one.studentId))), [alarm.calls]);
  const haystacks = useMemo(
    () => (alarm.others ?? []).map((one) => ({ one, text: fold(`${one.firstName} ${one.lastName} ${one.className ?? ""}`) })),
    [alarm.others],
  );
  const words = fold(query).split(/\s+/).filter(Boolean);
  const matches: OtherPupilView[] =
    words.length === 0 ? [] : haystacks.filter((row) => !taken.has(row.one.studentId) && words.every((word) => row.text.includes(word))).map((row) => row.one);

  const close = () => {
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  };
  const pick = (one: OtherPupilView) => {
    onFound(callId, one.studentId);
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
          {words.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("teacher.findOtherType")}</p>
          ) : matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("teacher.findOtherNone")}</p>
          ) : (
            <>
              <ul ref={results} className="space-y-1" aria-label={t("teacher.findOtherResults")}>
                {matches.slice(0, RESULT_LIMIT).map((one, index) => {
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
              {matches.length > RESULT_LIMIT ? (
                <p className="text-sm text-muted-foreground">{t("teacher.findOtherMore", { shown: RESULT_LIMIT, count: matches.length })}</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
