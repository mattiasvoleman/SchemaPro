"use client";

import { Suspense, lazy, useState } from "react";
import type { ColumnMappingDialogProps } from "@/components/import/column-mapping-dialog";

/*
 * The column mapping dialog, fetched the first time it is opened (Kolumnmappning, X2).
 *
 * It carries the mapping core, the catalogue of fields, the personnummer shape, the template hooks and the panel: code only
 * this click needs, and the schedule exchange's route has bytes for none of it in its first load. React.lazy rather than
 * next/dynamic, whose loader runtime costs 1.4 KB of its own (bundle-gate-measurement.md). Mounted from the first open and kept
 * mounted after, so its close animation and what was chosen survive a close; never rendered during SSR, since nothing is open
 * on the first render.
 */
const ColumnMappingDialog = lazy(() =>
  import("@/components/import/column-mapping-dialog").then((module) => ({ default: module.ColumnMappingDialog })),
);

export function LazyColumnMappingDialog(props: ColumnMappingDialogProps) {
  const [used, setUsed] = useState(props.open);
  if (props.open && !used) setUsed(true);
  if (!used) return null;
  return (
    <Suspense fallback={null}>
      <ColumnMappingDialog {...props} />
    </Suspense>
  );
}
