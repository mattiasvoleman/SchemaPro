import { createPrismaMock, createTxMock } from '../../../test/utils/prisma-mock';
import { ALL_V2_SCOPES, ProviderWorld, W } from '../../../test/utils/ss12000-provider-world';
import type { PrismaService } from '../../database/prisma.service';
import { adhocActivityId } from './ids';
import type { Scope } from './scopes';
import { Ss12000V2Service, type V2Caller } from './ss12000-v2.service';

/**
 * S1's filters, sortkeys, lookups and refusals, resource by resource, on the
 * provider world: what each one keeps and what it answers for an attribute
 * SchemaPro never holds.
 */

const caller = (scopes: readonly string[] = ALL_V2_SCOPES): V2Caller => ({ schoolId: W.school, keyId: W.keyFull, scopes: new Set(scopes as Scope[]) });
const ids = (page: { data: Array<{ id: string }> }) => page.data.map((item) => item.id);
const WINDOW = { 'startTime.onOrAfter': '2026-10-01T00:00:00Z', 'startTime.onOrBefore': '2026-10-31T00:00:00Z' };

function setup() {
  const world = new ProviderWorld();
  const tx = createTxMock();
  world.install(tx);
  const service = new Ss12000V2Service(createPrismaMock(tx) as unknown as PrismaService);
  return { world, service };
}

describe('organisations', () => {
  it('filters on what S1 defines, and answers empty for what SchemaPro never holds', async () => {
    const { service } = setup();
    expect(ids(await service.listOrganisations(caller(), { type: 'Skolenhet', schoolUnitCode: '12345678', schoolTypes: 'GR' }))).toEqual([W.org]);
    for (const raw of [{ type: 'Huvudman' }, { schoolUnitCode: '99999999' }, { schoolTypes: 'GY' }, { organisationCode: 'X' }, { municipalityCode: '0180' }, { 'meta.created.after': '2027-01-01T00:00:00Z' }]) {
      expect({ raw, ids: ids(await service.listOrganisations(caller(), raw)) }).toEqual({ raw, ids: [] });
    }
    expect(ids(await service.listOrganisations(caller(), { 'startDate.onOrAfter': '2030-01-01', sortkey: 'DisplayNameAsc' }))).toEqual([W.org]);
  });

  it('is the school itself under its own id with several skolenheter, and a skolenhet with none', async () => {
    const { world, service } = setup();
    world.identity.organisation_ids = ['aaaaaaaa-0000-4000-8000-0000000000ab', W.org];
    world.identity.school_unit_codes = ['1', '2'];
    const [many] = (await service.listOrganisations(caller(), {})).data;
    expect(many).toMatchObject({ id: W.school, organisationType: 'Skola' });
    expect(many!['schoolUnitCode']).toBeUndefined();
    world.identity.organisation_ids = [];
    world.identity.school_unit_codes = [];
    const [none] = (await service.listOrganisations(caller(), {})).data;
    expect(none).toMatchObject({ id: W.school, organisationType: 'Skolenhet' });
    // Every reference follows.
    expect((await service.getGroup(caller(), W.c7aSource, {}))['organisation']).toEqual({ id: W.school });
  });

  it('looks up by id and by skolenhetskod, and 404s an id it does not hold', async () => {
    const { service } = setup();
    expect((await service.lookupOrganisations(caller(), { schoolUnitCodes: ['12345678'] }, {})).map((o) => o.id)).toEqual([W.org]);
    expect(await service.lookupOrganisations(caller(), { ids: [W.school], organisationCodes: ['x'] }, {})).toEqual([]);
    await expect(service.getOrganisation(caller(), W.school, {})).rejects.toMatchObject({ status: 404 });
    await expect(service.lookupOrganisations(caller(), { ids: 'nope' }, {})).rejects.toMatchObject({ code: 'INVALID_BODY' });
    await expect(service.lookupOrganisations(caller(), null, {})).rejects.toMatchObject({ code: 'INVALID_BODY' });
    await expect(service.lookupOrganisations(caller(), { schoolUnitCodes: [42] }, {})).rejects.toMatchObject({ code: 'INVALID_BODY' });
    await expect(service.lookupOrganisations(caller(), { ids: Array.from({ length: 1001 }, () => W.org) }, {})).rejects.toMatchObject({ code: 'INVALID_BODY' });
  });
});

