"use client";

/*
 * Publiceringsläge: DIRECT (every grundschema edit reaches the calendar as
 * it is saved — the default, and how SchemaPro has always worked) or DRAFT
 * (edits stay an utkast only admins see, until one is published here or from
 * the timetable).
 *
 * The switch is the gateway's to allow (POST /publication-settings/mode):
 * to DRAFT it records what is published now as the starting point (a
 * BASELINE per year); back to DIRECT only when nothing is waiting — a
 * pending draft would otherwise reach the calendar unreviewed, or never.
 * The refusal says how to get there: publish the draft to the year's end, or
 * discard it. The card shows that sentence where the button was pressed.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { useSwitchPublishMode } from "@/lib/publication-queries";
import { publicationErrorText } from "@/lib/publication-messages";
import type { PublishMode } from "@/lib/publication-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function ModeCard({ mode }: { mode: PublishMode }) {
  const t = useTranslations("publishing");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const switchMode = useSwitchPublishMode();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target: PublishMode = mode === "DIRECT" ? "DRAFT" : "DIRECT";

  const doSwitch = async () => {
    setProblem(null);
    try {
      await switchMode.mutateAsync(target);
      toast.success(t(target === "DRAFT" ? "modeSwitchedDraft" : "modeSwitchedDirect"));
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {t("modeTitle")}
          <Badge variant={mode === "DRAFT" ? "warning" : "secondary"}>
            {t(mode === "DRAFT" ? "modeDraft" : "modeDirect")}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{t(mode === "DRAFT" ? "modeDraftBody" : "modeDirectBody")}</p>
        <Button variant="outline" onClick={() => setConfirming(true)} disabled={switchMode.isPending}>
          {t(target === "DRAFT" ? "modeToDraft" : "modeToDirect")}
        </Button>
        {problem ? (
          <p role="alert" className="font-medium">
            {problem}
          </p>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t(target === "DRAFT" ? "modeToDraft" : "modeToDirect")}
        description={t(target === "DRAFT" ? "modeToDraftConfirm" : "modeToDirectConfirm")}
        confirmLabel={t(target === "DRAFT" ? "modeToDraft" : "modeToDirect")}
        loading={switchMode.isPending}
        onConfirm={doSwitch}
      />
    </Card>
  );
}
