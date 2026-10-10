"use client";

import { Suspense, lazy, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock, Settings2 } from "lucide-react";
import Link from "next/link";
import { localePath } from "@/i18n/paths";
import { useAbsenceReasons, useAbsences } from "@/lib/cover-queries";
import type { Absence, AbsenceCounts } from "@/lib/cover-types";
import { absenceFormOf, absencePeriodText, shiftDate } from "@/lib/cover-absence-form";
import { reasonName } from "@/lib/cover-view";
import { toDateString } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The settings (reasons, self-report, the pool and its windows): React.lazy
 * and mounted on the first click, so an admin who only covers today's lessons
 * never downloads them.
 */
const CoverSettingsDialog = lazy(() =>
  import("./cover-settings-dialog").then((module) => ({ default: module.CoverSettingsDialog })),
);

/**
 * Ändra, Avsluta i förtid and Återkalla, the same way: a register is read far
 * more often than it is changed, and these three are the page's form code.
 */
const AbsenceDialog = lazy(() =>
  import("@/components/cover/absence-dialog").then((module) => ({ default: module.AbsenceDialog })),
);
const AbsenceEndDialog = lazy(() =>
  import("@/components/cover/absence-end-dialog").then((module) => ({ default: module.AbsenceEndDialog })),
);
const AbsenceWithdrawDialog = lazy(() =>
  import("@/components/cover/absence-end-dialog").then((module) => ({ default: module.AbsenceWithdrawDialog })),
);

const PHASE_VARIANT = {
  PLANNED: "secondary",
  ONGOING: "warning",
  ENDED: "outline",
  WITHDRAWN: "outline",
} as const;

/** The day the board opens on: today for a running absence, else its first day. */
export function boardDateOf(absence: Absence, today: string): string {
  const first = absenceFormOf(absence).from;
  return absence.phase === "ONGOING" && first < today ? today : first;
}

function CountsCell({ counts }: { counts: AbsenceCounts }) {
  const t = useTranslations("teacherAbsence");
  const parts: { key: string; text: string; variant: "warning" | "success" | "secondary" | "outline" }[] = [];
  if (counts.open > 0) parts.push({ key: "open", text: t("countOpen", { count: counts.open }), variant: "warning" });
  if (counts.covered > 0) parts.push({ key: "covered", text: t("countCovered", { count: counts.covered }), variant: "success" });
  if (counts.cancelled > 0) parts.push({ key: "cancelled", text: t("countCancelled", { count: counts.cancelled }), variant: "secondary" });
  if (counts.handled > 0) parts.push({ key: "handled", text: t("countHandled", { count: counts.handled }), variant: "secondary" });
  if (counts.passedOpen > 0) parts.push({ key: "passed", text: t("countPassed", { count: counts.passedOpen }), variant: "outline" });
  if (parts.length === 0) return <span className="text-muted-foreground">{t("countNone")}</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {parts.map((part) => (
        <Badge key={part.key} variant={part.variant}>
          {part.text}
        </Badge>
      ))}
    </div>
  );
}

/**
 * The absence register on Lärarfrånvaro: current and coming absences (ended
 * and withdrawn on request), each with its lessons' cover state, and Ändra,
 * Avsluta i förtid, Återkalla and a link to its day on the board.
 *
 * The reason is shown here, on an admin-only page, and nowhere a colleague,
 * a pupil or a guardian looks.
 */
export function AbsenceRegister({ teachers }: { teachers: { id: string; name: string }[] }) {
  const t = useTranslations("teacherAbsence");
  const tReasons = useTranslations("absenceReasons");
  const locale = useLocale();
  const today = toDateString(new Date());
  const [showEnded, setShowEnded] = useState(false);
  const [editing, setEditing] = useState<Absence | null>(null);
  const [ending, setEnding] = useState<Absence | null>(null);
  const [withdrawing, setWithdrawing] = useState<Absence | null>(null);
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialogsOpened, setDialogsOpened] = useState(false);
  const opening = (action: () => void) => () => {
    setDialogsOpened(true);
    action();
  };

  const { data: absences, isLoading } = useAbsences(
    showEnded ? { includeEnded: true, from: shiftDate(today, -90) } : {},
  );
  const { data: reasons } = useAbsenceReasons();

  const nameOf = useMemo(() => new Map(teachers.map((teacher) => [teacher.id, teacher.name])), [teachers]);
  const reasonOf = useMemo(() => new Map((reasons ?? []).map((reason) => [reason.id, reason])), [reasons]);

  return (
    <section className="mb-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{t("registerTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("registerBody")}</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showEnded} onChange={(event) => setShowEnded(event.target.checked)} />
            {t("showEnded")}
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSettingsOpened(true);
              setSettingsOpen(true);
            }}
          >
            <Settings2 />
            {t("settings")}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : (absences ?? []).length === 0 ? (
        <p className="rounded-lg border bg-card px-4 py-3 text-sm text-muted-foreground">{t("registerEmpty")}</p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columnTeacher")}</TableHead>
                <TableHead>{t("columnPeriod")}</TableHead>
                <TableHead>{t("columnReason")}</TableHead>
                <TableHead>{t("columnPhase")}</TableHead>
                <TableHead>{t("columnLessons")}</TableHead>
                <TableHead className="text-right">{t("columnActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(absences ?? []).map((absence) => {
                const live = absence.phase === "PLANNED" || absence.phase === "ONGOING";
                return (
                  <TableRow key={absence.id}>
                    <TableCell className="font-medium">
                      {nameOf.get(absence.userId) ?? "—"}
                      {absence.selfReported ? (
                        <span className="block text-xs font-normal text-muted-foreground">{t("selfReported")}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{absencePeriodText(absence, locale)}</TableCell>
                    <TableCell>
                      {absence.reasonId ? reasonName(tReasons, reasonOf.get(absence.reasonId)) : tReasons("NONE")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={PHASE_VARIANT[absence.phase]}>{t(`phases.${absence.phase}`)}</Badge>
                    </TableCell>
                    <TableCell>
                      {absence.status === "ACTIVE" ? <CountsCell counts={absence.counts} /> : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {absence.status === "ACTIVE" ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link href={localePath(locale, `/admin/cover?date=${boardDateOf(absence, today)}`)}>
                              <CalendarClock />
                              {t("openBoard")}
                            </Link>
                          </Button>
                        ) : null}
                        {live ? (
                          <Button variant="outline" size="sm" onClick={opening(() => setEditing(absence))}>
                            {t("edit")}
                          </Button>
                        ) : null}
                        {absence.phase === "ONGOING" ? (
                          <Button variant="outline" size="sm" onClick={opening(() => setEnding(absence))}>
                            {t("end")}
                          </Button>
                        ) : null}
                        {live ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            onClick={opening(() => setWithdrawing(absence))}
                          >
                            {t("withdraw")}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {dialogsOpened ? (
        <Suspense fallback={null}>
          <AbsenceDialog
            open={editing !== null}
            onOpenChange={(open) => !open && setEditing(null)}
            mode="ADMIN"
            absence={editing}
            teachers={teachers}
          />
          <AbsenceEndDialog absence={ending} mode="ADMIN" onOpenChange={(open) => !open && setEnding(null)} />
          <AbsenceWithdrawDialog absence={withdrawing} onOpenChange={(open) => !open && setWithdrawing(null)} />
        </Suspense>
      ) : null}
      {settingsOpened ? (
        <Suspense fallback={null}>
          <CoverSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} teachers={teachers} />
        </Suspense>
      ) : null}
    </section>
  );
}
