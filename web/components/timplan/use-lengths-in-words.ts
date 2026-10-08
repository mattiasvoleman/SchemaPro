import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import type { LengthPart } from "@/lib/lesson-lengths";

/**
 * A post's lengths as a screen reader and a sentence say them: "1 lektion à
 * 80 minuter och 1 lektion à 40 minuter". Each part is its own ICU plural, so
 * "1 lektion" and "2 lektioner" are the translator's, and the parts are joined
 * by the locale's own list ("och" / "and"), which no message can do for a
 * list of one to three.
 */
export function useLengthsInWords(): (parts: readonly LengthPart[]) => string {
  const t = useTranslations("requirements");
  const locale = useLocale();
  return useCallback(
    (parts) =>
      new Intl.ListFormat(locale, { type: "conjunction" }).format(
        parts.map((part) => t("lengthPart", { lessons: part.count, minutes: part.minutes })),
      ),
    [t, locale],
  );
}
