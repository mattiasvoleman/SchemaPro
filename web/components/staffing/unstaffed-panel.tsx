"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { UnstaffedRequirement } from "@/lib/teacher-load";
import type { StaffingWarning } from "@/lib/types";
import type { LessonShare } from "@/lib/lesson-shares";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { TeacherSuggestions } from "@/components/staffing/teacher-suggestions";
import { WarningsNotice } from "@/components/staffing/staffing-notices";

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
  sharesOf,
}: {
  rows: UnstaffedRequirement[];
  teacherName: (userId: string) => string;
  /**
   * Delade lektioner: a post's stored shares. A row for a share nobody
   * teaches (row.share) is given a teacher by writing them again, that one
   * with its teacher (useAssignShare).
   */
  sharesOf: (requirementId: string) => readonly LessonShare[];
}) {
  const t = useTranslations("staffing");
  const [openId, setOpenId] = useState<string | null>(null);
  /**
   * What WARN said about the last row staffed here, and which row: shown in
   * THIS panel, under its heading. It used to go to a banner above the
   * matrix — off-screen from a panel that sits below forty teachers, and
   * without the row, which leaves the panel the moment the report refetches.
   */
  const [warned, setWarned] = useState<{ context: string; warnings: StaffingWarning[] } | null>(
    null,
  );
  const liveRef = useRef<HTMLDivElement>(null);
  /**
   * Where focus goes after a click that unmounts the button it was on (the
   * list closes, then the row leaves): the warning when there is one, the
   * panel itself otherwise — never <body>. Bumped per assignment so the same
   * target is focused again on the next one.
   */
  const [focusTo, setFocusTo] = useState<{ target: "live" | "panel"; at: number } | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    // The panel by its id: SectionCard takes no ref, and the anchor is unique.
    (focusTo.target === "live" ? liveRef.current : document.getElementById(UNSTAFFED_ANCHOR))?.focus();
  }, [focusTo]);

  return (
    <SectionCard
      id={UNSTAFFED_ANCHOR}
      // Focusable by script only: a link to #unstaffed lands focus here.
      tabIndex={-1}
      className="scroll-mt-4"
      title={t("unstaffedTitle")}
      description={t("unstaffedHint")}
    >
      {/* Always mounted, so the sentence is announced when it arrives. */}
      <div ref={liveRef} role="status" aria-live="polite" tabIndex={-1} className="empty:hidden">
        {warned ? (
          <WarningsNotice
            live={false}
            warnings={warned.warnings}
            context={warned.context}
            onDismiss={() => {
              setWarned(null);
              setFocusTo({ target: "panel", at: Date.now() });
            }}
          />
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("unstaffedEmpty")}</p>
      ) : (
        <ul className="divide-y text-sm">
          {rows.map((row) => {
            // A post's lead and each of its teacherless shares are rows of their own.
            const key = row.share ? `${row.requirementId}-${row.share.minutes}` : row.requirementId;
            const open = openId === key;
            const panelId = `suggest-${key}`;
            return (
              <li key={key} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {row.share
                      ? t("unstaffedShareRow", {
                          group: row.groupName,
                          subject: row.subjectName,
                          lessons: row.share.lessons,
                          length: row.share.minutes,
                          minutes: row.teacherMinutesPerWeek,
                        })
                      : t("unstaffedRow", {
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
                      onClick={() => setOpenId(open ? null : key)}
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
                      share={row.share ? { minutes: row.share.minutes, stored: sharesOf(row.requirementId) } : undefined}
                      onAssigned={({ warnings }) => {
                        setOpenId(null);
                        setWarned(
                          warnings.length > 0
                            ? { context: `${row.groupName} · ${row.subjectName}`, warnings }
                            : null,
                        );
                        setFocusTo({ target: warnings.length > 0 ? "live" : "panel", at: Date.now() });
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
