"use client";

import { useTranslations } from "next-intl";
import { Download } from "lucide-react";
import { CSV_TEMPLATES, downloadCsv, type ImportKind } from "@/lib/csv";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface CsvExport {
  kind: ImportKind;
  /** Called on click; returns the finished file contents. */
  build: () => string;
  /** Nothing to export — the entry is shown but disabled. */
  empty?: boolean;
}

/**
 * Downloads a page's data in the same format its import reads.
 *
 * One kind renders a plain button, several render a menu: a page offering both
 * classes and teaching groups has to say which file it is about to hand over,
 * and a single button labelled "Export" would be a guess.
 *
 * The filename comes from the template, so the file a school downloads is
 * named exactly like the template they may already have on disk.
 */
export function CsvExportButton({ exports }: { exports: CsvExport[] }) {
  const t = useTranslations("csvImport");

  const run = (entry: CsvExport) =>
    downloadCsv(CSV_TEMPLATES[entry.kind].filename, entry.build());

  if (exports.length === 1) {
    const only = exports[0]!;
    return (
      <Button variant="outline" onClick={() => run(only)} disabled={only.empty}>
        <Download />
        {t("exportButton")}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Download />
          {t("exportButton")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {exports.map((entry) => (
          <DropdownMenuItem
            key={entry.kind}
            disabled={entry.empty}
            onSelect={() => run(entry)}
          >
            {t(`kinds.${entry.kind}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