describe('persons', () => {
  it('relationship filters act on enrolments, duties, guardianship and memberships', async () => {
    const { service } = setup();
    const by = async (raw: Record<string, unknown>) => ids(await service.listPersons(caller(), raw)).sort();
    expect(await by({ 'relationship.entity.type': 'enrolment' })).toEqual([W.p1Source, W.p2, W.p3, W.p4].sort());
    expect(await by({ 'relationship.entity.type': 'duty' })).toEqual([W.t1]);
    expect(await by({ 'relationship.entity.type': 'responsibleFor.enrolment' })).toEqual([W.g1]);
    // An open membership has no endDate, and S1 always includes those.
    expect(await by({ 'relationship.entity.type': 'groupMembership', 'relationship.endDate.onOrBefore': '2026-12-31' })).toEqual([W.p1Source, W.p2, W.p3, W.p4].sort());
    expect(await by({ 'relationship.entity.type': 'groupMembership', 'relationship.startDate.onOrBefore': '2026-01-01' })).toEqual([W.p1Source, W.p4].sort());
    expect(await by({ 'relationship.organisation': W.org, 'relationship.startDate.onOrAfter': '2026-08-17', 'relationship.entity.type': 'enrolment' })).toEqual(
      [W.p1Source, W.p2, W.p3, W.p4].sort(),
    );
    expect(await by({ 'relationship.organisation': 'aaaaaaaa-0000-4000-8000-000000000999' })).toEqual([]);
    expect(await by({ 'relationship.entity.type': 'responsibleFor.placement' })).toEqual([]);
    expect(await by({ eduPersonPrincipalName: 'palle@elev.ekskolan.se' })).toEqual([]);
  });

  it('nameContains: case-insensitive, anywhere, every value in some name (S1\'s example)', async () => {
    const { service } = setup();
    expect(ids(await service.listPersons(caller(), { nameContains: ['Pa', 'gens'] }))).toEqual([W.p1Source]);
    expect(ids(await service.listPersons(caller(), { nameContains: ['PALLE', 'nobody'] }))).toEqual([]);
  });

  it('sorts by every name sortkey, refuses the civic ones, and 404s a guardian for a key without responsibles.read', async () => {
    const { service } = setup();
    const family = ids(await service.listPersons(caller(), { sortkey: 'FamilyNameAsc' }));
    expect(family[0]).toBe(W.admin);
    const givenDesc = (await service.listPersons(caller(), { sortkey: 'GivenNameDesc' })).data.map((p) => p['givenName']);
    expect(givenDesc).toEqual([...givenDesc].sort((a, b) => String(b).localeCompare(String(a), 'sv')));
    for (const sortkey of ['GivenNameAsc', 'FamilyNameDesc', 'DisplayNameAsc', 'ModifiedDesc']) {
      expect((await service.listPersons(caller(), { sortkey })).data).toHaveLength(9);
    }
    await expect(service.listPersons(caller(), { sortkey: 'CivicNoAsc' })).rejects.toMatchObject({ code: 'SORTKEY_NOT_SUPPORTED' });
    await expect(service.getPerson(caller(ALL_V2_SCOPES.filter((s) => s !== 'responsibles.read')), W.g1, {})).rejects.toMatchObject({ status: 404 });
    await expect(service.getPerson(caller(), 'x', {})).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(service.listPersons(caller(['groups.read']), {})).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    await expect(service.listPersons(caller(['persons.read']), { expand: 'duties' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    await expect(service.listPersons(caller(['persons.read']), { expand: 'groupMemberships' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
  });

  it('a guardian\'s responsibleFor and a pupil\'s empty one', async () => {
    const { service } = setup();
    const gun = await service.getPerson(caller(), W.g1, { expand: 'responsibleFor' });
    expect(gun['_embedded']).toEqual({ responsibleFor: [{ person: { id: W.p1Source } }] });
    const palle = await service.getPerson(caller(), W.p1Source, { expand: ['responsibleFor', 'placements', 'ownedPlacements'] });
    expect(palle['_embedded']).toEqual({ responsibleFor: [], placements: [], ownedPlacements: [] });
    const looked = await service.lookupPersons(caller(), { ids: [W.p2, W.p1] }, {});
    expect(looked.map((p) => p.id)).toEqual([W.p2]);
  });
});

describe('groups', () => {
  it('filters on type, school type, organisation and dates, and sorts on every S1 key', async () => {
    const { service } = setup();
    expect(ids(await service.listGroups(caller(), { groupType: 'Undervisning' }))).toEqual([W.ma7]);
    expect(ids(await service.listGroups(caller(), { groupType: ['Mentor'] }))).toEqual([]);
    expect(ids(await service.listGroups(caller(), { schoolTypes: 'GR', 'startDate.onOrAfter': '2026-01-01' })).sort()).toEqual([W.c7aSource, W.c8b].sort());
    expect(ids(await service.listGroups(caller(), { organisation: ['aaaaaaaa-0000-4000-8000-000000000999'] }))).toEqual([]);
    expect(ids(await service.listGroups(caller(), { 'endDate.onOrBefore': '2026-12-31' }))).toEqual([W.c6a]);
    for (const sortkey of ['ModifiedDesc', 'DisplayNameAsc', 'StartDateAsc', 'StartDateDesc', 'EndDateAsc', 'EndDateDesc']) {
      expect((await service.listGroups(caller(), { sortkey })).data).toHaveLength(4);
    }
    expect(ids(await service.listGroups(caller(), { sortkey: 'StartDateAsc', limit: '1' }))).toEqual([W.c6a]);
    expect((await service.lookupGroups(caller(), { ids: [W.ma7] }, { expand: 'assignmentRoles' })).map((g) => g.id)).toEqual([W.ma7]);
    await expect(service.getGroup(caller(), W.c8aFuture, {})).rejects.toMatchObject({ status: 404 });
    await expect(service.getGroup(caller(['groups.read']), W.c8b, { expand: 'assignmentRoles' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    await expect(service.lookupGroups(caller(['groups.read']), { ids: [] }, { expand: 'assignmentRoles' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
  });

  it('the mentor is the class\'s assignmentRole, by Duty', async () => {
    const { service } = setup();
    const group = await service.getGroup(caller(), W.c7aSource, { expand: 'assignmentRoles' });
    expect(group['_embedded']).toEqual({ assignmentRoles: [{ duty: { id: W.emp1 }, assignmentRoleType: 'Mentor', startDate: '2026-08-17', endDate: '2027-06-11' }] });
  });
});

describe('duties', () => {
  it('filters on organisation, role, person and dates; sorts; embeds the person', async () => {
    const { service } = setup();
    expect(ids(await service.listDuties(caller(), { organisation: W.org, dutyRole: 'Lärare', person: W.t1, 'startDate.onOrAfter': '2026-08-01' }))).toEqual([W.emp1]);
    for (const raw of [{ organisation: W.school }, { dutyRole: 'Rektor' }, { person: W.t2 }, { 'endDate.onOrBefore': '2026-12-31' }]) {
      expect({ raw, ids: ids(await service.listDuties(caller(), raw)) }).toEqual({ raw, ids: [] });
    }
    for (const sortkey of ['StartDateAsc', 'StartDateDesc', 'ModifiedDesc']) expect((await service.listDuties(caller(), { sortkey })).data).toHaveLength(1);
    const duty = await service.getDuty(caller(), W.emp1, { expand: 'person' });
    expect((duty['_embedded'] as { person: { id: string } }).person.id).toBe(W.t1);
    expect((await service.lookupDuties(caller(), { ids: [W.emp1, W.duty2Source] }, {})).map((d) => d.id)).toEqual([W.emp1]);
    await expect(service.getDuty(caller(), W.duty2Source, {})).rejects.toMatchObject({ status: 404 });
    await expect(service.listDuties(caller(['duties.read']), { expand: 'person' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    await expect(service.getDuty(caller(['duties.read']), W.emp1, { expand: 'person' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    await expect(service.lookupDuties(caller(['duties.read']), {}, { expand: 'person' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
  });

  it('a teacher whose source duty is linked is served under it, and no duties without an active year', async () => {
    const { world, service } = setup();
    world.dutyLinks.push({ id: '41000000-0000-4000-8000-000000000009', schoolId: W.school, userId: W.t1, academicYearId: W.year, ss12000DutyId: 'dddddddd-0000-4000-8000-000000000001', dutyRole: 'Förstelärare', startDate: new Date('2026-08-17'), endDate: null, endedAt: null });
    expect(ids(await service.listDuties(caller(), {}))).toEqual(['dddddddd-0000-4000-8000-000000000001']);
    for (const year of world.years) year['isActive'] = false;
    expect(ids(await service.listDuties(caller(), {}))).toEqual([]);
    expect(ids(await service.listActivities(caller(), {}))).toEqual([]);
    expect(ids(await service.listSyllabuses(caller(), {}))).toEqual([]);
  });
});

describe('activities', () => {
  it('filters on member, teacher, organisation, group and dates; sorts; looks up by teacher and member', async () => {
    const { service } = setup();
    const adhoc = adhocActivityId(W.l3Adhoc);
    // Through her class 8B and her teaching group Ma7; being named on the ad-hoc lesson is no membership of its group.
    expect(ids(await service.listActivities(caller(), { member: W.p4 })).sort()).toEqual([W.m1, W.m2].sort());
    expect(ids(await service.listActivities(caller(), { member: 'aaaaaaaa-0000-4000-8000-000000000999' }))).toEqual([]);
    expect(ids(await service.listActivities(caller(), { teacher: W.duty2Source }))).toEqual([W.m1]);
    expect(ids(await service.listActivities(caller(), { group: W.ma7 }))).toEqual([W.m1]);
    expect(ids(await service.listActivities(caller(), { group: 'aaaaaaaa-0000-4000-8000-000000000999' }))).toEqual([]);
    expect(ids(await service.listActivities(caller(), { organisation: W.school }))).toEqual([]);
    expect(ids(await service.listActivities(caller(), { 'startDate.onOrAfter': '2026-10-01' }))).toEqual([adhoc]);
    for (const sortkey of ['ModifiedDesc', 'DisplayNameAsc']) expect((await service.listActivities(caller(), { sortkey })).data).toHaveLength(3);
    const looked = await service.lookupActivities(caller(), { teachers: [W.emp1], members: [W.p2] }, {});
    expect(looked.map((a) => a.id).sort()).toEqual([W.m1, adhoc].sort());
    expect((await service.lookupActivities(caller(), { ids: [W.m2] }, { expand: 'syllabus' })).map((a) => a.id)).toEqual([W.m2]);
    await expect(service.getActivity(caller(), W.m3Parked, {})).rejects.toMatchObject({ status: 404 });
    for (const expand of ['groups', 'teachers', 'syllabus']) {
      await expect(service.listActivities(caller(['activities.read']), { expand })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    }
    await expect(service.getActivity(caller(['activities.read']), W.m1, { expand: 'groups' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
  });

  it('names its references only for a key that may read them', async () => {
    const { service } = setup();
    const named = await service.getActivity(caller(), W.m1, { expandReferenceNames: 'true' });
    expect(named['syllabus']).toEqual({ id: W.ma, displayName: 'Matematik' });
    expect((named['groups'] as Array<{ displayName?: string }>)[0]!.displayName).toBe('7A');
    expect((named['teachers'] as Array<{ duty: { displayName?: string } }>)[0]!.duty.displayName).toBe('Tove Lärare');
    const bare = await service.getActivity(caller(['activities.read']), W.m1, { expandReferenceNames: 'true' });
    expect(JSON.stringify(bare)).not.toContain('displayName":"7A');
    expect(bare['syllabus']).toEqual({ id: W.ma });
  });
});

describe('calendar events', () => {
  it('filters on activity, student, teacher, organisation, group and end time; sorts', async () => {
    const { service } = setup();
    const by = async (raw: Record<string, unknown>) => ids(await service.listCalendarEvents(caller(), { ...WINDOW, ...raw })).sort();
    expect(await by({ activity: W.m1 })).toEqual([W.l1, W.l2Substituted].sort());
    expect(await by({ student: W.p4 })).toEqual([W.l1, W.l3Adhoc, W.l5Cancelled].sort());
    expect(await by({ student: 'aaaaaaaa-0000-4000-8000-000000000999' })).toEqual([]);
    expect(await by({ teacher: W.emp1 })).toEqual([W.l1, W.l2Substituted, W.l3Adhoc].sort());
    expect(await by({ group: W.ma7 })).toEqual([W.l1]);
    expect(await by({ group: 'aaaaaaaa-0000-4000-8000-000000000999' })).toEqual([]);
    expect(await by({ organisation: W.school })).toEqual([]);
    expect(await by({ 'endTime.onOrBefore': '2026-10-12T08:00:00Z', 'endTime.onOrAfter': '2026-10-12T00:00:00Z' })).toEqual([W.l1]);
    expect(await by({ 'meta.modified.before': '2026-01-01T00:00:00Z' })).toEqual([]);
    for (const sortkey of ['ModifiedDesc', 'StartTimeAsc', 'StartTimeDesc']) {
      expect((await service.listCalendarEvents(caller(), { ...WINDOW, sortkey })).data).toHaveLength(4);
    }
    expect(ids(await service.listCalendarEvents(caller(), { ...WINDOW, sortkey: 'StartTimeDesc', limit: '1' }))).toEqual([W.l3Adhoc]);
  });

  it('refuses a window backwards or over 400 days, and a lookup of more than it can answer', async () => {
    const { service } = setup();
    await expect(service.listCalendarEvents(caller(), { 'startTime.onOrAfter': '2026-10-31T00:00:00Z', 'startTime.onOrBefore': '2026-10-01T00:00:00Z' })).rejects.toMatchObject({ code: 'INVALID_FILTER' });
    await expect(service.listCalendarEvents(caller(), { 'startTime.onOrAfter': '2026-01-01T00:00:00Z', 'startTime.onOrBefore': '2027-03-01T00:00:00Z' })).rejects.toMatchObject({ code: 'INVALID_FILTER' });
    await expect(service.listCalendarEvents(caller(['calendarEvents.read']), { ...WINDOW, expand: 'activity' })).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    await expect(service.getCalendarEvent(caller(), W.l4Future, {})).rejects.toMatchObject({ status: 404 });
    const byTeacher = await service.lookupCalendarEvents(caller(), { teacher: [W.emp1], student: [W.p4], activities: [adhocActivityId(W.l3Adhoc)] }, {});
    expect(byTeacher.map((e) => e.id).sort()).toEqual([W.l1, W.l2Substituted, W.l3Adhoc, W.l5Cancelled].sort());
    expect(await service.lookupCalendarEvents(caller(), { ids: [] }, {})).toEqual([]);
  });

  it('an event of a DRAFT school\'s deleted template keeps that template as its activity until a publish settles it', async () => {
    const { world, service } = setup();
    world.lessons.find((lesson) => lesson['id'] === W.l3Adhoc)!['masterLessonId'] = null;
    world.pendingRemovals.push({ calendarLessonId: W.l3Adhoc, schoolId: W.school, masterLessonId: W.m2 });
    const event = await service.getCalendarEvent(caller(), W.l3Adhoc, { expand: 'activity', expandReferenceNames: 'true' });
    expect(event['activity']).toEqual({ id: W.m2, displayName: 'Mentorstid — 8B' });
    expect(ids(await service.listActivities(caller(), {}))).not.toContain(adhocActivityId(W.l3Adhoc));
  });
});

describe('rooms, syllabuses and deletions', () => {
  it('rooms filter on their owner and sort', async () => {
    const { service } = setup();
    expect(ids(await service.listRooms(caller(), { organisation: W.org, sortkey: 'DisplayNameAsc' }))).toEqual([W.r2, W.r1]);
    expect(ids(await service.listRooms(caller(), { organisation: W.school }))).toEqual([]);
    expect(ids(await service.listRooms(caller(), { sortkey: 'ModifiedDesc' }))).toEqual([W.r2, W.r1]);
    expect((await service.lookupRooms(caller(), { ids: [W.r1] }, {})).map((r) => r.id)).toEqual([W.r1]);
    await expect(service.getRoom(caller(), W.ma, {})).rejects.toMatchObject({ status: 404 });
  });

  it('syllabuses sort on what is held, refuse what is not, and are not served beside two school forms', async () => {
    const { world, service } = setup();
    for (const sortkey of ['SubjectNameAsc', 'SubjectNameDesc', 'SubjectDesignationAsc', 'SubjectDesignationDesc', 'ModifiedDesc']) {
      expect((await service.listSyllabuses(caller(), { sortkey })).data).toHaveLength(2);
    }
    for (const sortkey of ['SubjectCodeAsc', 'CourseNameDesc', 'CourseCodeAsc']) {
      await expect(service.listSyllabuses(caller(), { sortkey })).rejects.toMatchObject({ code: 'SORTKEY_NOT_SUPPORTED' });
    }
    expect((await service.lookupSyllabuses(caller(), { ids: [W.ma] }, {})).map((s) => s.id)).toEqual([W.ma]);
    await expect(service.getSyllabus(caller(), W.r1, {})).rejects.toMatchObject({ status: 404 });
    world.localTimplans.push({ id: '11000000-0000-4000-8000-000000000002', schoolId: W.school, schoolForm: 'ANPASSAD_GRUNDSKOLA_AMNEN' });
    world.yearTimplans.push({ schoolId: W.school, academicYearId: W.year, gradeLevel: 5, localTimplanId: '11000000-0000-4000-8000-000000000002' });
    expect((await service.listSyllabuses(caller(), {})).data).toEqual([]);
    expect((await service.getActivity(caller(), W.m1, {}))['syllabus']).toBeUndefined();
    const [org] = (await service.listOrganisations(caller(), {})).data;
    expect(org!['schoolTypes']).toEqual(['FKLASS', 'GR', 'GRS']);
  });

  it('deletedEntities needs a read scope, pages by removal time, and translates an ad-hoc activity\'s id', async () => {
    const { service } = setup();
    await expect(service.deletedEntities(caller(['subscriptions.write']), {})).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
    const first = await service.deletedEntities(caller(), { limit: '1' });
    expect(first.data.persons).toEqual([W.p5]);
    const second = await service.deletedEntities(caller(), { pageToken: first.pageToken! });
    expect(second.data.activitites).toEqual([adhocActivityId('80000000-0000-4000-8000-0000000000ff')]);
    const later = await service.deletedEntities(caller(), { after: '2026-10-02T12:00:00Z' });
    expect(later.data.rooms).toEqual(['50000000-0000-4000-8000-0000000000ff']);
    expect(later.data.persons).toEqual([]);
  });
});
