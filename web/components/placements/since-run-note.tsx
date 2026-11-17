"use client";

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Notice } from "@/components/ui/notice";
import { changedSinceRun, type SinceRunBoard, type SinceRunJob } from "@/lib/placement-since-run";

/*
 * The two things the week says about where it stands against the last Generera (A3), above the summary:
 *   - that the förläggningar are no longer what the grundschema was written from ("Ändrat sedan senaste schemat. Generera om."),
 *     which Generera's row "En Generera pågår" already says better while one runs, so it is left out then;
 *   - that the card an address pointed at is not there any more (the lesson was moved or removed since the run).
 * Before the first schema the week's own sentence (beforeAfter) is all there is, and this says nothing.
 */
export function SinceRunNote({
  board,
  jobs,
  running,
  missing,
}: {
  board: SinceRunBoard;
  jobs: readonly SinceRunJob[] | undefined;
  running: boolean;
  missing: boolean;
}) {
  const t = useTranslations("placementWeek.fromRun");
  const changed = !running && changedSinceRun(board, jobs);
  if (!changed && !missing) return null;
  return (
    <>
      {missing ? (
        <p role="status" className="text-sm font-medium" data-testid="placement-link-missing">
          {t("missing")}
        </p>
      ) : null}
      {changed ? (
        <div data-testid="placement-since-run">
          <Notice tone="warning">
            {t("changed")}{" "}
            <Link href="/admin/generate" className="font-medium underline underline-offset-4" data-writes="SCHEMALAGGNING">
              {t("toGenerate")}
            </Link>
          </Notice>
        </div>
      ) : null}
    </>
  );
}
