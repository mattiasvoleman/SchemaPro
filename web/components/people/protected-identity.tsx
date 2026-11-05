"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatStamp } from "@/lib/employment-history-view";
import { useProfile } from "@/components/profile-context";
import { Button } from "@/components/ui/button";

/**
 * Skyddad identitet on a person's opened row (20270107090000): whether the
 * school has marked the person, where each mark comes from, who set or
 * removed one and when; and, for whoever writes Personal, a mark by hand,
 * which stands beside the register's until an administrator removes it; for
 * those who decide, removing the marks. A marked person is kept out of every
 * file of people Rastra writes (lib/people-files.ts), but not out of what the
 * systems the school connected read over SS12000: the text says so.
 *
 * Read for the opened person alone (GET /api/v1/person-protections/:userId),
 * never with the page, and recorded in the läslogg as a read of that person
 * and of those its history names. Never which protection: the school does
 * not store it.
 */

type Source = "SS12000" | "MANUAL";

interface ProtectionView {
  userId: string;
  sources: Source[];
  events: Array<{ action: "ADDED" | "REMOVED"; source: Source; actorName: string | null; at: string }>;
}

export const protectionKey = (userId: string) => ["person-protections", userId] as const;

export function ProtectedIdentity({ userId, writes, decides }: { userId: string; writes: boolean; decides: boolean }) {
  const t = useTranslations("protectedIdentity");
  const tCommon = useTranslations("common");
  const timezone = useProfile().school?.timezone ?? "Europe/Stockholm";
  const client = useQueryClient();
  const path = `/api/v1/person-protections/${encodeURIComponent(userId)}`;
  const { data, isLoading, isError } = useQuery({
    queryKey: protectionKey(userId),
    queryFn: () => api.get<ProtectionView>(path),
  });
  const change = useMutation({
    mutationFn: (mark: boolean) => (mark ? api.put<ProtectionView>(path) : api.delete<ProtectionView>(path)),
    onSuccess: (answer, mark) => {
      client.setQueryData(protectionKey(userId), answer);
      void client.invalidateQueries({ queryKey: protectionKey(userId) });
      toast.success(mark ? t("marked") : t("unmarked"));
    },
    onError: () => toast.error(tCommon("error")),
  });

  const sources = data?.sources ?? [];
  const byHand = sources.includes("MANUAL");
  const fromRegister = sources.includes("SS12000");
  const headingId = `protected-identity-${userId}`;
  const state = byHand && fromRegister ? "both" : byHand ? "byHand" : fromRegister ? "fromRegister" : "none";

  return (
    <section aria-labelledby={headingId} className="space-y-1 text-sm">
      <h3 id={headingId} className="font-medium">
        {t("title")}
      </h3>
      {isLoading ? (
        <p className="text-muted-foreground" aria-busy="true">
          …
        </p>
      ) : isError || !data ? (
        <p className="text-muted-foreground">{t("loadFailed")}</p>
      ) : (
        <>
          <p>{t(`state.${state}`)}</p>
          <p className="text-muted-foreground">{t("explain")}</p>
          <p className="text-muted-foreground">{t("integrations")}</p>
          {fromRegister && !byHand ? <p className="text-muted-foreground">{t("registerOwns")}</p> : null}
          {data.events.length > 0 ? (
            <ul className="space-y-0.5" aria-label={t("historyTitle")}>
              {data.events.map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  <time dateTime={event.at} className="tabular-nums text-muted-foreground">
                    {formatStamp(event.at, timezone)}
                  </time>{" "}
                  {t(`event.${event.action}.${event.source}`, { who: event.actorName ?? t("nobody") })}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            {writes && !byHand ? (
              <Button
                data-writes="PERSONAL"
                variant="outline"
                size="sm"
                disabled={change.isPending}
                aria-busy={change.isPending}
                onClick={() => change.mutate(true)}
              >
                {fromRegister ? t("setAlongside") : t("set")}
              </Button>
            ) : null}
            {decides && sources.length > 0 ? (
              <Button
                data-writes="DECIDES"
                variant="outline"
                size="sm"
                disabled={change.isPending}
                aria-busy={change.isPending}
                onClick={() => change.mutate(false)}
              >
                {t("remove")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
