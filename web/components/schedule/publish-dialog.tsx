"use client";

/*
 * The timetable's Publicera dialog: the period the grundschema is rolled out
 * over, and the warning when lunch is not set up.
 *
 * Fetched apart from the page, in the lesson dialogs' chunk (lesson-dialogs.ts),
 * for the reason the page's other dialogs are; see lesson-edit-dialog.tsx. The
 * dates and the publish itself stay with the page. The date picker is imported
 * statically: the dialog is already fetched apart from the page, and the page
 * used to import it lazily for that same reason.
 */

import { useTranslations } from "next-intl";
import { Loader2, TriangleAlert } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the school has lunch set up; the warning shows when it has not. */
  lunchEnabled: boolean;
  fromDate: string;
  onFromDateChange: (value: string) => void;
  toDate: string;
  onToDateChange: (value: string) => void;
  onPublish: () => void;
  pending: boolean;
}

export function PublishDialog({
  open,
  onOpenChange,
  lunchEnabled,
  fromDate,
  onFromDateChange,
  toDate,
  onToDateChange,
  onPublish,
  pending,
}: PublishDialogProps) {
  const t = useTranslations("timetable");
  const tLunch = useTranslations("lunch");
  const tCommon = useTranslations("common");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("publishTitle")}</DialogTitle>
          <DialogDescription>{t("publishBody")}</DialogDescription>
        </DialogHeader>
        {lunchEnabled ? null : (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <div className="space-y-1">
              <p>{tLunch("publishWarning")}</p>
              <Link href="/admin/constraints" className="font-medium underline underline-offset-4">
                {tLunch("publishWarningLink")}
              </Link>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="publish-from">{t("publishFrom")}</Label>
            <DateField
              label={t("publishFrom")}
              id="publish-from"
              value={fromDate}
              onChange={(value) => onFromDateChange(value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="publish-to">{t("publishTo")}</Label>
            <DateField
              label={t("publishTo")}
              id="publish-to"
              value={toDate}
              onChange={(value) => onToDateChange(value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={onPublish} disabled={pending}>
            {pending ? (
              <>
                <Loader2 className="animate-spin" />
                {t("publishing")}
              </>
            ) : (
              t("publishConfirm")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
