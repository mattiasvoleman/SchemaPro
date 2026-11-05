import { unitGradeOf, type GradeNumbering } from '../../common/grade-numbering';
import { normaliseUnitCode, spansOverlap, unitForGrade } from '../../school-units/school-unit-map';
import type { FetchedRoster } from './fetch-plan';
import { activeOn, isProtected, type DutyRole, type S1Duty, type S1Group, type S1Organisation, type S1Person } from './s1';

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
 * auto-applied; the flag goes with the run's minimisation. What is kept is
 * the school's mark that the person is protected (PersonProtections,
 * 20270107090000), and on the sync's mark which protection the register
 * gives (kind, 20270111090000: the stronger where two places differ, none
 * for a marking not recognised), which the SS12000 provider passes on; the
 * diff keeps both as the register has them:
 *  - a person the register marks and the sync has not (an administrator's
 *    own mark is a row of its own): PROTECTION ADD, selected and automatic,
 *    since it only keeps the person out of files. That is the linked person,
 *    or the one local row the run matches by address and proposes to LINK or
 *    RELINK (after.byAddress), whether or not the link is made: a person
 *    typed in by hand, read from a file or imported before the register
 *    protected them is marked by the first run that finds them. By address
 *    it is automatic only when the names agree too, loosely (namesAgree:
 *    accents, hyphens, order and a call name do not part them); else, and
 *    for each of two rows sharing the address, it is proposed deselected
 *    with a code (PROTECTION_ADDRESS_NAME_DIFFERS,
 *    PROTECTION_ADDRESS_AMBIGUOUS), since addresses are reused. Such a
 *    proposal holds the night's run for an administrator, as a selected
 *    change does (ss12000-sync.service.ts, autoApply). It names the
 *    person in its after alone (the minimisation nulls it): externalId and
 *    localId stay empty, so a finished run says how many marks it set, never
 *    whose. A person this apply creates, links or relinks is marked by the
 *    apply with that change too (apply.ts);
 *  - a mark the sync wrote (source SS12000), for a linked person a FULL run
 *    reads as "Ingen" wherever it names them and as nothing else, or for an
 *    unlinked row no protected source person reaches by address any more
 *    (PROTECTION_ADDRESS_NO_LONGER_MATCHES): PROTECTION END, deselected and
 *    never automatic, so the defaults never lift a protection. An absent
 *    marking is not "Ingen", an INCREMENTAL run may not read the record (a
 *    child's) that still marks the person, and an administrator's mark is
 *    theirs: the sync lifts only its own row;
 *  - a mark the sync holds whose kind is not the register's (or was written
 *    before the school kept it): PROTECTION UPDATE with the register's kind,
 *    selected and automatic, since it only changes what the connected
 *    systems are told, to what the register itself says. A mark by hand
 *    has no kind and is never touched.
 *
 * DEACTIVATE, of a linked person only: a FULL run that no longer finds them
 * (a pupil not returned by the enrolment fetch, staff with no active duty, a
 * guardian no active pupil names), deletedEntities, every enrolment at the
 * skolenhet ended, or personStatus Avliden / Utvandrad. Staff deactivation
 * is never automatic. A record the parser refused is not an absence: a
 * linked person whose record was refused is PERSON_RECORD_INVALID, and while
 * any person record of the run was refused, a deactivation inferred from
 * absence (ABSENT_FROM_SOURCE, NO_ACTIVE_CHILD — the refused record may be
 * the child) is ROSTER_HAS_INVALID_RECORDS: deselected, never automatic. REACTIVATE only undoes a deactivation an applied sync
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
 *
 * SKOLENHETER (migration 20261031090000). Every chosen organisation of type
 * Skolenhet is a SchoolUnit: matched by its ss12000Id first, else LINKed to
 * the one unlinked local unit with the same skolenhetskod (or, when the
 * source gives no code, the same name), else CREATEd. The source owns a
 * linked unit's name, code and skolformer (the ones SchemaPro holds; an S1
 * type outside them is SCHOOL_UNIT_TYPES_UNSUPPORTED); a code that is not
 * eight digits is SCHOOL_UNIT_CODE_INVALID and never written, and a code
 * another local unit holds is SCHOOL_UNIT_CODE_TAKEN. The årskurs span is
 * SchemaPro's, since S1's Organisation has none: a FULL run reads the
 * schoolYear of the active enrolments at the unit and proposes that span
 * where the unit has none, or the span widened to hold them, never a
 * narrower one, as an
 * UPDATE of its own, deselected as LOCAL_EDIT_SINCE_LAST_SYNC when the admin
 * changed the unit after the last apply, and SCHOOL_UNIT_SPAN_OVERLAP when
 * it would share an årskurs with another unit. A linked unit the run no
 * longer reads is SCHOOL_UNIT_NOT_CHOSEN, and an organisation of another
 * type ORGANISATION_NOT_SKOLENHET. With two or more units, a class whose
 * årskurs puts it in another unit than the source's group names is
 * GROUP_UNIT_MISMATCH: the span is the map here, so either the span or the
 * class's årskurs is not what the source has. No unit change is ever
 * automatic: the sync principal reads units and writes none.
 */

