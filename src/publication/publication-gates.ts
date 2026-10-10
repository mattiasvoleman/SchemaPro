/**
 * "FÅR PUBLICERAS": the named checks an admin sees before a publish.
 *
 * Each check reports what it found as a GateFinding; the school's policy
 * (PublicationSettings, migration 20261011090000) decides whether a finding
 * WARNs or REFUSEs. Every column defaults to WARN, and a WARN refuses
 * nothing — it asks for a deliberate "Publicera ändå" (acknowledgeWarnings) —
 * so a school that never opens the settings is refused nothing it can do
 * today. Two checks never follow the policy: PUB_CALENDAR_REFUSED is a
 * refusal the database already made in the dry run (fixed REFUSE), and the
 * INFO findings (nothing to publish, a range that replaces another cleanly)
 * are information and ask for nothing.
 *
 * PURE. The service collects the findings; this file settles them.
 */

export const GATE_CODES = [
  'PUB_CALENDAR_REFUSED',
  'PUB_CLASHES',
  'PUB_PARKED',
  'PUB_UNPLACED',
  'PUB_UNSTAFFED',
  'PUB_NO_TEACHER',
  'PUB_NO_ROOM',
  'PUB_STAFFING_REFUSE',
  'PUB_TIMPLAN',
  'PUB_RANGE_OVERLAP',
  'PUB_RANGE_GAP',
  'PUB_WEEK_SPLIT',
  'PUB_DAY_OPS_LOST',
  'PUB_FROM_IN_PAST',
  'PUB_LUNCH_NOT_SET',
  'PUB_NOTHING_TO_PUBLISH',
] as const;
export type GateCode = (typeof GATE_CODES)[number];

export type GateMode = 'WARN' | 'REFUSE';
export type GateSeverity = 'INFO' | 'WARN' | 'REFUSE';

/** The policy columns, as PublicationSettings names them. */
export interface GatePolicy {
  gateClashes: GateMode;
  gateParked: GateMode;
  gateUnplaced: GateMode;
  gateUnstaffed: GateMode;
  gateMissingTeacher: GateMode;
  gateMissingRoom: GateMode;
  gateStaffing: GateMode;
  gateTimplan: GateMode;
  gateOverlap: GateMode;
  gatePast: GateMode;
  gateLunch: GateMode;
  gateWeekSplit: GateMode;
  gateGap: GateMode;
  gateDayOpsLost: GateMode;
}

export const GATE_POLICY_KEYS = [
  'gateClashes',
  'gateParked',
  'gateUnplaced',
  'gateUnstaffed',
  'gateMissingTeacher',
  'gateMissingRoom',
  'gateStaffing',
  'gateTimplan',
  'gateOverlap',
  'gatePast',
  'gateLunch',
  'gateWeekSplit',
  'gateGap',
  'gateDayOpsLost',
] as const satisfies readonly (keyof GatePolicy)[];

/** No row: every check WARNs. */
export const DEFAULT_GATE_POLICY: GatePolicy = Object.fromEntries(
  GATE_POLICY_KEYS.map((key) => [key, 'WARN']),
) as unknown as GatePolicy;

/** Which policy column a check follows; null = never the policy's to decide. */
export const GATE_COLUMN: Record<GateCode, keyof GatePolicy | null> = {
  PUB_CALENDAR_REFUSED: null,
  PUB_CLASHES: 'gateClashes',
  PUB_PARKED: 'gateParked',
  PUB_UNPLACED: 'gateUnplaced',
  PUB_UNSTAFFED: 'gateUnstaffed',
  PUB_NO_TEACHER: 'gateMissingTeacher',
  PUB_NO_ROOM: 'gateMissingRoom',
  PUB_STAFFING_REFUSE: 'gateStaffing',
  PUB_TIMPLAN: 'gateTimplan',
  PUB_RANGE_OVERLAP: 'gateOverlap',
  PUB_RANGE_GAP: 'gateGap',
  PUB_WEEK_SPLIT: 'gateWeekSplit',
  PUB_DAY_OPS_LOST: 'gateDayOpsLost',
  PUB_FROM_IN_PAST: 'gatePast',
  PUB_LUNCH_NOT_SET: 'gateLunch',
  PUB_NOTHING_TO_PUBLISH: null,
};

/** One thing a check names: a lesson, a requirement, a teacher, a date range. */
export interface GateEntry {
  /** What the admin reads: "Matematik · 7B, mån 08:00", never a pupil. */
  label: string;
  masterLessonId?: string;
  requirementId?: string;
  teacherId?: string;
  calendarLessonId?: string;
  from?: string;
  to?: string;
}

export interface GateFinding {
  code: GateCode;
  count: number;
  entries?: GateEntry[];
  params?: Record<string, string | number>;
  /** Information only: shown, never asked about. */
  info?: boolean;
}

export interface GateItem {
  code: GateCode;
  severity: GateSeverity;
  count: number;
  /** At most MAX_GATE_ENTRIES; `count` says how many there were. */
  items: GateEntry[];
  params: Record<string, string | number>;
}

export const MAX_GATE_ENTRIES = 20;

const ORDER = new Map<GateCode, number>(GATE_CODES.map((code, index) => [code, index]));
const SEVERITY_ORDER: Record<GateSeverity, number> = { REFUSE: 0, WARN: 1, INFO: 2 };

/**
 * The findings, settled by the policy: REFUSE first, then WARN, then INFO,
 * each in GATE_CODES order. A finding with nothing in it (count 0) is
 * dropped — a check that found nothing has nothing to say.
 */
export function settleGates(findings: readonly GateFinding[], policy: GatePolicy): GateItem[] {
  const items: GateItem[] = [];
  for (const finding of findings) {
    if (finding.count <= 0) continue;
    const column = GATE_COLUMN[finding.code];
    const severity: GateSeverity = finding.info
      ? 'INFO'
      : column === null
        ? finding.code === 'PUB_CALENDAR_REFUSED'
          ? 'REFUSE'
          : 'INFO'
        : policy[column];
    items.push({
      code: finding.code,
      severity,
      count: finding.count,
      items: (finding.entries ?? []).slice(0, MAX_GATE_ENTRIES),
      params: finding.params ?? {},
    });
  }
  return items.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (ORDER.get(a.code) ?? 0) - (ORDER.get(b.code) ?? 0),
  );
}

export interface GateVerdict {
  refused: boolean;
  /** At least one WARN: publishing needs acknowledgeWarnings. */
  needsAcknowledgement: boolean;
}

export function gateVerdict(items: readonly GateItem[]): GateVerdict {
  return {
    refused: items.some((item) => item.severity === 'REFUSE'),
    needsAcknowledgement: items.some((item) => item.severity === 'WARN'),
  };
}

/** Whether the school has set any check to REFUSE: the legacy publish asks only then. */
export function refusesAnything(policy: GatePolicy): boolean {
  return GATE_POLICY_KEYS.some((key) => policy[key] === 'REFUSE');
}
