"use client";

import { useLocale, useTranslations } from "next-intl";
import { WRITER_ORDER, profileWrites, type AdminArea } from "@/lib/admin-areas";
import { useProfile, useReadOnly } from "@/components/profile-context";

/**
 * Which of the page's writes this administrator may make, by the areas of
 * Roller i skolan: the appointments and the open hours are Schemaläggning's,
 * the school's option and discarding a draft are Publicering's, and publishing
 * a class's drafts takes all three of Schemaläggning, Drift and Publicering.
 *
 * The page writes more than one area, so no area gates it as a whole
 * (PAGE_GATES: no row) and each control asks for its own. A control the
 * profile may not use is disabled and says why, beside the write's own
 * `data-writes` mark, which the (app) layout hides the control by for a läsare.
 * The gateway refuses the same writes by name (AREA_NOT_YOURS) and the database
 * under it: this spares a click that would be refused.
 */
export function useAreaGate() {
  const { profile } = useProfile();
  const readOnly = useReadOnly();
  const tAreas = useTranslations("adminAreas");
  const t = useTranslations("classTeacherAdmin");
  const locale = useLocale();
  // A profile built without one reads as a full administrator, as the other admin pages' cards read it.
  const adminProfile = profile.adminProfile === undefined ? "FULL" : profile.adminProfile;

  const may = (...areas: AdminArea[]): boolean => !readOnly && areas.every((area) => profileWrites(adminProfile, area));

  /** "Din profil ändrar inte Schemaläggning. Schemaläggning ändras av rektor, en fullständig administratör eller en schemaläggare." */
  const why = (...areas: AdminArea[]): string | null => {
    const missing = areas.find((area) => readOnly || !profileWrites(adminProfile, area));
    if (!missing) return null;
    const list = new Intl.ListFormat(locale, { type: "disjunction" });
    const writers = list.format(WRITER_ORDER.filter((writer) => profileWrites(writer, missing)).map((writer) => tAreas(`doer.${writer}`)));
    return t("gate", { area: tAreas(`area.${missing}`), writers });
  };

  return { may, why };
}
