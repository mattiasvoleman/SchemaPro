"use client";

import { useId } from "react";
import { saveBytes, saveText } from "@/lib/pseudonym-download";
import type { Say } from "@/lib/pseudonym-labels";
import { MARKER_KINDS } from "@/lib/pseudonym-markers";
import { renderReport } from "@/lib/pseudonym-report";
import type { Note, RunResult } from "@/lib/pseudonym-run";
import type { Entry } from "./entry";
import { BUTTON, BUTTON_OUTLINE, CARD, FIELD, LABEL, TABLE, TD, TH } from "./styles";

type Done = Extract<RunResult, { ok: true }>;

const LIMITS = ["report.limit1", "report.limit2", "report.limit3", "report.limit4", "report.limit5", "report.limit6", "report.limit7"] as const;

function noteOnPage(say: Say, note: Note): string {
  switch (note.code) {
    case "lines":
      return say("note.lines", { file: note.file + 1 });
    case "titleRows":
      return say("note.titleRows", { file: note.file + 1, rows: note.rows });
    case "freeText":
      return say("note.freeText", { file: note.file + 1, column: note.column + 1 });
    case "manyReplaced":
      return say("note.manyReplaced", { file: note.file + 1, column: note.column + 1 });
    case "unterminated":
      return say("note.unterminated", { file: note.file + 1 });
    case "encodingFellBack":
      return say("note.encodingFellBack", { file: note.file + 1 });
  }
}

export function ResultView({
  result,
  entries,
  say,
  confirmed,
  onConfirmed,
  onOutName,
}: {
  result: Done;
  entries: readonly Entry[];
  say: Say;
  confirmed: boolean;
  onConfirmed: (value: boolean) => void;
  onOutName: (id: number, name: string) => void;
}) {
  const id = useId();
  const { report, check } = result;
  const kinds = MARKER_KINDS.filter((kind) => report.totals[kind].occurrences > 0);
  const { pnr, sam } = report.checkDigit;
  const allowed = confirmed && check.passed;
  const reportText = renderReport(report, say);

  return (
    <div className="space-y-6">
      {/* Not a landmark of its own: the scrollable table below it is the region of this name, and two regions with one name cannot be told apart (axe landmark-unique). */}
      <section className={CARD}>
        <h3 id={`${id}-counts`} className="text-base font-semibold">
          {say("result.countsHeading")}
        </h3>
        {kinds.length === 0 ? (
          <p className="mt-2 text-sm">{say("report.nothingReplaced")}</p>
        ) : (
          <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label={say("result.countsHeading")}>
            <table className={TABLE}>
              <caption className="sr-only">{say("result.countsHeading")}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>{say("result.kind")}</th>
                  <th scope="col" className={TH}>{say("result.occurrences")}</th>
                  <th scope="col" className={TH}>{say("result.distinct")}</th>
                </tr>
              </thead>
              <tbody>
                {kinds.map((kind) => (
                  <tr key={kind}>
                    <th scope="row" className={`${TD} font-medium`}>{say(`kind.${kind}`)}</th>
                    <td className={TD}>{report.totals[kind].occurrences}</td>
                    <td className={TD}>{report.totals[kind].distinct}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pnr.holds + pnr.fails + sam.holds + sam.fails > 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {say("result.checkDigit", { holds: pnr.holds + sam.holds, fails: pnr.fails + sam.fails })}
          </p>
        ) : null}
      </section>

      <section className={CARD} aria-labelledby={`${id}-limits`}>
        <h3 id={`${id}-limits`} className="text-base font-semibold">
          {say("result.limitsHeading")}
        </h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {report.notes.map((note, i) => (
            <li key={`note-${i}`} className="font-medium">{noteOnPage(say, note)}</li>
          ))}
          {LIMITS.map((key) => (
            <li key={key}>{say(key)}</li>
          ))}
        </ul>
      </section>

      <section className={CARD} aria-labelledby={`${id}-preview`}>
        <h3 id={`${id}-preview`} className="text-base font-semibold">
          {say("result.previewHeading")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{say("result.previewHint")}</p>
        <div className="mt-3 space-y-4">
          {result.files.map((file, i) => (
            <details key={entries[i]?.id ?? i} className="rounded-md border" open={i === 0}>
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{say("result.previewOf", { n: i + 1 })}</summary>
              <div className="overflow-x-auto px-3 pb-3" tabIndex={0} role="region" aria-label={say("result.previewOf", { n: i + 1 })}>
                {entries[i]?.plan.shape === "lines" ? (
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs" translate="no">{file.preview.map((row) => row.cells[0]).join("\n")}</pre>
                ) : (
                  <table className={TABLE}>
                    <caption className="sr-only">{say("result.previewOf", { n: i + 1 })}</caption>
                    <tbody className="font-mono text-xs" translate="no">
                      {file.preview.map((row) => (
                        <tr key={row.number}>
                          <th scope="row" className={`${TD} text-muted-foreground`}>{row.number}</th>
                          {row.cells.map((cell, c) => (
                            <td key={c} className={`${TD} break-words`}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className={CARD} aria-labelledby={`${id}-send`}>
        <h3 id={`${id}-send`} className="text-base font-semibold">
          {say("result.sendHeading")}
        </h3>
        {check.passed ? (
          <p role="status" className="mt-2 text-sm">{say("result.checkPassed")}</p>
        ) : (
          <div role="alert" className="mt-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
            <p className="font-medium">{say("result.checkFailed")}</p>
            <ul className="mt-1 list-disc pl-5">
              {check.failures.map((failure) => (
                <li key={failure.file}>{say("result.checkFailedFile", { file: failure.file + 1, count: failure.count })}</li>
              ))}
            </ul>
          </div>
        )}

        <label className="mt-4 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirmed} onChange={(event) => onConfirmed(event.target.checked)} disabled={!check.passed} />
          <span>{say("result.confirm")}</span>
        </label>

        <div className="mt-4 space-y-4">
          {result.files.map((file, i) => {
            const entry = entries[i];
            if (entry === undefined) return null;
            return (
              <div key={entry.id} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-1">
                  <label htmlFor={`${id}-name-${entry.id}`} className={LABEL}>
                    {say("result.fileName", { n: i + 1 })}
                  </label>
                  <input id={`${id}-name-${entry.id}`} className={FIELD} value={entry.outName} onChange={(event) => onOutName(entry.id, event.target.value)} />
                </div>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={!allowed || entry.outName.trim() === ""}
                  onClick={() => saveBytes(entry.outName.trim(), file.bytes, entry.outName.toLowerCase().endsWith(".csv") ? "text/csv" : "text/plain")}
                >
                  {say("result.downloadFile", { n: i + 1 })}
                </button>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">{say("result.fileNameHint")}</p>
          <div>
            <button type="button" className={BUTTON_OUTLINE} disabled={!allowed} onClick={() => saveText("rapport-pseudonymisering.txt", reportText)}>
              {say("result.downloadReport")}
            </button>
          </div>
        </div>
        <p className="mt-4 text-sm text-muted-foreground">{say("result.sendNote")}</p>

        <details className="mt-4 rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{say("result.reportShown")}</summary>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-xs" tabIndex={0} aria-label={say("result.reportShown")} translate="no">
            {reportText}
          </pre>
        </details>
      </section>
    </div>
  );
}
