"use client";

/*
 * The timetable's word on what it is showing, in utkastläge: "Utkast: 3
 * ändringar ej publicerade", or that the draft is the published timetable.
 * Pressed, it opens the review dialog. In direct mode it draws nothing — the
 * grid IS what is published there, and a school that never switched sees the
 * page it always had.
 *
 * Fetched lazily with the lesson dialogs (lesson-dialogs.ts): the page
 * starts that fetch as it mounts anyway, and the badge's hooks and strings
 * stay off the route's first load.
 *
 * The count follows the grid's edits through `revision` — when the page last
 * read its lessons — rather than a timer or a refetch per render.
 */

import { useTranslations } from "next-intl";
import { useDraftState, usePublicationSettings } from "@/lib/publication-queries";
import { pendingCount } from "@/lib/publication-view";
import { Badge } from "@/components/ui/badge";

export function PublicationBadge({
  yearId,
  revision,
  onReview,
}: {
  yearId: string;
  revision: number;
  onReview: () => void;
}) {
  const t = useTranslations("publishing");
  const settings = usePublicationSettings();
  const draft = settings.data?.publishMode === "DRAFT";
  const state = useDraftState(yearId, draft, revision);
  if (!draft) return null;
  const count = state.data ? pendingCount(state.data) : null;
  return (
    <button type="button" onClick={onReview} className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Badge variant={count === null || count > 0 ? "warning" : "success"}>
        {count === null ? t("badgeDraft") : count > 0 ? t("badgePending", { count }) : t("badgeClean")}
      </Badge>
    </button>
  );
}
