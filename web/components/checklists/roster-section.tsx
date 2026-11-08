"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, Printer, Users } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useChecklistActions, useInstructors, useRoster } from "@/lib/checklists-queries";
import {
  CHECKLIST_NOT_FOUND,
  PROOF_NOTE_MAX,
  TICK_MAX,
  earlierProofs,
  instructorOf,
  latestProof,
  missingIds,
  setChosen,
  stillOnRoster,
  tickBody,
  tickProblems,
  tickableIds,
  type ProofRoster,
  type ProofRow,
  type ProofsWritten,
  type TickProblem,
} from "@/lib/checklists";
import { CHECKLIST_STATE_VARIANT } from "@/lib/status-variants";
import { toDateString } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { useChecklistsText } from "./use-checklists-text";
import { useChecklistDialogs } from "./use-dialogs";
import { usePrintSheet } from "./use-print-sheet";

const FIELD_OF: Partial<Record<TickProblem, string>> = {
  date: "tick-date",
  dateFuture: "tick-date",
  noteLong: "tick-note",
};

/**
 * One template in one group: the pupils, what each has had, and the form that
 * ticks the chosen ones. The roster is read when this is drawn and not kept (the
 * gateway records it in the läslogg).
 *
 * A pupil can be ticked once a day for a template: ticking again the same day is
 * counted, not written, and the result says how many were new and how many
 * already had the day's tick. The date is today unless changed and is never one
 * that has not come; the instructor is the signed-in person unless another is
 * named. A tick made in error is voided with a reason, and the roster stops
 * counting it, but it stays on the pupil's card.
 *
 * Who can be ticked is the gateway's say per row (`canTick`): a teacher's own
 * pupils, and an administrator's all. A row the reader may only look at has no
 * box. A name opens the pupil's card.
 */
