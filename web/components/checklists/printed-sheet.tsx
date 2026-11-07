"use client";

import { EntryHow } from "./entry-how";
import { useChecklistsText } from "./use-checklists-text";
import { CONSENT_STATES, countOf, earlierProofs, instructorOf, latestProof, templateLabel } from "@/lib/checklists";
import type { ConsentDetail, ProofRoster } from "@/lib/checklists";

/*
 * The paper of Checklistor: drawn for the printer and nowhere else, so this is
 * the lazily fetched half of the screens that print (use-print-sheet.ts). It is
 * drawn from what the gateway answered for paper and from nothing the screen
 * holds: the pupils with a protected identity are not in the rows or the counts,
 * and `heldOut` says how many were left out and that the screen has them.
 *
 * Plain markup on purpose: paper is black on white (globals.css writes the
 * light tokens for print), a table with a head row that repeats on every page,
 * and no control.
 */

function Held({ count }: { count: number }) {
  const { t } = useChecklistsText();
  return count > 0 ? <p className="mt-3 text-sm font-medium">{t("print.held", { count })}</p> : null;
}

const CELL = "border-b border-border px-2 py-1.5 text-left align-top text-sm";

export function PrintedRoster({ roster }: { roster: ProofRoster }) {
  const { t, day, number, moment } = useChecklistsText();
  return (
    <article className="space-y-1 text-foreground">
      <h1 className="text-xl font-semibold">{templateLabel(roster.template)}</h1>
      <p className="text-sm">
        {t("print.group", { group: roster.group.name })} · {t("print.printed", { moment: moment(new Date().toISOString()) })}
      </p>
      {roster.template.description ? <p className="whitespace-pre-wrap text-sm">{roster.template.description}</p> : null}
      <p className="text-sm font-medium">{t("roster.done", { done: number(roster.done), pupils: number(roster.pupils) })}</p>
      <table className="mt-2 w-full border-collapse">
        <thead className="table-header-group">
          <tr>
            <th scope="col" className={CELL}>
              {t("roster.colPupil")}
            </th>
            <th scope="col" className={CELL}>
              {t("roster.colClass")}
            </th>
            <th scope="col" className={CELL}>
              {t("roster.colStatus")}
            </th>
          </tr>
        </thead>
        <tbody>
          {roster.rows.map((row) => {
            const latest = latestProof(row);
            const by = latest ? instructorOf(latest) : null;
            return (
              <tr key={row.studentId} className="break-inside-avoid">
                <td className={CELL}>{row.name}</td>
                <td className={CELL}>{row.className ?? ""}</td>
                <td className={CELL}>
                  {latest
                    ? `${by ? t("roster.had", { date: day(latest.instructedOn), by }) : t("roster.hadNoName", { date: day(latest.instructedOn) })}${
                        earlierProofs(row) > 0 ? ` · ${t("roster.earlier", { count: earlierProofs(row) })}` : ""
                      }`
                    : t("roster.missing")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Held count={roster.heldOut} />
    </article>
  );
}

export function PrintedConsentList({ detail }: { detail: ConsentDetail }) {
  const { t, day, instantDay, number, moment } = useChecklistsText();
  const { list } = detail;
  return (
    <article className="space-y-1 text-foreground">
      <h1 className="text-xl font-semibold">{list.title}</h1>
      <p className="text-sm">
        {t("print.class", { class: list.className })} · {t("print.printed", { moment: moment(new Date().toISOString()) })}
        {list.closedAt ? ` · ${t("print.closed", { date: instantDay(list.closedAt) })}` : ""}
      </p>
      <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-sm">{list.body}</p>
      <p className="text-sm">
        {CONSENT_STATES.map((state) => `${t(`state.${state}`)} ${number(countOf(list.counts, state))}`).join(" · ")}
      </p>
      <table className="mt-2 w-full border-collapse">
        <thead className="table-header-group">
          <tr>
            <th scope="col" className={CELL}>
              {t("detail.colPupil")}
            </th>
            <th scope="col" className={CELL}>
              {t("detail.colState")}
            </th>
            <th scope="col" className={CELL}>
              {t("print.colHow")}
            </th>
          </tr>
        </thead>
        <tbody>
          {detail.rows.map((row) => (
            <tr key={row.studentId} className="break-inside-avoid">
              <td className={CELL}>
                {row.name}
                {row.className ? ` · ${row.className}` : ""}
              </td>
              <td className={CELL}>
                {t(`state.${row.state}`)}
                {row.entry && row.state !== "ASKED" && row.state !== "MISSING" ? ` ${day(row.entry.givenOn)}` : ""}
              </td>
              <td className={CELL}>
                {row.state === "ASKED" ? (
                  row.ask ? t("detail.waitingOn", { waiting: row.ask.guardiansWaiting, asked: row.ask.guardiansAsked }) : ""
                ) : row.entry ? (
                  <EntryHow entry={row.entry} />
                ) : (
                  ""
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Held count={detail.heldOut} />
    </article>
  );
}
