"use client";

import { Suspense, lazy, useState } from "react";
import type { ClassHalvesDialogProps } from "@/components/groups/class-halves-dialog";

/*
 * "Dela klassen" and "Placera elever" (Halvklasser), fetched the first time
 * either opens, as LazyCsvImportDialog is: React.lazy rather than
 * next/dynamic, mounted from the first open and kept mounted after so the
 * close animation survives, and never rendered during SSR.
 */
const ClassHalvesDialog = lazy(() =>
  import("@/components/groups/class-halves-dialog").then((module) => ({
    default: module.ClassHalvesDialog,
  })),
);

export function LazyClassHalvesDialog(props: ClassHalvesDialogProps) {
  const [used, setUsed] = useState(props.opened !== null);
  if (props.opened !== null && !used) setUsed(true);
  if (!used) return null;
  return (
    <Suspense fallback={null}>
      <ClassHalvesDialog {...props} />
    </Suspense>
  );
}
