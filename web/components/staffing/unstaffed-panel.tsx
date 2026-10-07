"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { UnstaffedRequirement } from "@/lib/teacher-load";
import type { StaffingWarning } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { TeacherSuggestions } from "@/components/staffing/teacher-suggestions";

/** The panel's anchor: the generate page's prerequisite line links here. */
export const UNSTAFFED_ANCHOR = "unstaffed";

/**
 * "Obemannade rader": every timplanspost of the year without a lead teacher,
 * each with "Föreslå lärare" — Untis' Lehrervorschlag, aSc's green/red.
 *
 * One row's suggestions at a time. Each opening asks the gateway to rank the
 * whole staff against the year's load, which is the right cost for the row
 * being decided and the wrong one for forty rows at once; and the list that
 * opens is long enough that two of them would push the panel off the screen.
 * A row that has been staffed disappears on its own: the mutation refreshes
 * the report this list is read from.
 */
export function UnstaffedPanel({
  rows,
  teacherName,
  onAssigned,
}: {
  rows: UnstaffedRequirement[];
  teacherName: (userId: string) => string;
  onAssigned: (warnings: StaffingWarning[]) => void;
}) {
  const t = useTranslations("staffing");
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section
      id={UNSTAFFED_ANCHOR}
      className="scroll-mt-4 rounded-lg border bg-card p-4"
      aria-labelledby="staffing-unstaffed"
    >
      <h2 id="staffing-unstaffed" className="font-semibold">
        {t("unstaffedTitle")}
      </h2>
      <p className="mb-2 text-xs text-muted-foreground">{t("unstaffedHint")}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("unstaffedEmpty")}</p>
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((row) => {
            const open = openId === row.requirementId;
            const panelId = `suggest-${row.requirementId}`;
            return (
              <li key={row.requirementId} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {t("unstaffedRow", {
                      group: row.groupName,
                      subject: row.subjectName,
                      minutes: row.teacherMinutesPerWeek,
                    })}
                  </span>
                  <span className="flex items-center gap-2">
                    <Link
                      href="/admin/requirements"
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      {t("openRequirements")}
                    </Link>
                    <Button
                      size="sm"
                      variant={open ? "secondary" : "outline"}
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => setOpenId(open ? null : row.requirementId)}
                    >
                      <Sparkles />
                      {t("suggestTeachers")}
                    </Button>
                  </span>
                </div>
                {open ? (
                  <div id={panelId} className="mt-2">
                    <TeacherSuggestions
                      requirementId={row.requirementId}
                      currentTeacherId={null}
                      teacherName={teacherName}
                      onAssigned={({ warnings }) => {
                        setOpenId(null);
                        onAssigned(warnings);
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
