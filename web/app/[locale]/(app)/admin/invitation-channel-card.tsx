"use client";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import type { InvitationChannel } from "@/lib/queries";
import { Notice } from "@/components/ui/notice";

/**
 * The administrator's start page says whether the invitations will arrive: every invitation and every password reset is a mail from
 * Supabase Auth, and Supabase's own sender lets two an hour through. A school that finds out when the third teacher does not get theirs
 * is a school that thinks the product is broken. The page cannot read the project's setting (the token that reads it is the
 * operator's, never the API's): it says what the operator has declared, and says that nobody has when nobody has.
 *
 * A read that fails says nothing: a card that said "not stated" because the gateway was busy would be a false alarm.
 */
export function InvitationChannelCard() {
  const t = useTranslations("dashboard");
  // Its own query, with the key lib/queries.ts's useInvitationChannel has, and not that hook: queries.ts is the shared module of forty routes,
  // and the start page, which does not otherwise carry it, would have carried all of it for one read (+5.4 KB measured, 2026-11-26).
  const data = useQuery({
    queryKey: ["dashboard", "invitationChannel"],
    queryFn: () => api.get<InvitationChannel>("/api/v1/users/invitation-channel"),
    staleTime: 5 * 60_000,
  }).data;
  if (!data) return null;

  if (!data.configured) {
    return (
      <Notice tone="destructive" title={t("channelOffTitle")}>
        {t("channelOff")}
      </Notice>
    );
  }
  if (data.smtp === "CUSTOM") {
    return (
      <Notice tone="success" title={t("channelCustomTitle")}>
        {data.perHour === null ? t("channelCustom") : t("channelCustomLimit", { perHour: data.perHour })}
      </Notice>
    );
  }
  return (
    <Notice tone="warning" title={t("channelNotStatedTitle")}>
      {t("channelNotStated")}
    </Notice>
  );
}
