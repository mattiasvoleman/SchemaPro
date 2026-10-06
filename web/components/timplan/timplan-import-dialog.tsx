"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { downloadCsv, parseCsv, type RowError } from "@/lib/csv";
import {
  mapTimplanRows,
  TIMPLAN_CSV_TEMPLATE,
  timplanTemplateCsv,
  type TimplanFileColumn,
} from "@/lib/timplan-csv";
import {
  useImportTimplan,
  type LocalTimplanStatus,
  type TimplanImportReport,
  type TimplanImportRow,
} from "@/lib/timplan-queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

interface FilePreview {
  headers: string[];
  previewRows: string[][];
  rows: TimplanImportRow[];
  errors: RowError[];
  columns: TimplanFileColumn[];
}

export interface TimplanImportDialogProps {
  plan: { id: string; name: string; status: LocalTimplanStatus };
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
 */
export function TimplanImportDialog({ plan, open, onOpenChange }: TimplanImportDialogProps) {
  const t = useTranslations("timplan");
  const tImport = useTranslations("csvImport");
  const tCommon = useTranslations("common");
  const importTimplan = useImportTimplan();
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [report, setReport] = useState<TimplanImportReport | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const decided = plan.status === "DECIDED";

  const reset = () => {
    setPreview(null);
    setReport(null);
    setFileInputKey((key) => key + 1);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const onFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = parseCsv(await file.text());
    const mapped = mapTimplanRows(parsed);
    setReport(null);
    setPreview({
      headers: parsed.headers,
      previewRows: parsed.rows.slice(0, PREVIEW_ROWS),
      rows: mapped.rows,
      errors: mapped.errors,
      columns: mapped.columns,
    });
  };

  const submit = async () => {
    if (!preview) return;
    try {
      setReport(
        await importTimplan.mutateAsync({
          localTimplanId: plan.id,
          columns: preview.columns,
          rows: preview.rows,
        }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const notice = (
    <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">{t("importUpdates")}</p>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
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
            <div className="space-y-4">
              {decided ? (
                <p role="alert" className="text-sm text-destructive">
                  {t("importNotDraft")}
                </p>
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
              <div className="space-y-2">
                <Label htmlFor="timplan-import-file">{tImport("chooseFile")}</Label>
                <Input
                  key={fileInputKey}
                  id="timplan-import-file"
                  type="file"
                  accept=".csv,text/csv"
                  disabled={decided}
                  onChange={(event) => void onFileChosen(event)}
                />
              </div>

              {preview ? (
                <div className="space-y-3">
                  {preview.errors.length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-destructive">{tImport("mappingErrors")}</p>
                      <ul className="max-h-40 space-y-1 overflow-y-auto text-sm text-destructive">
                        {preview.errors.map((error, index) => (
                          <li key={`${error.row}-${index}`}>{error.message}</li>
                        ))}
                      </ul>
                    </div>
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
