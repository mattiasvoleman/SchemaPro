"use client";

/*
 * Everything pseudonymising a departed person does besides the name
 * (app.gallring_pseudonymise, 20261021110000), said where the school decides
 * it: under Slutade personer, and beside what a chosen period would take.
 * Their own notices go whatever Notiser says, which nothing else on the page
 * would lead anyone to expect.
 */

import { useId } from "react";
import { useTranslations } from "next-intl";

const EFFECTS = ["names", "login", "notices", "links", "devices", "posts"] as const;

export function PeopleEffects({ className }: { className?: string }) {
  const t = useTranslations("dataProtection");
  const id = useId();
  return (
    <div className={className}>
      <p id={id}>{t("peopleEffectsTitle")}</p>
      <ul aria-labelledby={id} className="list-disc space-y-0.5 pl-5">
        {EFFECTS.map((effect) => (
          <li key={effect}>{t(`peopleEffects.${effect}`)}</li>
        ))}
      </ul>
    </div>
  );
}
