"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAnswerHuvudman, useSchoolHuvudman, type HuvudmanAnswer } from "./use-huvudman-ownership";

/*
 * Huvudman (20261212090000): who owns the school, who asks to, who of the
 * owner reads the school and with which SS12000 keys, and the school's
 * answers. A huvudman owns the school only on the decider's yes (rektor or
 * full, as the school's other decisions here), and either side ends it.
 * Owned, the huvudman's people read every area of the school as its läsare
 * and change nothing, and every read of personal data is in the read log
 * below; its keys read the school as the school's own key does, attendance
 * and absence aside.
 */
export function HuvudmanCard() {
  const t = useTranslations("dataProtection.huvudman");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const view = useSchoolHuvudman();
  const answer = useAnswerHuvudman();
  const [asked, setAsked] = useState<HuvudmanAnswer | null>(null);
  // The question the dialog shows, kept while it closes: its words must not
  // change under the fade once the answer is in.
  const [shown, setShown] = useState<HuvudmanAnswer | null>(null);
  const ask = (answer: HuvudmanAnswer) => {
    setShown(answer);
    setAsked(answer);
  };

  const day = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { dateStyle: "medium", timeZone: "Europe/Stockholm" });
  const data = view.data;
  const askedName =
    shown && shown.kind !== "leave" ? (data?.requests.find((request) => request.huvudmanId === shown.huvudmanId)?.name ?? "") : (data?.owner?.name ?? "");

  const confirm = () => {
    if (!asked) return;
    answer.mutate(asked, {
      onSuccess: () => {
        toast.success(asked.kind === "accept" ? t("accepted") : asked.kind === "decline" ? t("declined") : t("left"));
        setAsked(null);
      },
      onError: (error) => {
        const code = error instanceof ApiError ? error.code : undefined;
        toast.error(code && t.has(`errors.${code}`) ? t(`errors.${code}`) : tCommon("error"));
      },
    });
  };

  return (
    <SectionCard id="huvudman" title={t("title")} description={t("body")}>
      {view.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : view.isError || !data ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("error")} />
      ) : (
        <div className="space-y-4 text-sm">
          {data.owner ? (
            <div className="space-y-2">
              <p>
                {t("owned", { name: data.owner.name, since: day.format(new Date(data.owner.since)) })}
                {data.owner.acceptedBy ? ` ${t("acceptedBy", { name: data.owner.acceptedBy })}` : ""}
              </p>
              <p className="text-muted-foreground">{t("reads")}</p>
              <h3 className="font-medium">{t("readers")}</h3>
              {data.readers.length === 0 ? (
                <p className="text-muted-foreground">{t("noReaders")}</p>
              ) : (
                <ul className="list-disc space-y-0.5 pl-5">
                  {data.readers.map((reader) => (
                    <li key={reader.id}>
                      {`${reader.firstName} ${reader.lastName}`}, {t(`role${reader.role}`)}
                      {reader.isActive ? "" : ` (${t("inactive")})`}
                      {reader.ownRow ? (
                        <span className="block text-xs text-muted-foreground">
                          {reader.ownRow === "ACTIVE" ? t("ownRowActive") : t("ownRowInactive")}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {data.keys && data.keys.length > 0 ? (
                <>
                  <h3 className="font-medium">{t("keys")}</h3>
                  <ul className="list-disc space-y-0.5 pl-5">
                    {data.keys.map((key) => (
                      <li key={key.id}>
                        {key.name}
                        {key.revokedAt
                          ? ` (${t("revoked")})`
                          : key.lastUsedAt
                            ? ` · ${t("lastUsed", { when: day.format(new Date(key.lastUsedAt)) })}`
                            : ` · ${t("neverUsed")}`}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {/* Dataskydd is the deciders' page (PAGE_GATES DECIDES); the
                  gateway asks the same of every answer (@Decides). */}
              <Button type="button" size="sm" variant="outline" data-writes="DECIDES" onClick={() => ask({ kind: "leave" })}>
                {t("leave", { name: data.owner.name })}
              </Button>
            </div>
          ) : (
            <p>{t("none")}</p>
          )}

          {data.requests.length > 0 ? (
            <div className="space-y-2">
              <h3 className="font-medium">{t("requests")}</h3>
              <ul className="space-y-2">
                {data.requests.map((request) => (
                  <li key={request.huvudmanId} className="flex flex-wrap items-center gap-2">
                    <span>{t("asks", { name: request.name, when: day.format(new Date(request.requestedAt)) })}</span>
                    <Button
                      type="button"
                      size="sm"
                      data-writes="DECIDES"
                      disabled={answer.isPending || data.owner !== null}
                      onClick={() => ask({ kind: "accept", huvudmanId: request.huvudmanId })}
                    >
                      {t("accept", { name: request.name })}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-writes="DECIDES"
                      disabled={answer.isPending}
                      onClick={() => ask({ kind: "decline", huvudmanId: request.huvudmanId })}
                    >
                      {t("decline", { name: request.name })}
                    </Button>
                  </li>
                ))}
              </ul>
              {data.owner ? <p className="text-xs text-muted-foreground">{t("acceptNeedsLeave")}</p> : null}
            </div>
          ) : null}

          {data.history.length > 0 ? (
            <details className="text-xs">
              <summary className="cursor-pointer font-medium">{t("history")}</summary>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {data.history.map((event, index) => (
                  <li key={`${event.at}:${index}`}>
                    {day.format(new Date(event.at))} · {event.huvudmanName} ·{" "}
                    {t.has(`event${event.kind}`) ? t(`event${event.kind}`) : event.kind}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={asked !== null}
        onOpenChange={(open) => {
          if (!open) setAsked(null);
        }}
        title={
          shown?.kind === "accept"
            ? t("confirmAcceptTitle", { name: askedName })
            : shown?.kind === "decline"
              ? t("confirmDeclineTitle", { name: askedName })
              : t("confirmLeaveTitle", { name: askedName })
        }
        description={shown?.kind === "accept" ? t("confirmAcceptBody") : shown?.kind === "decline" ? t("confirmDeclineBody") : t("confirmLeaveBody")}
        confirmLabel={shown?.kind === "accept" ? t("accept", { name: askedName }) : shown?.kind === "decline" ? t("decline", { name: askedName }) : t("leave", { name: askedName })}
        // Opening the school to the huvudman is the step to weigh.
        destructive={shown?.kind === "accept"}
        loading={answer.isPending}
        onConfirm={confirm}
      />
    </SectionCard>
  );
}
