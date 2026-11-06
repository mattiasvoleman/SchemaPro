"use client";

import { Fragment, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronRight, CircleHelp, Clock, X, type LucideIcon } from "lucide-react";
import { PupilRow } from "@/components/crisis/pupil-row";
import { useProfile } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadFailed } from "@/components/crisis/load-failed";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAlarmDetail, useCrisisActions } from "@/lib/crisis-admin-queries";
import { callState, isDone, liveFigures, pupilsToFind, silentTeachers, type CallState } from "@/lib/crisis-live";
import type { AlarmSummary, CallView, MarkState } from "@/lib/crisis-types";
import {
  MAX_NOTE_LENGTH,
  clock,
  crisisErrorText,
  errorCodeOf,
  isOpen,
  markTime,
  newMark,
  stopwatch,
  unmarkedPupils,
} from "@/lib/crisis-view";
import type { MessageLookup } from "@/lib/engine-message";

/*
 * The live view of an alarm: the roll call as it fills in. It reads the alarm
 * every five seconds and whenever the gateway says a mark was made
 * (lib/use-crisis-realtime.ts), and says what changed to a screen reader in
 * one polite sentence (the counters' live region) rather than by moving focus
 * or re-reading the tables.
 *
 * Everything shown is worked out from the groups (lib/crisis-live.ts), so the
 * counters, the lists and the table cannot disagree. A group nobody answers
 * for ("Ingen lärare") is marked by the administration, from its row; so is
 * any pupil in the lists, for a teacher who cannot reach their phone.
 */

const STATE_ICON: Record<CallState, LucideIcon> = {
  DONE: Check,
  DONE_MISSING: X,
  IN_PROGRESS: Clock,
  WAITING: CircleHelp,
};
const STATE_VARIANT = {
  DONE: "success",
  DONE_MISSING: "destructive",
  IN_PROGRESS: "warning",
  WAITING: "warning",
} as const satisfies Record<CallState, string>;

/** The lists of pupils still to find show this many rows before "Visa alla": at the start of an alarm it is every pupil. */
const LIST_LIMIT = 40;

