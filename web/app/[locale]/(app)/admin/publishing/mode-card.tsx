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
import { PLAN_STATUS_VARIANT } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";

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
    <SectionCard
      id="publish-mode"
      title={
        <span className="flex flex-wrap items-center gap-2">
          {t("modeTitle")}
          {/* An utkast waits for a decision (warning, as a draft timplan
              does); direct is a neutral fact about the school. */}
          <Badge variant={mode === "DRAFT" ? PLAN_STATUS_VARIANT.DRAFT : "secondary"}>
            {t(mode === "DRAFT" ? "modeDraft" : "modeDirect")}
          </Badge>
        </span>
      }
    >
      <p className="max-w-prose text-sm">{t(mode === "DRAFT" ? "modeDraftBody" : "modeDirectBody")}</p>
      <Button variant="outline" onClick={() => setConfirming(true)} disabled={switchMode.isPending} data-writes="PUBLICERING">
        {t(target === "DRAFT" ? "modeToDraft" : "modeToDirect")}
      </Button>
      {/* What the gateway refused and how to get there, where the switch was pressed. */}
      {problem ? <Notice tone="destructive">{problem}</Notice> : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t(target === "DRAFT" ? "modeToDraft" : "modeToDirect")}
        description={t(target === "DRAFT" ? "modeToDraftConfirm" : "modeToDirectConfirm")}
        confirmLabel={t(target === "DRAFT" ? "modeToDraft" : "modeToDirect")}
        loading={switchMode.isPending}
        onConfirm={doSwitch}
      />
    </SectionCard>
  );
}
