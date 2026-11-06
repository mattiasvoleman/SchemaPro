"use client";

import { useTranslations } from "next-intl";
import { Check, CircleHelp, Clock, DoorOpen, UserX, X, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PupilMark, PupilStatus, PupilView } from "@/lib/crisis-types";
import { PUPIL_STATUS_VARIANT } from "@/lib/crisis-view";
import { cn } from "@/lib/utils";

/*
 * One pupil of a group: the name, where the pupil stands in words and an icon
 * (never colour alone), and "Finns" / "Saknas" to say it. The same row on the
 * teacher's page, with the big touch targets of a phone in a hand that is
 * moving (44 px), and on the administration's live view, where the
 * administration marks a group nobody answers for.
 *
 * The buttons are a set of toggles (aria-pressed): the one that is pressed is
 * the mark the list holds. There is no mark to take one back; pressing another
 * one corrects it, and the timeline keeps both.
 *
 * "Inte i huset" (AWAY) is a third, and the administration's alone: a pupil
 * nobody has seen who is not thought to be in the building. It is said apart
 * from Finns and Saknas in words and an icon, and a teacher's page never
 * passes `away`, because the gateway refuses it from a teacher. Its icon, the
 * open door, is one no other page uses: LogOut, which the user menu draws, made
 * the shell's chunk lend it to the crisis pages and cost +17 B on every
 * admin route (measured; /admin/requirements has no bytes to spare).
 *
 * A pupil a teacher found who is on no list of theirs has no marks to press,
 * only "Ta tillbaka" (`onRetract`) while the alarm is going.
 */

const ICON: Record<PupilStatus, LucideIcon> = {
  FOUND: Check,
  MISSING: X,
  AWAY: DoorOpen,
  ABSENT_BEFORE: UserX,
  UNREPORTED: CircleHelp,
};

export function PupilRow({
  pupil,
  pending = false,
  onMark,
  away = false,
  onRetract,
  large = false,
  detail,
}: {
  pupil: PupilView;
  /** A line under the name: where the pupil's group is, when the row stands outside it. */
  detail?: string;
  /** The mark shown has not been acknowledged by the gateway yet. */
  pending?: boolean;
  /** Absent: the row is read-only (a reader, an alarm that is over). */
  onMark?: (state: PupilMark) => void;
  /** Also offers "Inte i huset": the administration's, never a teacher's. */
  away?: boolean;
  /** Offers "Ta tillbaka" for a pupil found with no mark of their own to press: takes the find back. */
  onRetract?: () => void;
  large?: boolean;
}) {
  const t = useTranslations("crisis");
  const name = `${pupil.firstName} ${pupil.lastName}`.trim();
  const Icon = ICON[pupil.status];
  const size = large ? "h-11 min-w-[5.5rem] px-4 text-base" : "h-8 px-3 text-xs";
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-2">
      <div className="min-w-0 space-y-1">
        <p className={cn("break-words font-medium", large && "text-base")}>{name}</p>
        {detail ? <p className="break-words text-xs text-muted-foreground">{detail}</p> : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge variant={PUPIL_STATUS_VARIANT[pupil.status]} className="gap-1">
            <Icon className="size-3" aria-hidden="true" />
            {t(`status.${pupil.status}`)}
          </Badge>
          {pupil.status === "ABSENT_BEFORE" && pupil.priorAbsentSource ? (
            <span className="text-xs text-muted-foreground">{t(`absentSource.${pupil.priorAbsentSource}`)}</span>
          ) : null}
          {pending ? (
            <span className="flex items-center gap-1 text-xs font-medium text-foreground">
              <Clock className="size-3" aria-hidden="true" />
              {t("pending")}
            </span>
          ) : null}
        </div>
      </div>
      {onMark ? (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className={cn(
              size,
              pupil.status === "FOUND" && "border-transparent bg-success-strong text-success-foreground hover:bg-success-strong hover:text-success-foreground",
            )}
            aria-pressed={pupil.status === "FOUND"}
            aria-label={t("markFoundFor", { name })}
            onClick={() => {
              if (pupil.status !== "FOUND") onMark("FOUND");
            }}
          >
            {pupil.status === "FOUND" ? <Check aria-hidden="true" /> : null}
            {t("markFound")}
          </Button>
          <Button
            type="button"
            variant={pupil.status === "MISSING" ? "destructive" : "outline"}
            className={size}
            aria-pressed={pupil.status === "MISSING"}
            aria-label={t("markMissingFor", { name })}
            onClick={() => {
              if (pupil.status !== "MISSING") onMark("MISSING");
            }}
          >
            {pupil.status === "MISSING" ? <X aria-hidden="true" /> : null}
            {t("markMissing")}
          </Button>
          {away ? (
            <Button
              type="button"
              variant={pupil.status === "AWAY" ? "secondary" : "outline"}
              className={cn(size, "whitespace-normal")}
              aria-pressed={pupil.status === "AWAY"}
              aria-label={t("markAwayFor", { name })}
              onClick={() => {
                if (pupil.status !== "AWAY") onMark("AWAY");
              }}
            >
              {pupil.status === "AWAY" ? <DoorOpen aria-hidden="true" /> : null}
              {t("markAway")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {onRetract ? (
        <Button type="button" variant="outline" className={size} aria-label={t("retractFor", { name })} onClick={onRetract}>
          {t("retract")}
        </Button>
      ) : null}
    </li>
  );
}