export function LiveView({
  alarmId,
  open,
  canAct,
  onSelect,
  onClose,
  onProtocol,
}: {
  alarmId: string;
  /** The alarms that are going, to switch between when more than one is. */
  open: readonly AlarmSummary[];
  canAct: boolean;
  onSelect: (alarmId: string) => void;
  onClose: () => void;
  onProtocol: (alarmId: string) => void;
}) {
  const t = useTranslations("crisis");
  const tErrors = useTranslations("crisis.errors") as unknown as MessageLookup;
  const locale = useLocale();
  const timeZone = useProfile().school?.timezone;
  const detail = useAlarmDetail(alarmId);
  const { end, mark } = useCrisisActions();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [hideDone, setHideDone] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [ending, setEnding] = useState(false);
  const [note, setNote] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const going = detail.data ? isOpen(detail.data.alarm) : false;

  useEffect(() => {
    if (!going) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [going]);

  if (detail.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!detail.data) {
    return (
      <LoadFailed
        title={t("live.loadFailed")}
        hint={errorCodeOf(detail.error) === "CRISIS_ALARM_NOT_FOUND" ? t("errors.CRISIS_ALARM_NOT_FOUND") : t("live.loadFailedHint")}
        headingLevel={2}
        action={
          <Button type="button" variant="outline" onClick={onClose}>
            {t("live.close")}
          </Button>
        }
      />
    );
  }

  const { alarm, calls } = detail.data;
  const live = alarm.mode === "LIVE";
  const figures = liveFigures(calls);
  const silent = silentTeachers(calls);
  const toFind = pupilsToFind(calls);
  const shownToFind = showAll ? toFind : toFind.slice(0, LIST_LIMIT);
  const at = (instant: string) => clock(instant, locale, timeZone);
  const people = (names: readonly string[]) => names.join(", ");

  const markPupils = (call: CallView, studentIds: readonly string[], state: MarkState) => {
    if (studentIds.length === 0) return;
    const madeAt = markTime(Date.now(), 0, alarm.startedAt);
    mark.mutate(
      { id: alarm.id, marks: studentIds.map((studentId) => newMark(call.id, studentId, state, madeAt)) },
      {
        onSuccess: (result) => {
          if (result.unresolved.length > 0) toast.error(t("live.markUnresolved", { count: result.unresolved.length }));
        },
        onError: (error) => toast.error(crisisErrorText(tErrors, error, t("live.markFailed"))),
      },
    );
  };

  const toggle = (id: string) =>
    setExpanded((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const submitEnd = () => {
    end.mutate(
      { id: alarm.id, ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          setEnding(false);
          setNote("");
          toast.success(t("live.endedToast"));
        },
      },
    );
  };

  const incomplete = figures.missing > 0 || figures.unreported > 0;
  const shownCalls = hideDone ? calls.filter((call) => !isDone(call)) : calls;

  return (
    <section aria-labelledby="live-title" className="space-y-4">
      <div className="space-y-3 rounded-lg border bg-card p-4">
        {open.length > 1 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("live.switchLabel")}>
            {open.map((one) => (
              <Button
                key={one.id}
                type="button"
                size="sm"
                variant={one.id === alarm.id ? "default" : "outline"}
                aria-pressed={one.id === alarm.id}
                onClick={() => onSelect(one.id)}
              >
                {t(`mode.${one.mode}`)} · {t(`kind.${one.kind}`)}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={live ? "destructive" : "warning"} className="text-sm">
            {t(`mode.${alarm.mode}`)}
          </Badge>
          <h2 id="live-title" className="text-xl font-semibold">
            {t(`kind.${alarm.kind}`)} · {going ? t("live.going") : t("live.over")}
          </h2>
          {going ? (
            <span role="timer" aria-label={t("live.elapsed")} className="text-xl font-semibold tabular-nums">
              {stopwatch(Date.parse(alarm.startedAt), now)}
            </span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("live.started", { time: at(alarm.startedAt), by: alarm.startedBy ?? "—" })}
          {alarm.endedAt ? ` · ${t("live.endedAt", { time: at(alarm.endedAt), by: alarm.endedBy ?? "—" })}` : ""}
        </p>
        {alarm.autoEnded ? <p className="text-sm">{t("live.autoEnded")}</p> : null}
        {alarm.endNote ? <p className="text-sm">{t("live.note", { note: alarm.endNote })}</p> : null}
        {alarm.guardiansNotifiedAt ? <p className="text-sm">{t("live.guardiansTold", { time: at(alarm.guardiansNotifiedAt) })}</p> : null}
        <div className="flex flex-wrap gap-2">
          {going && canAct ? (
            <Button type="button" onClick={() => setEnding(true)}>
              {t("live.end")}
            </Button>
          ) : null}
          {!going ? (
            <>
              <Button type="button" onClick={() => onProtocol(alarm.id)}>
                {t("live.openProtocol")}
              </Button>
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("live.close")}
              </Button>
            </>
          ) : null}
        </div>
        {going && !canAct ? <Notice tone="neutral">{t("live.viewOnly")}</Notice> : null}
      </div>

      {detail.isError ? <LoadFailed variant="inline" title={t("live.refetchFailed")} hint={t("live.refetchFailedHint")} /> : null}

      {/* One polite sentence for a screen reader; the tiles below are for the eye. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {t("live.summary", {
          groupsDone: figures.groupsDone,
          groups: figures.groups,
          found: figures.found,
          missing: figures.missing,
          unreported: figures.unreported,
          teachersAnswered: figures.teachersAnswered,
          teachers: figures.teachers,
        })}
      </p>
      <KpiStrip columns={3} className="lg:grid-cols-6">
        <KpiTile label={t("live.groupsDone")} value={t("live.ofTotal", { done: figures.groupsDone, total: figures.groups })} />
        <KpiTile label={t("count.found")} value={figures.found} />
        <KpiTile label={t("count.missing")} value={figures.missing} />
        <KpiTile label={t("count.unreported")} value={figures.unreported} />
        <KpiTile label={t("count.absentBefore")} value={figures.absentBefore} />
        <KpiTile label={t("live.teachersAnswered")} value={t("live.ofTotal", { done: figures.teachersAnswered, total: figures.teachers })} />
      </KpiStrip>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard id="live-silent" title={t("live.silentTitle")} description={t("live.silentBody")}>
          {silent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("live.silentNone")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {silent.map((teacher) => (
                <li key={teacher.userId} className="px-3 py-2 text-sm">
                  <span className="font-medium">{teacher.name}</span>
                  <span className="block text-xs text-muted-foreground">{people(teacher.groups)}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard id="live-find" title={t("live.findTitle")} description={t("live.findBody")}>
          {toFind.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("live.findNone")}</p>
          ) : (
            <>
              <ul className="divide-y rounded-md border">
                {shownToFind.map((row) => {
                  const call = calls.find((one) => one.id === row.callId)!;
                  return (
                    <PupilRow
                      key={`${row.callId}:${row.pupil.studentId}`}
                      pupil={row.pupil}
                      detail={[row.groupName, row.subjectName, row.roomName, row.teachers.length > 0 ? people(row.teachers) : t("live.noTeacher")]
                        .filter(Boolean)
                        .join(" · ")}
                      {...(going && canAct ? { onMark: (state: MarkState) => markPupils(call, [row.pupil.studentId], state) } : {})}
                    />
                  );
                })}
              </ul>
              {toFind.length > LIST_LIMIT ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setShowAll((value) => !value)}>
                  {showAll ? t("live.showFewer") : t("live.showAll", { count: toFind.length })}
                </Button>
              ) : null}
            </>
          )}
        </SectionCard>
      </div>

      <SectionCard
        id="live-groups"
        title={t("live.groupsTitle")}
        action={
          <label className="flex min-h-8 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={hideDone} onChange={(event) => setHideDone(event.target.checked)} />
            {t("live.hideDone")}
          </label>
        }
      >
        {calls.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("live.noGroups")}</p>
        ) : (
          <TableCard caption={t("live.groupsTitle")} tableClassName="min-w-[44rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{t("live.colGroup")}</TableHead>
                <TableHead scope="col">{t("live.colRoom")}</TableHead>
                <TableHead scope="col">{t("live.colTeachers")}</TableHead>
                <TableHead scope="col">{t("live.colStatus")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownCalls.map((call) => {
                const state = callState(call);
                const StateIcon = STATE_ICON[state];
                const expectedPupils = call.counts.pupils - call.counts.absentBefore;
                const isExpanded = expanded.has(call.id);
                const unmarked = unmarkedPupils(call.pupils);
                return (
                  <Fragment key={call.id}>
                    <TableRow>
                      <TableCell className="align-top">
                        <button
                          type="button"
                          className="flex items-center gap-1 rounded-md text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          aria-expanded={isExpanded}
                          aria-controls={`crisis-call-${call.id}`}
                          onClick={() => toggle(call.id)}
                        >
                          {isExpanded ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
                          {call.groupName}
                        </button>
                        <span className="block pl-5 text-xs text-muted-foreground">{call.subjectName}</span>
                        {call.basis === "NEXT_LESSON" ? (
                          <Badge variant="outline" className="ml-5 mt-1">
                            {t("live.nextLesson")}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="align-top">{call.roomName ?? "—"}</TableCell>
                      <TableCell className="align-top">
                        {call.uncovered ? (
                          <Badge variant="warning">{t("live.noTeacher")}</Badge>
                        ) : (
                          <ul className="space-y-0.5">
                            {call.teachers.map((teacher, index) => (
                              <li key={`${teacher.userId ?? "x"}-${index}`}>
                                {teacher.name ?? "—"}
                                <span className="block text-xs text-muted-foreground">
                                  {teacher.answeredAt ? t("live.answeredAt", { time: at(teacher.answeredAt) }) : t("live.notAnswered")}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        <Badge variant={STATE_VARIANT[state]} className="gap-1">
                          <StateIcon className="size-3" aria-hidden="true" />
                          {t(`live.state.${state}`, { missing: call.counts.missing })}
                        </Badge>
                        <span className="block text-xs text-muted-foreground">
                          {t("live.marked", { done: call.counts.found + call.counts.missing, total: expectedPupils })}
                        </span>
                      </TableCell>
                    </TableRow>
                    {isExpanded ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={4} className="bg-muted/30">
                          <div id={`crisis-call-${call.id}`} className="space-y-2">
                            {going && canAct && unmarked.length > 0 ? (
                              <Button
                                type="button"
                                size="sm"
                                disabled={mark.isPending}
                                onClick={() => markPupils(call, unmarked, "FOUND")}
                              >
                                {call.counts.missing > 0
                                  ? t("live.restFound", { count: unmarked.length })
                                  : t("live.allFound", { count: unmarked.length })}
                              </Button>
                            ) : null}
                            {call.pupils.length === 0 ? (
                              <p className="text-sm text-muted-foreground">{t("live.noPupils")}</p>
                            ) : (
                              <ul className="divide-y rounded-md border bg-card" aria-label={t("live.pupilsOf", { group: call.groupName })}>
                                {call.pupils.map((pupil) => (
                                  <PupilRow
                                    key={pupil.studentId}
                                    pupil={pupil}
                                    {...(going && canAct ? { onMark: (next: MarkState) => markPupils(call, [pupil.studentId], next) } : {})}
                                  />
                                ))}
                              </ul>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </TableCard>
        )}
      </SectionCard>

      <Dialog
        open={ending}
        onOpenChange={(next) => {
          if (end.isPending) return;
          setEnding(next);
          if (!next) end.reset();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t(live ? "live.endTitleLive" : "live.endTitleDrill")}</DialogTitle>
            <DialogDescription>{t("live.endBody")}</DialogDescription>
          </DialogHeader>
          {incomplete ? (
            <Notice tone="warning" title={t("live.endWarningTitle")}>
              {t("live.endWarning", { missing: figures.missing, unreported: figures.unreported })}
            </Notice>
          ) : null}
          <FormField id="crisis-end-note" label={t("live.noteLabel")} optional hint={t("live.noteHint", { max: MAX_NOTE_LENGTH })}>
            <Textarea maxLength={MAX_NOTE_LENGTH} value={note} onChange={(event) => setNote(event.target.value)} rows={3} />
          </FormField>
          <p className="text-xs text-muted-foreground tabular-nums">
            {note.length}/{MAX_NOTE_LENGTH}
          </p>
          {end.isError ? (
            <Notice tone="destructive">{crisisErrorText(tErrors, end.error, t("live.endFailed"))}</Notice>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={end.isPending} onClick={() => setEnding(false)}>
              {t("live.keepGoing")}
            </Button>
            <Button type="button" variant={incomplete ? "destructive" : "default"} disabled={end.isPending} onClick={submitEnd}>
              {end.isPending ? t("live.ending") : t("live.endConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
