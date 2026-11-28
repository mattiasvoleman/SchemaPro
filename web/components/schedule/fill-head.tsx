"use client";

import { lazy, Suspense, useState } from "react";
import { useTranslations } from "next-intl";
import { ListPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import type { FillDialogProps } from "@/components/schedule/fill-dialog";

/*
 * LÄGG DET SOM GÅR, THE BUTTON IN THE BOARD'S TOOLBAR (E7a): small, drawn as the page mounts (it rides in the lesson dialogs' chunk beside the tray's own
 * head), and the dialog it opens is fetched the first time it is pressed, since a school asks for a fill a few times in a week. A dialog that does not
 * arrive is said in a toast, and the next press fetches it again; nothing of the dialog is in the route's first load.
 */
const lazyDialog = () => lazy(() => import("@/components/schedule/fill-dialog").then((module) => ({ default: module.FillDialog })));
let Dialog = lazyDialog();

export function FillHead(props: Omit<FillDialogProps, "open" | "onClose"> & { writable: boolean }) {
  const t = useTranslations("fillDialog");
  const [open, setOpen] = useState(false);
  const { writable, ...dialog } = props;
  if (!writable) return null;
  return (
    <>
      <Button size="sm" variant={open ? "default" : "outline"} aria-haspopup="dialog" onClick={() => setOpen(true)} data-writes="SCHEMALAGGNING DRIFT">
        <ListPlus />
        {t("button")}
      </Button>
      {open ? (
        <DialogLoadBoundary
          onError={() => {
            // A lazy() keeps a rejected fetch for good: a fresh wrapper is what makes the next press fetch again.
            Dialog = lazyDialog();
            setOpen(false);
            toast.error(t("loadFailed"));
          }}
        >
          <Suspense fallback={null}>
            {/* A proposal belongs to the year it was asked for: the dialog is not modal, so the page can be switched to another year while one stands. A new key
                is a new dialog (the old one's cleanup takes its proposal off the board) with nothing asked yet. */}
            <Dialog key={dialog.yearId} {...dialog} open onClose={() => setOpen(false)} />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}
    </>
  );
}
