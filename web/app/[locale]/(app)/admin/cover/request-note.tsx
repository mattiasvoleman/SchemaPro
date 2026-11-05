"use client";

import { useLocale, useTranslations } from "next-intl";
import { Undo2 } from "lucide-react";
import type { BoardConfirmation, BoardRequest } from "@/lib/cover-request-types";
import { confirmedAt, pairRequest, requestTally } from "@/lib/cover-request-view";
import type { BoardItem } from "@/lib/cover-types";
import { Button } from "@/components/ui/button";

/**
 * What a pair says of the questions asked about it (Vikariefrågan), under its
 * status on the board and in the phone list:
 *
 *   - while a request is OPEN: how many colleagues were asked and how many
 *     said no, until when it stands, and "Dra tillbaka";
 *   - ACCEPTED, on the covered pair it placed: "Tillsatt via förfrågan";
 *   - ran out, withdrawn or closed, on a pair still without a vikarie: a muted
 *     line, so the administrator sees the question was asked and is over;
 *   - on a COVERED pair: whether the vikarie has tapped "Bekräfta".
 *
 * Withdrawing is the board's write (Drift), marked as such so a reading
 * administrator is shown none.
 */
export function RequestNote({
  item,
  requests,
  confirmations,
  now,
  pairName,
  busy,
  onWithdraw,
}: {
  item: BoardItem;
  requests: readonly BoardRequest[];
  confirmations: readonly BoardConfirmation[];
  now: number;
  /** "Anna Lind: 08:00–09:00 · Matematik · 7A": names the button for a screen reader. */
  pairName: string;
  busy: boolean;
  onWithdraw: (request: BoardRequest) => void;
}) {
  const t = useTranslations("coverRequests");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const found = pairRequest(item, requests);
  const tally = requestTally(found?.request ?? { recipients: [] });
  const confirmed = confirmedAt(item, confirmations);
  const lessonOver = new Date(item.endsAt).getTime() <= now;

  const until = (iso: string) =>
    new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  return (
    <>
      {found?.kind === "OPEN" ? (
        <span className="block whitespace-normal text-xs">
          {t("stateOpen", { asked: tally.asked, declined: tally.declined })}
          <span className="block text-muted-foreground">{t("until", { time: until(found.request.expiresAt) })}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ml-2 mt-0.5 h-6 gap-1 px-2 text-xs"
            disabled={busy}
            aria-label={tCommon("actionNamed", { action: t("withdraw"), name: pairName })}
            onClick={() => onWithdraw(found.request)}
            data-writes="DRIFT"
          >
            <Undo2 aria-hidden="true" />
            {t("withdraw")}
          </Button>
        </span>
      ) : null}
      {found?.kind === "ACCEPTED" ? <span className="block whitespace-normal text-xs">{t("stateAccepted")}</span> : null}
      {found && found.kind !== "OPEN" && found.kind !== "ACCEPTED" ? (
        <span className="block whitespace-normal text-xs text-muted-foreground">
          {t(found.kind === "EXPIRED" ? "stateExpired" : found.kind === "WITHDRAWN" ? "stateWithdrawn" : "stateClosed")}
        </span>
      ) : null}
      {item.status === "COVERED" && item.decision === "SUBSTITUTE" && item.substituteId ? (
        confirmed ? (
          <span className="block whitespace-normal text-xs text-muted-foreground">{t("confirmed")}</span>
        ) : lessonOver ? null : (
          <span className="block whitespace-normal text-xs text-muted-foreground">{t("notConfirmed")}</span>
        )
      ) : null}
    </>
  );
}
