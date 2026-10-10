import { createPrismaMock, createTxMock } from '../../../test/utils/prisma-mock';
import { allKeys, checkSchema } from '../../../test/utils/s1-contract';
import { ABSENCE_TEXT, ALL_V2_SCOPES, ProviderWorld, W } from '../../../test/utils/ss12000-provider-world';
import type { PrismaService } from '../../database/prisma.service';
import { DUTY_PROPERTIES } from '../ss12000-duties';
import { adhocActivityId } from './ids';
import { S1_SCHEMAS, S1_SHA256, S1_VERSION } from './s1-provider.generated';
import type { Scope } from './scopes';
import { Ss12000V2Service, type V2Caller } from './ss12000-v2.service';

/**
 * Every object the v2.0 provider emits, built by the real service from the
 * provider world, walked against S1 (s1-provider.generated.ts, generated
 * from SIS's openapi_ss12000_version2_1_0.yaml): no key S1 does not define,
 * every required key present, enum values valid, uuid/date/date-time/email
 * formats right. Plus the privacy invariants that are properties of the
 * output itself.
 */

const caller = (scopes: readonly string[] = ALL_V2_SCOPES): V2Caller => ({
  schoolId: W.school,
  keyId: W.keyFull,
  scopes: new Set(scopes as Scope[]),
});

function setup() {
  const world = new ProviderWorld();
  const tx = createTxMock();
  world.install(tx);
  const prisma = createPrismaMock(tx);
  const service = new Ss12000V2Service(prisma as unknown as PrismaService);
  return { world, service, prisma };
}

const WINDOW = { 'startTime.onOrAfter': '2026-10-01T00:00:00Z', 'startTime.onOrBefore': '2026-10-31T00:00:00Z' };

describe('S1 transcription', () => {
  it('is generated from the YAML the consumer was written against', () => {
    expect(S1_VERSION).toBe('2.1.0');
    expect(S1_SHA256).toBe('aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28');
    // S1's own spellings, kept.
    expect(S1_SCHEMAS['DeletedEntities_data']!.properties).toHaveProperty('activitites');
    expect(S1_SCHEMAS['_subscriptions_get_request']!.properties).toHaveProperty('modifiedEntites');
  });

  it('v1 /duties and v2 /duties describe the same Duty', () => {
    expect(Object.keys(S1_SCHEMAS['Duty']!.properties).sort()).toEqual([...DUTY_PROPERTIES].sort());
  });
});

describe('every v2 object is S1-shaped', () => {
  it('lists, with every expand and referenced names', async () => {
    const { service } = setup();
    const all = caller();
    const cases: Array<[string, Promise<unknown>]> = [
      ['Organisations', service.listOrganisations(all, { expandReferenceNames: 'true' })],
      ['PersonsExpanded', service.listPersons(all, { expand: ['duties', 'responsibleFor', 'placements', 'ownedPlacements', 'groupMemberships'], expandReferenceNames: 'true' })],
      ['GroupsExpanded', service.listGroups(all, { expand: 'assignmentRoles', expandReferenceNames: 'true' })],
      ['Duties', service.listDuties(all, { expand: 'person', expandReferenceNames: 'true' })],
      ['Activities', service.listActivities(all, { expand: ['groups', 'teachers', 'syllabus'], expandReferenceNames: 'true' })],
      ['CalendarEvents', service.listCalendarEvents(all, { ...WINDOW, expand: 'activity', expandReferenceNames: 'true' })],
      ['Rooms', service.listRooms(all, { expandReferenceNames: 'true' })],
      ['Syllabuses', service.listSyllabuses(all, {})],
      ['DeletedEntities', service.deletedEntities(all, {})],
    ];
    for (const [schema, pending] of cases) {
      const body = await pending;
      expect({ schema, violations: checkSchema(body, schema) }).toEqual({ schema, violations: [] });
      expect((body as { data: unknown }).data).toBeTruthy();
    }
  });

  it('items and lookups', async () => {
    const { service } = setup();
    const all = caller();
    expect(checkSchema(await service.getPerson(all, W.p1Source, { expand: 'duties' }), 'PersonExpanded')).toEqual([]);
    expect(checkSchema(await service.getGroup(all, W.c7aSource, {}), 'GroupExpanded')).toEqual([]);
    expect(checkSchema(await service.getActivity(all, W.m1, {}), 'ActivityExpanded')).toEqual([]);
    expect(checkSchema(await service.getCalendarEvent(all, W.l1, {}), 'CalendarEvent')).toEqual([]);
    expect(checkSchema(await service.getRoom(all, W.r1, {}), 'Room')).toEqual([]);
    expect(checkSchema(await service.getSyllabus(all, W.ma, {}), 'Syllabus')).toEqual([]);
    expect(checkSchema(await service.getOrganisation(all, W.org, {}), 'Organisation')).toEqual([]);
    expect(checkSchema(await service.getDuty(all, W.emp1, {}), 'DutyExpanded')).toEqual([]);
    for (const item of await service.lookupCalendarEvents(all, { activities: [W.m1] }, {})) {
      expect(checkSchema(item, 'CalendarEvent')).toEqual([]);
    }
  });
});

