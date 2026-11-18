"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type { TemplateKind } from "@/lib/column-fields";
import type { MappingTemplate } from "@/lib/column-mapping";
import { readTable, type RawTable } from "@/lib/column-table";
import { useImportTemplates } from "@/lib/column-template-queries";
import { decodeCsvBytes } from "@/lib/csv-encoding";
import { MAX_UPLOAD_BYTES } from "@/lib/schedule-exchange";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ColumnMappingPanel, type MappingState } from "@/components/import/column-mapping-panel";

/** The table the user chose to use: the mapped text for the gateway's reader, how many rows it holds, and what to call it. */
export interface MappedTable {
  csv: string;
  rows: number;
  name: string;
}

export interface ColumnMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: TemplateKind;
  /** Pasted text, or a file chosen; the dialog reads a file's bytes in the encoding it was saved in. */
  source: { text: string } | { file: File } | null;
  onUse: (table: MappedTable) => void;
}

const NO_TEMPLATES: MappingTemplate[] = [];
const PREVIEW_ROWS = 5;
/** A paste this long is not a timetable, and a browser that parses it freezes: it is turned back with a sentence. */
const MAX_TEXT = 5_000_000;
const ENCODING_NAME = { "windows-1252": "Windows-1252", macintosh: "Mac Roman" } as const;

type Reading = { state: "loading" } | { state: "problem"; text: string } | { state: "table"; table: RawTable; encoding: string | null };

/**
 * Peka ut kolumnerna: a table pasted or chosen, mapped to the fields of one kind, and what that makes of its first rows, before
 * anything is sent anywhere (Kolumnmappning, X2). Whatever the user keeps is the mapped text, UTF-8, which the page hands to the
 * gateway's own reader as an ordinary table; nothing of the original leaves the browser, and a column that looks like
 * personnummer is not even part of what is sent.
 */
export function ColumnMappingDialog({ open, onOpenChange, kind, source, onUse }: ColumnMappingDialogProps) {
  const t = useTranslations("columnMapping");
  const [reading, setReading] = useState<Reading>({ state: "loading" });
  const [mapping, setMapping] = useState<MappingState | null>(null);
  const templates = useImportTemplates(open ? kind : null);

  useEffect(() => {
    if (!open || source === null) return;
    let live = true;
    setReading({ state: "loading" });
    setMapping(null);
    const finish = (text: string, encoding: string | null) => {
      if (!live) return;
      if (text.length > MAX_TEXT) setReading({ state: "problem", text: t("tooLong") });
      else {
        const table = readTable(text);
        setReading(table.rows.length === 0 ? { state: "problem", text: t("empty") } : { state: "table", table, encoding });
      }
    };
    if ("text" in source) {
      finish(source.text, null);
    } else {
      void source.file.arrayBuffer().then((buffer) => {
        const decoded = decodeCsvBytes(new Uint8Array(buffer));
        if (decoded.problem !== null) {
          if (live) setReading({ state: "problem", text: decoded.problem });
          return;
        }
        finish(decoded.text, decoded.encoding === "utf-8" ? null : ENCODING_NAME[decoded.encoding]);
      });
    }
    return () => {
      live = false;
    };
    // `t` is not a dependency: a new language is no new table.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  const onChange = useCallback((next: MappingState | null) => setMapping(next), []);
  const applied = mapping?.applied ?? null;
  // The bytes the gateway will be sent (UTF-8), counted and not made into a file: nothing here is handed out.
  const size = useMemo(() => (applied && applied.csv !== "" ? new TextEncoder().encode(applied.csv).length : 0), [applied]);
  const tooLarge = size > MAX_UPLOAD_BYTES;
  const usable = applied !== null && applied.ok && applied.rows.length > 0 && !tooLarge;
  const name = source !== null && "file" in source ? source.file.name : t("pasted");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("dialog.title")}</DialogTitle>
        </DialogHeader>

        {reading.state === "loading" ? <Skeleton className="h-40 w-full" /> : null}
        {reading.state === "problem" ? <Notice tone="destructive">{reading.text}</Notice> : null}
        {reading.state === "table" ? (
          // min-w-0: the dialog is a grid, and a grid item is as wide as its widest content unless it may shrink; the column table
          // scrolls inside its own box (overflow-x-auto) instead of widening the dialog past a phone's edge.
          <div className="min-w-0 space-y-4">
            {reading.encoding ? <p className="text-sm text-muted-foreground">{t("readAs", { encoding: reading.encoding })}</p> : null}
            <ColumnMappingPanel key={source && "file" in source ? `${source.file.name}-${source.file.size}` : "paste"} kind={kind} table={reading.table} templates={templates.data ?? NO_TEMPLATES} onChange={onChange} />
            {applied && applied.problems.length === 0 && applied.rows.length > 0 ? (
              <div className="space-y-1">
                <p className="text-sm font-medium">{t("dialog.preview")}</p>
                <div className="max-h-56 overflow-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {applied.headers.map((header, index) => (
                          <TableHead key={index}>{header}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {applied.rows.slice(0, PREVIEW_ROWS).map((row, at) => (
                        <TableRow key={at}>
                          {row.map((cell, index) => (
                            <TableCell key={index}>{cell}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ) : null}
            {tooLarge ? <Notice tone="destructive">{t("dialog.tooLarge", { size: Math.round(MAX_UPLOAD_BYTES / 1024) })}</Notice> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("dialog.cancel")}
          </Button>
          <Button
            disabled={!usable}
            onClick={() => {
              if (applied) onUse({ csv: applied.csv, rows: applied.rows.length, name });
            }}
          >
            {t("dialog.use")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
