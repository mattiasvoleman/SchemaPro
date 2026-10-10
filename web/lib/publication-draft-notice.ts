import { api } from "@/lib/api";
import type { DraftState, PublicationSettings } from "@/lib/publication-types";
import { pendingCount } from "@/lib/publication-view";

/**
 * Whether the timetable an admin exports is an unpublished draft: the school
 * is in utkastläge and the year's grundschema differs from what is published.
 * The PDF and the calendar file then say "Utkast – ej publicerat", so a
 * printout of a draft cannot pass for the timetable teachers are reading.
 *
 * Fetched by the timetable's export buttons with import(), at the press: two
 * small reads that would otherwise sit in the route's first load. A read that
 * fails answers false — the export is the admin's to make, and in direct
 * mode, the default, there is no draft to mark.
 */
export async function draftPendingFor(academicYearId: string): Promise<boolean> {
  try {
    const settings = await api.get<PublicationSettings>("/api/v1/publication-settings");
    if (settings.publishMode !== "DRAFT") return false;
    const state = await api.get<DraftState>(`/api/v1/publications/state?academicYearId=${academicYearId}`);
    return pendingCount(state) > 0 || state.pendingRemovals > 0;
  } catch {
    return false;
  }
}
