"use client";

/*
 * Beslutshistorik: every decision recorded on this page, newest first. The
 * table is append-only in the database (RetentionDecisions), so this is the
 * school's record of who decided what and when.
 */

import { useLocale, useTranslations } from "next-intl";
import { formatRetentionInstant, type RetentionDecision } from "@/lib/retention-types";
import { SectionCard } from "@/components/ui/section-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { decisionLabel } from "./period";

export function HistoryCard({ history, timeZone }: { history: RetentionDecision[]; timeZone: string }) {
  const t = useTranslations("dataProtection");
  const locale = useLocale();
  return (
    <SectionCard id="retention-history" title={t("historyTitle")} description={t("historyDescription")}>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
      ) : (
        <TableCard caption={t("historyTitle")} tableClassName="min-w-[40rem]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("historyWhen")}</TableHead>
              <TableHead>{t("historyKind")}</TableHead>
              <TableHead>{t("historyDecision")}</TableHead>
              <TableHead>{t("historyReference")}</TableHead>
              <TableHead>{t("historyBy")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.map((entry) => (
              <TableRow key={`${entry.dataType}-${entry.decidedAt}`}>
                <TableCell className="whitespace-nowrap">{formatRetentionInstant(entry.decidedAt, locale, timeZone)}</TableCell>
                <TableCell>{t(`kind.${entry.dataType}.name`)}</TableCell>
                <TableCell>{decisionLabel(entry, (key, values) => t(key, values))}</TableCell>
                <TableCell>{entry.reference ?? "–"}</TableCell>
                <TableCell>{entry.decidedBy ?? t("historyByUnknown")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableCard>
      )}
    </SectionCard>
  );
}
