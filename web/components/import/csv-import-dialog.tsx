"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download } from "lucide-react";
import {
  downloadTemplate,
  mapClassRows,
  mapMembershipRows,
  mapRoomTypeRows,
  mapStudentRows,
  mapTeacherRows,
  parseCsv,
  type ImportKind,
  type ParsedCsv,
  type RowError,
} from "@/lib/csv";
import {
  IMPORT_NEEDS_YEAR,
  useAcademicYears,
  useImportCsv,
  type ImportReport,
} from "@/lib/queries";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Parsed CSV -> typed rows + row-numbered errors, per import kind. */
const MAPPERS: Record<
  ImportKind,
  (parsed: ParsedCsv) => { rows: Array<Record<string, unknown>>; errors: RowError[] }
> = {
  students: mapStudentRows,
  teachers: mapTeacherRows,
  classes: mapClassRows,
  teachingGroups: mapMembershipRows,
  roomTypes: mapRoomTypeRows,
};

const PREVIEW_ROWS = 5;

interface FilePreview {
  fileName: string;
  headers: string[];
  /** First rows of the raw parse, for the preview table. */
  previewRows: string[][];
  /** Typed rows ready to POST (invalid rows already excluded). */
  rows: Array<Record<string, unknown>>;
  errors: RowError[];
}

export interface CsvImportDialogProps {
  /** Which import kinds this page offers (first one is preselected). */
  kinds: ImportKind[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * One-dialog import flow: pick a kind, download the matching template, choose
 * a CSV file, review the parse (first rows + mapping errors), import, and read
 * the created/skipped/errors report. Parsing happens entirely in the browser
 * (web/lib/csv.ts); the API receives typed rows.
 */
export function CsvImportDialog({ kinds, open, onOpenChange }: CsvImportDialogProps) {
  const t = useTranslations("csvImport");
  const tCommon = useTranslations("common");
  const { data: years } = useAcademicYears();
  const activeYear = years?.find((year) => year.isActive) ?? null;
  const importCsv = useImportCsv();

  const [kind, setKind] = useState<ImportKind>(kinds[0]);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  // Remounting the input is the reliable way to clear a picked file.
  const [fileInputKey, setFileInputKey] = useState(0);

  const reset = () => {
    setPreview(null);
    setReport(null);
    setFileInputKey((key) => key + 1);
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const changeKind = (value: string) => {
    setKind(value as ImportKind);
    // A parsed file belongs to the kind it was mapped with — start over.
    reset();
  };

  const onFileChosen = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = parseCsv(await file.text());
    const mapped = MAPPERS[kind](parsed);
    setReport(null);
    setPreview({
      fileName: file.name,
      headers: parsed.headers,
      previewRows: parsed.rows.slice(0, PREVIEW_ROWS),
      rows: mapped.rows,
      errors: mapped.errors,
    });
  };

  const missingYear = IMPORT_NEEDS_YEAR[kind] && activeYear === null;

  const submit = async () => {
    if (!preview) return;
    try {
      const result = await importCsv.mutateAsync({
        kind,
        ...(activeYear !== null ? { academicYearId: activeYear.id } : {}),
        rows: preview.rows,
      });
      setReport(result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>

        {report ? (
          <>
            <div className="space-y-3">
              <p className="text-sm font-medium">
                {t("resultSummary", { created: report.created, skipped: report.skipped })}
              </p>
              {report.errors.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-sm font-medium text-destructive">{t("rowErrors")}</p>
                  <ul className="max-h-48 space-y-1 overflow-y-auto text-sm text-destructive">
                    {report.errors.map((error, index) => (
                      <li key={`${error.row}-${index}`}>
                        {t("rowError", { row: error.row, message: error.message })}
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
              <div className="space-y-2">
                <Label>{t("kindLabel")}</Label>
                <div className="flex items-center gap-2">
                  <Select value={kind} onValueChange={changeKind}>
                    <SelectTrigger aria-label={t("kindLabel")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {kinds.map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {t(`kinds.${entry}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    className="shrink-0"
                    onClick={() => downloadTemplate(kind)}
                  >
                    <Download />
                    {t("downloadTemplate")}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="csv-import-file">{t("chooseFile")}</Label>
                <Input
                  key={fileInputKey}
                  id="csv-import-file"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => void onFileChosen(event)}
                />
              </div>

              {missingYear ? (
                <p className="text-sm text-destructive">{t("noActiveYear")}</p>
              ) : null}

              {preview ? (
                <div className="space-y-3">
                  {preview.errors.length > 0 ? (
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-destructive">
                        {t("mappingErrors")}
                      </p>
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
                    {t("rowsReady", { count: preview.rows.length })}
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
                  preview === null ||
                  preview.rows.length === 0 ||
                  preview.errors.length > 0 ||
                  missingYear ||
                  importCsv.isPending
                }
              >
                {importCsv.isPending ? t("importing") : t("import")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
