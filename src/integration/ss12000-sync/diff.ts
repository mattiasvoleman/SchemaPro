import type { FetchedRoster } from './fetch-plan';
import { activeOn, isProtected, type DutyRole, type S1Duty, type S1Group, type S1Person } from './s1';

/*
 * The dry-run diff: what applying the source's roster would change in the
 * school, change by change, and what it cannot change and why. Pure — no
 * database, no clock but `today` — so every rule is a table test
 * (diff.spec.ts). The rules are the design's §2.4 as amended by its review
 * (A1.11–A1.13, A2, A4); in short:
 *
 * MATCHING. A stored ss12000Id is always matched first. Without one, a LINK
 * is proposed only when exactly one ACTIVE local row has the address
 * (case-insensitively), its role is the one the source implies, and exactly
 * one source person in the run claims the address; a group LINK needs the
 * same name, the active läsår and the same kind. Otherwise a conflict:
 * PERSON_AMBIGUOUS_MATCH, PERSON_ROLE_MISMATCH, PERSON_EMAIL_TAKEN, or
 * PERSON_MATCHES_INACTIVE with a deselected RELINK (link and reactivate a
 * deactivated row on purpose, as when the register merged two duplicates).
 * Never by name for a person.
 *
 * ROLES are derived only for a CREATE: an active enrolment at the source's
 * skolenhet on T -> STUDENT; an active Duty there -> TEACHER (Lärare,
 * Förstelärare, Speciallärare/specialpedagog selected; Lärarassistent,
 * Fritidspedagog, Förskollärare deselected for review, DUTY_ROLE_REVIEW,
 * since a TEACHER login reaches pupils' data; every other DutyRole
 * DUTY_NON_TEACHING_ROLE, deselected); named in an active pupil's
 * responsibles -> GUARDIAN. Two at once is PERSON_MULTIPLE_ROLES. A
 * linked person's role is never changed, and a SCHOOL_ADMIN is only ever
 * linked, never updated, moved or deactivated.
 *
 * PROTECTED IDENTITY. Every change touching a person whose securityMarking
 * (on Person or on a PersonReference) is not "Ingen" is deselected and never
 * auto-applied; the flag goes with the run's minimisation and is never
 * stored on the person.
 *
 * DEACTIVATE, of a linked person only: a FULL run that no longer finds them
 * (a pupil not returned by the enrolment fetch, staff with no active duty, a
 * guardian no active pupil names), deletedEntities, every enrolment at the
 * skolenhet ended, or personStatus Avliden / Utvandrad. Staff deactivation
 * is never automatic. REACTIVATE only undoes a deactivation an applied sync
 * made; one an admin made is PERSON_DEACTIVATED_LOCALLY.
 *
 * LOCAL EDITS WIN. A name or class that differs while the row was edited
 * after the source's last apply (updatedAt > lastAppliedAt) is
 * LOCAL_EDIT_SINCE_LAST_SYNC: deselected and never auto-applied, so the
 * nightly run does not revert an admin's move.
 *
 * GROUPS map to the läsår containing T when active on T, else the one
 * containing their startDate; nothing is written into a year that is not
 * the active one, and a span over several years is GROUP_SPANS_YEARS. A
 * class move goes through the role-guarded write, so P4's trigger records
 * it (dated the school's local today: a past startDate at the source is not
 * backdated).
 *
 * NOTHING IS DELETED. A teaching-group membership or a guardian link that
 * ended at the source is MEMBERSHIP_ENDED_AT_SOURCE / RESPONSIBLE_ENDED_AT_SOURCE
 * for the admin; a guardian with no active child left is deactivated
 * instead; a duty link that ended gets endedAt.
 */

export type LocalRole = 'STUDENT' | 'TEACHER' | 'SCHOOL_ADMIN' | 'GUARDIAN';
export type ChangeEntity = 'PERSON' | 'GROUP' | 'CLASS_MEMBERSHIP' | 'GROUP_MEMBERSHIP' | 'RESPONSIBLE' | 'DUTY_LINK' | 'ORGANISATION';
export type ChangeOp = 'CREATE' | 'LINK' | 'RELINK' | 'UPDATE' | 'MOVE' | 'DEACTIVATE' | 'REACTIVATE' | 'ADD' | 'END' | 'CONFLICT' | 'INFO';

export interface LocalUser {
  id: string;
  role: LocalRole;
  firstName: string;
  lastName: string;
  email: string;
  isActive: boolean;
  studentGroupId: string | null;
  ss12000Id: string | null;
  invited: boolean;
  updatedAt: Date;
  /** Inactive because an applied sync change deactivated them, and untouched since. */
  deactivatedBySync: boolean;
}

export interface LocalGroup {
  id: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  academicYearId: string;
  gradeLevel: number | null;
  ss12000Id: string | null;
  updatedAt: Date;
}

export interface LocalYear {
  id: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
}

export interface LocalDutyLink {
  id: string;
  userId: string;
  academicYearId: string;
  ss12000DutyId: string;
  dutyRole: string;
  startDate: string;
  endDate: string | null;
  ended: boolean;
}

