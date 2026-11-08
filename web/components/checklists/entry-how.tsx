import type { ConsentEntryView } from "@/lib/checklists";
import { useChecklistsText } from "./use-checklists-text";

/**
 * How an answer came to be, in a sentence: written in by a person from a paper,
 * a call or a meeting ("Skrivet in av Anna Svensson den 5 nov. 2026, lämnat 3
 * nov. 2026 av vårdnadshavaren"), or confirmed by the guardians in the app
 * ("Bekräftat i appen 3 nov. 2026"). A confirmation in the app has no writer: the
 * guardians' own login is the one that confirmed.
 */
export function EntryHow({ entry }: { entry: ConsentEntryView }) {
  const { t, day, instantDay } = useChecklistsText();
  if (entry.source === "KVITTENS") return <>{t("how.kvittens", { date: day(entry.givenOn) })}</>;
  const written = entry.recordedByName
    ? t("how.registeredBy", { name: entry.recordedByName, date: instantDay(entry.recordedAt) })
    : t("how.registered", { date: instantDay(entry.recordedAt) });
  const given = entry.givenBy ? t("how.givenBy", { given: day(entry.givenOn), by: entry.givenBy }) : t("how.given", { given: day(entry.givenOn) });
  return <>{`${written}, ${given}`}</>;
}
