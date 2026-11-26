"use client";

import { useTranslations } from "next-intl";
import { useInvitationChannel } from "@/lib/queries";
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
  const data = useInvitationChannel().data;
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
