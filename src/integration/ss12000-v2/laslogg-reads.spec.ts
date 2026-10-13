import { V2_READS, type V2Seen } from './ss12000-v2.service';

/*
 * What each SS12000 v2 read records in the läslogg (runRead maps the emitted
 * ids back to Users rows and writes one statement per kind). The resource's
 * own fields first, then whatever its expands embedded: a person, posts,
 * mentorships, whole groups with their members, a person's memberships.
 */

type Obj = Record<string, unknown> & { id: string };

/** Ids per kind, persons and duties apart, empty kinds left out, sorted. */
function seen(read: (items: readonly Obj[]) => V2Seen[], items: Obj[]) {
  const out: Record<string, { persons: string[]; duties: string[] }> = {};
  for (const entry of read(items)) {
    const bucket = (out[entry.kind] ??= { persons: [], duties: [] });
    bucket.persons.push(...(entry.persons ?? []));
    bucket.duties.push(...(entry.duties ?? []));
  }
  for (const [kind, bucket] of Object.entries(out)) {
    if (bucket.persons.length + bucket.duties.length === 0) delete out[kind];
    else {
      bucket.persons.sort();
      bucket.duties.sort();
    }
  }
  return out;
}

const ref = (id: string) => ({ id });

describe('the läslogg of SS12000 v2', () => {
  it('persons: everyone listed, their guardians, and what duties and groupMemberships embed', () => {
    const pupil: Obj = { id: 'p1', responsibles: [{ person: ref('g1') }], _embedded: { groupMemberships: [{ group: ref('grp') }] } };
    const guardian: Obj = { id: 'g1', _embedded: { responsibleFor: [{ person: ref('p1') }], groupMemberships: [] } };
    const teacher: Obj = { id: 't1', _embedded: { duties: [{ id: 'd1', person: ref('t1') }] } };
    expect(seen(V2_READS.persons, [pupil, guardian, teacher])).toEqual({
      PEOPLE: { persons: ['g1', 'p1', 't1'], duties: [] },
      GUARDIANS: { persons: ['g1', 'g1', 'p1', 'p1'], duties: [] },
      EMPLOYMENT: { persons: ['t1'], duties: [] },
      ROSTER: { persons: ['p1'], duties: [] },
    });
  });

  it('groups: their members, and a mentorship embedded by duty', () => {
    const group: Obj = {
      id: 'grp',
      groupMemberships: [{ person: ref('p1') }, { person: ref('p2') }],
      _embedded: { assignmentRoles: [{ duty: ref('d9'), assignmentRoleType: 'Mentor' }] },
    };
    expect(seen(V2_READS.groups, [group])).toEqual({
      ROSTER: { persons: ['p1', 'p2'], duties: [] },
      EMPLOYMENT: { persons: [], duties: ['d9'] },
    });
  });

  it('duties: the post\'s person, and with expand=person the person themselves', () => {
    const duty: Obj = { id: 'd1', person: ref('t1'), _embedded: { person: { id: 't1', givenName: 'Bo' } } };
    expect(seen(V2_READS.duties, [duty, { id: 'd2', person: ref('t2') }])).toEqual({
      EMPLOYMENT: { persons: ['t1', 't2'], duties: [] },
      PEOPLE: { persons: ['t1'], duties: [] },
    });
  });

  it('activities: nothing by reference, and with expand=groups and expand=teachers the groups\' members and the posts', () => {
    const bare: Obj = { id: 'a1', groups: [ref('grp')], teachers: [{ duty: ref('d1') }] };
    expect(seen(V2_READS.activities, [bare])).toEqual({});
    const expanded: Obj = {
      ...bare,
      _embedded: {
        groups: [{ id: 'grp', groupMemberships: [{ person: ref('p1') }, { person: ref('p2') }] }],
        teachers: [{ id: 'd1', person: ref('t1') }],
      },
    };
    expect(seen(V2_READS.activities, [expanded])).toEqual({
      ROSTER: { persons: ['p1', 'p2'], duties: [] },
      EMPLOYMENT: { persons: ['t1'], duties: [] },
    });
  });

  it('calendar events: pupils named outside the groups, and a planned teacher not taking the lesson as an absence', () => {
    const event: Obj = {
      id: 'e1',
      studentExceptions: [{ student: ref('p3'), participates: true }],
      teacherExceptions: [
        { duty: ref('d1'), participates: false },
        { duty: ref('d2'), participates: true },
      ],
      _embedded: { activity: { id: 'a1', teachers: [{ duty: ref('d1') }] } },
    };
    expect(seen(V2_READS.calendarEvents, [event])).toEqual({
      ROSTER: { persons: ['p3'], duties: [] },
      STAFF_ABSENCES: { persons: [], duties: ['d1'] },
    });
  });
});
