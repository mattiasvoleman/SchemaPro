"use client";

import { Suspense, lazy, useState } from "react";
import type { CsvImportDialogProps } from "@/components/import/csv-import-dialog";

/*
 * The CSV import dialog, fetched the first time it is opened.
 *
 * It is click-opened on six admin pages, and statically it carried every
 * kind's row mapper (lib/csv.ts's MAPPERS: the uppdrag mapper included, on
 * pages that cannot import uppdrag), its preview table and its report view
 * into each page's own JS. Measured 2026-10-07 with `npm run build` and
 * scripts/bench/bundle-size.mjs — see the commit that introduced this file
 * for the per-route figures. React.lazy rather than next/dynamic, whose
 * loader runtime costs 1.4KB of its own (see admin/people).
 *
 * Mounted from the first open and kept mounted after, so the dialog's close
 * animation and the report it shows survive a close as they did before;
 * never rendered during SSR, since nothing is open on the first render.
 */
const CsvImportDialog = lazy(() =>
  import("@/components/import/csv-import-dialog").then((module) => ({
    default: module.CsvImportDialog,
  })),
);

export function LazyCsvImportDialog(props: CsvImportDialogProps) {
  const [used, setUsed] = useState(props.open);
  if (props.open && !used) setUsed(true);
  if (!used) return null;
  return (
    <Suspense fallback={null}>
      <CsvImportDialog {...props} />
    </Suspense>
  );
}
