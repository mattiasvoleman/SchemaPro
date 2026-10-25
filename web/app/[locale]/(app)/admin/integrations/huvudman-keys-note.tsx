"use client";

import { useLocale, useTranslations } from "next-intl";
import { SectionCard } from "@/components/ui/section-card";
import { useSchoolHuvudman } from "../dataskydd/use-huvudman-ownership";

/*
 * Huvudman (20261212090000): the SS12000 keys of the school's huvudman,
 * which read the school as the school's own keys do (attendance and absence
 * aside). Shown so that whoever keeps the school's integrations knows who
 * else reads them; the huvudman's kommunadministratör makes and revokes
 * them, and the school ends them all by leaving its huvudman (Dataskydd).
 * Nothing at all for a school without a huvudman.
 */
export function HuvudmanKeysNote() {
  const t = useTranslations("integrations.huvudmanKeys");
  const locale = useLocale();
  const view = useSchoolHuvudman();
  const owner = view.data?.owner;
  // Nothing for a school without a huvudman; nothing while it is read either,
  // below the school's own key cards, so that nothing above them moves.
  if (!owner) return null;
  const day = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { dateStyle: "medium", timeZone: "Europe/Stockholm" });
  // null: the school's deciders read the keys, and this administrator is none.
  const keys = view.data?.keys ?? null;
  return (
    <SectionCard id="huvudman-keys" title={t("title", { name: owner.name })} description={t("body")}>
      {keys === null ? (
        <p className="text-sm text-muted-foreground">{t("notDecider")}</p>
      ) : keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {keys.map((key) => (
            <li key={key.id}>
              {key.name} · <span className="font-mono text-xs">{key.scopes.join(", ")}</span> ·{" "}
              {key.revokedAt ? t("revoked") : key.lastUsedAt ? t("lastUsed", { when: day.format(new Date(key.lastUsedAt)) }) : t("neverUsed")}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
