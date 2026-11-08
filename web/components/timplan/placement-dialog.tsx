"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useRooms } from "@/lib/queries";
import { isMixed, lengthPartsOf, lessonCountOf } from "@/lib/lesson-lengths";
import {
  placementsRefusal,
  type PlacementInput,
  type PlacementRecurrence,
  type PlacementVerdict,
  type PlacementsOfRequirement,
} from "@/lib/requirement-placements";
import {
  fetchPlacementsOf,
  invalidatePlacements,
  placementsOfKey,
  savePlacements,
} from "@/lib/requirement-placements-api";
import {
  PLACEMENT_DAY_END,
  PLACEMENT_DAY_START,
  PLACEMENT_GRID_MINUTES,
  clockOfMinutes,
  fitSentence,
  minutesOfClock,
  verdictSentence,
} from "@/lib/requirement-placement-text";
import { sortByName } from "@/lib/sorting";
import type { TeachingRequirement } from "@/lib/types";
import { useReadOnly } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";

/*
 * Förlägg: the lessons of a timplanspost that the school already knows cannot
 * go anywhere else, given a day, a start and a room before Generera lays the
 * rest of the week around them.
 *
 * FETCHED ON THE FIRST PRESS of Förlägg (the timplan page holds it behind
 * lazy(), as the timetable holds SwapDialog): the page is within a few KB of
 * its bundle budget and a school places lessons a few times a year.
 *
 * It decides nothing. The gateway judges every row by the rule a hand edit of
 * the timetable is judged by, and this shows the verdict it was given — when
 * the dialog opens (a row can stop holding after the teacher was changed or a
 * lesson was locked beside it), and again, row by row, when a save is refused.
 * What the dialog does know is the post's shape, because it offers only what
 * can be saved: the post's lengths, the post's weeks, and no more lessons than
 * the post has, a pair of odd and even weeks counted as one.
 *
 * ODD AND EVEN WEEKS ON A POST OF EVERY WEEK go in pairs: an odd row and an
 * even row of one length are one lesson in two places ("udda veckor tisdag i
 * simhallen, jämna veckor torsdag"). The engine cannot lay half a lesson of an
 * every-week post, so a lone odd row is refused (PAIRS). The dialog says so
 * under the rows, and the add button, once it holds a lone row, adds the
 * other half of that pair.
 */

interface RowDraft {
  /** Stable across removals, so an error stays on the row it was said of. */
  key: number;
  day: string;
  start: string;
  minutes: string;
  roomId: string;
  /** The stored room's name, for a room the list no longer offers. */
  roomName: string | null;
  recurrence: PlacementRecurrence;
  /** The gateway's verdict on the row as stored; gone as soon as the row is changed. */
  verdict: PlacementVerdict | null;
}

interface FieldErrors {
  start?: string;
  room?: string;
}

export interface PlacementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The post being placed; null while nothing is. */
  requirement: TeachingRequirement | null;
  /** What the post is called ("7A · Slöjd"), for the title. */
  name: string | null;
  /** Whether the post shares its lessons between teachers, which a placement cannot. */
  shared: boolean;
}

const DAYS = [1, 2, 3, 4, 5] as const;

/** The lessons the rows are, a pair of odd and even weeks of one length counting as one. */
function lessonsDrafted(rows: readonly RowDraft[], postWeeks: PlacementRecurrence): number {
  if (postWeeks !== "ALL_WEEKS") return rows.length;
  let lessons = rows.filter((row) => row.recurrence === "ALL_WEEKS").length;
  for (const minutes of new Set(rows.map((row) => row.minutes))) {
    const odd = rows.filter((row) => row.minutes === minutes && row.recurrence === "ODD_WEEKS").length;
    const even = rows.filter((row) => row.minutes === minutes && row.recurrence === "EVEN_WEEKS").length;
    lessons += Math.max(odd, even);
  }
  return lessons;
}

/** A row on an every-week post whose other half is not there yet, and the weeks that other half runs. */
function loneRow(rows: readonly RowDraft[], postWeeks: PlacementRecurrence): { row: RowDraft; missing: PlacementRecurrence } | null {
  if (postWeeks !== "ALL_WEEKS") return null;
  for (const minutes of new Set(rows.map((row) => row.minutes))) {
    const odd = rows.filter((row) => row.minutes === minutes && row.recurrence === "ODD_WEEKS");
    const even = rows.filter((row) => row.minutes === minutes && row.recurrence === "EVEN_WEEKS");
    if (odd.length > even.length) return { row: odd[odd.length - 1]!, missing: "EVEN_WEEKS" };
    if (even.length > odd.length) return { row: even[even.length - 1]!, missing: "ODD_WEEKS" };
  }
  return null;
}