describe('what the objects say', () => {
  it('a linked person and group are emitted under the source\'s ids; ids of any uuid version are accepted', async () => {
    const { service } = setup();
    const persons = await service.listPersons(caller(), {});
    const ids = persons.data.map((person) => person.id);
    expect(ids).toContain(W.p1Source);
    expect(ids).not.toContain(W.p1);
    expect((await service.getPerson(caller(), W.p1Source.toUpperCase(), {})).id).toBe(W.p1Source);
    const group = await service.getGroup(caller(), W.c7aSource, {});
    expect(group['displayName']).toBe('7A');
    const p1 = persons.data.find((person) => person.id === W.p1Source)!;
    expect(p1['responsibles']).toEqual([{ person: { id: W.g1 } }]);
  });

  it('an enrolment starts where the pupil\'s unbroken chain starts, not at the last class move', async () => {
    const { service } = setup();
    const p3 = await service.getPerson(caller(), W.p3, {});
    expect(p3['enrolments']).toEqual([{ enroledAt: { id: W.org }, schoolYear: 8, schoolType: 'GR', startDate: '2026-08-17' }]);
  });

  it('a class lists its segments with S1\'s inclusive end, and an open one without', async () => {
    const { service } = setup();
    const group = await service.getGroup(caller(), W.c7aSource, {});
    expect(group['groupMemberships']).toEqual(
      expect.arrayContaining([
        { person: { id: W.p3 }, startDate: '2026-08-17', endDate: '2026-09-20' },
        { person: { id: W.p1Source }, startDate: '2026-08-17' },
      ]),
    );
    // The deactivated pupil is no member of anything emitted.
    expect(JSON.stringify(group)).not.toContain(W.p5);
  });

  it('no future year leaves: its groups and its lessons are not emitted', async () => {
    const { service } = setup();
    const groups = await service.listGroups(caller(), {});
    expect(groups.data.map((group) => group.id)).not.toContain(W.c8aFuture);
    expect(groups.data.map((group) => group.id)).toContain(W.c6a);
    const events = await service.listCalendarEvents(caller(), WINDOW);
    expect(events.data.map((event) => event.id)).not.toContain(W.l4Future);
  });

  it('an ad-hoc lesson\'s Activity has a UUIDv5 of its own, never the event\'s id', async () => {
    const { service } = setup();
    const event = await service.getCalendarEvent(caller(), W.l3Adhoc, {});
    const activityId = (event['activity'] as { id: string }).id;
    expect(activityId).toBe(adhocActivityId(W.l3Adhoc));
    expect(activityId).not.toBe(W.l3Adhoc);
    const activity = await service.getActivity(caller(), activityId, {});
    expect(activity).toMatchObject({ calendarEventsRequired: false, startDate: '2026-10-14', endDate: '2026-10-14' });
  });

  it('teachers are referenced by their Duty: a post\'s id, a link-only teacher\'s source duty id, nobody without either', async () => {
    const { service } = setup();
    const activity = await service.getActivity(caller(), W.m1, {});
    expect(activity['teachers']).toEqual([{ duty: { id: W.emp1 } }, { duty: { id: W.duty2Source } }]);
    const mentorstid = await service.getActivity(caller(), W.m2, {});
    expect(mentorstid['teachers']).toBeUndefined();
    expect(mentorstid['activityType']).toBe('Elevaktivitet');
    // /duties serves the posts only.
    const duties = await service.listDuties(caller(), {});
    expect(duties.data.map((duty) => duty.id)).toEqual([W.emp1]);
  });

  it('a substitution is the fact only: the vikarie participates, the planned teachers do not', async () => {
    const { service } = setup();
    const event = await service.getCalendarEvent(caller(), W.l2Substituted, {});
    expect(event['teacherExceptions']).toEqual(
      expect.arrayContaining([
        { duty: { id: W.emp1 }, participates: false },
        { duty: { id: W.duty2Source }, participates: false },
      ]),
    );
    // Tea has neither post nor link: she is left out, not invented.
    expect(JSON.stringify(event)).not.toContain(W.t3);
  });

  it('a pupil named on a lesson outside its groups is a studentException', async () => {
    const { service } = setup();
    const adhoc = await service.getCalendarEvent(caller(), W.l3Adhoc, {});
    expect(adhoc['studentExceptions']).toEqual([{ student: { id: W.p4 }, participates: true }]);
    const l1 = await service.getCalendarEvent(caller(), W.l1, {});
    // P2 sits in 7A, the lesson's own group: no exception.
    expect(l1['studentExceptions']).toBeUndefined();
  });
});

