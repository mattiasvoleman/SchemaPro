"use client";

import { Fragment, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, ChevronRight, ClipboardCheck, Printer } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useConsentDetail } from "@/lib/checklists-queries";
import {
  CHECKLIST_NOT_FOUND,
  CONSENT_KINDS,
  namesOfIds,
  setChosen,
  stillWritable,
  unansweredIds,
  writableIds,
  type ConsentAsked,
  type ConsentDetail,
  type ConsentKind,
  type ConsentRow,
} from "@/lib/checklists";
import { CHECKLIST_STATE_VARIANT } from "@/lib/status-variants";
import { useReadOnly } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import type { ChecklistAudience } from "./checklists";
import { ConsentCounts } from "./consent-counts";
import { ConsentStateBadge } from "./consent-state-badge";
import { EntryHow } from "./entry-how";
import { useChecklistsText } from "./use-checklists-text";
import { useChecklistDialogs } from "./use-dialogs";
import { usePrintSheet } from "./use-print-sheet";

/** The names of pupils the notice spells out before it says "and n more". */
const NAMES_SHOWN = 8;

/**
 * One list: the text the guardians are asked to consent to, where everyone
 * stands, and the actions on the pupils chosen: write an answer down, ask the
 * guardians in the app, and end the list.
 *
 * Each pupil's state is the gateway's say (what a consent is now is one
 * definition there): GRANTED, DECLINED, WITHDRAWN, ASKED (a request made after
 * the latest answer still waits for a guardian) or MISSING. A consent taken back
 * reads as taken back at once, with its date, and never as "no answer"; the
 * history behind every row is one click away, the latest first.
 *
 * The list is read when opened and not kept (the gateway records it in the
 * läslogg). Who can write for whom is the gateway's say per row (`canWrite`):
 * a teacher's mentees, and an administrator's all. The screen names every pupil
 * the reader may see; the paper holds out a pupil with a protected identity.
 */
