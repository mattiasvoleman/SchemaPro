"use client";

import { Suspense, lazy, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock, Settings2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useAbsenceReasons, useAbsences } from "@/lib/cover-queries";
import type { Absence, AbsenceCounts } from "@/lib/cover-types";
import { absenceFormOf, absencePeriodText, shiftDate } from "@/lib/cover-absence-form";
import { reasonName } from "@/lib/cover-view";
import { ABSENCE_PHASE_VARIANT, COVER_STATUS_VARIANT } from "@/lib/status-variants";
import { cn, toDateString } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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

/*
 * The register sits inside its SectionCard, so its table takes the inner
 * recipe (brief §9): no frame of its own, tighter rows, the first cell flush
 * with the card's heading. Below sm only the teacher, the phase and the
 * actions keep a column; the period moves under the name.
 */
const INNER_TH = "h-auto py-1.5 pr-3 text-xs";
const INNER_TD = "py-1.5 pr-3";
const WIDE = "hidden sm:table-cell";

/** The day the board opens on: today for a running absence, else its first day. */
export function boardDateOf(absence: Absence, today: string): string {
  const first = absenceFormOf(absence).from;
  return absence.phase === "ONGOING" && first < today ? today : first;
}

/** The lessons' cover state as chips, in the board's colours (lib/status-variants.ts). */
function CountsCell({ counts }: { counts: AbsenceCounts }) {
  const t = useTranslations("teacherAbsence");
  const parts: { key: string; text: string; variant: (typeof COVER_STATUS_VARIANT)[keyof typeof COVER_STATUS_VARIANT] }[] = [];
  if (counts.open > 0) parts.push({ key: "open", text: t("countOpen", { count: counts.open }), variant: COVER_STATUS_VARIANT.OPEN });
  if (counts.covered > 0) parts.push({ key: "covered", text: t("countCovered", { count: counts.covered }), variant: COVER_STATUS_VARIANT.COVERED });
  if (counts.cancelled > 0) parts.push({ key: "cancelled", text: t("countCancelled", { count: counts.cancelled }), variant: COVER_STATUS_VARIANT.CANCELLED });
  if (counts.handled > 0) parts.push({ key: "handled", text: t("countHandled", { count: counts.handled }), variant: COVER_STATUS_VARIANT.HANDLED_SUPERVISED_STUDY });
  if (counts.passedOpen > 0) parts.push({ key: "passed", text: t("countPassed", { count: counts.passedOpen }), variant: COVER_STATUS_VARIANT.PASSED });
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
  const tCommon = useTranslations("common");
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

  const { data: absences, isLoading, isError } = useAbsences(
    showEnded ? { includeEnded: true, from: shiftDate(today, -90) } : {},
  );
  const { data: reasons } = useAbsenceReasons();

  const nameOf = useMemo(() => new Map(teachers.map((teacher) => [teacher.id, teacher.name])), [teachers]);
  const reasonOf = useMemo(() => new Map((reasons ?? []).map((reason) => [reason.id, reason])), [reasons]);

  return (
    <SectionCard
      id="absence-register"
      title={t("registerTitle")}
      description={t("registerBody")}
      action={
        <>
          <div className="flex items-center gap-2">
            <Switch id="absence-show-ended" checked={showEnded} onCheckedChange={setShowEnded} />
            <Label htmlFor="absence-show-ended" className="font-normal">
              {t("showEnded")}
            </Label>
          </div>
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
        </>
      }
    >
      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : isError ? (
        <LoadError variant="inline" title={t("registerLoadFailed")} hint={t("registerLoadFailedHint")} />
      ) : (absences ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("registerEmpty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">{t("registerCaption")}</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={cn(INNER_TH, "pl-0")}>
                  {t("columnTeacher")}
                </TableHead>
                <TableHead scope="col" className={cn(INNER_TH, WIDE)}>
                  {t("columnPeriod")}
                </TableHead>
                <TableHead scope="col" className={cn(INNER_TH, WIDE)}>
                  {t("columnReason")}
                </TableHead>
                <TableHead scope="col" className={INNER_TH}>
                  {t("columnPhase")}
                </TableHead>
                <TableHead scope="col" className={cn(INNER_TH, WIDE)}>
                  {t("columnLessons")}
                </TableHead>
                <TableHead scope="col" className={cn(INNER_TH, "pr-0 text-right")}>
                  {t("columnActions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(absences ?? []).map((absence) => {
                const live = absence.phase === "PLANNED" || absence.phase === "ONGOING";
                const teacher = nameOf.get(absence.userId) ?? "—";
                const period = absencePeriodText(absence, locale);
                // "Återkalla Anna Lind 1–3 okt.": a teacher can have two absences in the list.
                const named = (action: string) => tCommon("actionNamed", { action, name: `${teacher} ${period}` });
                return (
                  <TableRow key={absence.id}>
                    <TableCell className={cn(INNER_TD, "pl-0 font-medium")}>
                      {teacher}
                      <span className="block text-xs font-normal tabular-nums text-muted-foreground sm:hidden">
                        {period}
                      </span>
                      {absence.selfReported ? (
                        <span className="block text-xs font-normal text-muted-foreground">{t("selfReported")}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className={cn(INNER_TD, WIDE, "whitespace-nowrap tabular-nums")}>{period}</TableCell>
                    <TableCell className={cn(INNER_TD, WIDE)}>
                      {absence.reasonId ? reasonName(tReasons, reasonOf.get(absence.reasonId)) : tReasons("NONE")}
                    </TableCell>
                    <TableCell className={cn(INNER_TD, "whitespace-nowrap")}>
                      <Badge variant={ABSENCE_PHASE_VARIANT[absence.phase]}>{t(`phases.${absence.phase}`)}</Badge>
                    </TableCell>
                    <TableCell className={cn(INNER_TD, WIDE)}>
                      {absence.status === "ACTIVE" ? <CountsCell counts={absence.counts} /> : null}
                    </TableCell>
                    <TableCell className={cn(INNER_TD, "pr-0 text-right")}>
                      {/* Words, not RowActions' icons: the manual (6.2) sends the reader
                          to Ändra, Avsluta i förtid and Återkalla by name, and the last
                          two have no icon anyone would read as them. */}
                      <div className="flex flex-wrap justify-end gap-2">
                        {absence.status === "ACTIVE" ? (
                          <Button variant="outline" size="sm" asChild>
                            <Link
                              href={`/admin/cover?date=${boardDateOf(absence, today)}`}
                              aria-label={named(t("openBoard"))}
                            >
                              <CalendarClock />
                              {t("openBoard")}
                            </Link>
                          </Button>
                        ) : null}
                        {live ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={named(t("edit"))}
                            onClick={opening(() => setEditing(absence))}
                          >
                            {t("edit")}
                          </Button>
                        ) : null}
                        {absence.phase === "ONGOING" ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={named(t("end"))}
                            onClick={opening(() => setEnding(absence))}
                          >
                            {t("end")}
                          </Button>
                        ) : null}
                        {/* Neutral: the withdraw dialog is the confirmation, and carries the red. */}
                        {live ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={named(t("withdraw"))}
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
    </SectionCard>
  );
}
