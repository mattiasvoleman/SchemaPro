"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { useAvailability, useAvailabilityActions } from "@/lib/cover-queries";
import type { PoolWindow, PoolWindowInput } from "@/lib/cover-types";
import { coverErrorText } from "@/lib/cover-view";
import { toDateString } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const NATIVE_SELECT =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** "Måndag 08:00–16:00" or "2026-10-14 08:00–12:00". */
export function windowText(window: PoolWindow, dayName: (day: number) => string): string {
  const when = window.date ?? dayName(window.dayOfWeek ?? 1);
  return `${when} ${window.startTime.slice(0, 5)}–${window.endTime.slice(0, 5)}`;
}

/**
 * The windows a pool member can work (SubstituteAvailabilities): dated or
 * weekly, each a start and an end. A pool member without a post is suggested
 * ONLY inside them (the hard rule POOL_NOT_DECLARED), so an empty list means
 * "never suggested" and says so.
 *
 * `userId` names the member for an admin; a pool member keeps their own and
 * passes nothing (RLS: substitute_availabilities_own_all). Native selects:
 * this sits on the teacher's own page, whose tier has the least room.
 */
export function AvailabilityEditor({ userId, own = false }: { userId?: string; own?: boolean }) {
  const t = useTranslations("substitutePool");
  const tDays = useTranslations("days");
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const { data: windows, isLoading } = useAvailability(userId);
  const { add, remove } = useAvailabilityActions();
  const [kind, setKind] = useState<"weekday" | "date">("weekday");
  const [date, setDate] = useState(() => toDateString(new Date()));
  const [weekday, setWeekday] = useState(1);
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("16:00");

  const dayName = (day: number) => tDays(String(day));
  const mine = (windows ?? []).filter((window) => !userId || window.userId === userId);

  const submit = async () => {
    const input: PoolWindowInput = {
      ...(userId ? { userId } : {}),
      ...(kind === "date" ? { date } : { dayOfWeek: weekday }),
      startTime: start,
      endTime: end,
    };
    try {
      await add.mutateAsync(input);
      toast.success(t("windowAdded"));
    } catch (error) {
      toast.error(coverErrorText(tErrors, error, tCommon("error")));
    }
  };

  const drop = async (id: string) => {
    try {
      await remove.mutateAsync(id);
    } catch (error) {
      toast.error(coverErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{own ? t("ownAvailabilityBody") : t("availabilityBody")}</p>
      {isLoading ? null : mine.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">{t("noWindows")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {mine.map((window) => {
            const text = windowText(window, dayName);
            return (
              <li key={window.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                <span className="tabular-nums">{window.date ? text : `${t("weekly")} · ${text}`}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("removeWindow", { when: text })}
                  onClick={() => void drop(window.id)}
                  disabled={remove.isPending}
                >
                  <Trash2 />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="window-kind">{t("windowKind")}</Label>
          <select
            id="window-kind"
            className={NATIVE_SELECT}
            value={kind}
            onChange={(event) => setKind(event.target.value === "date" ? "date" : "weekday")}
          >
            <option value="weekday">{t("kindWeekday")}</option>
            <option value="date">{t("kindDate")}</option>
          </select>
        </div>
        {kind === "date" ? (
          <div className="space-y-1">
            <Label htmlFor="window-date">{t("date")}</Label>
            <DateField id="window-date" label={t("date")} value={date} onChange={setDate} />
          </div>
        ) : (
          <div className="space-y-1">
            <Label htmlFor="window-weekday">{t("weekday")}</Label>
            <select
              id="window-weekday"
              className={NATIVE_SELECT}
              value={weekday}
              onChange={(event) => setWeekday(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                <option key={day} value={day}>
                  {dayName(day)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="window-start">{t("start")}</Label>
          <Input id="window-start" type="time" value={start} onChange={(event) => setStart(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="window-end">{t("end")}</Label>
          <Input id="window-end" type="time" value={end} onChange={(event) => setEnd(event.target.value)} />
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => void submit()} disabled={add.isPending || !start || !end}>
        {add.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
        {t("addWindow")}
      </Button>
    </div>
  );
}