export interface LocalSlice {
  schoolName: string;
  users: LocalUser[];
  groups: LocalGroup[];
  teachingMembers: Array<{ studentGroupId: string; studentId: string }>;
  guardianLinks: Array<{ guardianId: string; studentId: string; origin: 'MANUAL' | 'SS12000' }>;
  dutyLinks: LocalDutyLink[];
  years: LocalYear[];
  lastAppliedAt: Date | null;
}

export interface ProposedChange {
  entity: ChangeEntity;
  op: ChangeOp;
  externalId: string | null;
  localId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  conflictCode: string | null;
  selected: boolean;
  autoApplicable: boolean;
  protectedIdentity: boolean;
}

export type DiffCounts = Record<string, Record<string, number>>;

export interface DiffResult {
  changes: ProposedChange[];
  counts: DiffCounts;
  /** A FULL fetch that returned no pupils (or no staff) while linked ones exist: no diff. */
  sourceEmpty: 'PUPILS' | 'STAFF' | null;
}

export interface DiffInput {
  roster: FetchedRoster;
  local: LocalSlice;
  today: string;
  organisationIds: string[];
}

/** Duty roles a TEACHER row is created for and selected. */
export const TEACHING_DUTY_ROLES: readonly DutyRole[] = ['Lärare', 'Förstelärare', 'Speciallärare/specialpedagog'];
/** Duty roles a TEACHER row is proposed for, deselected for review. */
export const REVIEW_DUTY_ROLES: readonly DutyRole[] = ['Lärarassistent', 'Fritidspedagog', 'Förskollärare'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Plan = { localId: string | null; role: LocalRole; linked: boolean };
type GroupPlan = { localId: string | null; name: string; kind: 'CLASS' | 'TEACHING_GROUP'; linked: boolean };

/** The email SchemaPro would store for a person in `role`, per S1 Email.type; null when none. */
export function pickEmail(person: S1Person, role: LocalRole): string | null {
  const wanted = role === 'STUDENT' ? 'Skola elev' : role === 'GUARDIAN' ? 'Privat' : 'Skola personal';
  const typed = person.emails.find((email) => email.type === wanted)?.value;
  // The first EPPN is the fallback for pupils and staff only: a guardian's
  // school-issued identity is not where their mail goes.
  const fallback = role === 'GUARDIAN' ? undefined : person.eduPersonPrincipalNames[0];
  const chosen = (typed ?? fallback ?? '').trim().toLowerCase();
  return EMAIL.test(chosen) && chosen.length <= 254 ? chosen : null;
}

function dutyClass(roles: DutyRole[]): 'TEACHING' | 'REVIEW' | 'NON_TEACHING' {
  if (roles.some((role) => TEACHING_DUTY_ROLES.includes(role))) return 'TEACHING';
  if (roles.some((role) => REVIEW_DUTY_ROLES.includes(role))) return 'REVIEW';
  return 'NON_TEACHING';
}

function yearContaining(years: LocalYear[], day: string): LocalYear | null {
  return years.find((year) => year.startDate <= day && day <= year.endDate) ?? null;
}

function mostCommonLowest(values: number[]): number | null {
  if (values.length === 0) return null;
  const tally = new Map<number, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
}

export function computeDiff(input: DiffInput): DiffResult {
  const { roster, local, today } = input;
  const orgs = new Set(input.organisationIds);
  const changes: ProposedChange[] = [];
  const counts: DiffCounts = {};
  const bump = (entity: string, key: string, by = 1) => {
    counts[entity] ??= {};
    counts[entity]![key] = (counts[entity]![key] ?? 0) + by;
  };
  const push = (change: ProposedChange) => {
    // A note is never selected or applied; a protected person's change is never automatic.
    if (change.op === 'CONFLICT' || change.op === 'INFO') {
      change.selected = false;
      change.autoApplicable = false;
    }
    if (change.protectedIdentity) {
      change.selected = false;
      change.autoApplicable = false;
    }
    changes.push(change);
    bump(change.entity, change.op);
    if (change.conflictCode) bump('codes', change.conflictCode);
  };
  const note = (
    entity: ChangeEntity,
    op: 'CONFLICT' | 'INFO',
    code: string,
    externalId: string | null,
    localId: string | null = null,
    after: Record<string, unknown> | null = null,
    protectedIdentity = false,
  ) =>
    push({ entity, op, externalId, localId, before: null, after, conflictCode: code, selected: false, autoApplicable: false, protectedIdentity });

  const full = roster.mode === 'FULL';
  const lastApplied = local.lastAppliedAt?.getTime() ?? null;
  const editedLocally = (updatedAt: Date) => lastApplied !== null && updatedAt.getTime() > lastApplied;
  const activeYear = local.years.find((year) => year.isActive) ?? null;

  // ---------------------------------------------------------------------
  // Local indexes
  // ---------------------------------------------------------------------
  const usersById = new Map(local.users.map((user) => [user.id, user]));
  const usersByExt = new Map<string, LocalUser>();
  const usersByEmail = new Map<string, LocalUser[]>();
  for (const user of local.users) {
    if (user.ss12000Id) usersByExt.set(user.ss12000Id, user);
    const key = user.email.trim().toLowerCase();
    usersByEmail.set(key, [...(usersByEmail.get(key) ?? []), user]);
  }
  const groupsByExt = new Map<string, LocalGroup>();
  for (const group of local.groups) if (group.ss12000Id) groupsByExt.set(group.ss12000Id, group);
  const linksOf = new Set(local.guardianLinks.map((link) => `${link.guardianId}|${link.studentId}`));
  const membersOf = new Set(local.teachingMembers.map((member) => `${member.studentGroupId}|${member.studentId}`));

  // ---------------------------------------------------------------------
  // Source facts
  // ---------------------------------------------------------------------
  const persons = roster.persons;
  bump('PERSON', 'fetched', persons.size);
  bump('GROUP', 'fetched', roster.groups.length);
  bump('DUTY_LINK', 'fetched', roster.duties.length);

  const enrolmentsHere = (person: S1Person) => person.enrolments.filter((e) => orgs.has(e.organisationId) && !e.cancelled);
  const activeEnrolment = (person: S1Person) => enrolmentsHere(person).find((e) => activeOn(today, e.startDate, e.endDate)) ?? null;
  const activePupils = new Set([...persons.values()].filter((p) => activeEnrolment(p) !== null).map((p) => p.id));

  const activeDuties = new Map<string, S1Duty[]>();
  for (const duty of roster.duties) {
    if (!duty.personId || !orgs.has(duty.organisationId) || !activeOn(today, duty.startDate, duty.endDate)) continue;
    activeDuties.set(duty.personId, [...(activeDuties.get(duty.personId) ?? []), duty]);
  }

  const guardianOf = new Map<string, Array<{ pupilId: string; relationType: string | null }>>();
  const protectedIds = new Set<string>();
  for (const person of persons.values()) {
    if (isProtected(person.securityMarking)) protectedIds.add(person.id);
    if (!activePupils.has(person.id)) continue;
    for (const responsible of person.responsibles) {
      if (isProtected(responsible.securityMarking)) protectedIds.add(responsible.personId);
      guardianOf.set(responsible.personId, [
        ...(guardianOf.get(responsible.personId) ?? []),
        { pupilId: person.id, relationType: responsible.relationType },
      ]);
    }
  }
  for (const group of roster.groups) {
    for (const membership of group.memberships) if (isProtected(membership.personSecurityMarking)) protectedIds.add(membership.personId);
  }

  const deletedPersons = new Set(roster.deleted?.persons ?? []);
  const deletedGroups = new Set(roster.deleted?.groups ?? []);
  const deletedDuties = new Set(roster.deleted?.duties ?? []);

  // ---------------------------------------------------------------------
  // A3.4: an empty FULL fetch produces no diff.
  // ---------------------------------------------------------------------
  if (full) {
    const linkedActive = (role: LocalRole) => local.users.some((u) => u.ss12000Id && u.isActive && u.role === role);
    // What the fetch itself returned, not what a lookup filled in afterwards:
    // a changed client scope answers the list with nothing, and a lookup of
    // the people a group names would otherwise hide it.
    if (roster.enrolmentIds.size === 0 && linkedActive('STUDENT')) return { changes: [], counts, sourceEmpty: 'PUPILS' };
    if (roster.duties.length === 0 && roster.dutyPersonIds.size === 0 && linkedActive('TEACHER')) {
      return { changes: [], counts, sourceEmpty: 'STAFF' };
    }
  }

  const derivedRoles = (id: string): LocalRole[] => {
    const roles: LocalRole[] = [];
    if (activePupils.has(id)) roles.push('STUDENT');
    if (activeDuties.has(id)) roles.push('TEACHER');
    if (guardianOf.has(id)) roles.push('GUARDIAN');
    return roles;
  };

  // ---------------------------------------------------------------------
  // Persons: create, link, update, reactivate
  // ---------------------------------------------------------------------
  const plans = new Map<string, Plan>();
  for (const user of local.users) if (user.ss12000Id) plans.set(user.ss12000Id, { localId: user.id, role: user.role, linked: true });

  const inScope = [...persons.values()]
    .filter((person) => derivedRoles(person.id).length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Who claims which address in this run, among the unlinked: two claims is ambiguity.
  const claims = new Map<string, number>();
  for (const person of inScope) {
    if (usersByExt.has(person.id)) continue;
    const roles = derivedRoles(person.id);
    const email = pickEmail(person, roles[0]!);
    if (email) claims.set(email, (claims.get(email) ?? 0) + 1);
  }

  for (const person of persons.values()) {
    if (!usersByExt.has(person.id) && derivedRoles(person.id).length === 0) {
      const future = enrolmentsHere(person).some((e) => e.startDate > today);
      if (future) note('PERSON', 'INFO', 'PERSON_NOT_YET_ENROLLED', person.id);
    }
  }

  for (const person of inScope) {
    const roles = derivedRoles(person.id);
    const isProt = protectedIds.has(person.id);
    const linked = usersByExt.get(person.id);
    const gone = person.personStatus === 'Avliden' || person.personStatus === 'Utvandrad';
    const display = { firstName: person.givenName, lastName: person.familyName, middleName: person.middleName };

    if (deletedPersons.has(person.id)) note('PERSON', 'INFO', 'DELETED_BUT_RETURNED', person.id, linked?.id ?? null);

    if (linked) {
      if (linked.role === 'SCHOOL_ADMIN') continue;
      if (!roles.includes(linked.role)) {
        note('PERSON', 'INFO', 'PERSON_ROLE_MISMATCH', person.id, linked.id, { role: roles[0] }, isProt);
      }
      if (!linked.isActive) {
        if (gone) continue;
        if (linked.deactivatedBySync) {
          push({
            entity: 'PERSON', op: 'REACTIVATE', externalId: person.id, localId: linked.id,
            before: { isActive: false, ...display }, after: { isActive: true },
            conflictCode: null, selected: true, autoApplicable: false, protectedIdentity: isProt,
          });
        } else {
          note('PERSON', 'CONFLICT', 'PERSON_DEACTIVATED_LOCALLY', person.id, linked.id, display, isProt);
        }
        continue;
      }
      if (linked.firstName !== person.givenName || linked.lastName !== person.familyName) {
        const localEdit = editedLocally(linked.updatedAt);
        push({
          entity: 'PERSON', op: 'UPDATE', externalId: person.id, localId: linked.id,
          before: { firstName: linked.firstName, lastName: linked.lastName },
          after: { firstName: person.givenName, lastName: person.familyName, middleName: person.middleName },
          conflictCode: localEdit ? 'LOCAL_EDIT_SINCE_LAST_SYNC' : null,
          selected: !localEdit, autoApplicable: !localEdit, protectedIdentity: isProt,
        });
      }
      const email = pickEmail(person, linked.role);
      if (email && email !== linked.email.trim().toLowerCase()) {
        const holders = (usersByEmail.get(email) ?? []).filter((u) => u.id !== linked.id);
        if (holders.length > 0) {
          note('PERSON', 'CONFLICT', 'PERSON_EMAIL_TAKEN', person.id, linked.id, { email }, isProt);
        } else {
          push({
            entity: 'PERSON', op: 'UPDATE', externalId: person.id, localId: linked.id,
            before: { email: linked.email }, after: { email },
            conflictCode: linked.invited ? 'PERSON_EMAIL_CHANGE_INVITED' : null,
            selected: !linked.invited, autoApplicable: false, protectedIdentity: isProt,
          });
        }
      }
      continue;
    }

    if (gone) continue;
    // Unlinked: who would they be here?
    const primary: LocalRole = roles[0]!;
    const multiple = roles.length > 1;
    const email = pickEmail(person, primary);
    if (!email) {
      note('PERSON', 'CONFLICT', 'PERSON_NO_EMAIL', person.id, null, { role: primary, ...display }, isProt);
      continue;
    }
    const matches = usersByEmail.get(email) ?? [];
    if (matches.length > 0) {
      if (matches.some((u) => u.ss12000Id && u.ss12000Id !== person.id)) {
        note('PERSON', 'CONFLICT', 'PERSON_EMAIL_TAKEN', person.id, null, { email, role: primary, ...display }, isProt);
        continue;
      }
      if (matches.length > 1 || (claims.get(email) ?? 0) > 1) {
        note('PERSON', 'CONFLICT', 'PERSON_AMBIGUOUS_MATCH', person.id, null, { email, role: primary, ...display }, isProt);
        continue;
      }
      const match = matches[0]!;
      const sameRole = match.role === primary || (match.role === 'SCHOOL_ADMIN' && primary === 'TEACHER');
      if (!sameRole) {
        note('PERSON', 'CONFLICT', 'PERSON_ROLE_MISMATCH', person.id, match.id, { email, role: primary, localRole: match.role, ...display }, isProt);
        continue;
      }
      if (!match.isActive) {
        push({
          entity: 'PERSON', op: 'RELINK', externalId: person.id, localId: match.id,
          before: { isActive: false, firstName: match.firstName, lastName: match.lastName, email: match.email },
          after: { ss12000Id: person.id, isActive: true, ...display },
          conflictCode: 'PERSON_MATCHES_INACTIVE', selected: false, autoApplicable: false, protectedIdentity: isProt,
        });
        plans.set(person.id, { localId: match.id, role: match.role, linked: false });
        continue;
      }
      push({
        entity: 'PERSON', op: 'LINK', externalId: person.id, localId: match.id,
        before: { firstName: match.firstName, lastName: match.lastName, email: match.email, role: match.role },
        after: { ss12000Id: person.id, ...display },
        conflictCode: match.role === 'SCHOOL_ADMIN' ? 'PERSON_ADMIN_UNTOUCHED' : multiple ? 'PERSON_MULTIPLE_ROLES' : null,
        selected: true, autoApplicable: false, protectedIdentity: isProt,
      });
      plans.set(person.id, { localId: match.id, role: match.role, linked: false });
      if (match.role !== 'SCHOOL_ADMIN' && (match.firstName !== person.givenName || match.lastName !== person.familyName)) {
        push({
          entity: 'PERSON', op: 'UPDATE', externalId: person.id, localId: match.id,
          before: { firstName: match.firstName, lastName: match.lastName },
          after: { firstName: person.givenName, lastName: person.familyName, middleName: person.middleName },
          conflictCode: null, selected: true, autoApplicable: false, protectedIdentity: isProt,
        });
      }
      continue;
    }
    if ((claims.get(email) ?? 0) > 1) {
      note('PERSON', 'CONFLICT', 'PERSON_EMAIL_TAKEN', person.id, null, { email, role: primary, ...display }, isProt);
      continue;
    }
    let code: string | null = multiple ? 'PERSON_MULTIPLE_ROLES' : null;
    let selected = !multiple;
    if (primary === 'TEACHER') {
      const kind = dutyClass((activeDuties.get(person.id) ?? []).map((duty) => duty.dutyRole));
      if (kind === 'REVIEW') {
        code ??= 'DUTY_ROLE_REVIEW';
        selected = false;
      } else if (kind === 'NON_TEACHING') {
        code ??= 'DUTY_NON_TEACHING_ROLE';
        selected = false;
      }
    }
    push({
      entity: 'PERSON', op: 'CREATE', externalId: person.id, localId: null,
      before: null,
      after: { role: primary, firstName: person.givenName, lastName: person.familyName, middleName: person.middleName, email },
      conflictCode: code, selected, autoApplicable: false, protectedIdentity: isProt,
    });
    plans.set(person.id, { localId: null, role: primary, linked: false });
  }

  // ---------------------------------------------------------------------
  // Deactivation of linked people (never a SCHOOL_ADMIN)
  // ---------------------------------------------------------------------
  for (const user of [...local.users].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!user.ss12000Id || !user.isActive || user.role === 'SCHOOL_ADMIN') continue;
    const ext = user.ss12000Id;
    const record = persons.get(ext);
    let reason: string | null = null;
    if (deletedPersons.has(ext) && !record) reason = 'DELETED_AT_SOURCE';
    else if (record && (record.personStatus === 'Avliden' || record.personStatus === 'Utvandrad')) reason = 'PERSON_STATUS';
    else if (record && user.role === 'STUDENT' && enrolmentsHere(record).length > 0 && enrolmentsHere(record).every((e) => e.endDate !== null && e.endDate < today)) {
      reason = 'ENROLMENT_ENDED';
    } else if (full) {
      const present =
        user.role === 'STUDENT'
          ? roster.enrolmentIds.has(ext) || activePupils.has(ext)
          : user.role === 'TEACHER'
            ? activeDuties.has(ext) || roster.dutyPersonIds.has(ext)
            : guardianOf.has(ext);
      if (!present) reason = user.role === 'GUARDIAN' ? 'NO_ACTIVE_CHILD' : 'ABSENT_FROM_SOURCE';
    }
    if (!reason) continue;
    push({
      entity: 'PERSON', op: 'DEACTIVATE', externalId: ext, localId: user.id,
      before: { isActive: true, firstName: user.firstName, lastName: user.lastName, role: user.role },
      after: { isActive: false, reason },
      conflictCode: null, selected: true,
      // Staff are never deactivated automatically: a wrong end date at the
      // source would lock a teacher out the next morning.
      autoApplicable: user.role === 'STUDENT' || user.role === 'GUARDIAN',
      protectedIdentity: protectedIds.has(ext),
    });
  }
  const deactivating = new Set(changes.filter((c) => c.op === 'DEACTIVATE').map((c) => c.localId));

  // ---------------------------------------------------------------------
  // Groups
  // ---------------------------------------------------------------------
  const groupPlans = new Map<string, GroupPlan>();
  for (const group of local.groups) {
    if (group.ss12000Id && activeYear && group.academicYearId === activeYear.id) {
      groupPlans.set(group.ss12000Id, { localId: group.id, name: group.name, kind: group.kind, linked: true });
    }
  }
  const groupYear = new Map<string, LocalYear | null>();
  const supported = roster.groups.filter((group) => group.groupType === 'Klass' || group.groupType === 'Undervisning');
  bump('GROUP', 'unsupportedType', roster.groups.length - supported.length);
  for (const group of [...supported].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!orgs.has(group.organisationId)) {
      bump('GROUP', 'otherOrganisation');
      continue;
    }
    const kind = group.groupType === 'Klass' ? 'CLASS' : 'TEACHING_GROUP';
    const anchor = activeOn(today, group.startDate, group.endDate) ? today : group.startDate;
    const year = yearContaining(local.years, anchor);
    groupYear.set(group.id, year);
    const linked = groupsByExt.get(group.id);
    if (deletedGroups.has(group.id)) note('GROUP', 'INFO', 'DELETED_BUT_RETURNED', group.id, linked?.id ?? null);
    if (!year) {
      note('GROUP', 'INFO', 'GROUP_OUTSIDE_YEARS', group.id, linked?.id ?? null, { name: group.displayName });
      continue;
    }
    if (group.startDate < year.startDate || (group.endDate ?? '9999-12-31') > year.endDate) {
      note('GROUP', 'INFO', 'GROUP_SPANS_YEARS', group.id, linked?.id ?? null, { name: group.displayName, academicYearId: year.id });
    }
    if (!year.isActive) {
      bump('GROUP', year.startDate > today ? 'futureYear' : 'pastYear');
      continue;
    }
    if (linked) {
      if (linked.academicYearId !== year.id) {
        note('GROUP', 'CONFLICT', 'GROUP_YEAR_CHANGED', group.id, linked.id, { name: group.displayName, academicYearId: year.id });
        continue;
      }
      if (linked.kind !== kind) {
        note('GROUP', 'CONFLICT', 'GROUP_KIND_MISMATCH', group.id, linked.id, { name: group.displayName, kind });
        continue;
      }
      if (linked.name !== group.displayName) {
        const clash = local.groups.some((g) => g.id !== linked.id && g.academicYearId === year.id && g.name === group.displayName);
        if (clash) note('GROUP', 'CONFLICT', 'GROUP_NAME_TAKEN', group.id, linked.id, { name: group.displayName });
        else
          push({
            entity: 'GROUP', op: 'UPDATE', externalId: group.id, localId: linked.id,
            before: { name: linked.name }, after: { name: group.displayName },
            conflictCode: null, selected: true, autoApplicable: false, protectedIdentity: false,
          });
      }
      continue;
    }
    const sameName = local.groups.filter((g) => g.academicYearId === year.id && g.name === group.displayName);
    if (sameName.length === 1 && !sameName[0]!.ss12000Id && sameName[0]!.kind === kind) {
      const match = sameName[0]!;
      push({
        entity: 'GROUP', op: 'LINK', externalId: group.id, localId: match.id,
        before: { name: match.name, kind: match.kind }, after: { ss12000Id: group.id },
        conflictCode: null, selected: true, autoApplicable: false, protectedIdentity: false,
      });
      groupPlans.set(group.id, { localId: match.id, name: match.name, kind, linked: false });
      continue;
    }
    if (sameName.length > 0) {
      note('GROUP', 'CONFLICT', 'GROUP_NAME_TAKEN', group.id, sameName[0]!.id, { name: group.displayName, kind });
      continue;
    }
    const grades = group.memberships
      .filter((m) => activeOn(today, m.startDate, m.endDate))
      .map((m) => persons.get(m.personId))
      .map((p) => (p ? activeEnrolment(p)?.schoolYear ?? null : null))
      .filter((grade): grade is number => grade !== null && grade >= 0 && grade <= 12);
    push({
      entity: 'GROUP', op: 'CREATE', externalId: group.id, localId: null,
      before: null,
      after: { name: group.displayName, kind, academicYearId: year.id, gradeLevel: mostCommonLowest(grades) },
      conflictCode: null, selected: true, autoApplicable: false, protectedIdentity: false,
    });
    groupPlans.set(group.id, { localId: null, name: group.displayName, kind, linked: false });
  }
  for (const id of deletedGroups) {
    const linked = groupsByExt.get(id);
    if (linked && !roster.groups.some((g) => g.id === id)) note('GROUP', 'INFO', 'GROUP_DELETED_AT_SOURCE', id, linked.id, { name: linked.name });
  }

  // ---------------------------------------------------------------------
  // Class memberships (Klass of the active year)
  // ---------------------------------------------------------------------
  const pupilPlan = (id: string): Plan | null => {
    const plan = plans.get(id);
    return plan && plan.role === 'STUDENT' ? plan : null;
  };
  const localUserOf = (plan: Plan | null) => (plan?.localId ? usersById.get(plan.localId) ?? null : null);
  const activeClasses = new Map<string, S1Group[]>();
  for (const group of supported) {
    if (group.groupType !== 'Klass' || !orgs.has(group.organisationId)) continue;
    const year = groupYear.get(group.id);
    for (const membership of group.memberships) {
      if (!activeOn(today, membership.startDate, membership.endDate)) continue;
      if (!year || !year.isActive) {
        if (year && year.startDate > today) bump('CLASS_MEMBERSHIP', 'futureYear');
        continue;
      }
      activeClasses.set(membership.personId, [...(activeClasses.get(membership.personId) ?? []), group]);
    }
  }
  for (const [personId, classes] of [...activeClasses.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const plan = pupilPlan(personId);
    if (!plan || !activePupils.has(personId)) continue;
    const user = localUserOf(plan);
    if (user && (!user.isActive || deactivating.has(user.id))) continue;
    const isProt = protectedIds.has(personId);
    if (classes.length > 1) {
      note('CLASS_MEMBERSHIP', 'CONFLICT', 'MEMBERSHIP_MULTIPLE_CLASSES', personId, user?.id ?? null,
        { groups: classes.map((g) => ({ id: g.id, name: g.displayName })) }, isProt);
      continue;
    }
    const target = classes[0]!;
    const groupPlan = groupPlans.get(target.id);
    if (!groupPlan) {
      note('CLASS_MEMBERSHIP', 'CONFLICT', 'MEMBERSHIP_CLASS_NOT_LINKED', personId, user?.id ?? null, { groupName: target.displayName }, isProt);
      continue;
    }
    if (user && groupPlan.localId && user.studentGroupId === groupPlan.localId) continue;
    const localEdit = user ? editedLocally(user.updatedAt) && user.studentGroupId !== null : false;
    const current = user?.studentGroupId ? local.groups.find((g) => g.id === user.studentGroupId) : undefined;
    push({
      entity: 'CLASS_MEMBERSHIP', op: 'MOVE', externalId: personId, localId: user?.id ?? null,
      before: { studentGroupId: user?.studentGroupId ?? null, groupName: current?.name ?? null },
      after: { groupExternalId: target.id, groupLocalId: groupPlan.localId, groupName: groupPlan.name },
      conflictCode: localEdit ? 'LOCAL_EDIT_SINCE_LAST_SYNC' : null,
      selected: !localEdit,
      autoApplicable: !localEdit && plan.linked && groupPlan.linked,
      protectedIdentity: isProt,
    });
  }

  // ---------------------------------------------------------------------
  // Teaching-group memberships
  // ---------------------------------------------------------------------
  for (const group of [...supported].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (group.groupType !== 'Undervisning') continue;
    const groupPlan = groupPlans.get(group.id);
    if (!groupPlan || groupPlan.kind !== 'TEACHING_GROUP') continue;
    const activeMembers = new Set<string>();
    for (const membership of [...group.memberships].sort((a, b) => (a.personId < b.personId ? -1 : 1))) {
      if (!activeOn(today, membership.startDate, membership.endDate)) continue;
      activeMembers.add(membership.personId);
      const plan = pupilPlan(membership.personId);
      if (!plan || !activePupils.has(membership.personId)) continue;
      const user = localUserOf(plan);
      if (user && (!user.isActive || deactivating.has(user.id))) continue;
      if (user && groupPlan.localId && membersOf.has(`${groupPlan.localId}|${user.id}`)) continue;
      push({
        entity: 'GROUP_MEMBERSHIP', op: 'ADD', externalId: membership.personId, localId: user?.id ?? null,
        before: null,
        after: { groupExternalId: group.id, groupLocalId: groupPlan.localId, groupName: groupPlan.name },
        conflictCode: null, selected: true,
        autoApplicable: plan.linked && groupPlan.linked,
        protectedIdentity: protectedIds.has(membership.personId),
      });
    }
    if (!groupPlan.localId) continue;
    for (const member of local.teachingMembers) {
      if (member.studentGroupId !== groupPlan.localId) continue;
      const user = usersById.get(member.studentId);
      if (!user?.ss12000Id || !user.isActive || activeMembers.has(user.ss12000Id)) continue;
      note('GROUP_MEMBERSHIP', 'CONFLICT', 'MEMBERSHIP_ENDED_AT_SOURCE', user.ss12000Id, user.id,
        { groupExternalId: group.id, groupLocalId: groupPlan.localId, groupName: groupPlan.name, firstName: user.firstName, lastName: user.lastName },
        protectedIds.has(user.ss12000Id));
    }
  }

  // ---------------------------------------------------------------------
  // Responsibles -> GuardianStudents
  // ---------------------------------------------------------------------
  for (const pupil of inScope) {
    if (!activePupils.has(pupil.id)) continue;
    const plan = pupilPlan(pupil.id);
    if (!plan) continue;
    const pupilUser = localUserOf(plan);
    if (pupilUser && (!pupilUser.isActive || deactivating.has(pupilUser.id))) continue;
    const named = new Set<string>();
    for (const responsible of [...pupil.responsibles].sort((a, b) => (a.personId < b.personId ? -1 : 1))) {
      named.add(responsible.personId);
      const guardian = plans.get(responsible.personId);
      const isProt = protectedIds.has(pupil.id) || protectedIds.has(responsible.personId);
      if (!guardian) {
        note('RESPONSIBLE', 'CONFLICT', 'RESPONSIBLE_NOT_PROVISIONED', pupil.id, pupilUser?.id ?? null,
          { guardianExternalId: responsible.personId, relationType: responsible.relationType }, isProt);
        continue;
      }
      if (guardian.role !== 'GUARDIAN') {
        note('RESPONSIBLE', 'INFO', 'PERSON_MULTIPLE_ROLES', pupil.id, pupilUser?.id ?? null,
          { guardianExternalId: responsible.personId, guardianLocalId: guardian.localId }, isProt);
        continue;
      }
      if (pupilUser && guardian.localId && linksOf.has(`${guardian.localId}|${pupilUser.id}`)) continue;
      const guardianUser = guardian.localId ? usersById.get(guardian.localId) : undefined;
      if (guardianUser && (!guardianUser.isActive || deactivating.has(guardianUser.id))) continue;
      push({
        entity: 'RESPONSIBLE', op: 'ADD', externalId: pupil.id, localId: pupilUser?.id ?? null,
        before: null,
        after: {
          guardianExternalId: responsible.personId,
          guardianLocalId: guardian.localId,
          relationType: responsible.relationType,
          guardianName: guardianUser ? `${guardianUser.firstName} ${guardianUser.lastName}` : null,
        },
        conflictCode: null, selected: true,
        autoApplicable: plan.linked && guardian.linked,
        protectedIdentity: isProt,
      });
    }
    if (!pupilUser) continue;
    // A link to a guardian the source knows but no longer names for this child.
    for (const link of local.guardianLinks) {
      if (link.studentId !== pupilUser.id) continue;
      const guardianUser = usersById.get(link.guardianId);
      if (!guardianUser?.ss12000Id || !guardianUser.isActive || named.has(guardianUser.ss12000Id)) continue;
      if (deactivating.has(guardianUser.id)) continue;
      note('RESPONSIBLE', 'CONFLICT', 'RESPONSIBLE_ENDED_AT_SOURCE', pupil.id, pupilUser.id,
        { guardianLocalId: guardianUser.id, guardianName: `${guardianUser.firstName} ${guardianUser.lastName}`, origin: link.origin },
        protectedIds.has(pupil.id) || protectedIds.has(guardianUser.ss12000Id));
    }
  }

  // ---------------------------------------------------------------------
  // Duty links (no HR figure)
  // ---------------------------------------------------------------------
  if (activeYear) {
    const yearLinks = local.dutyLinks.filter((link) => link.academicYearId === activeYear.id);
    const seenDuties = new Set<string>();
    for (const duty of [...roster.duties].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!duty.personId || !orgs.has(duty.organisationId)) continue;
      seenDuties.add(duty.id);
      const holder = plans.get(duty.personId);
      if (!holder || (holder.role !== 'TEACHER' && holder.role !== 'SCHOOL_ADMIN')) continue;
      const ended = duty.endDate !== null && duty.endDate < today;
      const existing = yearLinks.find((link) => link.ss12000DutyId === duty.id);
      const isProt = protectedIds.has(duty.personId);
      const after = {
        personExternalId: duty.personId,
        userLocalId: holder.localId,
        dutyRole: duty.dutyRole,
        startDate: duty.startDate,
        endDate: duty.endDate,
        academicYearId: activeYear.id,
      };
      if (!existing) {
        if (ended || duty.startDate > activeYear.endDate) continue;
        push({
          entity: 'DUTY_LINK', op: 'ADD', externalId: duty.id, localId: null, before: null, after,
          conflictCode: null, selected: true, autoApplicable: holder.linked, protectedIdentity: isProt,
        });
        continue;
      }
      if (ended) {
        if (!existing.ended) {
          push({
            entity: 'DUTY_LINK', op: 'END', externalId: duty.id, localId: existing.id,
            before: { endDate: existing.endDate }, after: { ...after, ended: true },
            conflictCode: null, selected: true, autoApplicable: holder.linked, protectedIdentity: isProt,
          });
        }
        continue;
      }
      const differs =
        existing.ended ||
        existing.userId !== holder.localId ||
        existing.dutyRole !== duty.dutyRole ||
        existing.startDate !== duty.startDate ||
        existing.endDate !== duty.endDate;
      if (differs) {
        push({
          entity: 'DUTY_LINK', op: 'UPDATE', externalId: duty.id, localId: existing.id,
          before: { userLocalId: existing.userId, dutyRole: existing.dutyRole, startDate: existing.startDate, endDate: existing.endDate, ended: existing.ended },
          after,
          conflictCode: null, selected: true, autoApplicable: holder.linked, protectedIdentity: isProt,
        });
      }
    }
    for (const link of yearLinks) {
      if (link.ended || seenDuties.has(link.ss12000DutyId)) continue;
      if (!deletedDuties.has(link.ss12000DutyId) && !full) continue;
      const holder = usersById.get(link.userId);
      push({
        entity: 'DUTY_LINK', op: 'END', externalId: link.ss12000DutyId, localId: link.id,
        before: { endDate: link.endDate }, after: { ended: true, reason: deletedDuties.has(link.ss12000DutyId) ? 'DELETED_AT_SOURCE' : 'ABSENT_FROM_SOURCE' },
        conflictCode: null, selected: true, autoApplicable: true,
        protectedIdentity: holder?.ss12000Id ? protectedIds.has(holder.ss12000Id) : false,
      });
    }
  }

  // ---------------------------------------------------------------------
  // The organisation: shown, never written to Schools.
  // ---------------------------------------------------------------------
  if (roster.organisations.length === 1 && roster.organisations[0]!.displayName !== local.schoolName) {
    const organisation = roster.organisations[0]!;
    note('ORGANISATION', 'INFO', 'ORGANISATION_NAME_DIFFERS', organisation.id, null, {
      displayName: organisation.displayName,
      schoolUnitCode: organisation.schoolUnitCode,
    });
  }

  return { changes, counts, sourceEmpty: null };
}

/** The deactivations a brake counts against `max(floor, percent %)` of the linked active people. */
export function brakeTripped(
  changes: Array<Pick<ProposedChange, 'op'>>,
  linkedActive: number,
  floor: number,
  percent: number,
): boolean {
  const deactivations = changes.filter((change) => change.op === 'DEACTIVATE').length;
  return deactivations > Math.max(floor, Math.floor((linkedActive * percent) / 100));
}
