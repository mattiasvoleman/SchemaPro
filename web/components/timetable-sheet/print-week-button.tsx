"use client";

import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Printer } from "lucide-react";
import type { SheetDocument } from "@/lib/print-sheet";
import { weekValidity } from "@/lib/print-queries";
import { Button } from "@/components/ui/button";

/*
 * "Skriv ut veckan" on a pupil's, a guardian's or a teacher's own week
 * (Utskrift och inbäddning): the week the page shows, on one landscape A4,
 * headed with the school, whose week it is, the week and the period it is
 * valid for.
 *
 * THE PRINT IS THE PAGE. `build` makes the sheet from what the page already
 * read and draws (lib/print-sheet.ts), so printing reads nothing about
 * anybody that viewing did not — a guardian's child's week was recorded in
 * the read log (SCHEDULE) when the page read it. The one request a print
 * adds is the week's validity: dates only.
 *
 * HOW IT PRINTS: the sheet is rendered into a portal under <body> that only
 * paper shows (globals.css, html.printing-sheet), and window.print() is
 * called once the sheet says it is there. The sheet's module is lazy: the
 * schedule pages are in the core tier, and the printout is not what they
 * are for.
 *
 * AND THE PAGE COMES BACK: when the browser says the print is done
 * (afterprint), or else at the reader's next click or key once the dialog
 * has closed, since not every browser says it; when the sheet's module
 * cannot load (a deploy since the page was opened); and when the page is
 * left, also while the validity is still being asked.
 */

const PrintedSheet = lazy(() => import("./printed-sheet").then((module) => ({ default: module.PrintedSheet })));

/** A sheet that cannot be drawn gives the page back rather than taking it down. */
class SheetBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function PrintWeekButton({ build, disabled = false }: { build: () => SheetDocument; disabled?: boolean }) {
  const t = useTranslations("printWeek");
  const [sheet, setSheet] = useState<SheetDocument | null>(null);
  const [preparing, setPreparing] = useState(false);
  const finish = useRef<(() => void) | null>(null);
  const mounted = useRef(true);

  // The page is the sheet alone from before the sheet can mount (a cached
  // chunk mounts it in the same commit, and its effect prints before any
  // effect of this component runs) until the browser says the print is done.
  const start = async () => {
    if (preparing) return;
    setPreparing(true);
    const document = build();
    const validity = await weekValidity(document.week.from);
    // Left while the validity was asked: nothing has been changed yet, and nothing will be.
    if (!mounted.current) return;
    const root = window.document.documentElement;
    const done = () => {
      root.classList.remove("printing-sheet");
      window.removeEventListener("afterprint", done);
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
      finish.current = null;
      if (mounted.current) {
        setSheet(null);
        setPreparing(false);
      }
    };
    finish.current = done;
    root.classList.add("printing-sheet");
    window.addEventListener("afterprint", done);
    setSheet(validity ? { ...document, validity } : document);
  };

  const ready = useCallback(() => {
    window.print();
    // The dialog has closed when the reader can click or type on the page
    // again: the way back for a browser that never sends afterprint.
    if (finish.current) {
      window.addEventListener("pointerdown", finish.current);
      window.addEventListener("keydown", finish.current);
    }
  }, []);

  const failed = useCallback(() => finish.current?.(), []);

  // Leaving the page mid-print leaves nothing behind.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      finish.current?.();
    };
  }, []);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => void start()} disabled={disabled || preparing} className="print:hidden">
        <Printer aria-hidden="true" />
        {preparing ? t("preparing") : t("print")}
      </Button>
      {sheet
        ? createPortal(
            <div className="print-sheet-root">
              <SheetBoundary onError={failed}>
                <Suspense fallback={null}>
                  <PrintedSheet document={sheet} onReady={ready} />
                </Suspense>
              </SheetBoundary>
            </div>,
            window.document.body,
          )
        : null}
    </>
  );
}
