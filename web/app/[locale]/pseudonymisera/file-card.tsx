"use client";

import { useId } from "react";
import { headerLooksLikeData } from "@/lib/pseudonym-headers";
import type { Treatment } from "@/lib/pseudonym-headers";
import type { Say } from "@/lib/pseudonym-labels";
import { resolveTreatments } from "@/lib/pseudonym-run";
import type { ColumnPlan } from "@/lib/pseudonym-run";
import { CHOOSABLE_KINDS, treatmentKey, treatmentOf, type Entry } from "./entry";
import { BUTTON_SMALL, CARD, LABEL, SELECT, TABLE, TD, TH } from "./styles";

const SHAPES = ["number", "time", "date", "code", "word", "text"] as const;

/** What a column holds, as a line: the kinds of value and how many of each, and the personal things found in it. */
function contents(column: ColumnPlan, say: Say): string {
  const { stats } = column;
  const parts: string[] = SHAPES.filter((shape) => stats.shapes[shape] > 0).map((shape) => say("col.shape", { shape: say(`shape.${shape}`), count: stats.shapes[shape] }));
  // The same reason the proposal was withheld for (lib/pseudonym-headers.ts, datesAsked): the line says why a column of dates is asked about and not kept.
  if (column.datesAsked === "span") parts.push(say("col.dateSpan", { days: stats.dateSpanDays ?? 0 }));
  else if (column.datesAsked === "old") parts.push(say("col.dateOld"));
  else if (column.datesAsked === "compact") parts.push(say("col.dateCompact", { count: stats.compactDates }));
  else if (column.datesAsked === "unread") parts.push(say("col.dateUnread", { count: stats.unreadDates }));
  if (stats.withPersonalNumber > 0) parts.push(say("col.hasPnr", { count: stats.withPersonalNumber }));
  if (stats.withAddress > 0) parts.push(say("col.hasEmail", { count: stats.withAddress }));
  if (stats.withTelephone > 0) parts.push(say("col.hasTel", { count: stats.withTelephone }));
  return parts.length > 0 ? parts.join(" · ") : say("col.empty");
}

/** Why a column has the proposal it has, or that it has none. */
function proposalText(column: ColumnPlan, say: Say): string {
  const { proposal } = column;
  if (proposal === null) return say("proposal.none");
  if (proposal.reason === "header") return say("proposal.header", { group: say(`group.${proposal.detail as "pnr"}`) });
  // A column of personnummer is also a column of TF numbers (the same choice replaces both, each with its own marker), so the page says both.
  if (proposal.reason === "content") return say("proposal.content", { kind: say(proposal.detail === "pnr" ? "group.pnr" : `kind.${proposal.detail as "epost"}`) });
  return say(proposal.detail === "empty" ? "proposal.empty" : "proposal.numbers");
}

