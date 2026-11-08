"use client";

import { Suspense, lazy, useState } from "react";
import { toast } from "sonner";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import type { DialogSpec } from "./dialog-spec";
import { useChecklistsText } from "./use-checklists-text";

/*
 * The dialogs of Checklistor (a tick to void, a pupil's card, an answer to write
 * down, the question before an ask and before ending a list) are fetched on the
 * first click, not with the page: nobody opens one until they want it, and Radix
 * Dialog is then in no chunk the page loads at first. A chunk that does not
 * arrive is said in a toast, and the next click fetches afresh (a lazy component
 * that failed once stays failed, so the next one is made anew).
 */
const lazyDialogs = () => lazy(() => import("./dialogs").then((module) => ({ default: module.ChecklistDialog })));
let Dialogs = lazyDialogs();

export function useChecklistDialogs() {
  const { t } = useChecklistsText();
  const [spec, setSpec] = useState<DialogSpec | null>(null);
  // Which attempt to fetch the dialogs this is: a new key remounts the boundary after a failure.
  const [attempt, setAttempt] = useState(0);

  const failed = () => {
    toast.error(t("dialogLoadFailed"));
    Dialogs = lazyDialogs();
    setSpec(null);
    setAttempt((count) => count + 1);
  };

  return {
    open: setSpec,
    element: spec ? (
      <DialogLoadBoundary key={attempt} onError={failed}>
        <Suspense fallback={null}>
          <Dialogs spec={spec} onClose={() => setSpec(null)} />
        </Suspense>
      </DialogLoadBoundary>
    ) : null,
  };
}
