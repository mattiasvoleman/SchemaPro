"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download } from "lucide-react";
import {
  downloadTemplate,
  mapClassRows,
  mapMembershipRows,
  mapRequirementRows,
  mapRoomTypeRows,
  mapSubjectRows,
  mapStudentRows,
  mapTeacherDutyRows,
  mapTeacherQualificationRows,
  mapTeacherRows,
  parseCsv,
  type ImportKind,
  type ParsedCsv,
  type RowError,
} from "@/lib/csv";
import {
  IMPORT_NEEDS_YEAR,
  IMPORT_UPDATES_ROWS,
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
  (parsed: ParsedCsv) => {
    rows: Array<Record<string, unknown>>;
    errors: RowError[];
    /**
     * Which columns the file had. Only a kind that UPDATES needs it — for the
     * six create-only kinds an absent column cannot overwrite anything, so
     * they do not report one.
     */
    columns?: string[];
  }
> = {
  students: mapStudentRows,
  teachers: mapTeacherRows,
  classes: mapClassRows,
  teachingGroups: mapMembershipRows,
  roomTypes: mapRoomTypeRows,
  subjects: mapSubjectRows,
  requirements: mapRequirementRows,
  teacherQualifications: mapTeacherQualificationRows,
  teacherDuties: mapTeacherDutyRows,
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
  /** The file's own column set, where the mapper reports one. */
  columns?: string[];
}

export interface CsvImportDialogProps {
  /** Which import kinds this page offers (first one is preselected). */
  kinds: ImportKind[];
  /**
   * The läsår to import into, for a page that lets one be picked.
   *
   * The dialog used to always resolve this itself, to whichever year carries
   * `isActive`. That is right for a page with no year picker, and wrong for the
   * timplan, which has one: an admin planning next autumn selects 2027/2028,
   * sees that year's matrix, exports that year's file — and the import put it
   * into 2026/2027, because that is the year still flagged active. Nothing on
   * screen named a year, so there was nothing to notice.
   *
   * Omitted, the old behaviour stands, which is what the five year-less call
   * sites want. Given, it wins outright rather than being a fallback: a page
   * that knows which year it is showing is never the less reliable source.
   */
  academicYearId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * One-dialog import flow: pick a kind, download the matching template, choose
 * a CSV file, review the parse (first rows + mapping errors), import, and read
 * the created/skipped/errors report. Parsing happens entirely in the browser
 * (web/lib/csv.ts); the API receives typed rows.
 *
 * A kind that OVERWRITES rather than skips (IMPORT_UPDATES_ROWS — the timplan,
 * so far) says so in both halves of the flow, and the `updated` counter it
 * answers with joins the summary. Both are driven off the data rather than off
 * the kind name, so the six create-only kinds render byte for byte what they
 * rendered before.
 */
export function CsvImportDialog({
  kinds,
  academicYearId,
  open,
  onOpenChange,
}: CsvImportDialogProps) {
  const t = useTranslations("csvImport");
  const tCommon = useTranslations("common");
  const { data: years } = useAcademicYears();
  const targetYear =
    (academicYearId !== undefined && academicYearId !== null
      ? years?.find((year) => year.id === academicYearId)
      : years?.find((year) => year.isActive)) ?? null;
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
      ...(mapped.columns ? { columns: mapped.columns } : {}),
    });
  };

  const missingYear = IMPORT_NEEDS_YEAR[kind] && targetYear === null;

  /**
   * The sentence an admin has to read before they draw the wrong conclusion
   * from a partial file.
   *
   * An import that updates looks, from the outside, like the file replacing
   * what was there — so an admin who uploads a spreadsheet holding only
   * årskurs 7 can reasonably read the result as "the rest is gone". Nothing
   * was removed, and there is no undo to reach for either way; saying it in
   * the code comment where the decision was made helps nobody standing in
   * front of the dialog.
   *
   * Rendered before the file is chosen AND on the report, because the two are
   * different worries: beforehand it is "what will this do to what I already
   * entered", afterwards it is "did the rows I left out just disappear".
   */
  const overwriteNotice = IMPORT_UPDATES_ROWS[kind] ? (
    // foreground on muted: 17.00:1 light, 13.19:1 dark — AAA both ways. The
    // fill is what marks the box off; a border-token outline here would be a
    // 1.15:1 line doing work the fill already does.
    <p className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
      {t("updatesNotDeletes")}
    </p>
  ) : null;

  const submit = async () => {
    if (!preview) return;
    try {
      const result = await importCsv.mutateAsync({
        kind,
        ...(targetYear !== null ? { academicYearId: targetYear.id } : {}),
        ...(preview.columns ? { columns: preview.columns } : {}),
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
              {/*
                Two whole sentences rather than one with a clause appended when
                the counter happens to be there: `updated` is absent for every
                create-only kind, and a translator needs to see the sentence
                they are translating rather than a fragment that may or may not
                be glued on. `=== undefined`, not falsiness — a real zero
                updated rows is still an import that could have overwritten and
                must say so.
              */}
              <p className="text-sm font-medium">
                {report.updated === undefined
                  ? t("resultSummary", {
                      created: report.created,
                      skipped: report.skipped,
                    })
                  : t("resultSummaryUpdated", {
                      created: report.created,
                      updated: report.updated,
                      skipped: report.skipped,
                    })}
              </p>
              {overwriteNotice}
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

              {/* Above the file picker, so it is read before a file is picked
                  and not discovered afterwards. */}
              {overwriteNotice}

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
              ) : targetYear && IMPORT_NEEDS_YEAR[kind] ? (
                /*
                  The year the rows will land in, named on the way in.
                  An import that writes into a year is a big enough thing to
                  say out loud, and this is the only place in the flow a year
                  appears at all — the report afterwards counts rows, not years.
                */
                <p className="text-sm text-muted-foreground">
                  {t("importingIntoYear", { year: targetYear.name })}
                </p>
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
