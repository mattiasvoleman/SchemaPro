"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { CSV_TEMPLATES, downloadCsv, type ImportKind } from "@/lib/csv-export";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface CsvExport {
  kind: ImportKind;
  /**
   * Called on click; returns the finished file contents — or a promise of
   * them, for a page that loads its builder at the click rather than with
   * the route (/admin/requirements, at its bundle budget). Null downloads
   * nothing: the page has already said why (a builder that did not load).
   */
  build: () => string | null | Promise<string | null>;
  /** Nothing to export — the entry is shown but disabled. */
  empty?: boolean;
  /**
   * The file names pupils and may therefore name some with protected personal
   * data (skyddad identitet), which the school does not store: said once the
   * file has been handed over, since the school is the one who can hold such
   * a pupil's rows back.
   */
  protectedWarning?: boolean;
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
 *
 * ONE EXPORT AT A TIME. A builder that reads the gateway at the click
 * (vardnadshavare.csv, uppdrag.csv) takes a moment, and a second click in that
 * moment made a second read, which the läslogg records, and a second file. The
 * button is disabled while one runs; the ref is what stops the second click
 * that lands before the render that disables it.
 */
export function CsvExportButton({ exports }: { exports: CsvExport[] }) {
  const t = useTranslations("csvImport");
  const [pending, setPending] = useState(false);
  const running = useRef(false);

  const run = async (entry: CsvExport) => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    try {
      const file = await entry.build();
      if (file === null) return;
      downloadCsv(CSV_TEMPLATES[entry.kind].filename, file);
      if (entry.protectedWarning) toast.warning(t("protectedWarning"), { duration: 15000 });
    } finally {
      running.current = false;
      setPending(false);
    }
  };

  if (exports.length === 1) {
    const only = exports[0]!;
    return (
      <Button variant="outline" onClick={() => void run(only)} disabled={only.empty || pending} aria-busy={pending}>
        <Download />
        {t("exportButton")}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={pending} aria-busy={pending}>
          <Download />
          {t("exportButton")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {exports.map((entry) => (
          <DropdownMenuItem
            key={entry.kind}
            disabled={entry.empty}
            onSelect={() => void run(entry)}
          >
            {t(`kinds.${entry.kind}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
