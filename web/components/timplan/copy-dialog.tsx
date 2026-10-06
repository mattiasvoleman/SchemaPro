"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface CopyDialogProps {
  /** reopen: a DECIDED plan into a new draft; copy: any plan into a new draft. */
  mode: "reopen" | "copy";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planName: string;
  /** Every plan name the school has, for the name the gateway will pick. */
  takenNames?: readonly string[];
  pending: boolean;
  /** undefined = let the gateway name it ("… (utkast)" / "… (kopia)", numbered when taken). */
  onConfirm: (name: string | undefined) => Promise<void>;
}

/**
 * Öppna igen and Kopiera: both create a NEW draft from a plan, and both let
 * the admin name it. The name is optional — the gateway picks a free one,
 * "<name> (utkast)" for a reopened plan and "<name> (kopia)" for a copy,
 * numbered when that is taken — and the hint states the name that will be
 * used, so leaving the field empty is a choice and not a gamble.
 *
 * For a reopen the body says the decided plan stays as it is: the admin is
 * not editing the decision, they are starting the next proposal from it.
 */
export function CopyDialog({
  mode,
  open,
  onOpenChange,
  planName,
  takenNames = [],
  pending,
  onConfirm,
}: CopyDialogProps) {
  const t = useTranslations("timplan");
  const tCommon = useTranslations("common");
  const [name, setName] = useState("");

  const fallback = gatewayDraftName(planName, mode === "reopen" ? "utkast" : "kopia", takenNames);
  const tooLong = name.trim().length > 100;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) setName("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(mode === "reopen" ? "reopenTitle" : "copyTitle")}</DialogTitle>
          <DialogDescription>
            {t(mode === "reopen" ? "reopenBody" : "copyBody", { name: planName })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="timplan-copy-name">{t("copyNameLabel")}</Label>
          <Input
            id="timplan-copy-name"
            value={name}
            placeholder={fallback}
            aria-invalid={tooLong || undefined}
            aria-describedby="timplan-copy-name-hint"
            onChange={(event) => setName(event.target.value)}
          />
          <p id="timplan-copy-name-hint" className="text-xs text-muted-foreground">
            {tooLong ? t("nameTooLong") : t("copyNameHint", { name: fallback })}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={() => void onConfirm(name.trim() === "" ? undefined : name.trim())}
            disabled={pending || tooLong}
          >
            {t(mode === "reopen" ? "reopenConfirm" : "copyConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The name POST /:id/reopen or /:id/copy gives a draft when none is sent —
 * freeName in src/timplan/local-timplans.service.ts, restated: "<name>
 * (utkast)" or "<name> (kopia)", then "(utkast 2)", … — the first one no plan
 * of the school has, cut to stay within 100 characters. The suffix is the
 * gateway's and Swedish in every locale, because it is part of the stored
 * name. The hint used to print "{name} (draft)" in English and never the
 * number, so the draft the toast landed on was not the one announced.
 */
export function gatewayDraftName(base: string, suffix: "utkast" | "kopia", taken: readonly string[]): string {
  const names = new Set(taken);
  const candidate = (n: number) => {
    const tail = n === 1 ? ` (${suffix})` : ` (${suffix} ${n})`;
    return `${base.slice(0, 100 - tail.length).trimEnd()}${tail}`;
  };
  let n = 1;
  while (names.has(candidate(n))) n += 1;
  return candidate(n);
}
