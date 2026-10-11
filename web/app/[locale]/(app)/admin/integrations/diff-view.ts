import type { ChangeEntity, Payload, RunStatus, SyncChange } from "./ss12000-types";

/*
 * The diff review's arithmetic, apart from the dialog so it can be tested
 * without one.
 *
 * WHAT THE ADMIN CHOOSES IS WHAT IS APPLIED. Every change arrives with the
 * gateway's default (`selected`); the admin's ticks are kept as overrides,
 * and the apply sends exactly the difference: `select` for a change ticked
 * that was not chosen by default, `deselect` for one unticked that was
 * (ApplyRunDto). A change nobody touched keeps its default on both sides, so
 * the count the dialog shows is the count the gateway applies.
 *
 * A note (CONFLICT, INFO) is never selectable, and neither is a change
 * already applied (a night's auto-apply applies part of a run and leaves the
 * rest for the admin), nor anything of a run that is not DIFF_READY.
 */

export type Overrides = ReadonlyMap<string, boolean>;

export const isNote = (change: Pick<SyncChange, "op">) => change.op === "CONFLICT" || change.op === "INFO";

export function isSelectable(change: SyncChange, status: RunStatus): boolean {
  return status === "DIFF_READY" && !change.applied && !isNote(change);
}

export function isChosen(change: SyncChange, overrides: Overrides): boolean {
  return overrides.get(change.id) ?? change.selected;
}

/** The apply's body: what differs from the defaults, and nothing else. */
export function selectionBody(
  changes: SyncChange[],
  overrides: Overrides,
  status: RunStatus,
): { select: string[]; deselect: string[] } {
  const select: string[] = [];
  const deselect: string[] = [];
  for (const change of changes) {
    if (!isSelectable(change, status)) continue;
    const chosen = isChosen(change, overrides);
    if (chosen && !change.selected) select.push(change.id);
    if (!chosen && change.selected) deselect.push(change.id);
  }
  return { select, deselect };
}

export interface SelectionSummary {
  /** Changes the apply would make. */
  chosen: number;
  /** Changes the admin could choose. */
  selectable: number;
  /** Of the chosen, deactivations — what the gateway's brake counts. */
  deactivations: number;
  /** Of the chosen, a protected identity's (securityMarking at the source). */
  protectedChosen: number;
  /** Changes already applied by a night's auto-apply. */
  applied: number;
  /** Notes: conflicts and info, never applied. */
  notes: number;
}

export function summarise(changes: SyncChange[], overrides: Overrides, status: RunStatus): SelectionSummary {
  const summary: SelectionSummary = { chosen: 0, selectable: 0, deactivations: 0, protectedChosen: 0, applied: 0, notes: 0 };
  for (const change of changes) {
    if (change.applied) summary.applied += 1;
    if (isNote(change)) summary.notes += 1;
    if (!isSelectable(change, status)) continue;
    summary.selectable += 1;
    if (!isChosen(change, overrides)) continue;
    summary.chosen += 1;
    if (change.op === "DEACTIVATE") summary.deactivations += 1;
    if (change.protectedIdentity) summary.protectedChosen += 1;
  }
  return summary;
}

export interface ChangeFilter {
  entity: ChangeEntity | "ALL";
  /** Only conflicts, notes and protected identities. */
  attention: boolean;
}

export function matchesFilter(change: SyncChange, filter: ChangeFilter): boolean {
  if (filter.entity !== "ALL" && change.entity !== filter.entity) return false;
  if (filter.attention && !(isNote(change) || change.conflictCode !== null || change.protectedIdentity)) return false;
  return true;
}

/**
 * Ticks every selectable change in `rows` — the rows the dialog RENDERS, not
 * the whole filtered list behind "Visa fler" — on top of `overrides`.
 * Unticking clears them all. Ticking leaves out what the gateway flagged on
 * purpose: a protected identity, and any change with a code (a duty role
 * that would give a TEACHER login, a local edit, a relink, an invited
 * person's email): those are chosen one by one or not at all.
 */
export function withAll(overrides: Overrides, rows: SyncChange[], status: RunStatus, chosen: boolean): Map<string, boolean> {
  const next = new Map(overrides);
  for (const change of rows) {
    if (!isSelectable(change, status)) continue;
    if (chosen && (change.protectedIdentity || change.conflictCode !== null)) continue;
    next.set(change.id, chosen);
  }
  return next;
}

/** What a row is called when nothing names it: by what it is about. */
export function unknownSubjectKey(entity: ChangeEntity): "unknownPerson" | "unknownGroup" | "unknownOrganisation" {
  if (entity === "GROUP") return "unknownGroup";
  if (entity === "ORGANISATION") return "unknownOrganisation";
  return "unknownPerson";
}

// ---------------------------------------------------------------------------
// Reading a change
// ---------------------------------------------------------------------------

const text = (payload: Payload | null, key: string): string | null => {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
};

function fullName(payload: Payload | null): string | null {
  const first = text(payload, "firstName");
  const last = text(payload, "lastName");
  return first || last ? [first, last].filter(Boolean).join(" ") : null;
}

/**
 * Who each source id is, read off the run's own person rows (a CREATE's
 * after, a LINK's or DEACTIVATE's before) — the only place a name for a
 * person not yet in SchemaPro exists. A membership, a guardian link or a
 * duty names its person by id only.
 */
