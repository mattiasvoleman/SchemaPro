"use client";

/*
 * The named checks before a publish (Skola24's "Får publiceras"): one row per
 * check that found something, REFUSE first, then WARN, then INFO, as the
 * gateway orders them (settleGates). Each row says what was found and lists
 * up to twenty of the lessons, requirements or days it is about, by the
 * labels the gateway writes ("Matematik · 7B, mån 08:00" — never a pupil).
 *
 * The severity is said in words beside the icon, not only in colour: a
 * stopping check and a warning differ in what the admin can do next.
 */

import { useTranslations } from "next-intl";
import { Ban, Info, TriangleAlert } from "lucide-react";
import type { GateItem, GateSeverity } from "@/lib/publication-types";
import { cn } from "@/lib/utils";

const ICON: Record<GateSeverity, typeof Ban> = { REFUSE: Ban, WARN: TriangleAlert, INFO: Info };
const TONE: Record<GateSeverity, string> = {
  REFUSE: "border-destructive/50",
  WARN: "border-warning/60",
  INFO: "border-border",
};
const ICON_TONE: Record<GateSeverity, string> = {
  REFUSE: "text-destructive",
  WARN: "text-warning-foreground dark:text-warning",
  INFO: "text-foreground",
};

export function GateList({ gates }: { gates: readonly GateItem[] }) {
  const t = useTranslations("publishing");
  if (gates.length === 0) {
    return <p className="text-sm">{t("gatesNone")}</p>;
  }
  return (
    <ul className="space-y-2" aria-label={t("gatesTitle")}>
      {gates.map((gate) => {
        const Icon = ICON[gate.severity];
        const more = gate.count - gate.items.length;
        return (
          <li key={gate.code} className={cn("rounded-md border p-3 text-sm", TONE[gate.severity])}>
            <div className="flex items-start gap-2">
              <Icon className={cn("mt-0.5 size-4 shrink-0", ICON_TONE[gate.severity])} aria-hidden />
              <div className="min-w-0 flex-1 space-y-1">
                <p>
                  <span className="font-medium">{t(`severity.${gate.severity}`)}:</span>{" "}
                  {t(`gates.${gate.code}`, { count: gate.count })}
                </p>
                {gate.items.length > 0 ? (
                  <ul className="list-disc space-y-0.5 pl-5 text-xs">
                    {gate.items.map((item, index) => (
                      <li key={`${gate.code}-${index}`}>{item.label}</li>
                    ))}
                    {more > 0 ? <li>{t("gateMore", { count: more })}</li> : null}
                  </ul>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
