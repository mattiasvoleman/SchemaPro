"use client";

import { useLocale, useTranslations } from "next-intl";
import { Notice } from "@/components/ui/notice";
import { usePurgedBefore } from "@/lib/retention-queries";
import { formatRetentionDay, isBeforePurge, type RetentionDataType } from "@/lib/retention-types";

/**
 * "Närvaro före 12 oktober 2025 är gallrad enligt skolans beslut." A report
 * whose range reaches back past the school's gallring says so, rather than
 * showing an empty table or a zero as if nothing had happened (PRODUCT.md
 * principle 1: an empty view says why it is empty).
 *
 * `from` is the first day the view shows; without one (a list of the newest
 * rows) the line shows whenever the kind has been gallrat at all.
 */
export function PurgedNotice({ kind, from, className }: { kind: Exclude<RetentionDataType, "DEPARTED_PEOPLE">; from?: string | null; className?: string }) {
  const t = useTranslations("retentionNotice");
  const locale = useLocale();
  const purged = usePurgedBefore().of(kind);
  if (!purged || (from !== undefined && !isBeforePurge(from, purged))) return null;
  return (
    <Notice tone="neutral" className={className}>
      {t(kind, { date: formatRetentionDay(purged, locale) })}
    </Notice>
  );
}
