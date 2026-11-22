/**
 * The report that goes with the safe file, as text (Pseudonymiseraren, X1): what was replaced, counted per kind, how each column was treated and
 * by whom, the form of the file, and what the tool could not judge. It is made to be SENT: it holds counts, kinds, headers (as they stand in the safe
 * file) and patterns, never a value from the original, and not the original's file name. A test builds it from a file full of invented people and
 * looks for every one of them.
 *
 * The words come from the catalogue through `say`, in the language of the page; the structure is here.
 */

import type { Say } from "@/lib/pseudonym-labels";
import { MARKER_KINDS, type MarkerKind } from "@/lib/pseudonym-markers";
import { occurrencesOf, type FileReport, type Note, type RunReport } from "@/lib/pseudonym-run";
import type { Treatment } from "@/lib/pseudonym-headers";

const LINE_ENDINGS = { "\r\n": "CRLF", "\n": "LF", "\r": "CR" } as const;

/** One kind's line of the summary, for the kinds that had anything. */
function kindLines(say: Say, counts: Record<MarkerKind, { occurrences: number; distinct?: number }>): string[] {
  const lines: string[] = [];
  for (const kind of MARKER_KINDS) {
    const { occurrences, distinct } = counts[kind];
    if (occurrences === 0) continue;
    lines.push(
      distinct === undefined
        ? say("report.kindLineShort", { kind: say(`kind.${kind}`), count: occurrences })
        : say("report.kindLine", { kind: say(`kind.${kind}`), count: occurrences, distinct }),
    );
  }
  return lines;
}

function treatmentText(say: Say, treatment: Treatment): string {
  if (treatment.kind === "keep") return say("treatment.keep");
  if (treatment.kind === "clear") return say("treatment.clear");
  // A column marked personnummer gives a TF number in it a TF marker and a samordningsnummer a SAM one: the report says both, as the page's choice does.
  return say("treatment.mark", { kind: say(treatment.marker === "pnr" ? "group.pnr" : `kind.${treatment.marker}`) });
}

function describeFile(say: Say, report: FileReport, n: number): string[] {
  const lines: string[] = [say("report.file", { n })];
  const { facts } = report;
  const delimiter = facts.delimiter === ";" ? say("report.delimiter.semicolon") : facts.delimiter === "," ? say("report.delimiter.comma") : facts.delimiter === "\t" ? say("report.delimiter.tab") : say("report.delimiter.none");
  lines.push(
    say("report.form", {
      origin: say(`report.origin.${facts.origin}`),
      encoding: report.encoding,
      delimiter,
      eol: LINE_ENDINGS[facts.eol],
      bom: facts.bom ? say("report.bom.yes") : say("report.bom.no"),
    }),
  );
  if (report.encoding !== facts.encoding) lines.push(say("report.encodingChanged", { from: facts.encoding, to: report.encoding }));
  if (report.sheet !== null) lines.push(say("report.sheet", { name: report.sheet }));
  if (report.shape === "lines") {
    lines.push(say("report.sizeLines", { rows: report.rows }));
  } else {
    lines.push(
      report.headerRow === null
        ? say("report.sizeNoHeader", { rows: report.rows, columns: report.columns.length })
        : say("report.size", { rows: report.rows, columns: report.columns.length, headerRow: report.headerRow, titleRows: report.titleRows }),
    );
  }
  for (const column of report.columns) {
    lines.push(
      say("report.columnLine", {
        n: column.index + 1,
        header: column.header === "" ? say("report.noHeaderCell") : column.header,
        treatment: treatmentText(say, column.treatment),
        by: column.by === "user" ? say("by.user") : say(`by.${column.by}`),
        filled: column.filled,
        changed: column.changed,
      }),
    );
  }
  const own = kindLines(
    say,
    Object.fromEntries(MARKER_KINDS.map((kind) => [kind, { occurrences: occurrencesOf(report.tally[kind]) }])) as Record<MarkerKind, { occurrences: number }>,
  );
  if (own.length > 0) lines.push(say("report.fileTally", { list: own.join("; ") }));
  if (report.guarded > 0 || report.cleared > 0) lines.push(say("report.extras", { guarded: report.guarded, cleared: report.cleared }));
  return lines;
}

function noteText(say: Say, note: Note): string {
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

/** The limits of what the tool can judge: the same list the page shows above the result. */
const LIMITS = ["report.limit1", "report.limit2", "report.limit3", "report.limit4", "report.limit5", "report.limit6", "report.limit7"] as const;

export function renderReport(report: RunReport, say: Say): string {
  const out: string[] = [say("report.title"), say("report.purpose"), ""];

  out.push(say("report.summary"));
  const kinds = kindLines(say, report.totals);
  out.push(...(kinds.length > 0 ? kinds.map((line) => `- ${line}`) : [`- ${say("report.nothingReplaced")}`]));
  const { pnr, sam } = report.checkDigit;
  if (pnr.holds + pnr.fails > 0) out.push(`- ${say("report.checkDigit", { kind: say("kind.pnr"), holds: pnr.holds, fails: pnr.fails })}`);
  if (sam.holds + sam.fails > 0) out.push(`- ${say("report.checkDigit", { kind: say("kind.sam"), holds: sam.holds, fails: sam.fails })}`);
  if (report.spellings.length > 0) {
    out.push(`- ${say("report.spellings")}`);
    for (const { spelling, count } of report.spellings) out.push(`    ${say("report.spellingLine", { spelling, count })}`);
  }
  if (report.knownNames > 0) out.push(`- ${say("report.knownNames", { count: report.knownNames })}`);
  out.push("");

  report.files.forEach((file, index) => {
    out.push(...describeFile(say, file, index + 1), "");
  });

  if (report.notes.length > 0) {
    out.push(say("report.notes"));
    for (const note of report.notes) out.push(`- ${noteText(say, note)}`);
    out.push("");
  }

  out.push(say("report.limits"));
  for (const key of LIMITS) out.push(`- ${say(key)}`);
  out.push("", say("report.numbering"), say("report.offline"));
  return out.join("\n") + "\n";
}
