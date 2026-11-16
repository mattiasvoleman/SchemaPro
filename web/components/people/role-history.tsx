"use client";

import { useTranslations } from "next-intl";
import { useRoleChanges, type RoleChange } from "@/lib/admin-role-queries";
import { formatStamp } from "@/lib/employment-history-view";
import { useProfile } from "@/components/profile-context";

/**
 * A person's changes of role, administrator profile and HR-läs, newest first
 * (Roller i skolan; UserRoleChanges, written by the database whoever made the
 * change). Read when the person's row is opened.
 */
export function RoleHistory({ userId }: { userId: string }) {
  const t = useTranslations("adminAreas");
  const tRoles = useTranslations("roles");
  const school = useProfile().school;
  const { data, isLoading, isError } = useRoleChanges(userId);

  const roleText = (role: RoleChange["toRole"], profile: RoleChange["toProfile"], hr: boolean | null) => {
    if (role !== "SCHOOL_ADMIN" || profile === null) return tRoles(role);
    const name = t(`profile.${profile}`);
    return hr ? t("withHr", { profile: name }) : name;
  };

  return (
    <section aria-labelledby={`role-history-${userId}`} className="space-y-1 text-sm">
      <h3 id={`role-history-${userId}`} className="font-medium">
        {t("historyTitle")}
      </h3>
      {isLoading ? (
        <p className="text-muted-foreground" aria-busy="true">
          …
        </p>
      ) : isError ? (
        <p className="text-muted-foreground">{t("historyLoadFailed")}</p>
      ) : !data || data.length === 0 ? (
        <p className="text-muted-foreground">{t("historyEmpty")}</p>
      ) : (
        <ul className="space-y-0.5">
          {data.map((change) => {
            const to = roleText(change.toRole, change.toProfile, change.toHrRead);
            // The mark, said only when it really moved: `fromTeaches` is null for a row written before the mark and
            // for a creation, and `toTeaches` is false on every such row, so a null "from" says nothing.
            const teachesNow = change.fromTeaches != null && change.fromTeaches !== change.toTeaches;
            // A row that moved only the mark is not "Rektor → Rektor": it says the mark and nothing else. Every
            // other row, older ones included, reads as it always did.
            const onlyTheMark =
              teachesNow &&
              change.fromRole === change.toRole &&
              change.fromProfile === change.toProfile &&
              change.fromHrRead === change.toHrRead;
            const what = onlyTheMark
              ? null
              : change.fromRole === null
                ? t("historyCreated", { to })
                : t("historyChanged", { from: roleText(change.fromRole, change.fromProfile, change.fromHrRead), to });
            const said = [what, teachesNow ? t(change.toTeaches ? "teaches.historyOn" : "teaches.historyOff") : null]
              .filter((part): part is string => part !== null)
              .join(" · ");
            return (
              <li key={change.id}>
                <time dateTime={change.createdAt} className="tabular-nums text-muted-foreground">
                  {formatStamp(change.createdAt, school?.timezone ?? "Europe/Stockholm")}
                </time>{" "}
                {said}{" "}
                <span className="text-muted-foreground">
                  {change.actorName ? t("historyBy", { name: change.actorName }) : t("historyByNobody")}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
