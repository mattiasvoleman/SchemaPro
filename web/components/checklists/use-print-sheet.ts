"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

/**
 * "Skriv ut" for a roster and a consent list: at the click the sheet's module is
 * fetched (print-actions.ts holds the reads and the only call to the browser's
 * print; printed-sheet.tsx the markup) and the roster or list is asked of the
 * gateway "for paper", which has left the pupils with a protected identity out
 * and counted them. The sheet is drawn from that answer alone, and only then does
 * the browser's print open. A read that fails prints nothing, and says so.
 *
 * The sheet is a portal under <body> that only paper shows (globals.css,
 * html.printing-sheet): while it prints the page is the sheet alone. The class
 * on <html> lasts from the click until the browser says the print is done
 * (afterprint), or else at the reader's next click or key once the dialog has
 * closed, since not every browser says it; and it is gone when the page is left.
 * The answer is not kept: the next click asks again.
 */
type Sheets = typeof import("./printed-sheet");
type Printer = typeof import("./print-actions");

export function usePrintSheet<T>() {
  const t = useTranslations("checklists");
  const [paper, setPaper] = useState<T | null>(null);
  const [preparing, setPreparing] = useState(false);
  const printer = useRef<Printer | null>(null);
  const [sheets, setSheets] = useState<Sheets | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (paper === null || printer.current === null) return;
    const root = document.documentElement;
    const done = () => {
      root.classList.remove("printing-sheet");
      window.removeEventListener("afterprint", done);
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
      setPaper(null);
    };
    root.classList.add("printing-sheet");
    window.addEventListener("afterprint", done);
    printer.current.printSheet();
    // The dialog has closed when the reader can click or type on the page again: the way back for a browser that never sends afterprint.
    window.addEventListener("pointerdown", done);
    window.addEventListener("keydown", done);
    return () => {
      root.classList.remove("printing-sheet");
      window.removeEventListener("afterprint", done);
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
    };
  }, [paper]);

  /** `fetchPaper`: asks the gateway for the roster or the list for paper, with the module that holds the reads. */
  const print = async (fetchPaper: (actions: Printer) => Promise<T>) => {
    if (preparing || paper !== null) return;
    setPreparing(true);
    try {
      const [actions, loaded] = await Promise.all([import("./print-actions"), import("./printed-sheet")]);
      const answer = await fetchPaper(actions);
      if (!mounted.current) return;
      printer.current = actions;
      setSheets(loaded);
      setPaper(answer);
    } catch {
      if (mounted.current) toast.error(t("print.failed"));
    } finally {
      if (mounted.current) setPreparing(false);
    }
  };

  return { paper, sheets, preparing, print };
}
