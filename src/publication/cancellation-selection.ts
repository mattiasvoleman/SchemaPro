import { createHash } from 'node:crypto';
import { zonedTimeToUtc } from '../common/utils/time';
import { breakCoversGroup } from '../calendar/publish-days';

/**
 * WHICH LESSONS A BULK AVBOKNING TAKES.
 *
 * A row of the calendar is taken when it lies in the range (and the time
 * window, if one is given), belongs to the scope, and is still SCHEDULED, has
 * not begun and carries no attendance — the past is never rewritten, and a
 * lesson already cancelled or held is the school's record of what happened.
 * Everything else in the range and scope is counted by why it was left, so
 * the preview can say so.
 *
 * THE SCOPE is a class's or a group's, asked of every class on the lesson:
 *
 *   SCHOOL  every lesson;
 *   GRADES  a lesson any of whose classes has a year inside the span — the
 *           lov's own rule (publish-days.ts breakCoversGroup). A teaching
 *           group with no year of its own is NOT covered: erasing a lesson on
 *           a guess is the worse mistake, and those groups are named so the
 *           admin can add them by name;
 *   GROUPS  a lesson whose own group or an extra group is named.
 *
 * PURE: dates are 'YYYY-MM-DD', instants Date, the clock an argument.
 */

export interface SelectionCandidate {
  id: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  attendance: number;
  studentGroupId: string;
  gradeLevel: number | null;
  groupName: string;
  subjectName: string;
  extraGroups: { studentGroupId: string; gradeLevel: number | null }[];
  note: string | null;
}

export interface SelectionRule {
  scope: 'SCHOOL' | 'GRADES' | 'GROUPS';
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  groupIds: readonly string[];
  /** 'HH:MM' local, both or neither. */
  startTime: string | null;
  endTime: string | null;
  timezone: string;
  now: Date;
}

export interface SelectionOutcome {
  matched: SelectionCandidate[];
  excluded: { started: number; notScheduled: number; attendance: number };
  /** GRADES: groups on lessons in range that have no year, by name, once each. */
  ungradedGroups: string[];
}

export function inScope(candidate: SelectionCandidate, rule: SelectionRule): boolean | 'UNGRADED' {
  const groups = [
    { studentGroupId: candidate.studentGroupId, gradeLevel: candidate.gradeLevel },
    ...candidate.extraGroups,
  ];
  if (rule.scope === 'SCHOOL') return true;
  if (rule.scope === 'GROUPS') return groups.some((group) => rule.groupIds.includes(group.studentGroupId));
  const span = { minGradeLevel: rule.minGradeLevel, maxGradeLevel: rule.maxGradeLevel };
  if (groups.some((group) => group.gradeLevel !== null && breakCoversGroup(span, group.gradeLevel))) return true;
  return groups.every((group) => group.gradeLevel === null) ? 'UNGRADED' : false;
}

export function inWindow(candidate: SelectionCandidate, rule: SelectionRule): boolean {
  if (rule.startTime === null || rule.endTime === null) return true;
  const from = zonedTimeToUtc(candidate.date, rule.startTime, rule.timezone);
  const to = zonedTimeToUtc(candidate.date, rule.endTime, rule.timezone);
  return candidate.startsAt < to && from < candidate.endsAt;
}

export function selectLessons(candidates: readonly SelectionCandidate[], rule: SelectionRule): SelectionOutcome {
  const matched: SelectionCandidate[] = [];
  const excluded = { started: 0, notScheduled: 0, attendance: 0 };
  const ungraded = new Set<string>();
  for (const candidate of candidates) {
    if (!inWindow(candidate, rule)) continue;
    const scoped = inScope(candidate, rule);
    if (scoped === 'UNGRADED') {
      ungraded.add(candidate.groupName);
      continue;
    }
    if (!scoped) continue;
    if (candidate.status !== 'SCHEDULED') excluded.notScheduled++;
    else if (candidate.startsAt <= rule.now) excluded.started++;
    else if (candidate.attendance > 0) excluded.attendance++;
    else matched.push(candidate);
  }
  return { matched, excluded, ungradedGroups: [...ungraded].sort((a, b) => a.localeCompare(b, 'sv')) };
}

/** What a preview promised: the selection and exactly the rows it took. */
export function selectionDigest(rule: Omit<SelectionRule, 'now' | 'timezone'> & { fromDate: string; toDate: string; cause: string; name: string }, matched: readonly SelectionCandidate[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        rule.fromDate,
        rule.toDate,
        rule.scope,
        rule.minGradeLevel,
        rule.maxGradeLevel,
        [...rule.groupIds].sort(),
        rule.startTime,
        rule.endTime,
        rule.cause,
        rule.name,
        matched.map((row) => row.id).sort(),
      ]),
    )
    .digest('hex');
}
