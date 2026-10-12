"use client";

/*
 * Senaste gallringar: one row per night's run, the evidence the
 * dataskyddsombud asks for. A run holds counts and nothing else (GallringRuns,
 * 20261021110000): what went per kind, what waits (people held for SCB's
 * underlag, logins the provider would not delete) and the kinds a night's cap
 * stopped, which the next night continues.
 */

import { useLocale, useTranslations } from "next-intl";
import { formatRetentionInstant, RETENTION_DATA_TYPES, type GallringRun } from "@/lib/retention-types";
import { SectionCard } from "@/components/ui/section-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

export function RunsCard({ runs, timeZone }: { runs: GallringRun[]; timeZone: string }) {
  const t = useTranslations("dataProtection");
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale === "en" ? "en-GB" : "sv-SE");
  const kindName = (kind: string) => t(`kind.${kind}.name`);

  return (
    <SectionCard id="retention-runs" title={t("runsTitle")} description={t("runsDescription")}>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("runsEmpty")}</p>
      ) : (
        <TableCard caption={t("runsTitle")} tableClassName="min-w-[40rem]">
          <TableHeader>
            <TableRow>
              <TableHead>{t("runStarted")}</TableHead>
              <TableHead>{t("runStatusLabel")}</TableHead>
              <TableHead>{t("runTaken")}</TableHead>
              <TableHead>{t("runWaiting")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => {
              const taken = RETENTION_DATA_TYPES.filter((kind) => (run.counts[kind] ?? 0) > 0).map(
                (kind) => `${kindName(kind)} ${number.format(run.counts[kind] ?? 0)}`,
              );
              const unfinished = RETENTION_DATA_TYPES.filter((kind) => run.complete[kind] === false).map(kindName);
              const waiting = [
                run.waiting["DEPARTED_PEOPLE_SCB"] ? t("runWaitingScb", { count: run.waiting["DEPARTED_PEOPLE_SCB"] }) : null,
                run.waiting["DEPARTED_PEOPLE_LOGIN"] ? t("runWaitingLogin", { count: run.waiting["DEPARTED_PEOPLE_LOGIN"] }) : null,
                unfinished.length > 0 ? t("runContinues", { kinds: unfinished.join(", ") }) : null,
              ].filter((line): line is string => line !== null);
              return (
                <TableRow key={run.startedAt}>
                  <TableCell className="whitespace-nowrap">{formatRetentionInstant(run.startedAt, locale, timeZone)}</TableCell>
                  <TableCell>{t(`runStatus.${run.status}`)}</TableCell>
                  <TableCell>{taken.length > 0 ? taken.join(" · ") : t("runNothing")}</TableCell>
                  <TableCell>{waiting.length > 0 ? waiting.join(" · ") : "–"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </TableCard>
      )}
    </SectionCard>
  );
}