export function FileCard({
  entry,
  index,
  say,
  onHeaderRow,
  onHeadersAreNames,
  onTreatment,
  onRemove,
}: {
  entry: Entry;
  index: number;
  say: Say;
  onHeaderRow: (row: number | null) => void;
  onHeadersAreNames: (value: boolean) => void;
  onTreatment: (column: number, treatment: Treatment | null) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const { plan, input } = entry;
  const resolved = resolveTreatments(plan, { treatments: entry.treatments });
  const undecided = resolved.filter((treatment) => treatment === null).length;
  // The cells of the row taken for the header: a row of numbers, times or dates is a record, and a file with no header row begins with one.
  const headerCells =
    input.body.shape === "table" && plan.headerRow !== null ? (input.body.rows[input.body.rowNumbers.indexOf(plan.headerRow)] ?? null) : null;
  const rowCount = input.body.shape === "table" ? input.body.rows.length : input.body.lines.length;
  const delimiter = input.facts.delimiter === ";" ? say("report.delimiter.semicolon") : input.facts.delimiter === "," ? say("report.delimiter.comma") : input.facts.delimiter === "\t" ? say("report.delimiter.tab") : say("report.delimiter.none");

  return (
    <section className={CARD} aria-labelledby={`${id}-heading`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id={`${id}-heading`} className="text-base font-semibold" translate="no">
            {say("file.heading", { n: index + 1, name: entry.name })}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {say("file.facts", { origin: say(`report.origin.${input.facts.origin}`), encoding: input.facts.encoding, delimiter, rows: rowCount, columns: plan.columns.length })}
          </p>
        </div>
        <button type="button" className={BUTTON_SMALL} onClick={onRemove}>
          {say("file.remove")}
          <span className="sr-only" translate="no"> {entry.name}</span>
        </button>
      </div>

      {input.facts.unterminated ? (
        <p role="note" className="mt-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          {say("note.unterminatedOnPage")}
        </p>
      ) : null}

      {plan.shape === "lines" ? (
        <p role="note" className="mt-3 rounded-md border bg-muted/50 p-3 text-sm">
          {say("file.notTable")}
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor={`${id}-header`} className={LABEL}>
                {say("file.headerRow")}
              </label>
              <select
                id={`${id}-header`}
                className={SELECT}
                value={plan.headerRow === null ? "" : String(plan.headerRow)}
                onChange={(event) => onHeaderRow(event.target.value === "" ? null : Number(event.target.value))}
              >
                <option value="">{say("file.headerNone")}</option>
                {plan.headerCandidates.map((row) => {
                  const at = input.body.shape === "table" ? input.body.rowNumbers.indexOf(row) : -1;
                  const cells = input.body.shape === "table" && at !== -1 ? input.body.rows[at]!.filter((cell) => cell.trim() !== "").slice(0, 4) : [];
                  return (
                    <option key={row} value={String(row)} translate="no">
                      {say("file.headerRowOption", { n: row, cells: cells.join(" · ").slice(0, 60) })}
                    </option>
                  );
                })}
              </select>
              {plan.titleRows > 0 ? <p className="text-xs text-muted-foreground">{say("file.titleRows", { count: plan.titleRows })}</p> : null}
              {headerCells !== null && headerLooksLikeData(headerCells) ? (
                <p role="note" className="text-xs font-medium">
                  {say("file.headerLooksLikeData", { n: plan.headerRow ?? 0 })}
                </p>
              ) : null}
            </div>
            <label className="flex items-start gap-2 text-sm sm:mt-6">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={entry.headersAreNames} onChange={(event) => onHeadersAreNames(event.target.checked)} disabled={plan.headerRow === null} />
              <span>{say("file.headersAreNames")}</span>
            </label>
          </div>

          {undecided > 0 ? (
            <p role="status" className="mt-4 text-sm font-medium text-destructive">
              {say("file.undecided", { count: undecided })}
            </p>
          ) : null}

          <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label={say("col.caption", { n: index + 1 })}>
            <table className={TABLE}>
              <caption className="sr-only">{say("col.caption", { n: index + 1 })}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>{say("col.number")}</th>
                  <th scope="col" className={TH}>{say("col.header")}</th>
                  <th scope="col" className={TH}>{say("col.examples")}</th>
                  <th scope="col" className={TH}>{say("col.contents")}</th>
                  <th scope="col" className={TH}>{say("col.proposal")}</th>
                  <th scope="col" className={TH}>{say("col.choice")}</th>
                </tr>
              </thead>
              <tbody>
                {plan.columns.map((column) => {
                  const effective = resolved[column.index] ?? null;
                  return (
                    <tr key={column.index}>
                      <th scope="row" className={`${TD} font-medium ${effective === null ? "border-l-4 border-l-destructive" : ""}`}>{column.index + 1}</th>
                      <td className={TD} translate={column.header === "" ? undefined : "no"}>{column.header === "" ? <span className="text-muted-foreground">{say("col.noHeader")}</span> : column.header}</td>
                      <td className={`${TD} max-w-56 break-words font-mono text-xs`} translate="no">{column.stats.samples.length > 0 ? column.stats.samples.join(" · ") : "—"}</td>
                      <td className={`${TD} text-xs`}>{contents(column, say)}</td>
                      <td className={`${TD} text-xs ${column.proposal === null ? "font-semibold text-destructive" : ""}`}>{proposalText(column, say)}</td>
                      <td className={TD}>
                        <select
                          aria-label={say("col.choiceLabel", { n: column.index + 1 })}
                          className={`${SELECT} min-w-48`}
                          value={treatmentKey(effective)}
                          onChange={(event) => onTreatment(column.index, treatmentOf(event.target.value))}
                        >
                          <option value="">{say("choice.pick")}</option>
                          <option value="keep">{say("choice.keep")}</option>
                          <option value="clear">{say("choice.clear")}</option>
                          {CHOOSABLE_KINDS.map((kind) => (
                            <option key={kind} value={`mark:${kind}`}>
                              {say("choice.mark", { kind: say(kind === "pnr" ? "group.pnr" : `kind.${kind}`) })}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