export function RosterSection({ templateId, groupId, readOnly }: { templateId: string; groupId: string; readOnly: boolean }) {
  const { t, tCommon, day, refusal } = useChecklistsText();
  const query = useRoster(templateId, groupId);
  const roster = query.data;
  const { tick } = useChecklistActions();
  const dialogs = useChecklistDialogs();
  const printing = usePrintSheet<ProofRoster>();
  const canTickAny = !readOnly && (roster?.rows.some((row) => row.canTick) ?? false);
  const instructors = useInstructors(canTickAny);
  const [today] = useState(() => toDateString(new Date()));
  const [picked, setPicked] = useState<string[]>([]);
  const [instructedOn, setInstructedOn] = useState(today);
  const [instructorId, setInstructorId] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<ProofsWritten | null>(null);
  const pending = tick.isPending;
  const rows: readonly ProofRow[] = roster?.rows ?? [];
  const chosen = stillOnRoster(picked, rows);
  const form = { studentIds: chosen, instructedOn, instructorId, note };
  const problems = tickProblems(form, today);
  const chosenSet = new Set(chosen);
  const fieldError = (...which: TickProblem[]): string | undefined => {
    const found = tried ? problems.find((one) => which.includes(one)) : undefined;
    return found ? t(`tick.problem.${found}`, { max: found === "noteLong" ? PROOF_NOTE_MAX : TICK_MAX }) : undefined;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setTried(true);
    setProblem(null);
    setResult(null);
    if (problems.length > 0) {
      const field = FIELD_OF[problems[0]!];
      if (field) document.getElementById(field)?.focus();
      return;
    }
    try {
      setResult(await tick.mutateAsync(tickBody(templateId, form, today)));
      setPicked([]);
      setNote("");
      setTried(false);
    } catch (error) {
      setProblem(refusal(error));
    }
  };

  if (query.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (!roster) {
    const gone = query.error instanceof ApiError && query.error.code === CHECKLIST_NOT_FOUND;
    return (
      <LoadError
        variant="inline"
        title={t(gone ? "roster.notFound" : "roster.loadFailed")}
        hint={t(gone ? "roster.notFoundHint" : "roster.loadFailedHint")}
        action={
          gone ? undefined : (
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
              {tCommon("retry")}
            </Button>
          )
        }
      />
    );
  }

  const selectable = canTickAny;
  const pupilsError = fieldError("pupils", "pupilsMany");
  const Sheets = printing.sheets;
  const resultText = result
    ? t("tick.result", { written: result.written, already: result.already })
    : "";

  return (
    <div className="space-y-3">
      {/* Always on the page, so that a result put into it is announced. */}
      <p className="sr-only" role="status" aria-live="polite">
        {resultText}
      </p>
      {/* A read again that failed (after a tick, say) leaves the roster as it was last read, and says so. */}
      {query.isError ? <LoadError variant="inline" title={t("roster.loadFailed")} hint={tCommon("refetchFailedHint")} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-medium" aria-live="polite">
          {t("roster.done", { done: roster.done, pupils: roster.pupils })}
        </p>
        <div className="flex flex-wrap gap-2">
          {selectable ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={missingIds(rows).length === 0}
                onClick={() => setPicked(missingIds(rows))}
              >
                {t("roster.chooseMissing")}
              </Button>
              {chosen.length > 0 ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setPicked([])}>
                  {t("roster.clear")}
                </Button>
              ) : null}
            </>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rows.length === 0 || printing.preparing || printing.paper !== null}
            onClick={() => void printing.print((actions) => actions.fetchRosterForPaper(templateId, groupId))}
          >
            <Printer aria-hidden="true" />
            {printing.preparing ? t("print.preparing") : t("print.button")}
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Users} headingLevel={3} title={t("roster.emptyTitle")} description={t("roster.empty")} />
      ) : (
        <TableCard caption={t("roster.caption", { template: roster.template.title, group: roster.group.name })} tableClassName="min-w-[26rem]">
          <TableHeader>
            <TableRow>
              {selectable ? (
                <TableHead scope="col" className="w-10 pr-0">
                  <span className="sr-only">{t("roster.colChoose")}</span>
                </TableHead>
              ) : null}
              <TableHead scope="col">{t("roster.colPupil")}</TableHead>
              <TableHead scope="col" className="hidden sm:table-cell">
                {t("roster.colClass")}
              </TableHead>
              <TableHead scope="col">{t("roster.colStatus")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const latest = latestProof(row);
              const by = latest ? instructorOf(latest) : null;
              const earlier = earlierProofs(row);
              return (
                <TableRow key={row.studentId} data-state={chosenSet.has(row.studentId) ? "selected" : undefined}>
                  {selectable ? (
                    <TableCell className="w-10 pr-0">
                      {row.canTick ? (
                        <input
                          type="checkbox"
                          className="size-4 shrink-0 accent-primary"
                          aria-label={t("roster.choose", { name: row.name })}
                          checked={chosenSet.has(row.studentId)}
                          disabled={pending}
                          onChange={(event) => setPicked((current) => setChosen(current, [row.studentId], event.target.checked))}
                        />
                      ) : null}
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <button
                      type="button"
                      className="rounded-sm text-left font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={t("roster.openCard", { name: row.name })}
                      onClick={() => dialogs.open({ kind: "card", studentId: row.studentId, name: row.name })}
                    >
                      {row.name}
                    </button>
                    {row.className ? <span className="block text-xs text-muted-foreground sm:hidden">{row.className}</span> : null}
                    {row.canTick ? null : <span className="block text-xs text-muted-foreground">{t("roster.lookOnlyRow")}</span>}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">{row.className ?? ""}</TableCell>
                  <TableCell>
                    {latest ? (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="flex items-center gap-1.5">
                          <CircleCheck className="size-4 shrink-0 text-success-strong" aria-hidden="true" />
                          {by ? t("roster.had", { date: day(latest.instructedOn), by }) : t("roster.hadNoName", { date: day(latest.instructedOn) })}
                        </span>
                        {earlier > 0 ? <span className="text-xs text-muted-foreground">{t("roster.earlier", { count: earlier })}</span> : null}
                        {latest.note ? <span className="w-full text-xs text-muted-foreground">{latest.note}</span> : null}
                        {latest.canVoid && !readOnly ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-writes="DRIFT"
                            aria-label={t("roster.voidNamed", { name: row.name, date: day(latest.instructedOn) })}
                            onClick={() =>
                              dialogs.open({
                                kind: "void",
                                proofId: latest.id,
                                label: `${row.name} · ${roster.template.title}, ${day(latest.instructedOn)}`,
                              })
                            }
                          >
                            {t("roster.void")}
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <Badge variant={CHECKLIST_STATE_VARIANT.PROOF_MISSING}>{t("roster.missing")}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </TableCard>
      )}

      {result ? (
        <Notice tone="success" role={null} title={t("tick.resultTitle")} onDismiss={() => setResult(null)}>
          {resultText}
        </Notice>
      ) : null}

      {canTickAny && tickableIds(rows).length > 0 ? (
        <form onSubmit={submit} noValidate className="space-y-4 border-t pt-3" aria-busy={pending || undefined}>
          <h3 className="text-sm font-semibold">{t("tick.formTitle")}</h3>
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <FormField id="tick-date" label={t("tick.dateLabel")} hint={t("tick.dateHint")} error={fieldError("date", "dateFuture")}>
              <DateField value={instructedOn} onChange={setInstructedOn} max={today} label={t("tick.dateLabel")} />
            </FormField>
            <FormField id="tick-instructor" label={t("tick.instructorLabel")} hint={t("tick.instructorHint")}>
              <NativeSelect value={instructorId} onChange={(event) => setInstructorId(event.target.value)} disabled={pending}>
                <option value="">{t("tick.instructorMe")}</option>
                {(instructors.data ?? []).map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </div>
          <FormField
            id="tick-note"
            label={t("tick.noteLabel")}
            optional
            hint={t("counter", { count: note.trim().length, max: PROOF_NOTE_MAX })}
            error={fieldError("noteLong")}
          >
            <Input value={note} onChange={(event) => setNote(event.target.value)} autoComplete="off" disabled={pending} />
          </FormField>
          {instructors.isError ? <Notice tone="warning">{t("tick.instructorsFailed")}</Notice> : null}
          <p className="text-sm" aria-live="polite">
            {t("tick.chosen", { count: chosen.length })}
          </p>
          {pupilsError ? <p className="text-xs text-destructive">{pupilsError}</p> : null}
          {problem ? (
            <Notice tone="destructive" title={t("tick.failed")}>
              {problem}
            </Notice>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? t("tick.ticking") : t("tick.submit")}
          </Button>
        </form>
      ) : null}

      {dialogs.element}
      {Sheets && printing.paper !== null
        ? createPortal(
            <div className="print-sheet-root">
              <Sheets.PrintedRoster roster={printing.paper} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
