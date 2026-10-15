"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { SheetDocument } from "@/lib/print-sheet";
import { SHEET_PAGE_STYLE, WeekSheet, type Translate } from "./week-sheet";

/**
 * A person's own week, drawn for the printer and nowhere else: the lazily
 * loaded half of print-week-button.tsx. It says when it is on the page, so
 * the button prints the sheet and not an empty frame.
 */
export function PrintedSheet({ document, onReady }: { document: SheetDocument; onReady: () => void }) {
  const t = useTranslations("publicViewer") as unknown as Translate;
  const tDays = useTranslations("days") as unknown as Translate;
  const locale = useLocale();
  // Once per sheet: React's development mode mounts an effect twice, and a
  // second print dialog would be the reader's to dismiss.
  const told = useRef(false);
  useEffect(() => {
    if (told.current) return;
    told.current = true;
    onReady();
  }, [onReady]);
  return (
    <>
      <style>{SHEET_PAGE_STYLE}</style>
      <WeekSheet document={document} locale={locale} t={t} tDays={tDays} variant="print" idPrefix="printed" notes />
    </>
  );
}
