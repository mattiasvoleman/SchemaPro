"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { WarningItem } from "@/lib/placement-warnings";

/*
 * What the week says of a post's lessons without refusing them (D1): a line per warning, an icon AND the word "Varning" so that it is
 * never a colour alone, and after a warning that refuses what that means (Generera will refuse the week). The lines are the page's
 * (use-placement-warnings.ts): in the list under the week, once per post, and in a card's dialog, where a warning that does not refuse
 * says that the lesson is saved and that Generera takes it as it lies.
 */
export function WarningLines({ items, dialog = false }: { items: readonly WarningItem[]; dialog?: boolean }) {
  const t = useTranslations("placementWeek.warnings");
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-sm" aria-label={t("title")} data-testid="placement-warnings">
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-1.5 [overflow-wrap:anywhere]" data-testid="placement-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning-strong" />
          <span>
            <span className="font-medium">{t("label")}</span> {item.text}
            {item.refuses ? ` ${t("refuses")}` : dialog ? ` ${t("standsAnyway")}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
