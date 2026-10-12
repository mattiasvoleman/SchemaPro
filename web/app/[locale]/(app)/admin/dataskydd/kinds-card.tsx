"use client";

/*
 * Gallringsperioder: one row per kind of data, with the decision in force,
 * what it would take tonight, what is already gallrat, and Ändra. A kind
 * nobody has decided reads "Ej beslutat" and nothing of it is touched.
 */

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatRetentionDay, formatRetentionInstant, type RetentionKind } from "@/lib/retention-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { DecisionDialog } from "./decision-dialog";
import { decisionLabel } from "./period";

export function KindsCard({ kinds, timeZone }: { kinds: RetentionKind[]; timeZone: string }) {
  const t = useTranslations("dataProtection");
  const [editing, setEditing] = useState<RetentionKind | null>(null);
  return (
    <SectionCard id="retention-kinds" title={t("kindsTitle")} description={t("kindsDescription")}>
      <ul className="divide-y">
        {kinds.map((kind) => (
          <KindRow key={kind.dataType} kind={kind} timeZone={timeZone} onEdit={() => setEditing(kind)} />
        ))}
      </ul>
      {/* Mounted only while open, so its preview is asked for when somebody wants it. */}
      {editing ? (
        <DecisionDialog
          key={editing.dataType}
          kind={editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      ) : null}
    </SectionCard>
  );
}

function KindRow({ kind, timeZone, onEdit }: { kind: RetentionKind; timeZone: string; onEdit: () => void }) {
  const t = useTranslations("dataProtection");
  const locale = useLocale();
  const day = (iso: string) => formatRetentionDay(iso, locale);
  const name = t(`kind.${kind.dataType}.name`);
  const decided = kind.current && kind.current.decision !== "UNDECIDED" ? kind.current : null;
  const people = kind.dataType === "DEPARTED_PEOPLE";
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{name}</span>
          <Badge variant={decided?.decision === "PURGE_AFTER" ? "warning" : decided ? "secondary" : "outline"}>
            {decisionLabel(kind.current, (key, values) => t(key, values))}
          </Badge>
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">{t(`kind.${kind.dataType}.body`)}</p>
        {decided ? (
          <p className="text-sm text-muted-foreground">
            {decided.decidedBy
              ? t("decidedBy", { date: formatRetentionInstant(decided.decidedAt, locale, timeZone), name: decided.decidedBy })
              : t("decidedAt", { date: formatRetentionInstant(decided.decidedAt, locale, timeZone) })}
            {decided.reference ? ` · ${t("reference", { reference: decided.reference })}` : null}
          </p>
        ) : null}
        {kind.waitsUntil ? <p className="text-sm">{t("waitsUntil", { date: day(kind.waitsUntil) })}</p> : null}
        {kind.preview ? (
          <p className="text-sm">
            {t(people ? "tonightPeople" : "tonightRows", { count: kind.preview.due, date: day(kind.preview.cutoff) })}
            {people && kind.preview.held > 0 ? ` ${t("previewHeld", { count: kind.preview.held })}` : null}
          </p>
        ) : null}
        {kind.purgedBefore ? (
          <p className="text-sm text-muted-foreground">{t("purgedBefore", { date: day(kind.purgedBefore) })}</p>
        ) : null}
      </div>
      <Button variant="outline" size="sm" className="shrink-0 self-start" onClick={onEdit} aria-label={t("changeLabel", { kind: name })}>
        {t("change")}
      </Button>
    </li>
  );
}
