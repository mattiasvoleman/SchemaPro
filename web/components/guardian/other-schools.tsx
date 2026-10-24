"use client";

import { useQueries } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { School } from "lucide-react";
import { api } from "@/lib/api";
import { GUARDIAN_KEYS } from "@/lib/guardian-keys";
import type { GuardianChild } from "@/lib/guardian-queries";
import type { MySchool } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";

/**
 * Flera skolor per inloggning: a guardian with children at more than one
 * school sees them all from one sign-in. This page shows the children of the
 * school the browser chose; this card names the children at each of the
 * guardian's other schools, with the button that switches there.
 *
 * Each list is the gateway's own GET /api/v1/family/children, asked with
 * that school's id (X-School-Id), so it is that school's row security that
 * answers and that school's läslogg that records the read, as when the
 * guardian opens the page there. Fetched with the page's lazy chunk, which
 * only a guardian with another school loads. A school closed to this sign-in
 * (the access-token hook) is named and not asked: the gateway would refuse
 * the read.
 */
export function OtherSchools({ schools }: { schools: MySchool[] }) {
  const t = useTranslations("guardian");
  const tSwitcher = useTranslations("schoolSwitcher");
  const locale = useLocale();
  const reads = useQueries({
    queries: schools.map((school) => ({
      queryKey: [...GUARDIAN_KEYS.myChildren, "school", school.schoolId],
      queryFn: () => api.get<GuardianChild[]>("/api/v1/family/children", { school: school.schoolId }),
      enabled: school.closed === null,
    })),
  });

  return (
    <SectionCard id="other-schools" title={t("otherSchoolsTitle")} description={t("otherSchoolsBody")} icon={School}>
      <ul className="divide-y">
        {schools.map((school, index) => {
          const read = reads[index];
          const children = (read?.data ?? []).filter((child) => child.isActive);
          return (
            <li key={school.schoolId} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">{school.schoolName}</p>
                <p className="text-sm text-muted-foreground">
                  {school.closed !== null
                    ? tSwitcher("closedOther")
                    : read?.isPending
                    ? t("otherSchoolsLoading")
                    : read?.isError
                      ? t("otherSchoolsUnreadable")
                      : children.length === 0
                        ? t("otherSchoolsNone")
                        : children.map((child) => `${child.firstName} ${child.lastName}`).join(", ")}
                </p>
              </div>
              {school.closed === null && (
                <form method="post" action={`/${locale}/skola`}>
                  <Button type="submit" variant="outline" size="sm" name="school" value={school.schoolId}>
                    {tSwitcher("switchTo", { school: school.schoolName })}
                  </Button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
