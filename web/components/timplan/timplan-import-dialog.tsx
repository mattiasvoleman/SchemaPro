"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { downloadCsv, fileProblems, type RowError } from "@/lib/csv";
import type { MappingTemplate } from "@/lib/column-mapping";
import { useImportTemplates } from "@/lib/column-template-queries";
import {
  formatTimplanGrade,
  mapTimplanRows,
  rowsOutsideSpan,
  TIMPLAN_CSV_TEMPLATE,
  timplanTemplateCsv,
  type TimplanFileColumn,
} from "@/lib/timplan-csv";
import type { GradeSpan } from "@/lib/timplan-coverage";
import { spanText } from "@/lib/timplan-span";
import {
  useImportTimplan,
  type LocalTimplanStatus,
  type TimplanImportReport,
  type TimplanImportRow,
} from "@/lib/timplan-queries";
import { ColumnMappingPanel } from "@/components/import/column-mapping-panel";
import { PasteTable } from "@/components/import/paste-table";
import { useTableReading } from "@/components/import/use-table-reading";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PREVIEW_ROWS = 5;
const NO_TEMPLATES: MappingTemplate[] = [];

interface FilePreview {
  headers: string[];
  previewRows: string[][];
  rows: TimplanImportRow[];
  errors: RowError[];
  rowNumbers: number[];
  columns: TimplanFileColumn[];
  /** The code page a file that was not UTF-8 was read in. */
  legacyEncoding: string | null;
}

