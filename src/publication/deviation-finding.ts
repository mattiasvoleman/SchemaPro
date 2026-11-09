import type { PrismaClient } from '@prisma/client';
import {
  DEVIATION_ROOM_LOCK,
  DEVIATION_SUBJECT_DAYS_APART,
  DEVIATION_SUBJECT_PER_DAY,
  DEVIATION_TEACHER_DAILY_CAP,
} from '../optimization/deviations';
import { asParams, entriesOf, type StoredConflict } from '../optimization/stored-conflicts';
import { TEACHER_WORK_DAYS_HIDDEN } from '../optimization/work-days';
import type { GateEntry, GateFinding } from './publication-gates';

/**
 * PUB_DEVIATIONS (Bästa möjliga schema): the timetable the grundschema holds
 * was applied from a candidate whose rules gave way, an administrator accepted
 * exactly that list, and no publication has followed.
 *
 * The acceptance is where the apply kept it: the REGENERATE entry of
 * ScheduleChangeLogs (ScheduleCandidatesService.apply), whose `after` carries
 * the accepted list, its digest and the moment. The finding looks at the
 * year's NEWEST entry of the two kinds that replace the draft whole, a
 * REGENERATE and a RESTORE, and only that one:
 *
 *   - a Generera run, or an apply of a candidate that broke nothing, after it
 *     replaced the timetable the deviations were in, so they are gone;
 *   - a RESTORE of a version (the apply's own safety version, say) did too;
 *   - a hand edit does not: a lesson moved by hand may or may not have undone
 *     a deviation, the log does not say, and the finding is a reminder of what
 *     the school accepted, not a proof of what the timetable still breaks. It
 *     says so by being a WARN the school can acknowledge, and by listing the
 *     accepted rules as they were.
 *
 * "NO PUBLICATION HAS FOLLOWED" is a publication that was made (PUBLISHED, and
 * of the kinds an administrator makes: PUBLISH, LEGACY_PUBLISH) after the
 * apply. The next publish is the moment the deviations reach the school's
 * calendar, which is what the finding stands in front of; once one has, the
 * school has seen the finding, acknowledged it or been refused by it, and does
 * not need it again. A REFILL and a BASELINE are the system's own copies of
 * what was already published and say nothing about the new timetable.
 *
 * NO PERSON, NO FIGURE OF A POST. The labels are built here, in the gate's
 * Swedish, from the accepted entries' code and scalar params: a requirement by
 * the name it had, a weekday, numbers. The log copy holds no teacher id, a cap
 * is not said with the teacher it belongs to, and a part-timer's days were
 * stored in the hidden form (TEACHER_WORK_DAYS_HIDDEN, deviations.ts) and are
 * listed as that: the gate is read by every administrator who publishes, with
 * or without HR-läs, and its findings are stored in the publication's log.
 */

const WEEKDAY = ['', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör', 'sön'];

const dayName = (day: unknown): string => (typeof day === 'number' ? (WEEKDAY[day] ?? `dag ${day}`) : '?');
const plural = (n: unknown, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One accepted deviation as the gate lists it, in Swedish and without a person. */
export function deviationLabel(entry: Partial<StoredConflict>): string {
  const p = asParams(entry.params) ?? {};
  switch (entry.code) {
    case DEVIATION_TEACHER_DAILY_CAP:
      return `En lärares tak per dag gav vika ${dayName(p['day'])}: ${p['taught']} min mot taket ${p['minutes']} min`;
    case DEVIATION_SUBJECT_PER_DAY:
      return `${p['requirement']}: ${plural(p['count'], 'lektion', 'lektioner')} ${dayName(p['day'])}, högst ${p['maxPerDay']} per dag`;
    case DEVIATION_SUBJECT_DAYS_APART:
      return `${p['requirement']}: lektioner ${plural(p['closest'], 'dag', 'dagar')} från varandra, regeln kräver minst ${p['minDaysBetween']}`;
    case DEVIATION_ROOM_LOCK:
      return `${p['requirement']}: ${p['lessons']} av ${p['of']} lektioner i ett rum utanför ämnets rum`;
    case TEACHER_WORK_DAYS_HIDDEN:
      return 'En lärares gräns för antal undervisningsdagar gav vika. Gränsen står i tjänsten och visas för rektor, fullständig administratör och den med HR-läs.';
    default:
      // A code this version does not know (a newer one wrote the entry): the
      // sentence it stored, in the engine's English.
      return typeof entry.message === 'string' ? entry.message : 'Ett avsteg från skolans regler';
  }
}

/** The kinds of publication an administrator makes. */
const MADE_BY_AN_ADMINISTRATOR = ['PUBLISH', 'LEGACY_PUBLISH'] as const;

export async function deviationsFinding(tx: PrismaClient, academicYearId: string): Promise<GateFinding> {
  const none: GateFinding = { code: 'PUB_DEVIATIONS', count: 0 };
  // The newest entry that replaced the draft whole. One row: a handful a year,
  // each one an administrator's deliberate act.
  const last = await tx.scheduleChangeLog.findFirst({
    where: { academicYearId, action: { in: ['REGENERATE', 'RESTORE'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { action: true, createdAt: true, after: true },
  });
  if (!last || last.action !== 'REGENERATE') return none;
  const after = (last.after ?? {}) as { source?: unknown; deviations?: unknown; deviationsDigest?: unknown };
  // Accepted, not merely present: a candidate's list reaches the entry with
  // its digest or not at all.
  if (after.source !== 'CANDIDATE' || typeof after.deviationsDigest !== 'string' || !Array.isArray(after.deviations)) return none;
  const deviations = entriesOf(after.deviations);
  if (deviations.length === 0) return none;

  const followed = await tx.timetablePublication.findFirst({
    where: {
      academicYearId,
      outcome: 'PUBLISHED',
      kind: { in: [...MADE_BY_AN_ADMINISTRATOR] },
      publishedAt: { gt: last.createdAt },
    },
    select: { id: true },
  });
  if (followed) return none;

  const entries: GateEntry[] = deviations.map((entry) => ({ label: deviationLabel(entry) }));
  return {
    code: 'PUB_DEVIATIONS',
    count: entries.length,
    entries,
    params: { appliedAt: last.createdAt.toISOString() },
  };
}
