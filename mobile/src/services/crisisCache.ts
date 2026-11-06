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
 * "found with me" has neither `foundHere` nor `others`: they read as empty.
 *
 * The list is one JSON text per teacher, `others` included (every other pupil
 * of the school, a hundred bytes or so each: some hundred kilobytes for a
 * school of a thousand, once per alarm), so that the picker works without a
 * network. It is written whole each time the gateway answers; the kept list
 * needs no table of its own and no schema step, and the reading above is what
 * makes an older row safe.
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
