/**
 * The Historik card's sentences (staffing Fas 3): one version of a tjänst as
 * "Tjänstgöringsgrad: 100 % → 80 %".
 *
 * The gateway hands each version over as a list of changed fields in a FIXED
 * order (src/staffing/employment-log-diff.ts) with the values as the database
 * row held them — numbers, strings, booleans, ids, null. This module turns a
 * value into words and nothing else: the labels come in from the caller
 * (next-intl), so the arithmetic is tested without a translator and the card
 * stays a list.
 *
 * A field this module does not know — a column added after Fas 3 — is still
 * shown, under its own name with its raw value: the history must not hide a
 * change because its reader is older than the write.
 */

import type { HistoryChange, HistoryEntry } from "@/lib/staffing-history-queries";

export interface HistoryLabels {
  /** The field's name in the card, or null when the catalogue has none. */
  field: (entity: HistoryEntry["entity"], field: string) => string | null;
  contract: (kind: string) => string;
  dutyKind: (kind: string) => string;
  subject: (id: string) => string | null;
  group: (id: string) => string | null;
  minutes: (minutes: number) => string;
  percent: (percent: string) => string;
  yes: string;
  no: string;
  /** The value of an empty field: "—". */
  empty: string;
  /** A subject or group id nobody can name any more. */
  removed: string;
  /** blockedConstraintId set. */
  blocked: string;
}

/** 66.667 → "66,667"; at most three decimals, as the percentages are stored. */
function decimal(value: number): string {
  return String(Math.round(value * 1000) / 1000).replace(".", ",");
}

export function formatHistoryValue(
  entity: HistoryEntry["entity"],
  field: string,
  value: unknown,
  labels: HistoryLabels,
): string {
  if (value === null || value === undefined || value === "") return labels.empty;
  switch (field) {
    case "employmentPercent":
    case "reductionPercent":
      return typeof value === "number" || typeof value === "string"
        ? labels.percent(decimal(Number(value)))
        : String(value);
    case "teachingTargetMinutesPerWeek":
    case "minutesPerWeek":
      return typeof value === "number" ? labels.minutes(value) : String(value);
    case "contractKind":
      return labels.contract(String(value));
    case "kind":
      return entity === "DUTY" ? labels.dutyKind(String(value)) : String(value);
    case "countsAsTeaching":
      return value === true ? labels.yes : value === false ? labels.no : String(value);
    case "subjectId":
      return labels.subject(String(value)) ?? labels.removed;
    case "studentGroupId":
      return labels.group(String(value)) ?? labels.removed;
    case "blockedConstraintId":
      return labels.blocked;
    default:
      return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
}

/**
 * One line per changed field. An UPDATE says before → after; a created row
 * states what it was created with and a deleted one what it had, so a
 * protokoll citing a version reads the whole row there.
 */
export function historyLines(entry: HistoryEntry, labels: HistoryLabels): string[] {
  return entry.changes.map((change: HistoryChange) => {
    const name = labels.field(entry.entity, change.field) ?? change.field;
    const before = formatHistoryValue(entry.entity, change.field, change.before, labels);
    const after = formatHistoryValue(entry.entity, change.field, change.after, labels);
    if (entry.action === "CREATE") return `${name}: ${after}`;
    if (entry.action === "DELETE") return `${name}: ${before}`;
    return `${name}: ${before} → ${after}`;
  });
}

/**
 * The uppdrag's own label, when the version carries it — every CREATE and
 * DELETE does, an UPDATE only when the label itself changed. The caller falls
 * back on the uppdrag as it stands today.
 */
export function dutyLabelOf(entry: HistoryEntry): string | null {
  if (entry.entity !== "DUTY") return null;
  const label = entry.changes.find((change) => change.field === "label");
  const value = label ? (entry.action === "DELETE" ? label.before : label.after) : null;
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Who wrote the version. Null is the seed, a migration or the database
 * owner — "System". An id the people list no longer holds is a user deleted
 * since, and is said so rather than shown as an id (C22).
 */
export function actorLabel(
  actorId: string | null,
  nameOf: (id: string) => string | null,
  labels: { system: string; deleted: string },
): string {
  if (actorId === null) return labels.system;
  return nameOf(actorId) ?? labels.deleted;
}

/** "2026-10-09 14:02" in the school's own time zone. */
export function formatStamp(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

/**
 * The version the uppdragsbeskrivning cites: the newest of the teacher's year,
 * post and uppdrag alike, since a tjänst is both. Null before the first write.
 */
export function latestVersion(
  entries: readonly HistoryEntry[] | undefined,
): { version: number; createdAt: string } | null {
  if (!entries || entries.length === 0) return null;
  const newest = entries.reduce((best, entry) => (entry.version > best.version ? entry : best));
  return { version: newest.version, createdAt: newest.createdAt };
}