export type LocalRole = 'STUDENT' | 'TEACHER' | 'SCHOOL_ADMIN' | 'GUARDIAN';
export type ChangeEntity =
  | 'PERSON'
  | 'GROUP'
  | 'CLASS_MEMBERSHIP'
  | 'GROUP_MEMBERSHIP'
  | 'RESPONSIBLE'
  | 'DUTY_LINK'
  | 'ORGANISATION'
  | 'PROTECTION';
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
  /** Its classes' numbering; absent is NIOARIG (grade-numbering.ts). */
  gradeNumbering?: GradeNumbering;
}

export interface LocalUnit {
  id: string;
  name: string;
  code: string | null;
  schoolTypes: string[];
  gradeFrom: number | null;
  gradeTo: number | null;
  ss12000Id: string | null;
  updatedAt: Date;
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
  /** The school's skolenheter; absent in a slice read before they existed (treated as none). */
  units?: LocalUnit[];
  /** The marks of a protected identity (PersonProtections); absent is none. */
  protections?: Array<{ userId: string; source: 'SS12000' | 'MANUAL'; kind?: ProtectionKind | null }>;
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

/**
 * Who a source person or group is here. `localId` is the row it is or would
 * be matched to, used only to compare (is the pupil already in that class?);
 * a change carries it as a write target only when `linked` — the row holds
 * the source id already. A LINK or RELINK the admin may still deselect is
 * not a link: its dependants travel by the SOURCE id alone and the apply
 * resolves them only through a link or create applied in the same apply,
 * so a deselected match never receives a name, a class, a group, a guardian
 * or a duty.
 */
type Plan = { localId: string | null; role: LocalRole; linked: boolean };
type GroupPlan = { localId: string | null; name: string; kind: 'CLASS' | 'TEACHING_GROUP'; linked: boolean };
/** The local row a change may name as its target: only one already linked. */
const target = (plan: { localId: string | null; linked: boolean } | null | undefined): string | null =>
  plan?.linked ? plan.localId : null;

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

/**
 * A name's parts as the marking of a protected identity compares them:
 * compatibility forms taken apart (a ligature, a non-breaking space), accents
 * and zero-width characters dropped, apostrophes dropped, ß as ss, case
 * folded, and split at anything not a letter or digit (a space, a hyphen).
 * "José García" and "Jose Garcia", "Anna-Lena" and "anna lena" give the
 * same parts.
 */
function nameParts(value: string | null | undefined): Set<string> {
  const folded = (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Cf}/gu, '')
    .replace(/['\u2019\u02BC`]/g, '')
    .toLocaleLowerCase('sv')
    .replace(/ß/g, 'ss');
  return new Set(folded.split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 0));
}

/**
 * Name particles: words that do not tell one family (or person) from
 * another, so they never make two names agree. "van Dijk" and "Dijk" agree;
 * "van Dijk" and "van Berg" do not.
 */
const NAME_PARTICLES: ReadonlySet<string> = new Set([
  'af', 'av', 'da', 'dal', 'de', 'degli', 'dei', 'del', 'della', 'den', 'der', 'des', 'di', 'do', 'dos', 'du',
  'el', 'la', 'le', 'lo', 'ten', 'ter', 'van', 'vom', 'von', 'zu', 'zum', 'zur',
]);

/** Two names' parts agree when the parts that tell, particles aside, of one are all among the other's. */
function partsAgree(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const telling = (parts: ReadonlySet<string>): string[] => {
    const kept = [...parts].filter((part) => !NAME_PARTICLES.has(part));
    // A name of particles alone ("Van") is compared as it is.
    return kept.length > 0 ? kept : [...parts];
  };
  const [x, y] = [telling(a), telling(b)];
  if (x.length === 0 || y.length === 0) return false;
  const [xs, ys] = [new Set(x), new Set(y)];
  return x.every((part) => ys.has(part)) || y.every((part) => xs.has(part));
}

/**
 * Whether a local row's name agrees with a protected source person's, for a
 * mark matched on the address (reviews of #263, N2 and round 4 L-a). Missing
 * a protected person keeps them in the files, which weighs more than marking
 * one too many, so accents, hyphens, order and a call name do not part two
 * names; but one shared part is not enough. The given names of one (the
 * register's given and middle names, the row's first names) must all be
 * among the other's, so a call name agrees with all given names either way;
 * and the family name parts of one must all be among the other's, so a
 * double surname with a hyphen, in another order or by half agrees. Name
 * particles (van, de, af, von) are not counted. Another given name beside a
 * shared one, a nickname or a typo differs: the mark is then proposed for a
 * decision.
 */
function namesAgree(local: { firstName: string; lastName: string }, person: S1Person): boolean {
  const given = new Set([...nameParts(person.givenName), ...nameParts(person.middleName)]);
  return partsAgree(nameParts(local.firstName), given) && partsAgree(nameParts(local.lastName), nameParts(person.familyName));
}

/**
 * Which protection the register gives a person (20270111090000), as the
 * school stores it on the sync's mark and passes it on in securityMarking:
 * never for a mark by hand, and nothing for a marking the parser did not
 * recognise (the person is protected all the same).
 */
export type ProtectionKind = 'SEKRETESSMARKERING' | 'SKYDDAD_FOLKBOKFORING';

export function protectionKindOf(marking: S1Person['securityMarking']): ProtectionKind | null {
  return marking === 'Skyddad folkbokföring' ? 'SKYDDAD_FOLKBOKFORING' : marking === 'Sekretessmarkering' ? 'SEKRETESSMARKERING' : null;
}

const KIND_RANK: Record<ProtectionKind, number> = { SEKRETESSMARKERING: 1, SKYDDAD_FOLKBOKFORING: 2 };

/** Of two kinds read for one person in different places, the stronger: the register is never understated. */
function strongerKind(a: ProtectionKind | null | undefined, b: ProtectionKind | null): ProtectionKind | null {
  if (!a) return b;
  if (!b) return a;
  return KIND_RANK[b] > KIND_RANK[a] ? b : a;
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
  // Which protection, the strongest wherever the source names the person.
  const kinds = new Map<string, ProtectionKind | null>();
  const protects = (personId: string, marking: S1Person['securityMarking']) => {
    if (!isProtected(marking)) return;
    protectedIds.add(personId);
    kinds.set(personId, strongerKind(kinds.get(personId), protectionKindOf(marking)));
  };
  const kindOf = (personId: string): ProtectionKind | null => kinds.get(personId) ?? null;
  // A person a CREATE, LINK or RELINK makes or links here is marked by the
  // apply with that change (apply.ts), with the kind it carries.
  const protectionOf = (personId: string): { protectionKind?: ProtectionKind } => {
    const kind = protectedIds.has(personId) ? kindOf(personId) : null;
    return kind ? { protectionKind: kind } : {};
  };
  // Wherever the source says "Ingen" in so many words: the one ground for
  // lifting a mark (PROTECTION END), and only with nothing in protectedIds.
  const saidIngen = new Set<string>();
  for (const person of persons.values()) {
    protects(person.id, person.securityMarking);
    if (person.securityMarking === 'Ingen') saidIngen.add(person.id);
    if (!activePupils.has(person.id)) continue;
    for (const responsible of person.responsibles) {
      protects(responsible.personId, responsible.securityMarking);
      if (responsible.securityMarking === 'Ingen') saidIngen.add(responsible.personId);
      guardianOf.set(responsible.personId, [
        ...(guardianOf.get(responsible.personId) ?? []),
        { pupilId: person.id, relationType: responsible.relationType },
      ]);
    }
  }
  for (const group of roster.groups) {
    for (const membership of group.memberships) {
      protects(membership.personId, membership.personSecurityMarking);
      if (membership.personSecurityMarking === 'Ingen') saidIngen.add(membership.personId);
    }
  }

  const deletedPersons = new Set(roster.deleted?.persons ?? []);
  // Person records the parser refused: present at the source, unreadable here.
  const invalidPersons = new Set(
    roster.invalid.filter((record) => record.entity === 'PERSON' && record.externalId).map((record) => record.externalId as string),
  );
  const deletedGroups = new Set(roster.deleted?.groups ?? []);
  const deletedDuties = new Set(roster.deleted?.duties ?? []);
  // Ids deletedEntities names that nothing here is linked to: counted, ignored.
  const linkedPeople = new Set(local.users.map((u) => u.ss12000Id).filter(Boolean));
  const linkedGroups = new Set(local.groups.map((g) => g.ss12000Id).filter(Boolean));
  const linkedDuties = new Set(local.dutyLinks.map((d) => d.ss12000DutyId));
  bump('deleted', 'unlinkedPersons', [...deletedPersons].filter((id) => !linkedPeople.has(id)).length);
  bump('deleted', 'unlinkedGroups', [...deletedGroups].filter((id) => !linkedGroups.has(id)).length);
  bump('deleted', 'unlinkedDuties', [...deletedDuties].filter((id) => !linkedDuties.has(id)).length);

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
  // A protected source person the run matches by address to a local row it
  // does not link (yet): the mark's ground (see PROTECTED IDENTITY above).
  const addressMatches = new Map<string, { localId: string; email: string; namesAgree: boolean }>();
  const ambiguousMatches = new Map<string, { localIds: string[]; email: string }>();
  for (const user of local.users) if (user.ss12000Id) plans.set(user.ss12000Id, { localId: user.id, role: user.role, linked: true });

  const inScope = [...persons.values()]
    .filter((person) => derivedRoles(person.id).length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Who claims which address in this run: every unlinked person's address,
  // and every NEW address a linked person would be updated to. Two claims on
  // one address is ambiguity (or a clash), never two rows written with it —
  // Users is unique on (schoolId, email), and a clash would fail the whole
  // apply on every run until somebody found the pair.
  const claims = new Map<string, number>();
  for (const person of inScope) {
    const linked = usersByExt.get(person.id);
    if (linked) {
      if (!linked.isActive || linked.role === 'SCHOOL_ADMIN') continue;
      const next = pickEmail(person, linked.role);
      if (next && next !== linked.email.trim().toLowerCase()) claims.set(next, (claims.get(next) ?? 0) + 1);
      continue;
    }
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
        if (holders.length > 0 || (claims.get(email) ?? 0) > 1) {
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
        if (isProt) ambiguousMatches.set(person.id, { localIds: matches.map((u) => u.id), email });
        continue;
      }
      const match = matches[0]!;
      const sameRole = match.role === primary || (match.role === 'SCHOOL_ADMIN' && primary === 'TEACHER');
      if (!sameRole) {
        note('PERSON', 'CONFLICT', 'PERSON_ROLE_MISMATCH', person.id, match.id, { email, role: primary, localRole: match.role, ...display }, isProt);
        continue;
      }
      if (isProt) addressMatches.set(person.id, { localId: match.id, email, namesAgree: namesAgree(match, person) });
      if (!match.isActive) {
        push({
          entity: 'PERSON', op: 'RELINK', externalId: person.id, localId: match.id,
          before: { isActive: false, firstName: match.firstName, lastName: match.lastName, email: match.email },
          after: { ss12000Id: person.id, isActive: true, ...display, ...protectionOf(person.id) },
          conflictCode: 'PERSON_MATCHES_INACTIVE', selected: false, autoApplicable: false, protectedIdentity: isProt,
        });
        plans.set(person.id, { localId: match.id, role: match.role, linked: false });
        continue;
      }
      push({
        entity: 'PERSON', op: 'LINK', externalId: person.id, localId: match.id,
        before: { firstName: match.firstName, lastName: match.lastName, email: match.email, role: match.role },
        after: { ss12000Id: person.id, ...display, ...protectionOf(person.id) },
        conflictCode: match.role === 'SCHOOL_ADMIN' ? 'PERSON_ADMIN_UNTOUCHED' : multiple ? 'PERSON_MULTIPLE_ROLES' : null,
        selected: true, autoApplicable: false, protectedIdentity: isProt,
      });
      plans.set(person.id, { localId: match.id, role: match.role, linked: false });
      if (match.role !== 'SCHOOL_ADMIN' && (match.firstName !== person.givenName || match.lastName !== person.familyName)) {
        // Written only if the LINK beside it is applied: no local id here.
        push({
          entity: 'PERSON', op: 'UPDATE', externalId: person.id, localId: null,
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
      after: { role: primary, firstName: person.givenName, lastName: person.familyName, middleName: person.middleName, email, ...protectionOf(person.id) },
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
    } else if (full && invalidPersons.has(ext)) {
      // Refused, not absent: the person is there, their record is not readable.
      note('PERSON', 'CONFLICT', 'PERSON_RECORD_INVALID', ext, user.id, { role: user.role, firstName: user.firstName, lastName: user.lastName });
      continue;
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
    // Absence is only evidence when every record was read.
    const doubtful = invalidPersons.size > 0 && (reason === 'ABSENT_FROM_SOURCE' || reason === 'NO_ACTIVE_CHILD');
    push({
      entity: 'PERSON', op: 'DEACTIVATE', externalId: ext, localId: user.id,
      before: { isActive: true, firstName: user.firstName, lastName: user.lastName, role: user.role },
      after: { isActive: false, reason },
      conflictCode: doubtful ? 'ROSTER_HAS_INVALID_RECORDS' : null,
      selected: !doubtful,
      // Staff are never deactivated automatically: a wrong end date at the
      // source would lock a teacher out the next morning.
      autoApplicable: !doubtful && (user.role === 'STUDENT' || user.role === 'GUARDIAN'),
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
      note('CLASS_MEMBERSHIP', 'CONFLICT', 'MEMBERSHIP_MULTIPLE_CLASSES', personId, target(plan),
        { groups: classes.map((g) => ({ id: g.id, name: g.displayName })) }, isProt);
      continue;
    }
    const klass = classes[0]!;
    const groupPlan = groupPlans.get(klass.id);
    if (!groupPlan) {
      note('CLASS_MEMBERSHIP', 'CONFLICT', 'MEMBERSHIP_CLASS_NOT_LINKED', personId, target(plan), { groupName: klass.displayName }, isProt);
      continue;
    }
    if (user && groupPlan.localId && user.studentGroupId === groupPlan.localId) continue;
    const localEdit = user ? editedLocally(user.updatedAt) && user.studentGroupId !== null : false;
    const current = user?.studentGroupId ? local.groups.find((g) => g.id === user.studentGroupId) : undefined;
    push({
      entity: 'CLASS_MEMBERSHIP', op: 'MOVE', externalId: personId, localId: target(plan),
      before: { studentGroupId: plan.linked ? user?.studentGroupId ?? null : null, groupName: plan.linked ? current?.name ?? null : null },
      after: { groupExternalId: klass.id, groupLocalId: target(groupPlan), groupName: groupPlan.name },
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
        entity: 'GROUP_MEMBERSHIP', op: 'ADD', externalId: membership.personId, localId: target(plan),
        before: null,
        after: { groupExternalId: group.id, groupLocalId: target(groupPlan), groupName: groupPlan.name },
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
        note('RESPONSIBLE', 'CONFLICT', 'RESPONSIBLE_NOT_PROVISIONED', pupil.id, target(plan),
          { guardianExternalId: responsible.personId, relationType: responsible.relationType }, isProt);
        continue;
      }
      if (guardian.role !== 'GUARDIAN') {
        note('RESPONSIBLE', 'INFO', 'PERSON_MULTIPLE_ROLES', pupil.id, target(plan),
          { guardianExternalId: responsible.personId, guardianLocalId: target(guardian) }, isProt);
        continue;
      }
      if (pupilUser && guardian.localId && linksOf.has(`${guardian.localId}|${pupilUser.id}`)) continue;
      const guardianUser = guardian.localId ? usersById.get(guardian.localId) : undefined;
      if (guardianUser && (!guardianUser.isActive || deactivating.has(guardianUser.id))) continue;
      push({
        entity: 'RESPONSIBLE', op: 'ADD', externalId: pupil.id, localId: target(plan),
        before: null,
        after: {
          guardianExternalId: responsible.personId,
          guardianLocalId: target(guardian),
          relationType: responsible.relationType,
          guardianName: guardianUser && guardian.linked ? `${guardianUser.firstName} ${guardianUser.lastName}` : null,
        },
        conflictCode: null, selected: true,
        autoApplicable: plan.linked && guardian.linked,
        protectedIdentity: isProt,
      });
    }
    if (!pupilUser || !plan.linked) continue;
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
        userLocalId: target(holder),
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
        before: { endDate: link.endDate },
        // Whose duty ends, so the review can name them: the link's own row.
        after: {
          ended: true,
          reason: deletedDuties.has(link.ss12000DutyId) ? 'DELETED_AT_SOURCE' : 'ABSENT_FROM_SOURCE',
          userLocalId: link.userId,
          personExternalId: holder?.ss12000Id ?? null,
          dutyRole: link.dutyRole,
        },
        conflictCode: null, selected: true, autoApplicable: true,
        protectedIdentity: holder?.ss12000Id ? protectedIds.has(holder.ss12000Id) : false,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Protected identity: the school's mark (see PROTECTED IDENTITY above)
  // ---------------------------------------------------------------------
  // The sync's own mark: a person may hold an administrator's beside it,
  // which the sync neither needs nor touches.
  // The sync's own marks, with the kind each holds.
  const syncMarked = new Map(
    (local.protections ?? []).filter((m) => m.source === 'SS12000').map((m) => [m.userId, m.kind ?? null] as const),
  );
  const mark = (
    op: 'ADD' | 'UPDATE' | 'END',
    ext: string | null,
    userId: string,
    address: { email?: string; code: string | null } | null,
  ) => {
    // An ADD only keeps a person out of files: selected and made at night,
    // unless a code says the address alone is the ground. An UPDATE only
    // changes which protection the connected systems are told of, to the
    // register's own: made at night too. An END lifts a protection: never
    // by default, never at night. The kind rides in the after with the
    // person, and the minimisation nulls it with them.
    const automatic = (op === 'ADD' || op === 'UPDATE') && !address?.code;
    push({
      entity: 'PROTECTION', op, externalId: null, localId: null,
      before: null,
      after: {
        personExternalId: ext, userLocalId: userId,
        ...(op !== 'END' && ext ? { kind: kindOf(ext) } : {}),
        ...(address ? { byAddress: true, ...(address.email ? { email: address.email } : {}) } : {}),
      },
      conflictCode: address?.code ?? null, selected: automatic, autoApplicable: automatic, protectedIdentity: false,
    });
  };
  // A mark the sync holds whose kind is not the register's (or was written
  // before the school kept it): the register's kind, at night.
  const rekind = (ext: string, userId: string, address: { email?: string } | null) => {
    if (syncMarked.has(userId) && syncMarked.get(userId) !== kindOf(ext)) mark('UPDATE', ext, userId, address ? { ...address, code: null } : null);
  };
  // Every local row a protected source person reaches by address in this run.
  const addressed = new Set<string>();
  for (const ext of [...protectedIds].sort()) {
    const linked = usersByExt.get(ext);
    if (linked) {
      if (!syncMarked.has(linked.id)) mark('ADD', ext, linked.id, null);
      else rekind(ext, linked.id, null);
      continue;
    }
    // The one row the run matched by address (a LINK or RELINK it proposes):
    // marked whether or not the link is made, since a person typed in by
    // hand or read from a file is in Rastra all the same; at night only when
    // the names agree too (namesAgree), since an address is reused (a
    // sibling, a former pupil). Two rows with the address: each proposed,
    // none automatic.
    const match = addressMatches.get(ext);
    if (match) {
      addressed.add(match.localId);
      if (!syncMarked.has(match.localId)) {
        mark('ADD', ext, match.localId, { email: match.email, code: match.namesAgree ? null : 'PROTECTION_ADDRESS_NAME_DIFFERS' });
      } else {
        rekind(ext, match.localId, { email: match.email });
      }
      continue;
    }
    for (const localId of ambiguousMatches.get(ext)?.localIds ?? []) {
      addressed.add(localId);
      const email = ambiguousMatches.get(ext)!.email;
      if (!syncMarked.has(localId)) mark('ADD', ext, localId, { email, code: 'PROTECTION_ADDRESS_AMBIGUOUS' });
      else rekind(ext, localId, { email });
    }
  }
  if (full) {
    for (const user of local.users) {
      if (!syncMarked.has(user.id)) continue;
      if (user.ss12000Id) {
        if (saidIngen.has(user.ss12000Id) && !protectedIds.has(user.ss12000Id)) mark('END', user.ss12000Id, user.id, null);
      } else if (!addressed.has(user.id)) {
        // Marked by address, and no protected source person has the address
        // any more (it was corrected, or the person left the register).
        mark('END', null, user.id, { code: 'PROTECTION_ADDRESS_NO_LONGER_MATCHES' });
      }
    }
  }

  unitsDiff({ roster, local, today, orgs, push, note, editedLocally, activeYear, groupYear, supported });

  return { changes, counts, sourceEmpty: null };
}

/** The skolformer a unit holds here (SchoolUnitType); the order SchemaPro lists them in. */
const UNIT_TYPES = ['FKLASS', 'FTH', 'GR', 'GRS', 'TR', 'SP', 'SAM'];

interface UnitsDiffInput {
  roster: FetchedRoster;
  local: LocalSlice;
  today: string;
  orgs: Set<string>;
  push: (change: ProposedChange) => void;
  note: (entity: ChangeEntity, op: 'CONFLICT' | 'INFO', code: string, externalId: string | null, localId?: string | null, after?: Record<string, unknown> | null) => void;
  editedLocally: (updatedAt: Date) => boolean;
  activeYear: LocalYear | null;
  groupYear: Map<string, LocalYear | null>;
  supported: S1Group[];
}

/** The skolenheter: see SKOLENHETER above. */
function unitsDiff(input: UnitsDiffInput): void {
  const { roster, local, today, orgs, push, note, editedLocally } = input;
  const units = local.units ?? [];
  const byExt = new Map(units.filter((unit) => unit.ss12000Id).map((unit) => [unit.ss12000Id!, unit]));
  const sameTypes = (a: string[], b: string[]) => a.length === b.length && a.every((type, index) => type === b[index]);

  // The span each unit will have if the selected changes are applied: the
  // local one, or the one proposed below. Keyed by the local id, or by the
  // source id for a unit this run creates.
  const planned = new Map<string, { key: string; ext: string | null; name: string; code: string | null; gradeFrom: number | null; gradeTo: number | null }>();
  for (const unit of units) {
    planned.set(unit.id, { key: unit.id, ext: unit.ss12000Id, name: unit.name, code: unit.code, gradeFrom: unit.gradeFrom, gradeTo: unit.gradeTo });
  }
  const overlaps = (key: string, span: { gradeFrom: number; gradeTo: number }) =>
    [...planned.values()].find((other) => other.key !== key && spansOverlap(other, span)) ?? null;
  const claimed = new Set<string>();
  // Codes this run already gives a unit: a second organisation with one gets none.
  const codesClaimed = new Set<string>();

  for (const organisation of [...roster.organisations].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (organisation.organisationType !== 'Skolenhet') {
      note('ORGANISATION', 'INFO', 'ORGANISATION_NOT_SKOLENHET', organisation.id, null, {
        displayName: organisation.displayName,
        organisationType: organisation.organisationType,
      });
      continue;
    }
    const linked = byExt.get(organisation.id) ?? null;
    const code = sourceCode(organisation, note, linked?.id ?? null);
    const types = UNIT_TYPES.filter((type) => organisation.schoolTypes.includes(type));
    const unsupported = organisation.schoolTypes.filter((type) => !UNIT_TYPES.includes(type));
    if (unsupported.length > 0) {
      note('ORGANISATION', 'INFO', 'SCHOOL_UNIT_TYPES_UNSUPPORTED', organisation.id, linked?.id ?? null, {
        displayName: organisation.displayName,
        schoolTypes: unsupported,
      });
    }
    // Only a FULL run reads every pupil: an incremental one would see the
    // årskurser of the pupils that changed.
    const span =
      roster.mode === 'FULL'
        ? sourceSpan(roster, organisation.id, today, yearContaining(local.years, today)?.gradeNumbering ?? 'NIOARIG')
        : null;
    const holder = code ? units.find((unit) => unit.code === code && unit.id !== linked?.id) : undefined;

    // The local unit this organisation is, or would be.
    let target: LocalUnit | null = linked;
    let linking = false;
    if (!target) {
      if (holder && holder.ss12000Id === null && !claimed.has(holder.id)) {
        target = holder;
        linking = true;
      } else if (!code) {
        const named = units.filter((unit) => unit.ss12000Id === null && unit.name === organisation.displayName && !claimed.has(unit.id));
        if (named.length === 1) {
          target = named[0]!;
          linking = true;
        }
      }
    }
    // A code another unit holds (linked to another organisation, or already
    // claimed in this run) is never written.
    const codeTaken = code !== null && ((holder !== undefined && holder.id !== target?.id) || codesClaimed.has(code));
    if (codeTaken) {
      note('ORGANISATION', 'CONFLICT', 'SCHOOL_UNIT_CODE_TAKEN', organisation.id, target?.id ?? null, {
        displayName: organisation.displayName,
        schoolUnitCode: code,
        holder: holder && holder.id !== target?.id ? holder.name : null,
      });
    }
    const writeCode = code !== null && !codeTaken ? code : undefined;
    if (writeCode !== undefined) codesClaimed.add(writeCode);
    if (target) {
      claimed.add(target.id);
      // As the apply will leave it: the source's id, name and code.
      planned.set(target.id, {
        ...planned.get(target.id)!,
        ext: organisation.id,
        name: organisation.displayName,
        ...(writeCode !== undefined ? { code: writeCode } : {}),
      });
    }

    if (!target) {
      const key = `ext:${organisation.id}`;
      const free = span && !overlaps(key, span) ? span : null;
      if (span && !free) {
        note('ORGANISATION', 'CONFLICT', 'SCHOOL_UNIT_SPAN_OVERLAP', organisation.id, null, {
          displayName: organisation.displayName,
          gradeFrom: span.gradeFrom,
          gradeTo: span.gradeTo,
          other: overlaps(key, span)!.name,
        });
      }
      planned.set(key, {
        key, ext: organisation.id, name: organisation.displayName, code: writeCode ?? null, gradeFrom: free?.gradeFrom ?? null, gradeTo: free?.gradeTo ?? null,
      });
      push({
        entity: 'ORGANISATION', op: 'CREATE', externalId: organisation.id, localId: null,
        before: null,
        after: {
          name: organisation.displayName,
          code: writeCode ?? null,
          schoolTypes: types,
          gradeFrom: free?.gradeFrom ?? null,
          gradeTo: free?.gradeTo ?? null,
        },
        conflictCode: null, selected: true, autoApplicable: false, protectedIdentity: false,
      });
      continue;
    }

    // What the source owns: name, the code it gives, the skolformer it
    // lists. One UPDATE each, as a person's name and address are, so the
    // review shows every one and the admin chooses each; beside a LINK they
    // carry no local id and are written only if the LINK is.
    const updates: Array<[string, unknown, unknown]> = [];
    if (target.name !== organisation.displayName) updates.push(['name', target.name, organisation.displayName]);
    if (writeCode !== undefined && writeCode !== target.code) updates.push(['code', target.code, writeCode]);
    if (types.length > 0 && !sameTypes(types, UNIT_TYPES.filter((type) => target!.schoolTypes.includes(type)))) {
      updates.push(['schoolTypes', target.schoolTypes, types]);
    }
    if (linking) {
      push({
        entity: 'ORGANISATION', op: 'LINK', externalId: organisation.id, localId: target.id,
        before: { name: target.name, code: target.code, schoolTypes: target.schoolTypes },
        after: { ss12000Id: organisation.id },
        conflictCode: null, selected: true, autoApplicable: false, protectedIdentity: false,
      });
    }
    for (const [field, from, to] of updates) {
      push({
        entity: 'ORGANISATION', op: 'UPDATE', externalId: organisation.id, localId: linking ? null : target.id,
        // unitName: what the review calls the unit; never written.
        before: { unitName: target.name, [field]: from }, after: { [field]: to },
        conflictCode: null, selected: true, autoApplicable: false, protectedIdentity: false,
      });
    }

    // The span: SchemaPro's. The source's enrolments set one where the unit
    // has none and widen one they fall outside; a span wider than this
    // year's pupils (an F–6 with no förskoleklass this year) is left alone.
    if (!span) continue;
    const wanted =
      target.gradeFrom === null || target.gradeTo === null
        ? span
        : { gradeFrom: Math.min(span.gradeFrom, target.gradeFrom), gradeTo: Math.max(span.gradeTo, target.gradeTo) };
    if (wanted.gradeFrom === target.gradeFrom && wanted.gradeTo === target.gradeTo) continue;
    const other = overlaps(target.id, wanted);
    if (other) {
      note('ORGANISATION', 'CONFLICT', 'SCHOOL_UNIT_SPAN_OVERLAP', organisation.id, linking ? null : target.id, {
        displayName: organisation.displayName,
        gradeFrom: wanted.gradeFrom,
        gradeTo: wanted.gradeTo,
        other: other.name,
      });
      continue;
    }
    planned.set(target.id, { ...planned.get(target.id)!, ext: organisation.id, ...wanted });
    // A unit the admin wrote after the last apply, linked or about to be.
    const localEdit = editedLocally(target.updatedAt);
    push({
      entity: 'ORGANISATION', op: 'UPDATE', externalId: organisation.id,
      // A unit this apply links is reached through the source id alone.
      localId: linking ? null : target.id,
      before: { unitName: target.name, gradeFrom: target.gradeFrom, gradeTo: target.gradeTo },
      after: { gradeFrom: wanted.gradeFrom, gradeTo: wanted.gradeTo },
      conflictCode: localEdit ? 'LOCAL_EDIT_SINCE_LAST_SYNC' : null,
      selected: !localEdit, autoApplicable: false, protectedIdentity: false,
    });
  }

  for (const unit of units) {
    if (unit.ss12000Id && !roster.organisations.some((organisation) => organisation.id === unit.ss12000Id)) {
      note('ORGANISATION', 'INFO', 'SCHOOL_UNIT_NOT_CHOSEN', unit.ss12000Id, unit.id, { name: unit.name });
    }
  }

  // A class the source puts in one unit and its årskurs in another.
  const map = [...planned.values()].map((unit) => ({ ...unit, id: unit.key }));
  if (map.length < 2 || !input.activeYear) return;
  const groupsByExt = new Map(local.groups.filter((group) => group.ss12000Id).map((group) => [group.ss12000Id!, group]));
  for (const group of [...input.supported].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (group.groupType !== 'Klass' || !orgs.has(group.organisationId)) continue;
    if (input.groupYear.get(group.id)?.id !== input.activeYear.id) continue;
    const local = groupsByExt.get(group.id);
    if (!local || local.gradeLevel === null) continue;
    const unit = unitForGrade(map, local.gradeLevel, input.activeYear.gradeNumbering ?? 'NIOARIG');
    if (!unit || unit.ext === group.organisationId) continue;
    const named = map.find((entry) => entry.ext === group.organisationId);
    note('GROUP', 'CONFLICT', 'GROUP_UNIT_MISMATCH', group.id, local.id, {
      name: local.name,
      gradeLevel: local.gradeLevel,
      sourceUnit: named?.name ?? null,
      localUnit: unit.name,
    });
  }
}

/** The organisation's skolenhetskod when it is one; a code that is not is named and dropped. */
function sourceCode(organisation: S1Organisation, note: UnitsDiffInput['note'], localId: string | null): string | null {
  if (organisation.schoolUnitCode === null) return null;
  const code = normaliseUnitCode(organisation.schoolUnitCode);
  if (code === null) {
    note('ORGANISATION', 'CONFLICT', 'SCHOOL_UNIT_CODE_INVALID', organisation.id, localId, {
      displayName: organisation.displayName,
      schoolUnitCode: organisation.schoolUnitCode,
    });
  }
  return code;
}

/**
 * Lowest to highest schoolYear of the enrolments at the organisation active on
 * `today`, in the nine-year numbering a unit's span is stated in (0..10); null
 * when none gives one. The register numbers its årskurser as the läsår
 * containing `today` does (`numbering`): from HT 2028 a tioårig register's
 * 8–10 is the unit's 7–9, never a widening to 10, and its new åk 1 a 1–6
 * unit's 1, never a widening to förskoleklass (unitGradeOf).
 */
function sourceSpan(
  roster: FetchedRoster,
  organisationId: string,
  today: string,
  numbering: GradeNumbering,
): { gradeFrom: number; gradeTo: number } | null {
  const grades: number[] = [];
  for (const person of roster.persons.values()) {
    for (const enrolment of person.enrolments) {
      if (enrolment.organisationId !== organisationId || enrolment.cancelled || !activeOn(today, enrolment.startDate, enrolment.endDate)) continue;
      const grade = unitGradeOf(enrolment.schoolYear, numbering);
      if (grade !== null && grade >= 0 && grade <= 10) grades.push(grade);
    }
  }
  return grades.length === 0 ? null : { gradeFrom: Math.min(...grades), gradeTo: Math.max(...grades) };
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
