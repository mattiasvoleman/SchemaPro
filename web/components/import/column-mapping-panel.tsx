"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import { FIELDS, type TemplateKind } from "@/lib/column-fields";
import {
  applyMapping,
  describeColumns,
  headerRowCandidates,
  placementsOf,
  recognise,
  templateAssignment,
  type Applied,
  type Assignment,
  type Block,
  type MappingTemplate,
} from "@/lib/column-mapping";
import type { RawTable } from "@/lib/column-table";
import { useCreateImportTemplate, useDeleteImportTemplate, useUpdateImportTemplate } from "@/lib/column-template-queries";
import { hasPersonalNumber } from "@/lib/personal-number";
import { detectFormats, formatAssignment, formatsOfKind, readFormat } from "@/lib/skola24-format";
import type { UnreadReason } from "@/lib/skola24-format-types";
import { FormatNotices, FormatSelect, NO_FORMAT, type FormatView, type HeaderMode } from "@/components/import/column-mapping-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";

/** What the panel tells its parent whenever the mapping changes: the block, the assignment, and what applying it gives. */
export interface MappingState {
  block: Block;
  assignment: Assignment;
  applied: Applied;
}

export interface ColumnMappingPanelProps {
  kind: TemplateKind;
  table: RawTable;
  /** The school's templates of the kind: empty while they load, or when they cannot be read. */
  templates: readonly MappingTemplate[];
  onChange: (state: MappingState | null) => void;
  /**
   * For a dialog that has its own preview and its own count of the rows (the CSV importers): the columns are folded away behind
   * one line while nothing needs the user's say, the "N rows ready" and the file warnings its owner already shows are left out, and
   * the notices of the mapping itself (a column that is not read, a personnummer column dropped) stay.
   */
  compact?: boolean;
}

const SKIP = "__skip__";
const NONE = "";
const NO_ROWS: readonly number[] = [];

/**
 * The mapping of a table's columns, in the one place it is done (Kolumnmappning, X2): which row holds the headers, which
 * saved template fits, and for every column a choice of field, Läs inte kolumnen, or Inte placerad. Nothing is placed by
 * likeness: a column that nothing places says so and waits for the user, and the summary names every column that is not read.
 *
 * The panel holds the choices and does the saving of templates itself (a button, at once, independent of the import it
 * belongs to), so that the two places that show it, the schedule exchange and the CSV dialog, share all of it. The parent
 * gives it a `key` per table (a new paste is a new panel) and a stable `templates` list (an empty constant while they load).
 */
