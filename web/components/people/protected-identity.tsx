"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { PersonProtection } from "@/lib/protected-people";
import { Button } from "@/components/ui/button";

/**
 * Skyddad identitet on a person's opened row (20270107090000): whether the
 * school has marked the person, where the mark comes from, and, for whoever
 * writes Personal, setting or removing it. A marked person is kept out of
 * every file of people Rastra writes (lib/people-files.ts).
 *
 * The marks are read when a row is opened, never with the page: which
 * persons are protected is read only when somebody asks, and the läslogg
 * records it (PEOPLE). Never which protection: the school does not store it.
 */
export const PROTECTIONS_KEY = ["person-protections"] as const;

export function ProtectedIdentity({ userId, writes }: { userId: string; writes: boolean }) {
  const t = useTranslations("protectedIdentity");
  const tCommon = useTranslations("common");
  const client = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: PROTECTIONS_KEY,
    queryFn: () => api.get<PersonProtection[]>("/api/v1/person-protections"),
  });
  const change = useMutation({
    mutationFn: (marked: boolean) =>
      marked
        ? api.put<PersonProtection>(`/api/v1/person-protections/${encodeURIComponent(userId)}`)
        : api.delete<PersonProtection>(`/api/v1/person-protections/${encodeURIComponent(userId)}`),
    onSuccess: (_answer, marked) => {
      void client.invalidateQueries({ queryKey: PROTECTIONS_KEY });
      toast.success(marked ? t("marked") : t("unmarked"));
    },
    onError: () => toast.error(tCommon("error")),
  });

  const mark = data?.find((row) => row.userId === userId) ?? null;
  const headingId = `protected-identity-${userId}`;

  return (
    <section aria-labelledby={headingId} className="space-y-1 text-sm">
      <h3 id={headingId} className="font-medium">
        {t("title")}
      </h3>
      {isLoading ? (
        <p className="text-muted-foreground" aria-busy="true">
          …
        </p>
      ) : isError ? (
        <p className="text-muted-foreground">{t("loadFailed")}</p>
      ) : (
        <>
          <p>{mark ? (mark.source === "SS12000" ? t("fromRegister") : t("byHand")) : t("none")}</p>
          <p className="text-muted-foreground">{t("explain")}</p>
          {mark?.source === "SS12000" ? <p className="text-muted-foreground">{t("registerOwns")}</p> : null}
          {writes ? (
            <Button
              data-writes="PERSONAL"
              variant="outline"
              size="sm"
              disabled={change.isPending}
              aria-busy={change.isPending}
              onClick={() => change.mutate(mark === null)}
            >
              {mark ? t("remove") : t("set")}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