export function ConsentDetailView({
  id,
  title,
  audience,
  onBack,
  announce,
}: {
  id: string;
  /** The title the list already showed: the heading while the rest is read. */
  title: string;
  audience: ChecklistAudience;
  onBack: () => void;
  /** Said to a screen reader as well as shown. */
  announce: (message: string) => void;
}) {
  const { t, tCommon, day, instantDay, names, number } = useChecklistsText();
  const readOnly = useReadOnly();
  const query = useConsentDetail(id);
  const dialogs = useChecklistDialogs();
  const printing = usePrintSheet<ConsentDetail>();
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [done, setDone] = useState<string | null>(null);
  const detail = query.data;
  const rows: readonly ConsentRow[] = detail?.rows ?? [];
  const chosen = stillWritable(picked, rows);
  const chosenSet = new Set(chosen);
  const writable = writableIds(rows);
  const unanswered = unansweredIds(rows);

  const say = (message: string) => {
    setDone(message);
    announce(message);
  };

  const asked = (result: ConsentAsked) => {
    const without = namesOfIds(rows, result.withoutGuardian);
    say(
      [
        t("detail.asked", { guardians: result.guardians, pupils: result.pupils }),
        without.length > 0
          ? t("detail.askedWithout", {
              count: without.length,
              names: names(without, NAMES_SHOWN, (count) => t("detail.moreNames", { count: number(count) })),
            })
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    setPicked([]);
  };

  const body = () => {
    if (query.isLoading) {
      return (
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      );
    }
    if (query.error instanceof ApiError && query.error.code === CHECKLIST_NOT_FOUND) {
      return <EmptyState icon={ClipboardCheck} headingLevel={3} title={t("detail.notFoundTitle")} description={t("detail.notFound")} />;
    }
    if (!detail) {
      return (
        <LoadError
          variant="inline"
          title={t("detail.loadFailed")}
          hint={t("detail.loadFailedHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
              {tCommon("retry")}
            </Button>
          }
        />
      );
    }
    const { list } = detail;
    const closed = list.closedAt !== null;
    // A read again that failed (after an answer was written, say) leaves the list as it was last read, and says so.
    const stale = query.isError ? <LoadError variant="inline" title={t("detail.loadFailed")} hint={tCommon("refetchFailedHint")} /> : null;
    const mayWrite = !readOnly && !closed && writable.length > 0;
    const select = mayWrite;

    const openEntry = (entryKind: ConsentKind) =>
      dialogs.open({
        kind: "entry",
        listId: id,
        entryKind,
        studentIds: chosen,
        onDone: (written) => {
          say(t(`detail.written.${entryKind}`, { count: written }));
          setPicked([]);
        },
      });

    return (
      <>
        {stale}
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t("detail.class")}</dt>
          <dd>{list.className}</dd>
          <dt className="text-muted-foreground">{t("detail.made")}</dt>
          <dd>
            {list.createdByName
              ? t("detail.madeBy", { date: instantDay(list.createdAt), name: list.createdByName })
              : t("detail.madeOn", { date: instantDay(list.createdAt) })}
          </dd>
          {closed ? (
            <>
              <dt className="text-muted-foreground">{t("detail.closed")}</dt>
              <dd>{instantDay(list.closedAt!)}</dd>
            </>
          ) : null}
        </dl>
        <p className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm">{list.body}</p>
        <ConsentCounts counts={list.counts} />
        {closed ? (
          <Notice tone="neutral" title={t("detail.closedTitle")}>
            {t("detail.closedBody")}
          </Notice>
        ) : null}

        {mayWrite ? (
          <div className="space-y-3 border-t pt-3" data-writes="DRIFT">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {CONSENT_KINDS.map((entryKind, index) => (
                  <Button
                    key={entryKind}
                    type="button"
                    size="sm"
                    variant={index === 0 ? "default" : "outline"}
                    disabled={chosen.length === 0}
                    onClick={() => openEntry(entryKind)}
                  >
                    {t(`entry.title.${entryKind}`)}
                  </Button>
                ))}
              </div>
              {detail.canClose ? (
                <Button type="button" size="sm" variant="outline" onClick={() => dialogs.open({ kind: "close", listId: id, title: list.title, onDone: () => say(t("detail.closedDone")) })}>
                  {t("detail.close")}
                </Button>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {chosen.length === 0 ? t("detail.chooseHint") : t("detail.chosen", { count: chosen.length })}
            </p>
            {detail.kvittens ? (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={chosen.length === 0}
                    onClick={() => dialogs.open({ kind: "ask", listId: id, studentIds: chosen, count: chosen.length, onDone: asked })}
                  >
                    {t("detail.ask")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={unanswered.length === 0}
                    onClick={() => dialogs.open({ kind: "ask", listId: id, studentIds: null, count: unanswered.length, onDone: asked })}
                  >
                    {t("detail.askAll")}
                  </Button>
                </div>
                <p className="max-w-prose text-xs text-muted-foreground">{t("detail.askHelp")}</p>
              </div>
            ) : (
              <Notice tone="neutral" title={t("detail.kvittensOffTitle")}>
                {t(`detail.kvittensOff.${audience}`)}
              </Notice>
            )}
          </div>
        ) : !closed && !readOnly && detail.canClose ? (
          <div className="border-t pt-3" data-writes="DRIFT">
            <Button type="button" size="sm" variant="outline" onClick={() => dialogs.open({ kind: "close", listId: id, title: list.title, onDone: () => say(t("detail.closedDone")) })}>
              {t("detail.close")}
            </Button>
          </div>
        ) : null}

        {done ? (
          <Notice tone="success" role={null} title={t("detail.doneTitle")} onDismiss={() => setDone(null)}>
            {done}
          </Notice>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState icon={ClipboardCheck} headingLevel={3} title={t("detail.emptyTitle")} description={t("detail.empty")} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {select ? (
                <>
                  <Button type="button" size="sm" variant="outline" onClick={() => setPicked(chosen.length === writable.length ? [] : writable)}>
                    {chosen.length === writable.length ? t("detail.clearAll") : t("detail.chooseAll")}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={unanswered.length === 0} onClick={() => setPicked(unanswered)}>
                    {t("detail.chooseUnanswered")}
                  </Button>
                </>
              ) : null}
              <p className="ml-auto text-sm text-muted-foreground">{t("detail.pupils", { count: rows.length })}</p>
            </div>
            <TableCard caption={t("detail.caption", { title: list.title })} tableClassName="min-w-[28rem]">
              <TableHeader>
                <TableRow>
                  {select ? (
                    <TableHead scope="col" className="w-10 pr-0">
                      <span className="sr-only">{t("detail.colChoose")}</span>
                    </TableHead>
                  ) : null}
                  <TableHead scope="col">{t("detail.colPupil")}</TableHead>
                  <TableHead scope="col">{t("detail.colState")}</TableHead>
                  <TableHead scope="col" className="w-32 text-right">
                    <span className="sr-only">{t("detail.colHistory")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const expanded = open.has(row.studentId);
                  const columns = select ? 4 : 3;
                  return (
                    <Fragment key={row.studentId}>
                      <TableRow data-state={chosenSet.has(row.studentId) ? "selected" : undefined}>
                        {select ? (
                          <TableCell className="w-10 pr-0 align-top">
                            {row.canWrite ? (
                              <input
                                type="checkbox"
                                className="size-4 shrink-0 accent-primary"
                                aria-label={t("detail.choose", { name: row.name })}
                                checked={chosenSet.has(row.studentId)}
                                onChange={(event) => setPicked((current) => setChosen(current, [row.studentId], event.target.checked))}
                              />
                            ) : null}
                          </TableCell>
                        ) : null}
                        <TableCell className="align-top">
                          <button
                            type="button"
                            className="rounded-sm text-left font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t("roster.openCard", { name: row.name })}
                            onClick={() => dialogs.open({ kind: "card", studentId: row.studentId, name: row.name })}
                          >
                            {row.name}
                          </button>
                          <div className="text-xs text-muted-foreground">
                            {row.className ?? ""}
                            {row.inClass ? null : (
                              <Badge variant={CHECKLIST_STATE_VARIANT.LIST_CLOSED} className="ml-1.5 inline-flex">
                                {t("detail.leftClass")}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <StateCell row={row} />
                        </TableCell>
                        <TableCell className="text-right align-top">
                          {row.history.length > 0 ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-expanded={expanded}
                              aria-controls={`history-${row.studentId}`}
                              aria-label={t("detail.historyNamed", { name: row.name, count: row.history.length })}
                              onClick={() =>
                                setOpen((current) => {
                                  const next = new Set(current);
                                  if (!next.delete(row.studentId)) next.add(row.studentId);
                                  return next;
                                })
                              }
                            >
                              {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                              {t("detail.history", { count: row.history.length })}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                      {expanded ? (
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableCell colSpan={columns} id={`history-${row.studentId}`}>
                            <ol className="space-y-1.5 text-sm">
                              {row.history.map((entry) => (
                                <li key={entry.id}>
                                  <span className="font-medium">
                                    {t(`state.${entry.kind}`)} {day(entry.givenOn)}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {" · "}
                                    <EntryHow entry={entry} />
                                    {entry.note ? ` · ${t("detail.note", { note: entry.note })}` : ""}
                                  </span>
                                </li>
                              ))}
                            </ol>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </TableCard>
          </>
        )}
      </>
    );
  };

  const Sheets = printing.sheets;
  return (
    <SectionCard
      id="checklists-consent-detail"
      title={detail?.list.title ?? title}
      action={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!detail || printing.preparing || printing.paper !== null}
            onClick={() => void printing.print((actions) => actions.fetchListForPaper(id))}
          >
            <Printer aria-hidden="true" />
            {printing.preparing ? t("print.preparing") : t("print.button")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            {t("detail.back")}
          </Button>
        </>
      }
    >
      {body()}
      {dialogs.element}
      {Sheets && printing.paper !== null
        ? createPortal(
            <div className="print-sheet-root">
              <Sheets.PrintedConsentList detail={printing.paper} />
            </div>,
            document.body,
          )
        : null}
    </SectionCard>
  );
}

/** A pupil's answer: the state as a badge with its icon and words, the date, how it came to be, and who is being waited for. */
function StateCell({ row }: { row: ConsentRow }) {
  const { t, day } = useChecklistsText();
  const { entry, ask } = row;
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <ConsentStateBadge state={row.state} label={t(`state.${row.state}`)} />
        {entry && row.state !== "ASKED" ? <span className="text-sm font-medium">{day(entry.givenOn)}</span> : null}
      </div>
      {row.state === "ASKED" && ask ? (
        <p className="text-xs text-muted-foreground">{t("detail.waitingOn", { waiting: ask.guardiansWaiting, asked: ask.guardiansAsked })}</p>
      ) : null}
      {row.state === "ASKED" && entry ? (
        <p className="text-xs text-muted-foreground">{t("detail.previously", { answer: `${t(`state.${entry.kind}`)} ${day(entry.givenOn)}` })}</p>
      ) : null}
      {entry && row.state !== "ASKED" ? (
        <p className="text-xs text-muted-foreground">
          <EntryHow entry={entry} />
          {entry.note ? ` · ${t("detail.note", { note: entry.note })}` : ""}
        </p>
      ) : null}
    </div>
  );
}
