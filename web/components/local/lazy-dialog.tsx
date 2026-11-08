"use client";

import { Suspense, lazy, useMemo, useState, type ComponentType } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import type { ConfirmDialog } from "@/components/ui/confirm-dialog";

/** The props of the confirmation, which the dialog module does not export by name. */
export type ConfirmProps = React.ComponentProps<typeof ConfirmDialog>;

/** The confirmation's loader, one function for every page (a lazy component is made from it once per slot). */
export const loadConfirm = () =>
  import("@/components/ui/confirm-dialog").then((module) => ({ default: module.ConfirmDialog }));

/*
 * A dialog fetched the first time it is opened, for the pages of Lokal.
 *
 * Radix Dialog is in none of these routes' chunks, and most visits never open
 * a dialog: a teacher books, an administrator reads a table. React.lazy rather
 * than next/dynamic, whose loader costs 1.4KB of its own. Mounted from the
 * first open and kept mounted after, so the close animation survives; never
 * rendered during SSR, since nothing is open on the first render.
 *
 * A chunk that does not arrive is said in a toast in the reader's language
 * (the loader's own error is English and technical), the dialog is closed
 * and the next open fetches afresh: the boundary is remounted under a new key
 * and the lazy component is made again.
 *
 * `load` must be the same function on every render (a module-level one).
 */
export interface LazyDialogProps<P extends { open: boolean; onOpenChange: (open: boolean) => void }> {
  load: () => Promise<{ default: ComponentType<P> }>;
  /** Which sentence a failed fetch says: the form's or the confirmation's. */
  kind: "form" | "confirm";
  props: P;
}

export function LazyDialog<P extends { open: boolean; onOpenChange: (open: boolean) => void }>({
  load,
  kind,
  props,
}: LazyDialogProps<P>) {
  const tCommon = useTranslations("common");
  const [used, setUsed] = useState(props.open);
  const [attempt, setAttempt] = useState(0);
  // `attempt` is the cache key: a failed fetch makes a fresh lazy component.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const Dialog = useMemo(() => lazy(load), [load, attempt]);
  if (props.open && !used) setUsed(true);
  if (!used) return null;
  return (
    <DialogLoadBoundary
      key={attempt}
      onError={() => {
        toast.error(tCommon(kind === "form" ? "formLoadFailed" : "confirmLoadFailed"));
        props.onOpenChange(false);
        setUsed(false);
        setAttempt((current) => current + 1);
      }}
    >
      <Suspense fallback={null}>
        <Dialog {...props} />
      </Suspense>
    </DialogLoadBoundary>
  );
}
