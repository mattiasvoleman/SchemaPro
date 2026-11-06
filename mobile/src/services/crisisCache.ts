import { getCrisisList, saveCrisisList, whenDatabaseReady } from './database/localDatabase';
import { normalizeAlarms, withSentMarks, type MyCrisisResponse } from './crisis';
import type { PendingCrisisMark } from '../types';

/**
 * The last list the gateway gave a teacher, kept in the encrypted database so
 * the same list is there when the network is not (Krisläge, F2).
 *
 * One list per teacher (crisis_lists is keyed by teacher), so a shared tablet
 * never opens on a colleague's pupils; signing out clears it with the rest of
 * the cache (clearCachedSchoolData). A list the phone cannot read, from a
 * build whose shape has since changed, is none rather than a crash on the
 * screen that is needed most. A list kept by a build that did not yet know
 * "found with me" has no `foundHere`, no `foundFree` and no `away` in its
 * figures: they read as empty and nought. One kept by a build that held every
 * other pupil of the school (`others`) is read without them: the list is the
 * teacher's own groups and the pupils they found, and nothing of the school
 * beyond that is kept on the phone; the picker asks the gateway.
 */

export interface CachedCrisis {
  readonly response: MyCrisisResponse;
  /** When the gateway answered, which the screen shows as "Listan hämtades kl". */
  readonly asOf: string;
}

function parse(payload: string): MyCrisisResponse | null {
  try {
    const value = JSON.parse(payload) as Partial<MyCrisisResponse> | null;
    if (!value || typeof value.asOf !== 'string' || !Array.isArray(value.alarms)) return null;
    return { asOf: value.asOf, alarms: normalizeAlarms(value.alarms) };
  } catch {
    return null;
  }
}

export async function readCachedCrisis(teacherId: string): Promise<CachedCrisis | null> {
  // A tap on an alarm push can open this tab before the provider that opens the database has finished.
  await whenDatabaseReady();
  const row = await getCrisisList(teacherId);
  const response = row ? parse(row.payload) : null;
  return response ? { response, asOf: row!.asOf } : null;
}

export async function saveCachedCrisis(teacherId: string, response: MyCrisisResponse): Promise<void> {
  await saveCrisisList(teacherId, response.asOf, JSON.stringify(response));
}

/**
 * Writes marks the gateway has taken into the kept list, so that the list a
 * phone shows offline after them has them. The list's own time stays: it is
 * when the gateway last SAID this, and the screen says so.
 */
export async function patchCachedCrisis(teacherId: string, sent: readonly PendingCrisisMark[]): Promise<void> {
  const cached = await readCachedCrisis(teacherId);
  if (cached) await saveCachedCrisis(teacherId, withSentMarks(cached.response, sent));
}