describe('privacy, as properties of the output', () => {
  it('no absence reason, note, cause, HR figure, personnummer or EPPN in any answer', async () => {
    const { service } = setup();
    const all = caller();
    const bodies = [
      await service.listCalendarEvents(all, { ...WINDOW, expand: 'activity' }),
      await service.listPersons(all, { expand: ['duties', 'responsibleFor', 'groupMemberships'] }),
      await service.listDuties(all, { expand: 'person' }),
      await service.listActivities(all, { expand: ['teachers', 'groups', 'syllabus'] }),
      await service.listGroups(all, { expand: 'assignmentRoles' }),
    ];
    const text = JSON.stringify(bodies);
    expect(text).not.toContain(ABSENCE_TEXT);
    expect(text).not.toContain('Nedsättning');
    expect(text).not.toContain('070-1234567');
    const keys = allKeys(bodies);
    for (const key of ['note', 'cancelCause', 'reductionPercent', 'teachingTargetMinutesPerWeek', 'dutyPercent', 'hoursPerYear', 'civicNo', 'eduPersonPrincipalNames', 'phoneNumbers', 'securityMarking', 'relationType', 'minutesPlanned', 'comment']) {
      expect({ key, present: keys.has(key) }).toEqual({ key, present: false });
    }
  });

  it('dutyPercent leaves only under the school\'s Fas 3 opt-in, and never the nedsättning', async () => {
    const { service, world } = setup();
    world.policy['shareEmploymentWithIntegrations'] = true;
    const [duty] = (await service.listDuties(caller(), {})).data;
    expect(duty).toMatchObject({ dutyPercent: 80, hoursPerYear: Math.round((1767 * 80) / 100) });
    expect(JSON.stringify(duty)).not.toContain('reduction');
  });

  it('guardians and every responsibles[] exist only for a key with responsibles.read', async () => {
    const { service } = setup();
    const without = caller(ALL_V2_SCOPES.filter((scope) => scope !== 'responsibles.read'));
    const persons = await service.listPersons(without, {});
    expect(persons.data.map((person) => person.id)).not.toContain(W.g1);
    expect(allKeys(persons).has('responsibles')).toBe(false);
    expect(JSON.stringify(persons)).not.toContain('gun@privat.se');
    await expect(service.listPersons(without, { expand: 'responsibleFor' })).rejects.toMatchObject({ status: 403, code: 'SCOPE_MISSING' });
  });

  it('a referenced name needs the referenced resource\'s scope (A5.8)', async () => {
    const { service } = setup();
    const groupsOnly = caller(['groups.read']);
    const groups = await service.listGroups(groupsOnly, { expandReferenceNames: 'true' });
    const members = groups.data.flatMap((group) => (group['groupMemberships'] as Array<{ person: Record<string, unknown> }> | undefined) ?? []);
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => member.person['displayName'] === undefined)).toBe(true);
    expect(JSON.stringify(groups)).not.toContain('Girgensohn');
    // The organisation's name needs organisations.read too.
    expect((groups.data[0]!['organisation'] as Record<string, unknown>)['displayName']).toBeUndefined();
    await expect(service.listGroups(groupsOnly, { expand: 'assignmentRoles' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    const full = await service.listGroups(caller(), { expandReferenceNames: 'true' });
    expect(JSON.stringify(full)).toContain('Girgensohn');
  });

  it('a DRAFT school emits the published grundschema, never the draft', async () => {
    const { service, world } = setup();
    world.publishMode = 'DRAFT';
    world.publications.push({ id: 'pub-1', schoolId: W.school, academicYearId: W.year, publishedAt: new Date('2026-09-01T08:00:00Z') });
    world.snapshotRanges.push({ id: 'pub-1', publishedAt: new Date('2026-09-01T08:00:00Z'), validFrom: new Date('2026-08-17'), validTo: new Date('2027-06-11') });
    world.publishedLessons.push({
      id: 'pl-1', schoolId: W.school, publicationId: 'pub-1', academicYearId: W.year, masterLessonId: W.m2, subjectId: W.mentorstid,
      studentGroupId: W.c8b, teacherId: W.t1, coTeacherId: null, roomId: null, dayOfWeek: 2, startTime: new Date('1970-01-01T08:00:00Z'),
      endTime: new Date('1970-01-01T09:00:00Z'), isLocked: false, isGenerated: false, isParked: false, recurrence: 'ALL_WEEKS',
      startDate: null, endDate: null, extraGroupIds: [], studentIds: [],
    });
    const activities = await service.listActivities(caller(), {});
    const ids = activities.data.map((activity) => activity.id);
    expect(ids).toContain(W.m2);
    expect(ids).not.toContain(W.m1); // a draft master the snapshot does not hold
    const m2 = activities.data.find((activity) => activity.id === W.m2)!;
    // The published teacher, not the draft's (T3); meta from the publication.
    expect(m2['teachers']).toEqual([{ duty: { id: W.emp1 } }]);
    expect((m2['meta'] as { modified: string }).modified).toBe('2026-09-01T08:00:00.000Z');
  });
});
