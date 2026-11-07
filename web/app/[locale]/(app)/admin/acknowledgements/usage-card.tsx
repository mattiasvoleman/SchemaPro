"use client";

import { useAckUsage } from "@/lib/ack-queries";
import { limitState, usedShare, type AckUsageLine } from "@/lib/ack";
import { useAckText } from "@/components/acknowledgements/use-ack-text";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";

/**
 * The day's use of Kvittens' limits, for the administrator: what the school has
 * used of its 20 000 receipts, what the reader has used of their own share, and
 * who has used most. A receipt is one guardian asked about one pupil; the day is
 * the last 24 hours. The numbers are the database's (app.ack_usage asks the same
 * function the limit does), so what is shown here is what refuses.
 *
 * The number and the words are the reading: the bar is only the eye's help and
 * is hidden from assistive tech, as the reporting rate's is. From three
 * quarters of a limit the card says "close to the limit", and at all of it says
 * what that means, in words and not by colour alone.
 */
export function UsageCard() {
  const { t } = useAckText();
  const usage = useAckUsage();

  const value = (line: AckUsageLine): string => t("usage.value", { used: line.used, limit: line.limit, percent: usedShare(line) });

  const bar = (line: AckUsageLine) => (
    <div aria-hidden="true" className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(usedShare(line) * 100)}%` }} />
    </div>
  );

  const block = (label: string, line: AckUsageLine, reached: string) => {
    const state = limitState(line);
    return (
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="font-medium">{label}</p>
          <p className="tabular-nums">{value(line)}</p>
        </div>
        {bar(line)}
        {state === "ok" ? null : (
          <p className="text-sm font-medium">{state === "reached" ? reached : t("usage.near")}</p>
        )}
      </div>
    );
  };

  const body = (data: NonNullable<typeof usage.data>) => (
    <div className="space-y-5">
      {data.school ? block(t("usage.school"), data.school, t("usage.reached.school")) : null}
      {block(t("usage.mine"), data.mine, t("usage.reached.mine"))}

      {data.senders ? (
        <div className="space-y-2">
          <h3 className="font-medium">{t("usage.sendersTitle")}</h3>
          {data.senders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("usage.none")}</p>
          ) : (
            <TableCard caption={t("usage.sendersCaption")} tableClassName="min-w-[24rem]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("usage.colSender")}</TableHead>
                  <TableHead scope="col">{t("usage.colUsed")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.senders.map((sender, index) => {
                  const state = limitState(sender);
                  return (
                    <TableRow key={`${index}-${sender.name}`}>
                      <TableCell>{sender.name}</TableCell>
                      <TableCell>
                        <span className="tabular-nums">{value(sender)}</span>
                        {state === "ok" ? null : (
                          <span className="block text-sm font-medium">{state === "reached" ? t("usage.senderReached") : t("usage.near")}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableCard>
          )}
        </div>
      ) : null}
    </div>
  );

  return (
    <SectionCard id="ack-usage" title={t("usage.title")} description={t("usage.description")}>
      {usage.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : usage.isError || !usage.data ? (
        <LoadError variant="inline" title={t("usage.loadFailed")} hint={t("usage.loadFailedHint")} />
      ) : (
        body(usage.data)
      )}
    </SectionCard>
  );
}
