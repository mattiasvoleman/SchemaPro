"use client";

/*
 * Planera: ask the planner for a proposal for the exams that are not laid,
 * read it, choose which of it to use, and use it.
 *
 * A PROPOSAL LAYS NOTHING. POST /exams/plan answers with the placed exams
 * (a day, a time, the rooms with their writers and invigilators), the exams
 * it could not place and a reason for each, and the invigilator counter before
 * and after. It takes up to a minute, so the button waits and says so, and the
 * section is aria-busy. "Använd valda" sends back exactly what the proposal
 * gave for the ticked exams (lib/exam-form.ts applyItems), and the gateway asks
 * everything again for each one: an exam changed since answers EXAM_STALE, a
 * room or a teacher taken meanwhile EXAM_ROOM_TAKEN or EXAM_PLACEMENT. One
 * failing leaves the others laid, and the result names which and why.
 *
 * NAMES ARE THE GATEWAY'S. The invigilators and the counter come from the
 * answer only; a teacher with a protected identity is in none of it, and this
 * page reads no list of teachers to add one.
 *
 * THE PLANNER IS OFF UNTIL THE SCHOOL TURNS IT ON. Then there is no button,
 * only the reason; the exams and the rooms above work all the same.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { applyItems, placedByDay } from "@/lib/exam-form";
import type { ApplyResult, CounterChange, ExamProposal } from "@/lib/exam-types";
import type { AcademicYear } from "@/lib/types";
import { useReadOnly } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useErrorText, useFormats, useReasonText } from "./exam-format";
import { useApplyExams, useExamCounter, useExamRooms, useExamSettings, useExams, usePlanExams } from "./use-exams";

export function PlannerCard({ year, picked }: { year: AcademicYear; picked: ReadonlySet<string> }) {
  const t = useTranslations("exams");
  const readOnly = useReadOnly();
  const errorText = useErrorText();
  const { dayText } = useFormats();
  const settings = useExamSettings();
  const rooms = useExamRooms();
  const exams = useExams(year.id);
  const plan = usePlanExams();
  const apply = useApplyExams();
  const [proposal, setProposal] = useState<ExamProposal | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [notify, setNotify] = useState(true);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const unplanned = (exams.data ?? []).filter((exam) => !exam.plan);
  const ticked = unplanned.filter((exam) => picked.has(exam.id)).map((exam) => exam.id);
  const marked = (rooms.data ?? []).filter((room) => room.seats !== null).length;
  const done = new Set((result?.outcomes ?? []).filter((outcome) => outcome.ok).map((outcome) => outcome.examId));

  // Why there is no button, in the order the gateway would refuse: off, no subject, no room.
  const blocker: "off" | "subject" | "rooms" | null = !settings.data
    ? null
    : !settings.data.enabled
      ? "off"
      : !settings.data.replacementSubject
        ? "subject"
        : rooms.data && marked === 0
          ? "rooms"
          : null;
  const ready = settings.data !== undefined && rooms.data !== undefined && exams.data !== undefined && blocker === null;

  const doPlan = async () => {
    setProblem(null);
    setResult(null);
    try {
      const proposed = await plan.mutateAsync({ academicYearId: year.id, ...(ticked.length > 0 ? { examIds: ticked } : {}) });
      setProposal(proposed);
      setChosen(new Set(proposed.placed.map((exam) => exam.examId)));
    } catch (error) {
      setProposal(null);
      setProblem(errorText(error));
    }
  };

  const doApply = async () => {
    if (!proposal) return;
    setProblem(null);
    try {
      const outcome = await apply.mutateAsync({ academicYearId: year.id, items: applyItems(proposal, chosen), notify });
      setResult(outcome);
      setChosen(new Set([...chosen].filter((id) => !outcome.outcomes.some((one) => one.ok && one.examId === id))));
      const said = t("applied", { applied: outcome.applied, failed: outcome.failed });
      if (outcome.failed > 0) toast.error(said);
      else toast.success(said);
    } catch (error) {
      setProblem(errorText(error));
    }
  };

  const toggle = (examId: string, on: boolean) =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (on) next.add(examId);
      else next.delete(examId);
      return next;
    });

  return (
    <SectionCard id="exam-planner" title={t("plannerTitle")} description={t("plannerIntro")} aria-busy={plan.isPending || undefined}>
      {/* A live region that is always there: its text changes while the planner works and when it is done. */}
      <p role="status" className="sr-only">
        {plan.isPending
          ? t("planning")
          : proposal && proposal.status !== "NOTHING_TO_PLAN"
            ? t("proposalReady", { placed: proposal.placed.length, total: proposal.placed.length + proposal.unplaced.length })
            : ""}
      </p>

      {blocker === "off" ? (
        <Notice tone="neutral" title={t("offTitle")}>
          {t("plannerOffBody")}
        </Notice>
      ) : null}
      {blocker === "subject" ? (
        <Notice tone="warning" title={t("plannerNoSubjectTitle")}>
          {t("plannerNoSubjectBody")}
        </Notice>
      ) : null}
      {blocker === "rooms" ? (
        <Notice tone="warning" title={t("plannerNoRoomsTitle")}>
          {t("plannerNoRoomsBody")}
        </Notice>
      ) : null}
      {ready && unplanned.length === 0 ? <p className="text-sm text-muted-foreground">{t("allPlaced")}</p> : null}

      {readOnly || !ready || unplanned.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button data-writes="DRIFT" onClick={() => void doPlan()} disabled={plan.isPending || apply.isPending}>
            {plan.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {plan.isPending ? t("planning") : ticked.length > 0 ? t("planPicked", { count: ticked.length }) : t("planAll")}
          </Button>
          <p className="text-xs text-muted-foreground">{plan.isPending ? t("planningHint") : t("planHint")}</p>
        </div>
      )}

      {problem ? <Notice tone="destructive">{problem}</Notice> : null}

      {proposal ? (
        proposal.status === "NOTHING_TO_PLAN" ? (
          <p className="text-sm text-muted-foreground">{t("nothingToPlan")}</p>
        ) : (
          <div className="space-y-5">
            <p className="text-sm font-medium">
              {t("proposalSummary", { placed: proposal.placed.length, total: proposal.placed.length + proposal.unplaced.length })}
            </p>
            {proposal.status === "FEASIBLE" ? <p className="text-xs text-muted-foreground">{t("feasibleHint")}</p> : null}

            {placedByDay(proposal.placed).map((day) => (
              <div key={day.date} className="space-y-2">
                <h3 className="text-sm font-semibold">{dayText(day.date)}</h3>
                <TableCard caption={t("dayCaption", { date: dayText(day.date) })}>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">
                        <span className="sr-only">{t("useColumn")}</span>
                      </TableHead>
                      <TableHead scope="col">{t("examColumn")}</TableHead>
                      <TableHead scope="col">{t("timeColumn")}</TableHead>
                      <TableHead scope="col">{t("roomsColumn")}</TableHead>
                      <TableHead scope="col">{t("lossColumn")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {day.exams.map((exam) => (
                      <TableRow key={exam.examId}>
                        <TableCell>
                          {done.has(exam.examId) ? (
                            <Badge variant="success">{t("statePlaced")}</Badge>
                          ) : (
                            <input
                              type="checkbox"
                              aria-label={t("use", { name: exam.name })}
                              checked={chosen.has(exam.examId)}
                              disabled={readOnly || apply.isPending}
                              onChange={(event) => toggle(exam.examId, event.target.checked)}
                            />
                          )}
                        </TableCell>
                        <TableCell className="font-medium">{exam.name}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{`${exam.start}–${exam.end}`}</TableCell>
                        <TableCell>
                          <ul className="space-y-1">
                            {exam.rooms.map((room) => (
                              <li key={room.roomId}>
                                {t("proposedRoom", { room: room.roomName, classes: room.classes.join(", "), writers: room.writers })}
                                <span className="block text-xs text-muted-foreground">
                                  {room.invigilators.length > 0
                                    ? t("invigilators", { names: room.invigilators.map((one) => one.name).join(", ") })
                                    : t("noInvigilators")}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </TableCell>
                        <TableCell className="tabular-nums">{exam.loss > 0 ? t("loss", { minutes: exam.loss }) : t("lossNone")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </TableCard>
              </div>
            ))}

            {proposal.unplaced.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">{t("unplacedTitle")}</h3>
                <ul className="space-y-1.5 text-sm">
                  {proposal.unplaced.map((exam) => (
                    <UnplacedItem key={exam.examId} name={exam.name} code={exam.reason} params={exam.params} english={exam.message} />
                  ))}
                </ul>
              </div>
            ) : null}

            {proposal.counter.length > 0 ? (
              <CounterTable title={t("counterProposalTitle")} rows={proposal.counter} showAdded />
            ) : null}

            {proposal.placed.length > 0 && !readOnly ? (
              <div className="space-y-3 border-t pt-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setChosen(new Set(proposal.placed.filter((exam) => !done.has(exam.examId)).map((exam) => exam.examId)))}
                  >
                    {t("chooseAll")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setChosen(new Set())}>
                    {t("chooseNone")}
                  </Button>
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
                  <span>
                    {t("notify")}
                    <span className="block text-xs text-muted-foreground">{t("notifyHint")}</span>
                  </span>
                </label>
                <Button data-writes="DRIFT" onClick={() => void doApply()} disabled={chosen.size === 0 || apply.isPending}>
                  {apply.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                  {t("applyChosen", { count: chosen.size })}
                </Button>
              </div>
            ) : null}

            {result ? (
              <div className="space-y-2" role="status">
                <h3 className="text-sm font-semibold">{t("resultTitle")}</h3>
                <ul className="space-y-1.5 text-sm">
                  {result.outcomes.map((outcome) => {
                    const name = proposal.placed.find((exam) => exam.examId === outcome.examId)?.name ?? "";
                    return (
                      <li key={outcome.examId}>
                        <span className="font-medium">{name}</span>
                        {": "}
                        {outcome.ok
                          ? t("resultOk")
                          : `${outcome.message ?? t("resultFailed")}${outcome.code === "EXAM_STALE" ? ` ${t("staleHint")}` : ""}`}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>
        )
      ) : ready ? (
        <IdleCounter year={year} />
      ) : null}
    </SectionCard>
  );
}

function UnplacedItem({
  name,
  code,
  params,
  english,
}: {
  name: string;
  code: string;
  params: Record<string, string | number>;
  english: string | null;
}) {
  const reasonText = useReasonText();
  return (
    <li>
      <span className="font-medium">{name}</span>
      {": "}
      {reasonText(code, params, english)}
    </li>
  );
}

/** Who has kept watch so far this year, before any proposal is open. */
function IdleCounter({ year }: { year: AcademicYear }) {
  const t = useTranslations("exams");
  const counter = useExamCounter(year.id);
  if (!counter.data) return null;
  const rows: CounterChange[] = counter.data
    .filter((row) => row.passes > 0)
    .map((row) => ({ ...row, addedPasses: 0, addedMinutes: 0 }));
  return rows.length === 0 ? (
    <p className="text-sm text-muted-foreground">{t("counterNone")}</p>
  ) : (
    <CounterTable title={t("counterTitle", { year: year.name })} rows={rows} />
  );
}

/** The invigilator counter: what each teacher has, what a proposal adds, and what it comes to. */
function CounterTable({ title, rows, showAdded = false }: { title: string; rows: readonly CounterChange[]; showAdded?: boolean }) {
  const t = useTranslations("exams");
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      <TableCard caption={title}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t("teacherColumn")}</TableHead>
            <TableHead scope="col">{showAdded ? t("beforeColumn") : t("watchColumn")}</TableHead>
            {showAdded ? <TableHead scope="col">{t("addedColumn")}</TableHead> : null}
            {showAdded ? <TableHead scope="col">{t("afterColumn")}</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.teacherId}>
              <TableCell className="font-medium">{row.name}</TableCell>
              <TableCell className="tabular-nums">{t("figures", { passes: row.passes, minutes: row.minutes })}</TableCell>
              {showAdded ? (
                <TableCell className="tabular-nums">
                  {row.addedPasses > 0 ? t("figuresAdded", { passes: row.addedPasses, minutes: row.addedMinutes }) : "–"}
                </TableCell>
              ) : null}
              {showAdded ? (
                <TableCell className="tabular-nums">
                  {t("figures", { passes: row.passes + row.addedPasses, minutes: row.minutes + row.addedMinutes })}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </TableCard>
    </div>
  );
}
