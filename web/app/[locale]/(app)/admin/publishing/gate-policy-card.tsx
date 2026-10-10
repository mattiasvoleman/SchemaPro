"use client";

/*
 * The school's publish policy: for each named check, WARN (shown, and
 * publishing needs "Publicera ändå") or REFUSE (publishing stops until it is
 * fixed). Every check is WARN until the school says otherwise, so nothing
 * that published before Publicering is refused now.
 *
 * Two checks are not here: a dry run the database refuses always stops
 * (PUB_CALENDAR_REFUSED), and "nothing to publish" only informs.
 *
 * The form keeps what was changed and sends only that (PUT is partial), so
 * two admins saving different checks do not undo each other.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { useUpdatePublicationSettings } from "@/lib/publication-queries";
import { publicationErrorText } from "@/lib/publication-messages";
import {
  GATE_OF_POLICY,
  GATE_POLICY_KEYS,
  type GateMode,
  type GatePolicyKey,
  type PublicationSettings,
} from "@/lib/publication-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function GatePolicyCard({ settings }: { settings: PublicationSettings }) {
  const t = useTranslations("publishing");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const update = useUpdatePublicationSettings();
  const [changes, setChanges] = useState<Partial<Record<GatePolicyKey, GateMode>>>({});

  const save = async () => {
    try {
      await update.mutateAsync(changes);
      setChanges({});
      toast.success(t("policySaved"));
    } catch (error) {
      toast.error(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("policyTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{t("policyBody")}</p>
        <ul className="divide-y rounded-md border">
          {GATE_POLICY_KEYS.map((key) => {
            const value = changes[key] ?? settings[key];
            return (
              <li key={key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">{t(`policy.${GATE_OF_POLICY[key]}`)}</span>
                <Select
                  value={value}
                  onValueChange={(next) => setChanges((previous) => ({ ...previous, [key]: next as GateMode }))}
                >
                  <SelectTrigger className="w-36" aria-label={t(`policy.${GATE_OF_POLICY[key]}`)}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WARN">{t("severity.WARN")}</SelectItem>
                    <SelectItem value="REFUSE">{t("severity.REFUSE")}</SelectItem>
                  </SelectContent>
                </Select>
              </li>
            );
          })}
        </ul>
        <Button onClick={save} disabled={Object.keys(changes).length === 0 || update.isPending}>
          {tCommon("save")}
        </Button>
      </CardContent>
    </Card>
  );
}