export function personNames(changes: SyncChange[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const change of changes) {
    if (change.entity !== "PERSON" || !change.externalId) continue;
    const name = fullName(change.after) ?? fullName(change.before);
    if (name && !names.has(change.externalId)) names.set(change.externalId, name);
  }
  return names;
}

export interface ChangeReading {
  /** Whom or what the change is about. */
  subject: string | null;
  /** The message key (integrations.review.detail.*) and its values. */
  detail: { key: string; values: Record<string, string> } | null;
}

/**
 * What a row says, as message keys and values: the dialog renders them, the
 * test reads them. `localName` resolves a SchemaPro user id (the register,
 * when the page has it); `names` is personNames() of the run. A run past
 * DIFF_READY has no payload left (before/after are nulled the moment it
 * leaves it), and its rows read by op and code alone.
 */
export function readChange(
  change: SyncChange,
  names: ReadonlyMap<string, string>,
  localName: (id: string) => string | null,
): ChangeReading {
  const before = change.before;
  const after = change.after;
  const byExternal = (id: unknown) => (typeof id === "string" ? (names.get(id) ?? null) : null);
  const byLocal = (id: unknown) => (typeof id === "string" ? localName(id) : null);
  const person =
    fullName(after) ??
    fullName(before) ??
    byExternal(change.externalId) ??
    byLocal(change.localId);

  switch (change.entity) {
    case "PERSON": {
      if (change.op === "UPDATE") {
        const fromEmail = text(before, "email");
        const toEmail = text(after, "email");
        if (fromEmail || toEmail) {
          return {
            subject: byLocal(change.localId) ?? byExternal(change.externalId),
            detail: { key: "emailChange", values: { from: fromEmail ?? "", to: toEmail ?? "" } },
          };
        }
        const from = fullName(before);
        const to = fullName(after);
        return { subject: from ?? person, detail: from && to ? { key: "nameChange", values: { from, to } } : null };
      }
      if (change.op === "DEACTIVATE") {
        const reason = text(after, "reason");
        return { subject: fullName(before) ?? person, detail: reason ? { key: `reason.${reason}`, values: {} } : null };
      }
      const role = text(after, "role") ?? text(before, "role");
      const email = text(after, "email") ?? text(before, "email");
      if (role && email) return { subject: person, detail: { key: "roleEmail", values: { role, email } } };
      if (role) return { subject: person, detail: { key: "role", values: { role } } };
      if (email) return { subject: person, detail: { key: "email", values: { email } } };
      return { subject: person, detail: null };
    }
    case "GROUP": {
      const name = text(after, "name") ?? text(before, "name");
      const from = text(before, "name");
      const to = text(after, "name");
      if (change.op === "UPDATE" && from && to) return { subject: from, detail: { key: "nameChange", values: { from, to } } };
      const kind = text(after, "kind") ?? text(before, "kind");
      return { subject: name, detail: kind ? { key: `kind.${kind}`, values: {} } : null };
    }
    case "CLASS_MEMBERSHIP": {
      const to = text(after, "groupName");
      const from = text(before, "groupName");
      if (change.op === "MOVE" && to) {
        return {
          subject: byExternal(change.externalId) ?? byLocal(change.localId),
          detail: from ? { key: "classMove", values: { from, to } } : { key: "classJoin", values: { to } },
        };
      }
      return { subject: byExternal(change.externalId) ?? byLocal(change.localId), detail: null };
    }
    case "GROUP_MEMBERSHIP": {
      const group = text(after, "groupName");
      return {
        subject: fullName(after) ?? byExternal(change.externalId) ?? byLocal(change.localId),
        detail: group ? { key: "group", values: { group } } : null,
      };
    }
    case "RESPONSIBLE": {
      const guardian =
        text(after, "guardianName") ?? byExternal(after?.["guardianExternalId"]) ?? byLocal(after?.["guardianLocalId"]);
      const pupil = byExternal(change.externalId) ?? byLocal(change.localId);
      return { subject: pupil, detail: guardian ? { key: "guardian", values: { guardian } } : null };
    }
    case "DUTY_LINK": {
      const holder = byExternal(after?.["personExternalId"]) ?? byLocal(after?.["userLocalId"]);
      const role = text(after, "dutyRole");
      const reason = text(after, "reason");
      if (reason) return { subject: holder, detail: { key: `reason.${reason}`, values: {} } };
      const start = text(after, "startDate") ?? "";
      const end = text(after, "endDate");
      if (!role) return { subject: holder, detail: null };
      return { subject: holder, detail: end ? { key: "dutyUntil", values: { role, start, end } } : { key: "duty", values: { role, start } } };
    }
    case "ORGANISATION": {
      const code = text(after, "schoolUnitCode");
      return { subject: text(after, "displayName"), detail: code ? { key: "unitCode", values: { code } } : null };
    }
  }
}

/** Pupils with a guardian link the source no longer names: their ids, for the people register's guardian dialog. */
export function endedGuardianLinks(changes: SyncChange[]): Array<{ pupilId: string; guardianName: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ pupilId: string; guardianName: string | null }> = [];
  for (const change of changes) {
    if (change.conflictCode !== "RESPONSIBLE_ENDED_AT_SOURCE" || !change.localId) continue;
    const key = `${change.localId}|${text(change.after, "guardianLocalId") ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pupilId: change.localId, guardianName: text(change.after, "guardianName") });
  }
  return out;
}
