"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, ClipboardCheck, Download, Printer } from "lucide-react";
import { PurgedNotice } from "@/components/retention/purged-notice";
import { useProfile } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadFailed } from "@/components/crisis/load-failed";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAlarmList, useProtocol } from "@/lib/crisis-admin-queries";
import type { AlarmSummary, CrisisMode, ProtocolView } from "@/lib/crisis-types";
import { unlistedPupils } from "@/lib/crisis-protocol";
import { clock, dayAndClock, groupLabel, isOpen, stopwatch } from "@/lib/crisis-view";
import { exportProtocol, printProtocol, protectedAmongPupils } from "./protocol-actions";
import { ProtocolPaper } from "./protocol-paper";

/*
 * Protokoll: the school's alarms, real ones and exercises apart (they are kept
 * apart by the database too, and purged under their own decisions), and for
 * one alarm its groups, its pupils and the timeline of every mark: who
 * reported what, when, and whether it was on behalf of a colleague or after
 * the alarm had ended.
 *
 * It leaves the screen as a CSV file and as paper (protocol-actions.ts), and
 * neither names a pupil with a protected identity. The screen does: it is the
 * administration reading, as the live view is, and what the gateway answers
 * is recorded in the läslogg.
 */

function AlarmRows({ mode, onOpen }: { mode: CrisisMode; onOpen: (id: string) => void }) {
  const t = useTranslations("crisis");
  const locale = useLocale();
  const timeZone = useProfile().school?.timezone;
  const list = useAlarmList(mode);
  if (list.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (list.isError) return <LoadFailed title={t("protocol.loadFailed")} hint={t("protocol.loadFailedHint")} headingLevel={3} />;
  const alarms: AlarmSummary[] = list.data;
  if (alarms.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title={t(mode === "LIVE" ? "protocol.emptyLive" : "protocol.emptyDrill")}
        description={t("protocol.emptyBody")}
      />
    );
  }
  return (
    <TableCard caption={t(mode === "LIVE" ? "protocol.tabLive" : "protocol.tabDrill")} tableClassName="min-w-[44rem]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col">{t("protocol.colStarted")}</TableHead>
          <TableHead scope="col">{t("protocol.colKind")}</TableHead>
          <TableHead scope="col">{t("protocol.colLength")}</TableHead>
          <TableHead scope="col">{t("protocol.colPupils")}</TableHead>
          <TableHead scope="col">{t("protocol.colGroups")}</TableHead>
          <TableHead scope="col">{t("protocol.colTeachers")}</TableHead>
          <TableHead scope="col">
            <span className="sr-only">{t("protocol.colOpen")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {alarms.map((alarm) => {
          const label = `${t(`kind.${alarm.kind}`)} ${dayAndClock(alarm.startedAt, locale, timeZone)}`;
          return (
            <TableRow key={alarm.id}>
              <TableCell className="font-medium">{dayAndClock(alarm.startedAt, locale, timeZone)}</TableCell>
              <TableCell>{t(`kind.${alarm.kind}`)}</TableCell>
              <TableCell className="tabular-nums">
                {isOpen(alarm) ? (
                  <Badge variant="warning">{t("protocol.going")}</Badge>
                ) : (
                  <>
                    {stopwatch(Date.parse(alarm.startedAt), Date.parse(alarm.endedAt!))}
                    {alarm.autoEnded ? <span className="block text-xs text-muted-foreground">{t("protocol.autoEnded")}</span> : null}
                  </>
                )}
              </TableCell>
              <TableCell className="tabular-nums">
                {t("protocol.pupilsFigures", { found: alarm.counts.found, missing: alarm.counts.missing, unreported: alarm.counts.unreported })}
              </TableCell>
              <TableCell className="tabular-nums">{t("live.ofTotal", { done: alarm.callsComplete, total: alarm.calls })}</TableCell>
              <TableCell className="tabular-nums">{t("live.ofTotal", { done: alarm.teachersAnswered, total: alarm.teachers })}</TableCell>
              <TableCell className="text-right">
                <Button type="button" variant="outline" size="sm" aria-label={t("protocol.openNamed", { name: label })} onClick={() => onOpen(alarm.id)}>
                  {t("protocol.open")}
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </TableCard>
  );
}

function ProtocolDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations("crisis");
  const locale = useLocale();
  const { school } = useProfile();
  const timeZone = school?.timezone;
  const protocol = useProtocol(id);
  // The pupils held out of the paper, once the marks are read; the paper is on the page only then.
  const [paper, setPaper] = useState<ReadonlySet<string> | null>(null);

  useEffect(() => {
    if (!paper) return undefined;
    const done = () => setPaper(null);
    window.addEventListener("afterprint", done, { once: true });
    printProtocol();
    return () => window.removeEventListener("afterprint", done);
  }, [paper]);

  if (protocol.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (protocol.isError) {
    return (
      <LoadFailed
        title={t("protocol.detailFailed")}
        hint={t("protocol.detailFailedHint")}
        headingLevel={3}
        action={
          <Button type="button" variant="outline" onClick={onBack}>
            {t("protocol.backNamed")}
          </Button>
        }
      />
    );
  }
  const view: ProtocolView = protocol.data;
  const { alarm } = view;
  const live = alarm.mode === "LIVE";
  const at = (instant: string) => clock(instant, locale, timeZone);
  const nameOf = new Map(view.calls.flatMap((call) => call.pupils.map((pupil) => [pupil.studentId, `${pupil.firstName} ${pupil.lastName}`.trim()] as const)));
  // The group of pupils on no lesson comes with Swedish stand-in names; the page says it in its own language.
  const noLesson = t("noLesson.group");
  const unlisted = unlistedPupils(view.calls);
  const showFoundIn = view.marks.some((mark) => mark.foundIn !== null);

  const download = async () => {
    try {
      const heldOut = await exportProtocol(view, timeZone ?? "Europe/Stockholm");
      toast.info(t("protocol.heldOutFile", { count: heldOut }), { duration: 10000 });
    } catch {
      toast.error(t("protocol.exportFailed"));
    }
  };
  const print = async () => {
    try {
      setPaper(await protectedAmongPupils(view));
    } catch {
      toast.error(t("protocol.exportFailed"));
    }
  };

  return (
    <>
      <div className="space-y-4 print:hidden">
        <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {t(live ? "protocol.backLive" : "protocol.backDrill")}
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={live ? "destructive" : "warning"}>{t(`mode.${alarm.mode}`)}</Badge>
              <h2 className="text-lg font-semibold">
                {t(`kind.${alarm.kind}`)} · {dayAndClock(alarm.startedAt, locale, timeZone)}
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("live.started", { time: at(alarm.startedAt), by: alarm.startedBy ?? "—" })}
              {alarm.endedAt ? ` · ${t("live.endedAt", { time: at(alarm.endedAt), by: alarm.endedBy ?? "—" })}` : ` · ${t("protocol.going")}`}
            </p>
            {alarm.autoEnded ? <p className="text-sm">{t("live.autoEnded")}</p> : null}
            {alarm.endNote ? <p className="text-sm">{t("live.note", { note: alarm.endNote })}</p> : null}
            {alarm.guardiansNotifiedAt ? <p className="text-sm">{t("live.guardiansTold", { time: at(alarm.guardiansNotifiedAt) })}</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={download}>
              <Download aria-hidden="true" />
              {t("protocol.download")}
            </Button>
            <Button type="button" variant="outline" onClick={print}>
              <Printer aria-hidden="true" />
              {t("protocol.print")}
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{t("protocol.protectedNote")}</p>

        <KpiStrip columns={3} className="lg:grid-cols-6">
          <KpiTile label={t("live.groupsDone")} value={t("live.ofTotal", { done: alarm.callsComplete, total: alarm.calls })} />
          <KpiTile label={t("count.found")} value={alarm.counts.found} />
          <KpiTile label={t("count.missing")} value={alarm.counts.missing} />
          <KpiTile label={t("count.unreported")} value={alarm.counts.unreported} />
          <KpiTile label={t("count.absentBefore")} value={alarm.counts.absentBefore} />
          <KpiTile label={t("live.teachersAnswered")} value={t("live.ofTotal", { done: alarm.teachersAnswered, total: alarm.teachers })} />
        </KpiStrip>

        <SectionCard id="protocol-groups" title={t("live.groupsTitle")}>
          <TableCard caption={t("live.groupsTitle")} tableClassName="min-w-[44rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">{t("live.colGroup")}</TableHead>
                <TableHead scope="col">{t("live.colRoom")}</TableHead>
                <TableHead scope="col">{t("live.colTeachers")}</TableHead>
                <TableHead scope="col">{t("protocol.colPupils")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.calls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell className="align-top font-medium">
                    {groupLabel(call, noLesson)}
                    <span className="block text-xs font-normal text-muted-foreground">
                      {call.basis === "NO_LESSON" ? t("noLesson.owner") : call.subjectName}
                    </span>
                    {call.basis === "NEXT_LESSON" ? (
                      <Badge variant="outline" className="mt-1">
                        {t("live.nextLesson")}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top">{call.roomName ?? "—"}</TableCell>
                  <TableCell className="align-top">
                    {call.uncovered ? (
                      t("live.noTeacher")
                    ) : (
                      <ul>
                        {call.teachers.map((teacher, index) => (
                          <li key={`${teacher.userId ?? "x"}-${index}`}>
                            {teacher.name ?? "—"}{" "}
                            <span className="text-xs text-muted-foreground">
                              {teacher.answeredAt ? t("live.answeredAt", { time: at(teacher.answeredAt) }) : t("live.notAnswered")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  <TableCell className="align-top tabular-nums">
                    {t("protocol.pupilsFigures", { found: call.counts.found, missing: call.counts.missing, unreported: call.counts.unreported })}
                    {call.counts.absentBefore > 0 ? (
                      <span className="block text-xs text-muted-foreground">{t("protocol.absentFigure", { count: call.counts.absentBefore })}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableCard>
        </SectionCard>

        <SectionCard id="protocol-timeline" title={t("protocol.timeline")} description={t("protocol.timelineBody")}>
          {view.marks.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("protocol.timelineEmpty")}</p>
          ) : (
            <TableCard caption={t("protocol.timeline")} tableClassName="min-w-[40rem]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col">{t("protocol.colTime")}</TableHead>
                  <TableHead scope="col">{t("live.colGroup")}</TableHead>
                  <TableHead scope="col">{t("protocol.colPupil")}</TableHead>
                  <TableHead scope="col">{t("protocol.colMark")}</TableHead>
                  {showFoundIn ? <TableHead scope="col">{t("protocol.colNote")}</TableHead> : null}
                  <TableHead scope="col">{t("protocol.colBy")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.marks.map((mark, index) => (
                  <TableRow key={`${mark.studentId}-${mark.at}-${index}`}>
                    <TableCell className="tabular-nums">{new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { timeStyle: "medium", ...(timeZone ? { timeZone } : {}) }).format(new Date(mark.at))}</TableCell>
                    <TableCell>{unlisted.has(mark.studentId) ? noLesson : mark.groupName}</TableCell>
                    <TableCell>{nameOf.get(mark.studentId) ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={mark.state === "FOUND" ? "success" : "destructive"}>{t(`status.${mark.state}`)}</Badge>
                    </TableCell>
                    {showFoundIn ? (
                      <TableCell>{mark.foundIn ? t("protocol.foundIn", { group: groupLabel(mark.foundIn, noLesson) }) : "—"}</TableCell>
                    ) : null}
                    <TableCell>
                      {mark.by ?? "—"}
                      {mark.onBehalf ? <span className="block text-xs text-muted-foreground">{t("protocol.onBehalf")}</span> : null}
                      {mark.late ? <span className="block text-xs text-muted-foreground">{t("protocol.late")}</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableCard>
          )}
        </SectionCard>
      </div>

      {/* A print that did not come from the button has no paper: it says where the button is. */}
      {paper ? (
        <ProtocolPaper view={view} held={paper} school={school?.name ?? null} timeZone={timeZone} />
      ) : (
        <p className="hidden print:block">{t("protocol.printUseButton")}</p>
      )}
    </>
  );
}

export function ProtocolTab({ initialId }: { initialId: string | null }) {
  const t = useTranslations("crisis");
  const [id, setId] = useState<string | null>(initialId);
  const [mode, setMode] = useState<CrisisMode>("LIVE");

  useEffect(() => {
    if (initialId) setId(initialId);
  }, [initialId]);

  if (id) return <ProtocolDetail id={id} onBack={() => setId(null)} />;

  return (
    <Tabs value={mode} onValueChange={(value) => setMode(value as CrisisMode)}>
      <TabsList className="print:hidden">
        <TabsTrigger value="LIVE">{t("protocol.tabLive")}</TabsTrigger>
        <TabsTrigger value="DRILL">{t("protocol.tabDrill")}</TabsTrigger>
      </TabsList>
      <TabsContent value="LIVE" className="space-y-3 print:hidden">
        <PurgedNotice kind="CRISIS_ALARMS" />
        <AlarmRows mode="LIVE" onOpen={setId} />
      </TabsContent>
      <TabsContent value="DRILL" className="space-y-3 print:hidden">
        <PurgedNotice kind="CRISIS_DRILLS" />
        <AlarmRows mode="DRILL" onOpen={setId} />
      </TabsContent>
    </Tabs>
  );
}
