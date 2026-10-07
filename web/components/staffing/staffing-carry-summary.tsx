"use client";

import { useTranslations } from "next-intl";
import type { StaffingCarryPreview } from "@/lib/types";

/**
 * What carrying tjänster and uppdrag into the next läsår will write, and the
 * people and uppdrag the admin should look at first (staffing Fas 5).
 *
 * ONE SUMMARY, TWO PLACES. The rollover wizard's review step shows it for the
 * carry inside the rollover; the carry dialog on /admin/staffing shows it for
 * a year rolled without it. The gateway plans both with the same function
 * (src/year-rollover/rollover-staffing.ts), so the two previews have one
 * shape, and the lists that only a carry into an existing year can have (a
 * teacher already set up, a signature taken, a slot over another) are simply
 * empty inside the rollover.
 *
 * NAMED, NOT COUNTED, where a person has to act: a nedsättning or an own
 * riktmärke is often agreed for one year only, and carried silently it is a
 * confident wrong target in every report — so the teachers are listed by
 * name. The preview sends ids; `teacherName` resolves them from the roster
 * the page already holds.
 */

type DutyRow = { sourceDutyId: string; userId: string; label: string };

/** Nothing to write and nothing to say: the review hides the card rather than print a row of zeros. */
export function isEmptyCarry(preview: StaffingCarryPreview): boolean {
  const { employments, duties } = preview;
  return (
    employments.carried === 0 &&
    duties.carried === 0 &&
    employments.notCarried.length === 0 &&
    employments.signaturesDropped.length === 0 &&
    duties.notCarried.length === 0
  );
}

function Section({ title, items, warn }: { title: string; items: string[]; warn?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className={warn ? "text-warning-foreground dark:text-warning" : undefined}>{title}</p>
      <ul className="ml-4 list-disc text-muted-foreground">
        {items.map((item, index) => (
          <li key={`${index}-${item}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function StaffingCarrySummary({
  preview,
  teacherName,
}: {
  preview: StaffingCarryPreview;
  teacherName: (userId: string) => string;
}) {
  const t = useTranslations("staffing.carry.summary");
  const { employments, duties } = preview;
  // The group only where the label does not already say it ("Mentor 9A").
  const duty = (row: DutyRow & { groupName?: string | null }) =>
    row.groupName && !row.label.includes(row.groupName)
      ? t("dutyLineGroup", { label: row.label, group: row.groupName, teacher: teacherName(row.userId) })
      : t("dutyLine", { label: row.label, teacher: teacherName(row.userId) });
  const names = (ids: string[]) => ids.map(teacherName);
  const notCarried = (reason: (typeof duties.notCarried)[number]["reason"]) =>
    duties.notCarried.filter((row) => row.reason === reason);
  const people = (reason: (typeof employments.notCarried)[number]["reason"]) =>
    employments.notCarried.filter((row) => row.reason === reason).map((row) => teacherName(row.userId));

  return (
    <div className="space-y-3 text-sm">
      <p>
        {t("counts", {
          employments: employments.carried,
          duties: duties.carried,
          slots: duties.slots,
          followed: duties.followedGroup,
        })}
      </p>
      <Section title={t("withReduction")} items={names(employments.withReduction)} warn />
      <Section title={t("withTargetOverride")} items={names(employments.withTargetOverride)} warn />
      <Section title={t("mentorskapLeft")} items={notCarried("GROUP_LEAVES").map(duty)} warn />
      <Section title={t("groupDropped")} items={duties.groupDropped.map(duty)} warn />
      <Section
        title={t("relabelled")}
        items={duties.relabelled.map((row) =>
          t("relabelLine", { from: row.from, to: row.to, teacher: teacherName(row.userId) }),
        )}
      />
      <Section title={t("slotDropped")} items={duties.slotDropped.map(duty)} warn />
      <Section title={t("inactive")} items={people("INACTIVE")} />
      <Section title={t("notStaff")} items={people("NOT_STAFF")} />
      <Section title={t("alreadySetUp")} items={people("ALREADY_PRESENT")} />
      <Section title={t("dutyAlreadyPresent")} items={notCarried("ALREADY_PRESENT").map(duty)} />
      <Section
        title={t("signatureTaken")}
        items={employments.signaturesDropped.map((row) =>
          t("signatureLine", { teacher: teacherName(row.userId), signature: row.signature }),
        )}
        warn
      />
      <Section title={t("overlapsTargetDuty")} items={duties.overlapsTargetDuty.map(duty)} warn />
      <Section title={t("successorHasMentor")} items={duties.successorHasMentor.map(duty)} />
    </div>
  );
}
