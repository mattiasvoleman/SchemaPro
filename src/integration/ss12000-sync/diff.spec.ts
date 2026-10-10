import type { FetchedRoster } from './fetch-plan';
import { brakeTripped, computeDiff, pickEmail, type LocalSlice, type LocalUser, type ProposedChange } from './diff';
import type { S1Duty, S1Group, S1Person } from './s1';

const TODAY = '2026-10-10';
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ORG = 'aaaaaaaa-0000-4000-8000-000000000002';
const YEAR = 'a0000000-0000-4000-8000-000000000001';
const NEXT_YEAR = 'a0000000-0000-4000-8000-000000000002';

let seq = 0;
const ext = (n: number) => `e${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
const loc = (n: number) => `10${String(n).padStart(6, '0')}-0000-4000-8000-000000000000`;

function pupil(id: string, given: string, family: string, email: string, patch: Partial<S1Person> = {}): S1Person {
  return {
    id,
    givenName: given,
    middleName: null,
    familyName: family,
    eduPersonPrincipalNames: [],
    securityMarking: 'Ingen',
    personStatus: 'Aktiv',
    emails: [{ value: email, type: 'Skola elev' }],
    enrolments: [{ organisationId: ORG, schoolYear: 7, schoolType: 'GR', startDate: '2026-08-15', endDate: null, cancelled: false }],
    responsibles: [],
    modified: null,
    ...patch,
  };
}

function adult(id: string, given: string, family: string, email: string, type: 'Privat' | 'Skola personal', patch: Partial<S1Person> = {}): S1Person {
  return {
    id,
    givenName: given,
    middleName: null,
    familyName: family,
    eduPersonPrincipalNames: [],
    securityMarking: 'Ingen',
    personStatus: 'Aktiv',
    emails: [{ value: email, type }],
    enrolments: [],
    responsibles: [],
    modified: null,
    ...patch,
  };
}

function duty(id: string, personId: string, dutyRole: S1Duty['dutyRole'] = 'Lärare', patch: Partial<S1Duty> = {}): S1Duty {
  return { id, personId, organisationId: ORG, dutyRole, startDate: '2026-08-01', endDate: null, ...patch };
}

function group(id: string, name: string, type: 'Klass' | 'Undervisning', members: string[], patch: Partial<S1Group> = {}): S1Group {
  return {
    id,
    displayName: name,
    startDate: '2026-08-15',
    endDate: '2027-06-10',
    groupType: type,
    organisationId: ORG,
    memberships: members.map((personId) => ({ personId, personSecurityMarking: null, startDate: '2026-08-15', endDate: null })),
    ...patch,
  };
}

function roster(patch: Partial<FetchedRoster> & { people?: S1Person[] } = {}): FetchedRoster {
  const people = patch.people ?? [];
  const persons = new Map(people.map((p) => [p.id, p]));
  return {
    mode: 'FULL',
    incrementalUnsupported: false,
    organisations: [{ id: ORG, displayName: 'Ekskolan', organisationType: 'Skolenhet', schoolUnitCode: '123' }],
    persons,
    enrolmentIds: new Set(people.filter((p) => p.enrolments.length > 0).map((p) => p.id)),
    dutyPersonIds: new Set(),
    responsibleIds: new Set(),
    groups: [],
    duties: [],
    deleted: null,
    invalid: [],
    ...patch,
  };
}

function user(n: number, patch: Partial<LocalUser> = {}): LocalUser {
  return {
    id: loc(n),
    role: 'STUDENT',
    firstName: 'Förnamn',
    lastName: 'Efternamn',
    email: `user${n}@skola.se`,
    isActive: true,
    studentGroupId: null,
    ss12000Id: null,
    invited: false,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    deactivatedBySync: false,
    ...patch,
  };
}

function slice(patch: Partial<LocalSlice> = {}): LocalSlice {
  return {
    schoolName: 'Ekskolan',
    users: [],
    groups: [],
    teachingMembers: [],
    guardianLinks: [],
    dutyLinks: [],
    years: [
      { id: YEAR, startDate: '2026-08-01', endDate: '2027-07-31', isActive: true },
      { id: NEXT_YEAR, startDate: '2027-08-01', endDate: '2028-07-31', isActive: false },
    ],
    lastAppliedAt: null,
    ...patch,
  };
}

const diff = (r: FetchedRoster, l: LocalSlice) => computeDiff({ roster: r, local: l, today: TODAY, organisationIds: [ORG] });
const only = (changes: ProposedChange[], entity: string, op?: string) => changes.filter((c) => c.entity === entity && (!op || c.op === op));
const codes = (changes: ProposedChange[]) => changes.map((c) => c.conflictCode).filter(Boolean);

beforeEach(() => {
  seq = 0;
  void seq;
});

describe('computeDiff: persons', () => {
  it('CREATEs an unknown pupil as a catalogue row proposal, selected, never automatic', () => {
    const result = diff(roster({ people: [pupil(ext(1), 'Ella', 'Ek', 'Ella@Skola.se')] }), slice());
    expect(result.changes).toEqual([
      expect.objectContaining({
        entity: 'PERSON',
        op: 'CREATE',
        externalId: ext(1),
        after: expect.objectContaining({ role: 'STUDENT', firstName: 'Ella', lastName: 'Ek', email: 'ella@skola.se' }),
        selected: true,
        autoApplicable: false,
      }),
    ]);
  });

  it('LINKs by email only to exactly one ACTIVE row with the same role, and proposes the name update beside it', () => {
    const local = slice({ users: [user(1, { email: 'ELLA@skola.se', firstName: 'Elle' })] });
    const result = diff(roster({ people: [pupil(ext(1), 'Ella', 'Ek', 'ella@skola.se')] }), local);
    expect(only(result.changes, 'PERSON', 'LINK')).toEqual([expect.objectContaining({ localId: loc(1), externalId: ext(1), selected: true, autoApplicable: false })]);
    expect(only(result.changes, 'PERSON', 'UPDATE')).toHaveLength(1);
  });

  it('refuses a LINK across roles (PERSON_ROLE_MISMATCH)', () => {
    const local = slice({ users: [user(1, { email: 'ella@skola.se', role: 'GUARDIAN' })] });
    const result = diff(roster({ people: [pupil(ext(1), 'Ella', 'Ek', 'ella@skola.se')] }), local);
    expect(result.changes).toEqual([expect.objectContaining({ op: 'CONFLICT', conflictCode: 'PERSON_ROLE_MISMATCH', selected: false })]);
  });

  it('calls two source persons claiming one address PERSON_AMBIGUOUS_MATCH against a local row, PERSON_EMAIL_TAKEN otherwise', () => {
    const people = [
      adult(ext(10), 'Gun', 'Ek', 'hem@ek.se', 'Privat'),
      adult(ext(11), 'Per', 'Ek', 'hem@ek.se', 'Privat'),
      pupil(ext(1), 'Ella', 'Ek', 'ella@skola.se', { responsibles: [{ personId: ext(10), securityMarking: null, relationType: 'Vårdnadshavare' }, { personId: ext(11), securityMarking: null, relationType: 'Vårdnadshavare' }] }),
    ];
    const withLocal = diff(roster({ people }), slice({ users: [user(1, { email: 'hem@ek.se', role: 'GUARDIAN' })] }));
    expect(codes(only(withLocal.changes, 'PERSON', 'CONFLICT'))).toEqual(['PERSON_AMBIGUOUS_MATCH', 'PERSON_AMBIGUOUS_MATCH']);
    const fresh = diff(roster({ people }), slice());
    expect(codes(only(fresh.changes, 'PERSON', 'CONFLICT'))).toEqual(['PERSON_EMAIL_TAKEN', 'PERSON_EMAIL_TAKEN']);
    expect(only(fresh.changes, 'PERSON', 'CREATE').map((c) => c.externalId)).toEqual([ext(1)]);
  });

  it('proposes a deselected RELINK when only a DEACTIVATED row has the address (PERSON_MATCHES_INACTIVE)', () => {
    const local = slice({ users: [user(1, { email: 'ella@skola.se', isActive: false })] });
    const result = diff(roster({ people: [pupil(ext(1), 'Ella', 'Ek', 'ella@skola.se')] }), local);
    expect(result.changes).toEqual([expect.objectContaining({ op: 'RELINK', conflictCode: 'PERSON_MATCHES_INACTIVE', selected: false, autoApplicable: false })]);
  });

  it('calls an address held by a row linked to another source id PERSON_EMAIL_TAKEN', () => {
    const local = slice({ users: [user(1, { email: 'ella@skola.se', ss12000Id: ext(99) })] });
    const result = diff(roster({ people: [pupil(ext(1), 'Ella', 'Ek', 'ella@skola.se')] }), local);
    expect(codes(result.changes)).toContain('PERSON_EMAIL_TAKEN');
  });

  it('answers PERSON_NO_EMAIL when the role has no address of its type and no EPPN to fall back on', () => {
    const p = pupil(ext(1), 'Ella', 'Ek', 'x@y.se', { emails: [{ value: 'privat@hem.se', type: 'Privat' }] });
    expect(codes(diff(roster({ people: [p] }), slice()).changes)).toEqual(['PERSON_NO_EMAIL']);
    const withEppn = { ...p, eduPersonPrincipalNames: ['ella.ek@skola.se'] };
    expect(diff(roster({ people: [withEppn] }), slice()).changes[0]).toMatchObject({ op: 'CREATE', after: { email: 'ella.ek@skola.se' } });
  });

  it('picks the email by role per S1 Email.type, and never an EPPN for a guardian', () => {
    const p = adult(ext(1), 'A', 'B', 'personal@skola.se', 'Skola personal', { eduPersonPrincipalNames: ['eppn@skola.se'] });
    expect(pickEmail(p, 'TEACHER')).toBe('personal@skola.se');
    expect(pickEmail(p, 'GUARDIAN')).toBeNull();
  });

  it('updates names of a linked person (automatic), and an email change never automatically', () => {
    const local = slice({ users: [user(1, { ss12000Id: ext(1), firstName: 'Elle', lastName: 'Ek', email: 'old@skola.se' })] });
    const result = diff(roster({ people: [pupil(ext(1), 'Ella', 'Ek', 'new@skola.se')] }), local);
    const updates = only(result.changes, 'PERSON', 'UPDATE');
    expect(updates).toEqual([
      expect.objectContaining({ after: expect.objectContaining({ firstName: 'Ella' }), selected: true, autoApplicable: true }),
      expect.objectContaining({ after: { email: 'new@skola.se' }, selected: true, autoApplicable: false }),
    ]);
  });

  it('holds an email change of an INVITED person for the admin (PERSON_EMAIL_CHANGE_INVITED, deselected)', () => {
    const local = slice({ users: [user(1, { ss12000Id: ext(1), firstName: 'Ella', lastName: 'Ek', email: 'old@skola.se', invited: true })] });
    const result = diff(roster({ people: [pupil(ext(1), 'Ella', 'Ek', 'new@skola.se')] }), local);
    expect(result.changes).toEqual([expect.objectContaining({ op: 'UPDATE', conflictCode: 'PERSON_EMAIL_CHANGE_INVITED', selected: false, autoApplicable: false })]);
  });

  it('lets a local edit since the last apply win over the source (LOCAL_EDIT_SINCE_LAST_SYNC)', () => {
    const local = slice({
      lastAppliedAt: new Date('2026-10-01T00:00:00Z'),
      users: [user(1, { ss12000Id: ext(1), firstName: 'Ellen', lastName: 'Ek', email: 'ella@skola.se', updatedAt: new Date('2026-10-05T00:00:00Z') })],
    });
    const result = diff(roster({ people: [pupil(ext(1), 'Ella', 'Ek', 'ella@skola.se')] }), local);
    expect(result.changes).toEqual([expect.objectContaining({ op: 'UPDATE', conflictCode: 'LOCAL_EDIT_SINCE_LAST_SYNC', selected: false, autoApplicable: false })]);
  });

  it('never updates, moves or deactivates a SCHOOL_ADMIN, and only links one (PERSON_ADMIN_UNTOUCHED)', () => {
    const teacherDuty = duty(ext(50), ext(5));
    const linked = slice({ users: [user(5, { role: 'SCHOOL_ADMIN', ss12000Id: ext(5), firstName: 'Old', email: 'rektor@skola.se' })] });
    expect(diff(roster({ people: [adult(ext(5), 'Ny', 'Rektor', 'rektor@skola.se', 'Skola personal')], duties: [teacherDuty] }), linked).changes.filter((c) => c.entity === 'PERSON')).toEqual([]);
    expect(diff(roster({ people: [] }), linked).changes).toEqual([]);
    const unlinked = slice({ users: [user(5, { role: 'SCHOOL_ADMIN', email: 'rektor@skola.se' })] });
    const result = diff(roster({ people: [adult(ext(5), 'Ny', 'Rektor', 'rektor@skola.se', 'Skola personal')], duties: [teacherDuty] }), unlinked);
    expect(only(result.changes, 'PERSON')).toEqual([expect.objectContaining({ op: 'LINK', conflictCode: 'PERSON_ADMIN_UNTOUCHED', selected: true })]);
  });

  it('derives TEACHER from an active Lärare duty, holds assistant roles for review and other roles out', () => {
    const people = [
      adult(ext(1), 'L', 'Ä', 'larare@skola.se', 'Skola personal'),
      adult(ext(2), 'A', 'S', 'assistent@skola.se', 'Skola personal'),
      adult(ext(3), 'K', 'U', 'kurator@skola.se', 'Skola personal'),
    ];
    const duties = [duty(ext(51), ext(1), 'Förstelärare'), duty(ext(52), ext(2), 'Lärarassistent'), duty(ext(53), ext(3), 'Kurator')];
    const creates = only(diff(roster({ people, duties }), slice()).changes, 'PERSON', 'CREATE');
    expect(creates.map((c) => [c.externalId, c.after?.['role'], c.conflictCode, c.selected])).toEqual([
      [ext(1), 'TEACHER', null, true],
      [ext(2), 'TEACHER', 'DUTY_ROLE_REVIEW', false],
      [ext(3), 'TEACHER', 'DUTY_NON_TEACHING_ROLE', false],
    ]);
  });

  it('calls a teacher who is also a parent here PERSON_MULTIPLE_ROLES and deselects the create', () => {
    const people = [
      adult(ext(1), 'T', 'P', 'tp@skola.se', 'Skola personal'),
      pupil(ext(2), 'Barn', 'P', 'barn@skola.se', { responsibles: [{ personId: ext(1), securityMarking: null, relationType: 'Vårdnadshavare' }] }),
    ];
    const result = diff(roster({ people, duties: [duty(ext(51), ext(1))] }), slice());
    expect(only(result.changes, 'PERSON', 'CREATE').find((c) => c.externalId === ext(1))).toMatchObject({
      conflictCode: 'PERSON_MULTIPLE_ROLES',
      selected: false,
      after: expect.objectContaining({ role: 'TEACHER' }),
    });
  });

  it('deselects and never auto-applies ANY change touching a protected identity, and stores no marking', () => {
    const p = pupil(ext(1), 'Skyddad', 'Person', 'sp@skola.se', { securityMarking: 'Skyddad folkbokföring' });
    const result = diff(roster({ people: [p] }), slice({ users: [user(1, { ss12000Id: ext(1), firstName: 'X', email: 'sp@skola.se' })] }));
    expect(result.changes.length).toBeGreaterThan(0);
    for (const change of result.changes) {
      expect(change).toMatchObject({ selected: false, autoApplicable: false, protectedIdentity: true });
      expect(JSON.stringify(change)).not.toMatch(/Skyddad folkbokföring|Sekretessmarkering/);
    }
  });

  it('protects a guardian marked on the pupil\'s PersonReference, too', () => {
    const people = [
      adult(ext(10), 'G', 'H', 'g@hem.se', 'Privat'),
      pupil(ext(1), 'B', 'H', 'b@skola.se', { responsibles: [{ personId: ext(10), securityMarking: 'Sekretessmarkering', relationType: 'Vårdnadshavare' }] }),
    ];
    const result = diff(roster({ people }), slice());
    expect(only(result.changes, 'PERSON', 'CREATE').find((c) => c.externalId === ext(10))).toMatchObject({ protectedIdentity: true, selected: false });
  });

  it('lists a pupil whose enrolment starts after T as PERSON_NOT_YET_ENROLLED and creates nobody', () => {
    const p = pupil(ext(1), 'Ny', 'Elev', 'ny@skola.se', { enrolments: [{ organisationId: ORG, schoolYear: 7, schoolType: 'GR', startDate: '2026-11-01', endDate: null, cancelled: false }] });
    expect(diff(roster({ people: [p] }), slice()).changes).toEqual([expect.objectContaining({ op: 'INFO', conflictCode: 'PERSON_NOT_YET_ENROLLED' })]);
  });

  it('ignores enrolments at another organisation and cancelled ones', () => {
    const elsewhere = pupil(ext(1), 'A', 'B', 'a@skola.se', { enrolments: [{ organisationId: OTHER_ORG, schoolYear: 7, schoolType: 'GR', startDate: '2026-08-01', endDate: null, cancelled: false }] });
    const cancelled = pupil(ext(2), 'C', 'D', 'c@skola.se', { enrolments: [{ organisationId: ORG, schoolYear: 7, schoolType: 'GR', startDate: '2026-08-01', endDate: null, cancelled: true }] });
    expect(diff(roster({ people: [elsewhere, cancelled] }), slice()).changes).toEqual([]);
  });
});

describe('computeDiff: deactivation and reactivation', () => {
  it('deactivates a linked pupil a FULL run no longer finds (automatic), and a linked teacher only by hand', () => {
    const local = slice({
      users: [
        user(1, { ss12000Id: ext(1) }),
        user(2, { ss12000Id: ext(2), role: 'TEACHER' }),
        user(3, { ss12000Id: ext(3), role: 'GUARDIAN' }),
        user(4, {}),
      ],
    });
    const result = diff(roster({ people: [pupil(ext(9), 'Kvar', 'Elev', 'kvar@skola.se')], duties: [duty(ext(59), ext(8))] }), local);
    const off = only(result.changes, 'PERSON', 'DEACTIVATE');
    expect(off.map((c) => [c.localId, c.autoApplicable, c.after?.['reason']])).toEqual([
      [loc(1), true, 'ABSENT_FROM_SOURCE'],
      [loc(2), false, 'ABSENT_FROM_SOURCE'],
      [loc(3), true, 'NO_ACTIVE_CHILD'],
    ]);
  });

  it('never infers a deactivation from absence in an INCREMENTAL run, only from deletedEntities', () => {
    const local = slice({ users: [user(1, { ss12000Id: ext(1) }), user(2, { ss12000Id: ext(2) })] });
    const result = diff(roster({ mode: 'INCREMENTAL', people: [], deleted: { persons: [ext(2)], groups: [], duties: [] } }), local);
    expect(only(result.changes, 'PERSON', 'DEACTIVATE').map((c) => [c.localId, c.after?.['reason']])).toEqual([[loc(2), 'DELETED_AT_SOURCE']]);
  });

  it('does not deactivate an id deletedEntities lists that the same run also returns (INFO)', () => {
    const local = slice({ users: [user(1, { ss12000Id: ext(1), firstName: 'Ella', lastName: 'Ek', email: 'ella@skola.se' })] });
    const result = diff(roster({ mode: 'INCREMENTAL', people: [pupil(ext(1), 'Ella', 'Ek', 'ella@skola.se')], deleted: { persons: [ext(1)], groups: [], duties: [] } }), local);
    expect(result.changes.map((c) => [c.op, c.conflictCode])).toEqual([['INFO', 'DELETED_BUT_RETURNED']]);
  });

  it('deactivates a pupil whose every enrolment here ended, and anyone Avliden or Utvandrad', () => {
    const ended = pupil(ext(1), 'A', 'B', 'a@skola.se', { enrolments: [{ organisationId: ORG, schoolYear: 9, schoolType: 'GR', startDate: '2024-08-15', endDate: '2026-06-10', cancelled: false }] });
    const gone = pupil(ext(2), 'C', 'D', 'c@skola.se', { personStatus: 'Utvandrad' });
    const local = slice({ users: [user(1, { ss12000Id: ext(1) }), user(2, { ss12000Id: ext(2) })] });
    const result = diff(roster({ mode: 'INCREMENTAL', people: [ended, gone] }), local);
    expect(only(result.changes, 'PERSON', 'DEACTIVATE').map((c) => c.after?.['reason'])).toEqual(['ENROLMENT_ENDED', 'PERSON_STATUS']);
  });

  it('never deactivates an unlinked person', () => {
    expect(diff(roster({ people: [] }), slice({ users: [user(1), user(2, { role: 'TEACHER' })] })).changes).toEqual([]);
  });

  it('REACTIVATEs only a person an applied sync deactivated; one an admin deactivated is PERSON_DEACTIVATED_LOCALLY', () => {
    const p = pupil(ext(1), 'Förnamn', 'Efternamn', 'user1@skola.se');
    const bySync = diff(roster({ people: [p] }), slice({ users: [user(1, { ss12000Id: ext(1), isActive: false, deactivatedBySync: true })] }));
    expect(bySync.changes).toEqual([expect.objectContaining({ op: 'REACTIVATE', selected: true, autoApplicable: false })]);
    const byAdmin = diff(roster({ people: [p] }), slice({ users: [user(1, { ss12000Id: ext(1), isActive: false })] }));
    expect(byAdmin.changes).toEqual([expect.objectContaining({ op: 'CONFLICT', conflictCode: 'PERSON_DEACTIVATED_LOCALLY', selected: false })]);
  });

  it('produces no diff from a FULL fetch with no pupils while linked pupils exist (SS12000_SOURCE_EMPTY)', () => {
    const result = diff(roster({ people: [] }), slice({ users: [user(1, { ss12000Id: ext(1) })] }));
    expect(result).toMatchObject({ changes: [], sourceEmpty: 'PUPILS' });
    const staff = diff(roster({ people: [pupil(ext(5), 'A', 'B', 'a@skola.se')] }), slice({ users: [user(2, { role: 'TEACHER', ss12000Id: ext(2) })] }));
    expect(staff.sourceEmpty).toBe('STAFF');
  });

  it('holds a partial guardian end for the admin (RESPONSIBLE_ENDED_AT_SOURCE) and deactivates a guardian with no child left', () => {
    const people = [
      adult(ext(10), 'Kvar', 'G', 'kvar@hem.se', 'Privat'),
      pupil(ext(1), 'Barn', 'Ett', 'b1@skola.se', { responsibles: [{ personId: ext(10), securityMarking: null, relationType: 'Vårdnadshavare' }] }),
      pupil(ext(2), 'Barn', 'Två', 'b2@skola.se'),
    ];
    const local = slice({
      users: [
        user(1, { ss12000Id: ext(1), firstName: 'Barn', lastName: 'Ett', email: 'b1@skola.se' }),
        user(2, { ss12000Id: ext(2), firstName: 'Barn', lastName: 'Två', email: 'b2@skola.se' }),
        user(10, { ss12000Id: ext(10), role: 'GUARDIAN', firstName: 'Kvar', lastName: 'G', email: 'kvar@hem.se' }),
        user(11, { ss12000Id: ext(11), role: 'GUARDIAN', firstName: 'Borta', lastName: 'G', email: 'borta@hem.se' }),
      ],
      guardianLinks: [
        { guardianId: loc(10), studentId: loc(1), origin: 'SS12000' },
        { guardianId: loc(10), studentId: loc(2), origin: 'SS12000' },
        { guardianId: loc(11), studentId: loc(2), origin: 'MANUAL' },
      ],
    });
    const result = diff(roster({ people }), local);
    expect(only(result.changes, 'RESPONSIBLE', 'CONFLICT')).toEqual([
      expect.objectContaining({ conflictCode: 'RESPONSIBLE_ENDED_AT_SOURCE', localId: loc(2), after: expect.objectContaining({ guardianLocalId: loc(10) }) }),
    ]);
    expect(only(result.changes, 'PERSON', 'DEACTIVATE').map((c) => c.localId)).toEqual([loc(11)]);
  });
});

describe('computeDiff: groups and memberships', () => {
  it('CREATEs a Klass in the active year with the most common schoolYear of its members, lower on a tie', () => {
    const people = [
      pupil(ext(1), 'A', 'A', 'a@skola.se', { enrolments: [{ organisationId: ORG, schoolYear: 8, schoolType: 'GR', startDate: '2026-08-15', endDate: null, cancelled: false }] }),
      pupil(ext(2), 'B', 'B', 'b@skola.se'),
    ];
    const result = diff(roster({ people, groups: [group(ext(70), '7A', 'Klass', [ext(1), ext(2)])] }), slice());
    expect(only(result.changes, 'GROUP', 'CREATE')).toEqual([
      expect.objectContaining({ after: { name: '7A', kind: 'CLASS', academicYearId: YEAR, gradeLevel: 7 } }),
    ]);
    expect(only(result.changes, 'CLASS_MEMBERSHIP', 'MOVE').map((c) => [c.externalId, c.after?.['groupExternalId'], c.autoApplicable])).toEqual([
      [ext(1), ext(70), false],
      [ext(2), ext(70), false],
    ]);
  });

  it('LINKs a group by name only in the same year with the same kind, else GROUP_NAME_TAKEN', () => {
    const local = slice({ groups: [{ id: loc(70), name: '7A', kind: 'CLASS', academicYearId: YEAR, gradeLevel: 7, ss12000Id: null, updatedAt: new Date() }] });
    expect(only(diff(roster({ groups: [group(ext(70), '7A', 'Klass', [])] }), local).changes, 'GROUP')).toEqual([
      expect.objectContaining({ op: 'LINK', localId: loc(70) }),
    ]);
    expect(codes(diff(roster({ groups: [group(ext(70), '7A', 'Undervisning', [])] }), local).changes)).toEqual(['GROUP_NAME_TAKEN']);
  });

  it('writes nothing into a year that is not active, and flags a group spanning years', () => {
    const future = group(ext(70), '8A', 'Klass', [], { startDate: '2027-08-15', endDate: '2028-06-10' });
    expect(diff(roster({ groups: [future] }), slice()).changes).toEqual([]);
    const spanning = group(ext(71), '7B', 'Klass', [], { startDate: '2025-08-15', endDate: '2028-06-10' });
    expect(diff(roster({ groups: [spanning] }), slice()).changes.map((c) => [c.op, c.conflictCode])).toEqual([
      ['INFO', 'GROUP_SPANS_YEARS'],
      ['CREATE', null],
    ]);
    expect(codes(diff(roster({ groups: [group(ext(72), 'X', 'Klass', [], { startDate: '2030-01-01', endDate: null })] }), slice()).changes)).toEqual(['GROUP_OUTSIDE_YEARS']);
  });

  it('moves a linked pupil into a linked class automatically, keeps an admin\'s recent move, and conflicts on two classes', () => {
    const groups = [{ id: loc(70), name: '7A', kind: 'CLASS' as const, academicYearId: YEAR, gradeLevel: 7, ss12000Id: ext(70), updatedAt: new Date() },
      { id: loc(71), name: '7B', kind: 'CLASS' as const, academicYearId: YEAR, gradeLevel: 7, ss12000Id: ext(71), updatedAt: new Date() }];
    const p = pupil(ext(1), 'Förnamn', 'Efternamn', 'user1@skola.se');
    const moved = diff(roster({ people: [p], groups: [group(ext(70), '7A', 'Klass', [ext(1)])] }), slice({ groups, users: [user(1, { ss12000Id: ext(1), studentGroupId: loc(71) })] }));
    expect(moved.changes).toEqual([expect.objectContaining({ op: 'MOVE', localId: loc(1), autoApplicable: true, selected: true, after: expect.objectContaining({ groupLocalId: loc(70) }) })]);

    const edited = diff(
      roster({ people: [p], groups: [group(ext(70), '7A', 'Klass', [ext(1)])] }),
      slice({ groups, lastAppliedAt: new Date('2026-10-01T00:00:00Z'), users: [user(1, { ss12000Id: ext(1), studentGroupId: loc(71), updatedAt: new Date('2026-10-02T00:00:00Z') })] }),
    );
    expect(edited.changes).toEqual([expect.objectContaining({ op: 'MOVE', conflictCode: 'LOCAL_EDIT_SINCE_LAST_SYNC', selected: false, autoApplicable: false })]);

    const twice = diff(
      roster({ people: [p], groups: [group(ext(70), '7A', 'Klass', [ext(1)]), group(ext(71), '7B', 'Klass', [ext(1)])] }),
      slice({ groups, users: [user(1, { ss12000Id: ext(1), studentGroupId: loc(71) })] }),
    );
    expect(codes(twice.changes)).toEqual(['MEMBERSHIP_MULTIPLE_CLASSES']);
  });

  it('never writes a future year\'s class membership, and keeps a class when no active one is listed', () => {
    const p = pupil(ext(1), 'Förnamn', 'Efternamn', 'user1@skola.se');
    const future = group(ext(80), '8A', 'Klass', [ext(1)], { startDate: '2027-08-15', endDate: '2028-06-10' });
    future.memberships[0]!.startDate = '2026-10-01';
    const result = diff(roster({ people: [p], groups: [future] }), slice({ users: [user(1, { ss12000Id: ext(1), studentGroupId: loc(71) })] }));
    expect(result.changes.filter((c) => c.entity === 'CLASS_MEMBERSHIP')).toEqual([]);
  });

  it('ADDs teaching-group members, and holds one who left at the source for the admin (nothing is removed)', () => {
    const groups = [{ id: loc(90), name: 'Spanska 7', kind: 'TEACHING_GROUP' as const, academicYearId: YEAR, gradeLevel: null, ss12000Id: ext(90), updatedAt: new Date() }];
    const people = [pupil(ext(1), 'Förnamn', 'Efternamn', 'user1@skola.se'), pupil(ext(2), 'Förnamn', 'Efternamn', 'user2@skola.se')];
    const result = diff(
      roster({ people, groups: [group(ext(90), 'Spanska 7', 'Undervisning', [ext(1)])] }),
      slice({
        groups,
        users: [user(1, { ss12000Id: ext(1) }), user(2, { ss12000Id: ext(2) })],
        teachingMembers: [{ studentGroupId: loc(90), studentId: loc(2) }],
      }),
    );
    expect(only(result.changes, 'GROUP_MEMBERSHIP').map((c) => [c.op, c.localId, c.conflictCode, c.autoApplicable])).toEqual([
      ['ADD', loc(1), null, true],
      ['CONFLICT', loc(2), 'MEMBERSHIP_ENDED_AT_SOURCE', false],
    ]);
  });

  it('names a group deletedEntities lists GROUP_DELETED_AT_SOURCE and keeps the link', () => {
    const groups = [{ id: loc(70), name: '7A', kind: 'CLASS' as const, academicYearId: YEAR, gradeLevel: 7, ss12000Id: ext(70), updatedAt: new Date() }];
    const result = diff(roster({ mode: 'INCREMENTAL', deleted: { persons: [], groups: [ext(70)], duties: [] } }), slice({ groups }));
    expect(result.changes).toEqual([expect.objectContaining({ op: 'INFO', conflictCode: 'GROUP_DELETED_AT_SOURCE', localId: loc(70) })]);
  });
});

describe('computeDiff: guardians and duties', () => {
  it('ADDs a guardian link automatically only between two linked, unprotected people', () => {
    const people = [
      adult(ext(10), 'Förnamn', 'Efternamn', 'user10@skola.se', 'Privat'),
      pupil(ext(1), 'Förnamn', 'Efternamn', 'user1@skola.se', { responsibles: [{ personId: ext(10), securityMarking: null, relationType: 'God man' }] }),
    ];
    const linked = slice({ users: [user(1, { ss12000Id: ext(1) }), user(10, { ss12000Id: ext(10), role: 'GUARDIAN' })] });
    expect(diff(roster({ people }), linked).changes).toEqual([
      expect.objectContaining({ entity: 'RESPONSIBLE', op: 'ADD', autoApplicable: true, after: expect.objectContaining({ guardianLocalId: loc(10), relationType: 'God man' }) }),
    ]);
    const fresh = diff(roster({ people }), slice({ users: [user(1, { ss12000Id: ext(1) })] }));
    expect(only(fresh.changes, 'RESPONSIBLE')).toEqual([expect.objectContaining({ op: 'ADD', autoApplicable: false, after: expect.objectContaining({ guardianExternalId: ext(10), guardianLocalId: null }) })]);
  });

  it('calls a responsible the source names but nobody can provision RESPONSIBLE_NOT_PROVISIONED', () => {
    const people = [pupil(ext(1), 'Förnamn', 'Efternamn', 'user1@skola.se', { responsibles: [{ personId: ext(10), securityMarking: null, relationType: null }] })];
    expect(codes(diff(roster({ people }), slice({ users: [user(1, { ss12000Id: ext(1) })] })).changes)).toEqual(['RESPONSIBLE_NOT_PROVISIONED']);
  });

  it('links, updates and ends duty links for teachers, with no HR figure', () => {
    const people = [adult(ext(1), 'Förnamn', 'Efternamn', 'user1@skola.se', 'Skola personal')];
    const local = slice({
      users: [user(1, { role: 'TEACHER', ss12000Id: ext(1) })],
      dutyLinks: [
        { id: loc(500), userId: loc(1), academicYearId: YEAR, ss12000DutyId: ext(51), dutyRole: 'Lärare', startDate: '2026-08-01', endDate: null, ended: false },
        { id: loc(501), userId: loc(1), academicYearId: YEAR, ss12000DutyId: ext(52), dutyRole: 'Lärare', startDate: '2026-08-01', endDate: null, ended: false },
      ],
    });
    const result = diff(roster({ people, duties: [duty(ext(50), ext(1)), duty(ext(51), ext(1), 'Förstelärare')] }), local);
    const links = only(result.changes, 'DUTY_LINK');
    expect(links.map((c) => [c.op, c.externalId, c.autoApplicable])).toEqual([
      ['ADD', ext(50), true],
      ['UPDATE', ext(51), true],
      ['END', ext(52), true],
    ]);
    expect(JSON.stringify(links)).not.toMatch(/dutyPercent|hoursPerYear/);
  });
});

describe('brakeTripped', () => {
  it('trips above max(floor, percent of the linked active people)', () => {
    const five = Array.from({ length: 5 }, () => ({ op: 'DEACTIVATE' as const }));
    expect(brakeTripped(five, 100, 5, 2)).toBe(false);
    expect(brakeTripped([...five, { op: 'DEACTIVATE' }], 100, 5, 2)).toBe(true);
    expect(brakeTripped(Array.from({ length: 30 }, () => ({ op: 'DEACTIVATE' as const })), 1000, 5, 2)).toBe(true);
    expect(brakeTripped(Array.from({ length: 20 }, () => ({ op: 'DEACTIVATE' as const })), 1000, 5, 2)).toBe(false);
  });
});

describe('determinism', () => {
  it('gives the same changes in the same order for the same input', () => {
    const people = [pupil(ext(2), 'B', 'B', 'b@skola.se'), pupil(ext(1), 'A', 'A', 'a@skola.se')];
    const a = diff(roster({ people, groups: [group(ext(70), '7A', 'Klass', [ext(1), ext(2)])] }), slice());
    const b = diff(roster({ people: [...people].reverse(), groups: [group(ext(70), '7A', 'Klass', [ext(2), ext(1)])] }), slice());
    expect(a.changes).toEqual(b.changes);
  });
});