export interface TimplanImportDialogProps {
  /** `span`: the årskurser the plan is for, null for the whole school form. */
  plan: { id: string; name: string; status: LocalTimplanStatus; span: GradeSpan | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Importera CSV into ONE lokal timplan — the flow of CsvImportDialog, step for
 * step: download the template, pick a file, read the parse (first rows and
 * every mapping error) before anything is sent, import, read the
 * created/updated/skipped report with its row errors.
 *
 * Its own component rather than a ninth kind of that dialog, because the
 * target differs in kind: the eight there import into the SCHOOL or a LÄSÅR
 * picked by the dialog, this one into the plan on screen, named in the dialog
 * so a file is never read into the wrong plan. And that dialog's kinds are
 * Record tables in lib/queries.ts, which every route loads (see
 * lib/timplan-queries.ts).
 *
 * The import UPDATES cells already there and deletes none, like the
 * requirements import, and says so before the file is chosen and again on the
 * report. A DECIDED plan takes no file: the dialog says so and offers no
 * button, and the gateway answers 409 TIMPLAN_IS_DECIDED should a stale page
 * try anyway — that answer is shown as it comes.
 *
 * Rows for an årskurs outside the plan's årskurs span are imported all the
 * same, as an åk 10 in a nine-year plan is: stored, shown in a grey column,
 * counted nowhere. The preview says how many there are and which årskurser,
 * so the file's author is told before the numbers are missing from a sum.
 */
export function TimplanImportDialog({ plan, open, onOpenChange }: TimplanImportDialogProps) {
  const t = useTranslations("timplan");
  const tImport = useTranslations("csvImport");
  const tMap = useTranslations("columnMapping");
  const tCommon = useTranslations("common");
  const importTimplan = useImportTimplan();
  const { reading, mapping, setMapping, load, clear } = useTableReading((problem) => tMap(problem));
  const [pasted, setPasted] = useState("");
  const [report, setReport] = useState<TimplanImportReport | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const decided = plan.status === "DECIDED";
  const templates = useImportTemplates(open ? "timplan" : null);

  const reset = () => {
    clear();
    setPasted("");
    setReport(null);
    setFileInputKey((key) => key + 1);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const onFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setReport(null);
    void load({ file }, file.name);
  };

  // What the timplan's own mapper makes of the mapped table, which is what the preview shows and the import sends.
  const preview = useMemo<FilePreview | null>(() => {
    if (reading === null) return null;
    if (reading.state === "problem") {
      return { headers: [], previewRows: [], rows: [], errors: [{ row: 0, message: reading.problem }], rowNumbers: [], columns: [], legacyEncoding: null };
    }
    if (mapping === null) return null;
    const { applied } = mapping;
    const mapped = mapTimplanRows(applied.parsed);
    return {
      headers: applied.headers,
      previewRows: applied.rows.slice(0, PREVIEW_ROWS),
      rows: mapped.rows,
      // A mapping that cannot be applied is told by the panel, with the columns to choose, and not a second time here.
      errors: applied.problems.length > 0 ? [] : [...fileProblems(applied.parsed), ...mapped.errors],
      rowNumbers: mapped.rowNumbers,
      columns: mapped.columns,
      legacyEncoding: reading.encoding,
    };
  }, [reading, mapping]);
  // A row held back by the mapping (a personnummer in a column that is read) stops the import like any other row error.
  const mappingHolds = mapping !== null && !mapping.applied.ok;

  const submit = async () => {
    if (!preview) return;
    try {
      setReport(
        await importTimplan.mutateAsync({
          localTimplanId: plan.id,
          columns: preview.columns,
          rows: preview.rows,
          rowNumbers: preview.rowNumbers,
        }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const notice = <Notice role={null}>{t("importUpdates")}</Notice>;
  const outside = preview && plan.span ? rowsOutsideSpan(preview.rows, plan.span) : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("importTitle")}</DialogTitle>
        </DialogHeader>

        {report ? (
          <>
            <div className="space-y-3">
              <p className="text-sm font-medium">
                {tImport("resultSummaryUpdated", {
                  created: report.created,
                  updated: report.updated ?? 0,
                  skipped: report.skipped,
                })}
              </p>
              {notice}
              {report.errors.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">{tImport("rowErrors")}</p>
                  <ul className="max-h-48 space-y-1 overflow-y-auto text-sm text-destructive">
                    {report.errors.map((error, index) => (
                      <li key={`${error.row}-${index}`}>
                        {tImport("rowError", { row: error.row, message: error.message })}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button onClick={() => handleOpenChange(false)}>{tCommon("close")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {/* min-w-0: the dialog is a grid, and the column table inside would otherwise widen it past a phone's edge (it scrolls in its own box). */}
            <div className="min-w-0 space-y-4">
              {decided ? (
                // A decision to make (Öppna igen) before a file can be read: a warning.
                <Notice tone="warning">{t("importNotDraft")}</Notice>
              ) : (
                <p className="text-sm text-foreground">{t("importInto", { name: plan.name })}</p>
              )}
              <Button
                variant="outline"
                onClick={() => downloadCsv(TIMPLAN_CSV_TEMPLATE.filename, timplanTemplateCsv())}
              >
                <Download />
                {tImport("downloadTemplate")}
              </Button>
              {notice}
              <div className="space-y-1.5">
                <Label htmlFor="timplan-import-file">{tImport("chooseFile")}</Label>
                <Input
                  key={fileInputKey}
                  id="timplan-import-file"
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv"
                  disabled={decided}
                  onChange={onFileChosen}
                />
              </div>

              {decided ? null : (
                <div className="space-y-2">
                  <PasteTable id="timplan-import-paste" label={tImport("pasteLabel")} hint={tImport("pasteHint")} value={pasted} onChange={setPasted} />
                  <Button
                    variant="outline"
                    disabled={pasted.trim() === ""}
                    onClick={() => {
                      setReport(null);
                      void load({ text: pasted }, tMap("pasted"));
                    }}
                  >
                    {tImport("pasteRead")}
                  </Button>
                </div>
              )}

              {reading?.state === "table" ? (
                <ColumnMappingPanel
                  key={reading.serial}
                  kind="timplan"
                  table={reading.table}
                  templates={templates.data ?? NO_TEMPLATES}
                  onChange={setMapping}
                  compact
                />
              ) : null}

              {preview ? (
                <div className="space-y-3">
                  {preview.legacyEncoding ? (
                    <p className="text-sm text-muted-foreground">
                      {tImport("readAs", { encoding: preview.legacyEncoding })}
                    </p>
                  ) : null}
                  {preview.errors.length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-destructive">{tImport("mappingErrors")}</p>
                      <p className="text-sm text-muted-foreground">{tImport("rowNumbering")}</p>
                      <ul className="max-h-40 space-y-1 overflow-y-auto text-sm text-destructive">
                        {preview.errors.map((error, index) => (
                          <li key={`${error.row}-${index}`}>{error.message}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {outside && outside.count > 0 && plan.span ? (
                    <Notice>
                      {t("importOutsideSpan", {
                        count: outside.count,
                        span: spanText(t, plan.span),
                        grades: outside.grades.map(formatTimplanGrade).join(", "),
                      })}
                    </Notice>
                  ) : null}
                  {preview.previewRows.length > 0 ? (
                    <div className="max-h-56 overflow-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            {preview.headers.map((header, index) => (
                              <TableHead key={index}>{header}</TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.previewRows.map((row, rowIndex) => (
                            <TableRow key={rowIndex}>
                              {row.map((value, columnIndex) => (
                                <TableCell key={columnIndex}>{value}</TableCell>
                              ))}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  ) : null}
                  <p className="text-sm text-muted-foreground">
                    {tImport("rowsReady", { count: preview.rows.length })}
                  </p>
                </div>
              ) : null}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {tCommon("cancel")}
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={
                  decided ||
                  preview === null ||
                  preview.rows.length === 0 ||
                  preview.errors.length > 0 ||
                  mappingHolds ||
                  importTimplan.isPending
                }
              >
                {importTimplan.isPending ? tImport("importing") : tImport("import")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