export function PlacementDialog({ open, onOpenChange, requirement, name, shared }: PlacementDialogProps) {
  const t = useTranslations("requirements.placements");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title", { post: name ?? "" })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {requirement ? (
          <PlacementForm
            // A fresh form per post, so nothing of the last one is left in it.
            key={requirement.id}
            requirement={requirement}
            shared={shared}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PlacementForm({
  requirement,
  shared,
  onClose,
}: {
  requirement: TeachingRequirement;
  shared: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("requirements.placements");
  const tDays = useTranslations("days");
  const tCommon = useTranslations("common");
  const client = useQueryClient();
  const readOnly = useReadOnly();
  const uid = useId();
  const { data: roomRows, isError: roomsFailed } = useRooms();
  const rooms = sortByName(roomRows ?? [], (room) => room.name);

  const postWeeks = requirement.recurrence;
  const parts = lengthPartsOf(requirement);
  const mixed = isMixed(requirement);
  const total = lessonCountOf(requirement);
  // A post in a block is placed with its block, and a post that shares its
  // lessons names a teacher per lesson: neither can be placed (BLOCK, SHARES).
  const blocked = requirement.blockId ? "BLOCK" : shared ? "SHARES" : null;

  const read = useQuery({
    queryKey: placementsOfKey(requirement.id),
    queryFn: () => fetchPlacementsOf(requirement.id),
    enabled: blocked === null,
    // The rows are copied into the form once and then edited; a refetch on
    // focus must not be able to write over a half-made change.
    refetchOnWindowFocus: false,
    gcTime: 0,
  });

  const [rows, setRows] = useState<RowDraft[] | null>(null);
  const [nextKey, setNextKey] = useState(1);
  /** A row the gateway refused on save, by its key, and what it said. */
  const [refused, setRefused] = useState<{ key: number; text: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<number, FieldErrors>>({});
  /** The rows do not fit the post, or the base timetable is being written. */
  const [topError, setTopError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    if (rows !== null || !read.data) return;
    const stored: PlacementsOfRequirement = read.data;
    setRows(
      stored.placements.map((placement, index) => ({
        key: index + 1,
        day: String(placement.dayOfWeek),
        start: placement.startTime,
        minutes: String(placement.minutes),
        roomId: placement.roomId,
        roomName: placement.roomName,
        recurrence: placement.recurrence,
        verdict: stored.verdicts.find((verdict) => verdict.index === index) ?? null,
      })),
    );
    setNextKey(stored.placements.length + 1);
  }, [read.data, rows]);

  // Focus follows the first thing that went wrong, once it is drawn.
  useEffect(() => {
    if (focusId === null) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  const id = (part: string, key: number | string) => `${uid}-${part}-${key}`;
  const topId = `${uid}-top`;
  const addId = `${uid}-add`;
  const pairsId = `${uid}-pairs`;

  const list = rows ?? [];
  const drafted = lessonsDrafted(list, postWeeks);
  const lone = loneRow(list, postWeeks);
  const canAdd = !readOnly && (drafted < total || lone !== null);
  const stale = list.filter((row) => row.verdict !== null && !row.verdict.ok).length;
  const storedCount = read.data?.placements.length ?? 0;

  const update = (key: number, patch: Partial<RowDraft>) => {
    setRows((current) => (current ?? []).map((row) => (row.key === key ? { ...row, ...patch, verdict: null } : row)));
    setRefused((current) => (current?.key === key ? null : current));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  };

  const add = () => {
    // The first length the post still has a lesson to place of.
    const open = parts.find((part) => lessonsDrafted(list.filter((row) => Number(row.minutes) === part.minutes), postWeeks) < part.count);
    const row: RowDraft = lone
      ? { ...lone.row, key: nextKey, start: "", recurrence: lone.missing, verdict: null }
      : {
          key: nextKey,
          day: "1",
          start: "",
          minutes: String((open ?? parts[0]!).minutes),
          roomId: "",
          roomName: null,
          recurrence: postWeeks,
          verdict: null,
        };
    setNextKey(nextKey + 1);
    setRows([...list, row]);
    setFocusId(id("day", nextKey));
  };

  const remove = (key: number) => {
    setRows(list.filter((row) => row.key !== key));
    setRefused((current) => (current?.key === key ? null : current));
    setFocusId(addId);
  };

  const startProblem = (row: RowDraft): string | undefined => {
    const start = minutesOfClock(row.start);
    const end = start + Number(row.minutes);
    return Number.isFinite(start) &&
      start % PLACEMENT_GRID_MINUTES === 0 &&
      start >= PLACEMENT_DAY_START &&
      end <= PLACEMENT_DAY_END
      ? undefined
      : t("problemStart", { from: clockOfMinutes(PLACEMENT_DAY_START), to: clockOfMinutes(PLACEMENT_DAY_END) });
  };

  const submit = async () => {
    setTopError(null);
    setRefused(null);
    // What the gateway would only refuse with a 400 it cannot word, said first.
    const errors: Record<number, FieldErrors> = {};
    let first: string | null = null;
    for (const row of list) {
      const problem: FieldErrors = {};
      const start = startProblem(row);
      if (start) problem.start = start;
      if (!row.roomId) problem.room = t("problemRoom");
      if (problem.start || problem.room) {
        errors[row.key] = problem;
        first ??= problem.start ? id("start", row.key) : id("room", row.key);
      }
    }
    setFieldErrors(errors);
    if (first) {
      setFocusId(first);
      return;
    }

    const body: PlacementInput[] = list.map((row) => ({
      dayOfWeek: Number(row.day),
      startTime: row.start,
      minutes: Number(row.minutes),
      roomId: row.roomId,
      recurrence: row.recurrence,
    }));
    setSaving(true);
    try {
      await savePlacements(requirement.id, body);
      void invalidatePlacements(client);
      toast.success(t("saved"));
      onClose();
    } catch (error) {
      const refusal = placementsRefusal(error);
      if (refusal?.kind === "ROW") {
        const row = list[refusal.index];
        if (row) {
          setRefused({ key: row.key, text: verdictSentence(t, refusal.reason, refusal.params) });
          setFocusId(id("day", row.key));
        } else {
          setTopError(verdictSentence(t, refusal.reason, refusal.params));
          setFocusId(topId);
        }
      } else if (refusal?.kind === "FIT") {
        setTopError(fitSentence(t, refusal.reason));
        setFocusId(topId);
      } else if (error instanceof ApiError && error.code === "SCHEDULE_BUSY") {
        setTopError(t("busy"));
        setFocusId(topId);
      } else {
        setTopError(error instanceof Error ? error.message : tCommon("error"));
        setFocusId(topId);
      }
    } finally {
      setSaving(false);
    }
  };

  const weeksLabel = (weeks: PlacementRecurrence) =>
    weeks === "ODD_WEEKS" ? t("weeksOdd") : weeks === "EVEN_WEEKS" ? t("weeksEven") : t("weeksAll");

  return (
    <>
      <div
        id={topId}
        tabIndex={-1}
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // Said out loud when it appears: a save that went wrong is not on the field the reader is in.
        hidden={topError === null}
      >
        {topError !== null ? (
          <Notice tone="destructive" title={t("notSaved")}>
            {topError}
          </Notice>
        ) : null}
      </div>

      {blocked ? (
        <Notice role={null}>{fitSentence(t, blocked)}</Notice>
      ) : read.isError ? (
        <Notice tone="destructive">{t("loadFailed")}</Notice>
      ) : rows === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("loading")}
        </p>
      ) : (
        <fieldset disabled={readOnly || saving} className="min-w-0 space-y-4">
          {stale > 0 ? (
            <Notice tone="warning" title={t("staleTitle", { count: stale })}>
              {t("staleBody", { count: stale })}
            </Notice>
          ) : null}
          {roomsFailed ? <Notice tone="destructive">{t("roomsFailed")}</Notice> : null}

          {list.length === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}

          {list.map((row, index) => {
            const errors = fieldErrors[row.key] ?? {};
            const stored = row.verdict && !row.verdict.ok ? row.verdict : null;
            const rowError =
              refused?.key === row.key
                ? refused.text
                : stored
                  ? verdictSentence(t, stored.reason, stored.params)
                  : null;
            const rowErrorId = id("error", row.key);
            const end = Number.isFinite(minutesOfClock(row.start))
              ? clockOfMinutes(minutesOfClock(row.start) + Number(row.minutes))
              : null;
            return (
              <fieldset
                key={row.key}
                className="space-y-3 rounded-md border p-3"
                aria-describedby={rowError ? rowErrorId : undefined}
              >
                <legend className="px-1 text-sm font-medium">{t("rowTitle", { n: index + 1 })}</legend>
                <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
                  <div className="space-y-1.5">
                    <Label htmlFor={id("day", row.key)}>{t("day")}</Label>
                    <NativeSelect
                      id={id("day", row.key)}
                      value={row.day}
                      aria-invalid={rowError ? true : undefined}
                      aria-describedby={rowError ? rowErrorId : undefined}
                      onChange={(event) => update(row.key, { day: event.target.value })}
                    >
                      {DAYS.map((day) => (
                        <option key={day} value={day}>
                          {tDays(String(day))}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <FormField
                    id={id("start", row.key)}
                    label={t("start")}
                    hint={end ? t("ends", { end }) : undefined}
                    error={errors.start}
                  >
                    <Input
                      type="time"
                      step={300}
                      min={clockOfMinutes(PLACEMENT_DAY_START)}
                      max={clockOfMinutes(PLACEMENT_DAY_END - PLACEMENT_GRID_MINUTES)}
                      value={row.start}
                      onChange={(event) => update(row.key, { start: event.target.value })}
                    />
                  </FormField>
                  {mixed ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={id("length", row.key)}>{t("length")}</Label>
                      <NativeSelect
                        id={id("length", row.key)}
                        value={row.minutes}
                        onChange={(event) => update(row.key, { minutes: event.target.value })}
                      >
                        {parts.map((part) => (
                          <option key={part.minutes} value={part.minutes}>
                            {t("minutes", { minutes: part.minutes })}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  ) : null}
                  <FormField id={id("room", row.key)} label={t("room")} error={errors.room}>
                    {(control) => (
                      <NativeSelect
                        {...control}
                        value={row.roomId}
                        onChange={(event) => update(row.key, { roomId: event.target.value })}
                      >
                        <option value="">{t("roomPlaceholder")}</option>
                        {rooms.map((room) => (
                          <option key={room.id} value={room.id}>
                            {room.name}
                          </option>
                        ))}
                        {/* A room the list does not offer any more is kept as stored, not dropped. */}
                        {row.roomId && row.roomName && !rooms.some((room) => room.id === row.roomId) ? (
                          <option value={row.roomId}>{row.roomName}</option>
                        ) : null}
                      </NativeSelect>
                    )}
                  </FormField>
                  <FormField
                    id={id("weeks", row.key)}
                    label={t("weeks")}
                    hint={postWeeks === "ALL_WEEKS" ? undefined : t(postWeeks === "ODD_WEEKS" ? "weeksLockedOdd" : "weeksLockedEven")}
                  >
                    {(control) => (
                      <NativeSelect
                        {...control}
                        // The pairs paragraph under the rows belongs to this field on a post of every week.
                        aria-describedby={
                          postWeeks === "ALL_WEEKS" ? pairsId : control["aria-describedby"]
                        }
                        value={row.recurrence}
                        // A post of odd or even weeks is placed in those weeks only: set, and not to be changed.
                        disabled={postWeeks !== "ALL_WEEKS"}
                        onChange={(event) =>
                          update(row.key, { recurrence: event.target.value as PlacementRecurrence })
                        }
                      >
                        {(postWeeks === "ALL_WEEKS"
                          ? (["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"] as const)
                          : [postWeeks]
                        ).map((weeks) => (
                          <option key={weeks} value={weeks}>
                            {weeksLabel(weeks)}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                  </FormField>
                </div>
                {rowError ? (
                  <p id={rowErrorId} className="text-sm text-destructive">
                    {rowError}
                  </p>
                ) : null}
                {readOnly ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t("remove", { n: index + 1 })}
                    onClick={() => remove(row.key)}
                  >
                    <X className="mr-1 size-4" aria-hidden />
                    {t("removeShort")}
                  </Button>
                )}
              </fieldset>
            );
          })}

          {postWeeks === "ALL_WEEKS" ? (
            <p id={pairsId} className="text-xs text-muted-foreground">
              {t("pairsHint")}
            </p>
          ) : null}

          {readOnly ? null : (
            <div className="space-y-1.5">
              <Button
                id={addId}
                type="button"
                variant="outline"
                size="sm"
                disabled={!canAdd}
                aria-describedby={canAdd ? undefined : `${addId}-full`}
                onClick={add}
              >
                <Plus className="mr-1 size-4" aria-hidden />
                {t("add")}
              </Button>
              {canAdd ? null : (
                <p id={`${addId}-full`} className="text-xs text-muted-foreground">
                  {t("addFull", { count: total })}
                </p>
              )}
            </div>
          )}

          {list.length === 0 && storedCount > 0 ? <Notice role={null}>{t("emptySave")}</Notice> : null}
        </fieldset>
      )}

      <Notice role={null}>
        <p>{t("nextGenerate")}</p>
        <p>{t("handMove")}</p>
        <p>{t("neverGivesWay")}</p>
      </Notice>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {readOnly ? tCommon("close") : tCommon("cancel")}
        </Button>
        {readOnly || blocked ? null : (
          <Button
            type="button"
            data-writes="PLANERING"
            disabled={saving || rows === null}
            onClick={() => void submit()}
          >
            {tCommon("save")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