export function ColumnMappingPanel({ kind, table, templates, onChange, compact = false }: ColumnMappingPanelProps) {
  const t = useTranslations("columnMapping");
  // What the user has said: where the headers stand, and, once they have changed a column or taken a template, the columns as they left them.
  // Everything else is DERIVED from the table and the templates, so a template that arrives late places the columns the user has not touched.
  const [headerRow, setHeaderRow] = useState<number | null>(null);
  const [chosen, setChosen] = useState<{ assignment: Assignment; applied: MappingTemplate | null; touched: boolean } | null>(null);
  // Which Skola24 file the table is (Formatbeskrivare, X3): a description's id, NO_FORMAT, or null while the user has not chosen.
  const [formatChoice, setFormatChoice] = useState<string | null>(null);
  const [headerMode, setHeaderMode] = useState<HeaderMode>("auto");

  const recognition = useMemo(() => recognise(table, kind, templates, headerRow), [table, kind, templates, headerRow]);
  const formats = useMemo(() => formatsOfKind(kind), [kind]);
  const detected = useMemo(() => (formats.length === 0 ? [] : detectFormats(table, formats)), [table, formats]);
  // A description is applied by itself only when the table has exactly its documented headers, and no saved template fits: a school's own
  // template is what the school said. Every other fit is OFFERED. A description the user chose is applied, template or not.
  const automatic = recognition?.template == null ? (detected.find((fit) => fit.exact)?.format ?? null) : null;
  const formatId = formatChoice === NO_FORMAT ? null : (formatChoice ?? automatic);
  const inUse = useMemo<FormatView | null>(() => {
    const descriptor = formats.find((format) => format.id === formatId);
    if (descriptor === undefined) return null;
    const reading = readFormat(table, descriptor, { header: headerMode, ...(headerRow !== null ? { headerRow } : {}) });
    return reading === null ? null : { descriptor, reading };
  }, [table, formats, formatId, headerMode, headerRow]);
  const formatState = useMemo(() => (inUse === null ? null : { block: inUse.reading.block, assignment: formatAssignment(inUse.reading, kind) }), [inUse, kind]);
  const block = formatState?.block ?? recognition?.block ?? null;
  const assignment: Assignment = chosen?.assignment ?? formatState?.assignment ?? recognition?.assignment ?? [];
  const applied = chosen ? chosen.applied : inUse !== null ? null : (recognition?.template ?? null);
  const columns = useMemo(() => (block ? describeColumns(block, kind, assignment) : []), [block, kind, assignment]);
  const result = useMemo(
    () => (block && assignment.length === block.headers.length ? applyMapping(block, kind, assignment) : null),
    [block, kind, assignment],
  );
  // Why a column the description knows is not read, shown under it while the user has not placed it.
  const reasons = useMemo(() => {
    const found = new Map<number, UnreadReason>();
    inUse?.reading.columns.forEach((column) => {
      if (column.verdict.status === "unread") found.set(column.index, column.verdict.reason);
    });
    return found;
  }, [inUse]);
  const placedFields = useMemo(() => new Set(assignment.filter((field): field is string => typeof field === "string")), [assignment]);

  // Folded away while nothing needs the user's say; opened by a missing field, a column nothing places or a row held back, and then
  // kept open (a column the user has just placed must not fold the list away under their hand) until they close it themselves.
  const needsSay = result !== null && (result.problems.length > 0 || result.unplaced.length > 0 || result.rowProblems.length > 0);
  const [latched, setLatched] = useState(false);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  useEffect(() => {
    if (needsSay) setLatched(true);
  }, [needsSay]);

  // The parent's callback may be a new function every render; what it is told changes only when the mapping does.
  const notify = useRef(onChange);
  useEffect(() => {
    notify.current = onChange;
  });
  useEffect(() => {
    notify.current(block && result ? { block, assignment, applied: result } : null);
  }, [block, assignment, result]);

  const fields = FIELDS[kind];
  const label = (id: string) => t(`fields.${kind}.${id}`);
  const columnName = (index: number) => {
    const shown = columns[index]?.label;
    return shown === null ? t("columns.hiddenHeader") : shown === "" || shown === undefined ? t("columns.noHeader") : shown;
  };

  function choose(index: number, value: string) {
    // The template in use stays the one in use (so it can be saved over), but the table is no longer what it said.
    setChosen({ assignment: assignment.map((entry, at) => (at === index ? (value === NONE ? undefined : value === SKIP ? null : value) : entry)), applied, touched: true });
  }

  function chooseFormat(next: string | null) {
    // The columns the user placed are for another reading of the table.
    setFormatChoice(next);
    setChosen(null);
  }

  function useTemplate(template: MappingTemplate) {
    if (block) setChosen({ assignment: templateAssignment(block, template), applied: template, touched: false });
  }

  if (!block) return null;
  const candidates = headerRowCandidates(table);
  const cellText = (row: number) => {
    const cells = table.rows[table.rowNumbers.indexOf(row)]!.slice(0, 3).map((cell) => (hasPersonalNumber(cell) ? "…" : cell.trim()));
    return t("headerRow.option", { row, text: cells.join(" · ") });
  };

  const columnsView = (
    <>
      <FormatSelect
        formats={formats}
        choice={formatChoice}
        headerMode={headerMode}
        inUse={inUse}
        onChoose={chooseFormat}
        onHeaderMode={(mode) => {
          setHeaderMode(mode);
          setChosen(null);
        }}
      />
      {/* A file read with no header row has none to choose. */}
      {candidates.length > 1 && inUse?.reading.by !== "position" ? (
        <div className="space-y-1">
          <Label htmlFor="mapping-header-row">{t("headerRow.label")}</Label>
          <NativeSelect id="mapping-header-row" value={String(block.headerRowNumber)} onChange={(event) => {
              setHeaderRow(Number(event.target.value));
              setChosen(null);
            }} className="max-w-md">
            {candidates.map((row) => (
              <option key={row} value={row}>
                {cellText(row)}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("columns.title")}</caption>
          <thead>
            <tr className="border-b bg-muted/50 text-left">
              <th scope="col" className="px-3 py-2 font-medium">
                {t("columns.header")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("columns.sample")}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t("columns.field")}
              </th>
            </tr>
          </thead>
          <tbody>
            {columns.map((column) => (
              <tr key={column.index} className="border-b align-top last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-medium">
                  {columnName(column.index)}
                </th>
                <td className="max-w-xs px-3 py-2 text-muted-foreground">
                  <span className="line-clamp-3 break-words">{column.sample.join(" · ")}</span>
                </td>
                <td className="px-3 py-2">
                  {column.status === "personalNumber" ? (
                    <p className="text-sm">{t("personalNumber")}</p>
                  ) : (
                    <>
                      <NativeSelect
                        aria-label={t("columns.fieldOf", { column: columnName(column.index) })}
                        value={assignment[column.index] === undefined ? NONE : assignment[column.index] === null ? SKIP : (assignment[column.index] as string)}
                        onChange={(event) => choose(column.index, event.target.value)}
                        className="min-w-44"
                      >
                        <option value={NONE}>{t("option.unplaced")}</option>
                        <option value={SKIP}>{t("option.skip")}</option>
                        {fields.map((field) => (
                          <option key={field.id} value={field.id}>
                            {label(field.id)}
                            {field.required ? ` ${t("option.required")}` : ""}
                          </option>
                        ))}
                      </NativeSelect>
                      {column.status === "duplicate" ? <p className="mt-1 text-sm">{t("status.duplicate")}</p> : null}
                      {assignment[column.index] === null && reasons.has(column.index) ? <p className="mt-1 text-sm text-muted-foreground">{t(`format.unread.${reasons.get(column.index)}`)}</p> : null}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* A file with no header row (read by a Skola24 description) has no header row to save: the description is what recognises it. */}
      {block.headerRowNumber === 0 ? null : (
        <TemplateControls kind={kind} block={block} assignment={assignment} applied={applied} headerRow={block.headerRowNumber === table.rowNumbers[0] ? null : block.headerRowNumber} onSaved={(template) => setChosen({ assignment, applied: template, touched: false })} onDeleted={() => setChosen({ assignment, applied: null, touched: false })} />
      )}
    </>
  );

  if (compact) {
    const placed = columns.filter((column) => column.status === "placed").length;
    const readable = columns.filter((column) => column.status !== "personalNumber").length;
    return (
      <div className="space-y-3">
        {inUse === null ? <TemplateNotices recognition={recognition} applied={applied} touched={chosen?.touched === true} onUse={useTemplate} /> : null}
        <FormatNotices kind={kind} inUse={inUse} offered={detected} formats={formats} placed={placedFields} onUse={chooseFormat} />
        <details
          open={userOpen ?? (latched || needsSay)}
          onToggle={(event) => setUserOpen(event.currentTarget.open)}
          className="rounded-md border px-3 py-2"
        >
          <summary className="cursor-pointer text-sm font-medium">{t(needsSay ? "compact.needsSay" : "compact.allPlaced", { placed, total: readable })}</summary>
          <div className="mt-3 space-y-4">
            <p className="text-sm text-muted-foreground">{t("intro")}</p>
            {columnsView}
          </div>
        </details>
        {result ? <Summary result={result} label={label} columnName={columnName} heldRows={inUse?.reading.heldRows ?? NO_ROWS} fromFormat={inUse !== null} compact /> : null}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      {inUse === null ? <TemplateNotices recognition={recognition} applied={applied} touched={chosen?.touched === true} onUse={useTemplate} /> : null}
      <FormatNotices kind={kind} inUse={inUse} offered={detected} formats={formats} placed={placedFields} onUse={chooseFormat} />
      {columnsView}
      {result ? <Summary result={result} label={label} columnName={columnName} heldRows={inUse?.reading.heldRows ?? NO_ROWS} fromFormat={inUse !== null} /> : null}
    </div>
  );
}

function TemplateNotices({
  recognition,
  applied,
  touched,
  onUse,
}: {
  recognition: ReturnType<typeof recognise>;
  applied: MappingTemplate | null;
  touched: boolean;
  onUse: (template: MappingTemplate) => void;
}) {
  const t = useTranslations("columnMapping");
  if (!recognition && !applied) return null;
  return (
    <div className="space-y-2">
      {applied ? (
        <Notice tone={touched ? "neutral" : "success"}>
          {t(touched ? "template.changed" : recognition?.reason === "subset" && recognition.template?.id === applied.id ? "template.appliedMore" : "template.applied", { name: applied.name })}
        </Notice>
      ) : null}
      {recognition && applied === null && recognition.ambiguous.length > 1 ? (
        <Notice tone="warning" title={t("template.ambiguous")}>
          <ul className="mt-1 flex flex-wrap gap-2">
            {recognition.ambiguous.map((template) => (
              <li key={template.id}>
                <Button size="sm" variant="outline" onClick={() => onUse(template)}>
                  {template.name}
                </Button>
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {recognition && applied === null
        ? recognition.offered.map(({ template, missing }) => (
            <Notice key={template.id} tone="neutral">
              <span>{t("template.offered", { name: template.name, columns: missing.length })}</span>{" "}
              <Button size="sm" variant="outline" onClick={() => onUse(template)}>
                {t("template.useAnyway")}
              </Button>
            </Notice>
          ))
        : null}
    </div>
  );
}

function Summary({
  result,
  label,
  columnName,
  heldRows,
  fromFormat = false,
  compact = false,
}: {
  result: Applied;
  label: (id: string) => string;
  columnName: (index: number) => string;
  /** The file rows a Skola24 description holds back (a confidential mark): named by number, and not rows of the table the mapping reads. */
  heldRows: readonly number[];
  /** A Skola24 description is in use: the columns it skips are not "as you chose". */
  fromFormat?: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("columnMapping");
  const names = (refs: { index: number }[]) => refs.map((ref) => columnName(ref.index)).join(", ");
  return (
    <div className="space-y-2" aria-live="polite">
      {result.problems.length > 0 ? (
        <Notice tone="destructive" title={t("summary.cannot")}>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {result.problems.map((problem, index) => (
              <li key={index}>
                {t(`problems.${problem.code}`, {
                  field: problem.field ? label(problem.field) : "",
                  other: problem.other ? label(problem.other) : "",
                  columns: (problem.columns ?? []).map((name) => name ?? t("columns.hiddenHeader")).join(", "),
                })}
              </li>
            ))}
          </ul>
        </Notice>
      ) : compact ? null : (
        <Notice tone={result.ok ? "success" : "warning"}>{t("summary.ready", { count: result.rows.length })}</Notice>
      )}

      {result.rowProblems.length > 0 ? (
        <Notice tone="destructive" title={t("rowProblems.title")}>
          <ul className="mt-1 max-h-40 list-disc space-y-1 overflow-y-auto pl-5">
            {result.rowProblems.map((problem, index) => (
              <li key={`${problem.row}-${index}`}>{problem.message}</li>
            ))}
            {result.hiddenRowProblems > 0 ? <li>{t("rowProblems.more", { count: result.hiddenRowProblems })}</li> : null}
          </ul>
        </Notice>
      ) : null}

      {result.unplaced.length > 0 ? <Notice tone="warning">{t("unplaced", { count: result.unplaced.length, names: names(result.unplaced) })}</Notice> : null}
      {result.skipped.length > 0 ? <Notice tone="neutral">{t(fromFormat ? "format.skipped" : "skipped", { count: result.skipped.length, names: names(result.skipped) })}</Notice> : null}
      {result.dropped.length > 0 ? <Notice tone="neutral">{t("dropped", { count: result.dropped.length })}</Notice> : null}
      {result.emptied.length > 0 ? <Notice tone="neutral">{t("emptied", { count: result.emptied.length })}</Notice> : null}
      {heldRows.length > 0 ? <Notice tone="neutral">{t("held", { count: heldRows.length, rows: heldRows.slice(0, 20).join(", ") })}</Notice> : null}
      {result.warnings.filter((warning) => !compact || warning.code === "REPLACEMENT_CHARACTER").map((warning) => (
        <Notice key={warning.code} tone="warning">
          {t(`warnings.${warning.code}`, { rows: (warning.rows ?? []).join(", ") })}
        </Notice>
      ))}
    </div>
  );
}

/** Spara som mall, spara över mallen och ta bort den: at once, by a button, apart from the import the mapping is for. */
function TemplateControls({
  kind,
  block,
  assignment,
  applied,
  headerRow,
  onSaved,
  onDeleted,
}: {
  kind: TemplateKind;
  block: Block;
  assignment: Assignment;
  applied: MappingTemplate | null;
  headerRow: number | null;
  onSaved: (template: MappingTemplate) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("columnMapping");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "destructive"; text: string } | null>(null);
  const create = useCreateImportTemplate(kind);
  const update = useUpdateImportTemplate(kind);
  const remove = useDeleteImportTemplate(kind);
  const placements = useMemo(() => placementsOf(block, kind, assignment), [block, kind, assignment]);
  const busy = create.isPending || update.isPending || remove.isPending;

  const refused = (error: unknown): string => {
    if (error instanceof ApiError) {
      if (error.code === "TEMPLATE_NAME_TAKEN") return t("save.nameTaken");
      if (error.code === "TEMPLATE_LIMIT") return t("save.limit", { limit: Number(error.params?.limit ?? 20) });
      if (error.status === 403) return t("save.notYours");
    }
    return t("save.failed");
  };

  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t("save.title")}</legend>
      <p className="text-sm text-muted-foreground">{t("save.help")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Label htmlFor="mapping-template-name">{t("save.name")}</Label>
          <Input id="mapping-template-name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </div>
        <Button
          variant="outline"
          disabled={busy || name.trim() === "" || placements.length === 0}
          onClick={() =>
            create.mutate(
              { name, headerRow, placements },
              {
                onSuccess: (made) => {
                  setMessage({ tone: "success", text: t("save.saved", { name: made.name }) });
                  setName("");
                  onSaved(made);
                },
                onError: (error) => setMessage({ tone: "destructive", text: refused(error) }),
              },
            )
          }
        >
          {t("save.button")}
        </Button>
        {applied ? (
          <>
            <Button
              variant="outline"
              disabled={busy || placements.length === 0}
              onClick={() =>
                update.mutate(
                  { id: applied.id, headerRow, placements },
                  {
                    onSuccess: (changed) => {
                      setMessage({ tone: "success", text: t("save.saved", { name: changed.name }) });
                      onSaved(changed);
                    },
                    onError: (error) => setMessage({ tone: "destructive", text: refused(error) }),
                  },
                )
              }
            >
              {t("save.update", { name: applied.name })}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                remove.mutate(applied.id, {
                  onSuccess: () => {
                    setMessage({ tone: "success", text: t("save.deleted") });
                    onDeleted();
                  },
                  onError: (error) => setMessage({ tone: "destructive", text: refused(error) }),
                })
              }
            >
              {t("save.delete")}
            </Button>
          </>
        ) : null}
      </div>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
    </fieldset>
  );
}
