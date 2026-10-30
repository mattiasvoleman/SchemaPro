import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock } from '../../../test/utils/prisma-mock';
import { recordedReads } from '../../../test/utils/recorded-reads';
import { lessonNamed, PUPIL_LIST, pupilNamed, WITH_SVA, WITHOUT } from '../../../test/utils/pupil-list';
import { ALL_V2_SCOPES, ProviderWorld, W } from '../../../test/utils/ss12000-provider-world';
import type { PrismaService } from '../../database/prisma.service';
import { adhocActivityId, dutyStretchId } from './ids';
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

describe("a huvudman's key (Huvudman, 20261212090000)", () => {
  it('answers 409 HUVUDMAN_CHANGED when the school left, or the key was revoked, after the guard read them', async () => {
    const tx = createTxMock();
    new ProviderWorld().install(tx);
    const prisma = createPrismaMock(tx) as unknown as Record<string, unknown>;
    const refused = new Prisma.PrismaClientKnownRequestError('HUVUDMAN_KEY_DOES_NOT_READ_THE_SCHOOL', {
      code: 'P2039',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { originalCode: 'HM403', originalMessage: 'HUVUDMAN_KEY_DOES_NOT_READ_THE_SCHOOL' } } },
    });
    prisma['withHuvudmanKeyPrincipal'] = jest.fn().mockRejectedValue(refused);
    const service = new Ss12000V2Service(prisma as unknown as PrismaService);

    await expect(service.listPersons({ ...caller(), viaHuvudman: true }, {})).rejects.toMatchObject({ status: 409, code: 'HUVUDMAN_CHANGED' });
    // Anything else is what it was.
    prisma['withHuvudmanKeyPrincipal'] = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(service.listPersons({ ...caller(), viaHuvudman: true }, {})).rejects.toThrow('boom');
  });
});

describe('organisations', () => {
  it('filters on what S1 defines, and answers empty for what SchemaPro never holds', async () => {
    const { service } = setup();
    expect(ids(await service.listOrganisations(caller(), { type: 'Skolenhet', schoolUnitCode: '12345678', schoolTypes: 'GR' }))).toEqual([W.org]);
    for (const raw of [{ type: 'Huvudman' }, { schoolUnitCode: '99999999' }, { schoolTypes: 'GY' }, { organisationCode: 'X' }, { municipalityCode: '0180' }, { 'meta.created.after': '2027-01-01T00:00:00Z' }]) {
      expect({ raw, ids: ids(await service.listOrganisations(caller(), raw)) }).toEqual({ raw, ids: [] });
    }
    expect(ids(await service.listOrganisations(caller(), { 'startDate.onOrAfter': '2030-01-01', sortkey: 'DisplayNameAsc' }))).toEqual([W.org]);
  });

  it('without skolenheter is the school itself under its own id with several chosen (a Skola) and with none (a Skolenhet), as before units', async () => {
    const { world, service } = setup();
    world.identity.organisation_ids = ['aaaaaaaa-0000-4000-8000-0000000000ab', W.org];
    world.identity.school_unit_codes = ['1', '2'];
    const [many] = (await service.listOrganisations(caller(), {})).data;
    expect(many).toMatchObject({ id: W.school, organisationType: 'Skola' });
    expect(many!['schoolUnitCode']).toBeUndefined();
    // S1: schoolTypes "Anges endast för organisationselement typen Skolenhet".
    expect(many!['schoolTypes']).toBeUndefined();
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

describe('skolenheter', () => {
  const F6 = 'aaaaaaaa-0000-4000-8000-0000000000f6';
  const U79 = 'aaaaaaaa-0000-4000-8000-000000000079';
  const unit = (id: string, name: string, code: string | null, gradeFrom: number | null, gradeTo: number | null, schoolTypes: string[], ss12000Id: string | null) => ({
    id, schoolId: W.school, name, code, gradeFrom, gradeTo, schoolTypes, ss12000Id,
    createdAt: new Date('2026-09-01T08:00:00Z'), updatedAt: new Date('2026-09-02T08:00:00Z'),
  });
  function split() {
    const { world, service } = setup();
    // F–6 linked to the source's skolenhet, 7–9 SchemaPro's own and without skolformer.
    world.units.push(unit(F6, 'Ekskolan F–6', '11111111', 0, 6, ['FKLASS', 'GR'], W.org), unit(U79, 'Ekskolan 7–9', '22222222', 7, 9, [], null));
    return { world, service };
  }

  it('emits one Skolenhet per unit, under the source id once linked, with its code and skolformer', async () => {
    const { service } = split();
    const organisations = (await service.listOrganisations(caller(), { sortkey: 'DisplayNameAsc' })).data;
    expect(organisations).toEqual([
      // No skolformer of its own: the active year's timplans for 7–9.
      expect.objectContaining({ id: U79, displayName: 'Ekskolan 7–9', organisationType: 'Skolenhet', schoolUnitCode: '22222222', schoolTypes: ['GR'] }),
      expect.objectContaining({ id: W.org, displayName: 'Ekskolan F–6', organisationType: 'Skolenhet', schoolUnitCode: '11111111', schoolTypes: ['FKLASS', 'GR'] }),
    ]);
    expect(ids(await service.listOrganisations(caller(), { schoolUnitCode: '22222222' }))).toEqual([U79]);
    expect(ids(await service.listOrganisations(caller(), { schoolTypes: 'FKLASS' }))).toEqual([W.org]);
    expect((await service.lookupOrganisations(caller(), { schoolUnitCodes: ['11111111'] }, {})).map((o) => o.id)).toEqual([W.org]);
    await expect(service.getOrganisation(caller(), W.school, {})).rejects.toMatchObject({ status: 404 });
  });

  it("dates a unit by the later of its own version and the school's", async () => {
    const { world, service } = split();
    const at = (iso: string) => new Date(iso);
    world.versions.push(
      { schoolId: W.school, resource: 'Organisation', entityId: W.school, createdAt: at('2026-10-01T08:00:00Z'), modifiedAt: at('2026-10-05T08:00:00Z') },
      { schoolId: W.school, resource: 'Organisation', entityId: U79, createdAt: at('2026-09-01T08:00:00Z'), modifiedAt: at('2026-10-09T08:00:00Z') },
      { schoolId: W.school, resource: 'Organisation', entityId: F6, createdAt: at('2026-09-01T08:00:00Z'), modifiedAt: at('2026-09-03T08:00:00Z') },
    );
    const modified = Object.fromEntries((await service.listOrganisations(caller(), {})).data.map((o) => [o.id, (o['meta'] as { modified: string }).modified]));
    expect(modified).toEqual({ [U79]: '2026-10-09T08:00:00.000Z', [W.org]: '2026-10-05T08:00:00.000Z' });
  });

  it('puts a class, its pupils, its activities and its lessons in the unit holding its årskurs', async () => {
    const { service } = split();
    const names = { expandReferenceNames: 'true' };
    expect((await service.getGroup(caller(), W.c7aSource, names))['organisation']).toEqual({ id: U79, displayName: 'Ekskolan 7–9' });
    // An undervisningsgrupp without an årskurs is the first unit's.
    expect((await service.getGroup(caller(), W.ma7, {}))['organisation']).toEqual({ id: W.org });
    expect(ids(await service.listGroups(caller(), { organisation: U79 })).sort()).toEqual([W.c7aSource, W.c8b].sort());
    const [p1] = (await service.lookupPersons(caller(), { ids: [W.p1Source] }, {}));
    expect((p1!['enrolments'] as Array<{ enroledAt: { id: string } }>)[0]!.enroledAt).toEqual({ id: U79 });
    const by = async (raw: Record<string, unknown>) => ids(await service.listPersons(caller(), raw)).sort();
    expect(await by({ 'relationship.organisation': U79, 'relationship.entity.type': 'enrolment' })).toEqual([W.p1Source, W.p2, W.p3, W.p4].sort());
    expect(await by({ 'relationship.organisation': W.org, 'relationship.entity.type': 'enrolment' })).toEqual([]);
    expect(ids(await service.listActivities(caller(), { organisation: U79 })).sort()).toEqual([W.m1, W.m2, adhocActivityId(W.l3Adhoc)].sort());
    expect(ids(await service.listActivities(caller(), { organisation: W.org }))).toEqual([]);
    expect(ids(await service.listCalendarEvents(caller(), { ...WINDOW, organisation: W.org }))).toEqual([]);
    expect(ids(await service.listCalendarEvents(caller(), { ...WINDOW, organisation: U79 })).length).toBeGreaterThan(0);
  });

  it('places a duty at its mentor class\'s unit, else the first, and a room with the first', async () => {
    const { world, service } = split();
    expect((await service.getDuty(caller(), W.emp1, {}))['dutyAt']).toEqual({ id: U79 });
    expect(ids(await service.listDuties(caller(), { organisation: U79 }))).toEqual([W.emp1]);
    expect((await service.getRoom(caller(), W.r1, {}))['owner']).toEqual({ id: W.org });
    expect(ids(await service.listRooms(caller(), { organisation: U79 }))).toEqual([]);
    expect(ids(await service.listRooms(caller(), { organisation: W.org })).sort()).toEqual([W.r1, W.r2].sort());
    // No mentor class: the first unit.
    world.mentorships.length = 0;
    expect((await service.getDuty(caller(), W.emp1, {}))['dutyAt']).toEqual({ id: W.org });
  });

  // SFS 2025:729: a tioårig läsår's årskurs is one higher than the same
  // åldersband's in the nioårig numbering a unit's span is stated in, and
  // övergångsbestämmelse 5 reads the span one up, an åk 1 approval also for
  // the new åk 1 and one for förskoleklass alone lapsing (unitSpanIn): F–6 is
  // 1–7, 7–9 is 8–10. Each row is read in its own läsår's numbering.
  const tioarig = (world: ProviderWorld, yearId: string = W.year) => {
    world.years.find((year) => year['id'] === yearId)!['gradeNumbering'] = 'TIOARIG';
  };

  it('a tioårig läsår puts 7A — the nioåriga 6:orna — in F–6 with its pupils, activities, events, mentor and närvaro; 8B stays in 7–9', async () => {
    const { world, service } = split();
    tioarig(world);
    world.attendanceShared = true;
    expect((await service.getGroup(caller(), W.c7aSource, {}))['organisation']).toEqual({ id: W.org });
    expect((await service.getGroup(caller(), W.c8b, {}))['organisation']).toEqual({ id: U79 });
    expect(ids(await service.listGroups(caller(), { organisation: U79 }))).toEqual([W.c8b]);
    // The pupil's schoolYear stays the läsår's own: 7, not the nioåriga 6.
    const [p1] = await service.lookupPersons(caller(), { ids: [W.p1Source] }, {});
    expect(p1!['enrolments']).toEqual([expect.objectContaining({ enroledAt: { id: W.org }, schoolYear: 7 })]);
    const by = async (raw: Record<string, unknown>) => ids(await service.listPersons(caller(), raw)).sort();
    expect(await by({ 'relationship.organisation': U79, 'relationship.entity.type': 'enrolment' })).toEqual([W.p3, W.p4].sort());
    expect(await by({ 'relationship.organisation': W.org, 'relationship.entity.type': 'enrolment' })).toEqual([W.p1Source, W.p2].sort());
    expect(ids(await service.listActivities(caller(), { organisation: U79 }))).toEqual([W.m2]);
    expect(ids(await service.listActivities(caller(), { organisation: W.org })).sort()).toEqual([W.m1, adhocActivityId(W.l3Adhoc)].sort());
    expect(ids(await service.listCalendarEvents(caller(), { ...WINDOW, organisation: U79 }))).toEqual([W.l5Cancelled]);
    expect(ids(await service.listCalendarEvents(caller(), { ...WINDOW, organisation: W.org })).sort()).toEqual([W.l1, W.l2Substituted, W.l3Adhoc].sort());
    // Tove mentors 7A: her Duty is at F–6 now.
    expect((await service.getDuty(caller(), W.emp1, {}))['dutyAt']).toEqual({ id: W.org });
    expect(ids(await service.listDuties(caller(), { organisation: U79 }))).toEqual([]);
    // Närvaro and frånvaro by organisation follow the class.
    expect(ids(await service.listAttendances(caller(), { organisation: U79 }))).toEqual([]);
    expect(ids(await service.listAttendances(caller(), { organisation: W.org })).sort()).toEqual(
      [W.attPresent, W.attLate, W.attExcused, W.attAbsent, W.attUnknown].sort(),
    );
    expect(ids(await service.listAbsences(caller(), { organisation: U79 }))).toEqual([W.absGranted]);
    expect(ids(await service.listAbsences(caller(), { organisation: W.org })).sort()).toEqual([W.absSick, W.absHours, W.absForged].sort());
  });

  it('reads each class in its own läsår\'s numbering: last year\'s nioåriga 7C is 7–9\'s beside this tioårig 7A, and a tioårig läsår ahead moves nothing now', async () => {
    const C7C = '30000000-0000-4000-8000-000000000097';
    const { world, service } = split();
    world.groups.push({
      id: C7C, schoolId: W.school, academicYearId: W.pastYear, name: '7C', kind: 'CLASS', gradeLevel: 7, ss12000Id: null,
      createdAt: new Date('2025-05-01T08:00:00Z'), updatedAt: new Date('2025-05-02T08:00:00Z'),
    });
    tioarig(world, W.futureYear);
    expect((await service.getGroup(caller(), W.c7aSource, {}))['organisation']).toEqual({ id: U79 });
    expect((await service.getGroup(caller(), C7C, {}))['organisation']).toEqual({ id: U79 });
    tioarig(world, W.year);
    expect((await service.getGroup(caller(), W.c7aSource, {}))['organisation']).toEqual({ id: W.org });
    expect((await service.getGroup(caller(), C7C, {}))['organisation']).toEqual({ id: U79 });
  });

  it('derives a tioårig läsår\'s skolformer over the span övergångsbestämmelse 5 reads, an F unit holding none, and keeps the nioårig order for the first unit', async () => {
    const F0 = 'aaaaaaaa-0000-4000-8000-0000000000f0';
    const U16 = 'aaaaaaaa-0000-4000-8000-000000000016';
    const C1A = '30000000-0000-4000-8000-000000000091';
    const SP_PLAN = '11000000-0000-4000-8000-000000000003';
    const { world, service } = setup();
    // No skolformer of their own: each derives them from the active year's timplans.
    world.units.push(
      unit(F0, 'Ekskolan F', '10000000', 0, 0, [], null),
      unit(U16, 'Ekskolan 1–6', '11111111', 1, 6, [], W.org),
      unit(U79, 'Ekskolan 7–9', '22222222', 7, 9, [], null),
    );
    // A row for 10 the nioåriga 7–9 never reads and the tioåriga 8–10 does.
    world.localTimplans.push({ id: SP_PLAN, schoolId: W.school, schoolForm: 'SPECIALSKOLA' });
    world.yearTimplans.push({ schoolId: W.school, academicYearId: W.year, gradeLevel: 10, localTimplanId: SP_PLAN });
    world.groups.push({
      id: C1A, schoolId: W.school, academicYearId: W.year, name: '1A', kind: 'CLASS', gradeLevel: 1, ss12000Id: null,
      createdAt: new Date('2026-05-01T08:00:00Z'), updatedAt: new Date('2026-05-02T08:00:00Z'),
    });
    const typesOf = async () =>
      Object.fromEntries((await service.listOrganisations(caller(), {})).data.map((o) => [o.id, o['schoolTypes'] ?? null]));
    expect(await typesOf()).toEqual({ [F0]: ['FKLASS'], [W.org]: ['GR'], [U79]: ['GR'] });
    tioarig(world);
    // The world keeps its förskoleklass row; the F unit reads none of it.
    expect(await typesOf()).toEqual({ [F0]: null, [W.org]: ['GR'], [U79]: ['GR', 'SP'] });
    // The new åk 1 is the 1–6 unit's, not the F unit's (not toNioarig at the bottom).
    expect((await service.getGroup(caller(), C1A, {}))['organisation']).toEqual({ id: W.org });
    expect((await service.getGroup(caller(), W.c7aSource, {}))['organisation']).toEqual({ id: W.org });
    // What no span holds is still the first unit's — F, first in the nioårig order, though it holds nothing now.
    expect((await service.getGroup(caller(), W.ma7, {}))['organisation']).toEqual({ id: F0 });
    expect((await service.getRoom(caller(), W.r1, {}))['owner']).toEqual({ id: F0 });
  });

  it('a nioårig läsår, stated or left out, answers exactly as before', async () => {
    const answers = async (service: Ss12000V2Service) =>
      JSON.stringify([
        (await service.listOrganisations(caller(), {})).data,
        (await service.listGroups(caller(), {})).data,
        (await service.listPersons(caller(), {})).data,
        (await service.listDuties(caller(), {})).data,
        (await service.listActivities(caller(), {})).data,
        (await service.listCalendarEvents(caller(), WINDOW)).data,
      ]);
    const absent = split();
    const stated = split();
    for (const year of stated.world.years) year['gradeNumbering'] = 'NIOARIG';
    const before = await answers(absent.service);
    expect(before).toContain(U79);
    expect(await answers(stated.service)).toBe(before);
  });

  it("a tioårig läsår moves every relationship with the class: memberships, a guardian's responsibleFor and the mentor's duty", async () => {
    const { world, service } = split();
    const by = async (organisation: string, type: string) =>
      ids(await service.listPersons(caller(), { 'relationship.organisation': organisation, 'relationship.entity.type': type })).sort();
    // Nioårig: 7A and 8B are both 7–9's; Ma7, without an årskurs, the first unit's.
    expect(await by(U79, 'groupMembership')).toEqual([W.p1Source, W.p2, W.p3, W.p4].sort());
    expect(await by(U79, 'responsibleFor.enrolment')).toEqual([W.g1]);
    expect(await by(U79, 'duty')).toEqual([W.t1]);
    tioarig(world);
    // 7A — Palle, Petra, and Pelle before his move — is F–6's; 8B stays 7–9's.
    expect(await by(U79, 'groupMembership')).toEqual([W.p3, W.p4].sort());
    expect(await by(W.org, 'groupMembership')).toEqual([W.p1Source, W.p2, W.p3, W.p4].sort());
    // Gun answers for Palle in 7A, and Tove mentors it.
    expect(await by(U79, 'responsibleFor.enrolment')).toEqual([]);
    expect(await by(W.org, 'responsibleFor.enrolment')).toEqual([W.g1]);
    expect(await by(U79, 'duty')).toEqual([]);
    expect(await by(W.org, 'duty')).toEqual([W.t1]);
  });

  it("one answer holds both läsår's classes, each read in its own numbering: last year's nioåriga 7C and its pupil at 7–9 beside this tioårig 7A at F–6", async () => {
    const C7C = '30000000-0000-4000-8000-000000000098';
    const { world, service } = split();
    world.groups.push({
      id: C7C, schoolId: W.school, academicYearId: W.pastYear, name: '7C', kind: 'CLASS', gradeLevel: 7, ss12000Id: null,
      createdAt: new Date('2025-05-01T08:00:00Z'), updatedAt: new Date('2025-05-02T08:00:00Z'),
    });
    // Petra was in last year's 7C until the summer.
    world.enrollments.push({
      schoolId: W.school, studentId: W.p2, academicYearId: W.pastYear, studentGroupId: C7C, gradeLevel: 7,
      validFrom: new Date('2025-08-18T00:00:00Z'), validTo: new Date('2026-06-13T00:00:00Z'),
    });
    tioarig(world);
    const placed = Object.fromEntries((await service.listGroups(caller(), {})).data.map((group) => [group.id, (group['organisation'] as { id: string }).id]));
    expect(placed).toEqual({ [C7C]: U79, [W.c6a]: W.org, [W.c7aSource]: W.org, [W.c8b]: U79, [W.ma7]: W.org });
    expect(ids(await service.listGroups(caller(), { organisation: U79 })).sort()).toEqual([C7C, W.c8b].sort());
    // Petra's 7C membership is 7–9's, her 7A one F–6's.
    const members = async (organisation: string) =>
      ids(await service.listPersons(caller(), { 'relationship.organisation': organisation, 'relationship.entity.type': 'groupMembership' })).sort();
    expect(await members(U79)).toEqual([W.p2, W.p3, W.p4].sort());
    expect(await members(W.org)).toEqual([W.p1Source, W.p2, W.p3, W.p4].sort());
  });

  it("derives skolformer in the active läsår's numbering: a tioårig läsår before or after it reads no row of 10", async () => {
    const SP_PLAN = '11000000-0000-4000-8000-000000000003';
    const { world, service } = split();
    world.localTimplans.push({ id: SP_PLAN, schoolId: W.school, schoolForm: 'SPECIALSKOLA' });
    world.yearTimplans.push({ schoolId: W.school, academicYearId: W.year, gradeLevel: 10, localTimplanId: SP_PLAN });
    const u79 = async () => (await service.listOrganisations(caller(), { schoolUnitCode: '22222222' })).data[0]!['schoolTypes'];
    tioarig(world, W.pastYear);
    tioarig(world, W.futureYear);
    expect(await u79()).toEqual(['GR']);
    tioarig(world, W.year);
    expect(await u79()).toEqual(['GR', 'SP']);
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
    // P1 has been enrolled since 2025-08-18: moving up over the summer is not a new enrolment.
    expect(await by({ 'relationship.organisation': W.org, 'relationship.startDate.onOrAfter': '2026-08-17', 'relationship.entity.type': 'enrolment' })).toEqual(
      [W.p2, W.p3, W.p4].sort(),
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

  it('a mentorship with its own Från and Till carries them, on the class and on the Duty (20261017090000)', async () => {
    const { world, service } = setup();
    // The mentor until the jullov; the year's bound where the uppdrag has none.
    Object.assign(world.mentorships[0]!, { validFrom: null, validTo: new Date('2026-12-18T00:00:00.000Z') });
    const group = await service.getGroup(caller(), W.c7aSource, { expand: 'assignmentRoles' });
    expect(group['_embedded']).toEqual({ assignmentRoles: [{ duty: { id: W.emp1 }, assignmentRoleType: 'Mentor', startDate: '2026-08-17', endDate: '2026-12-18' }] });
    const [duty] = (await service.listDuties(caller(), { person: W.t1 })).data;
    expect(duty!['assignmentRole']).toEqual([
      expect.objectContaining({ assignmentRoleType: 'Mentor', startDate: '2026-08-17', endDate: '2026-12-18' }),
    ]);
  });

  it('a post cut where its grad changes: the class names each Duty the mentorship falls in, and no reader without duties.read sees a cut', async () => {
    const world = new ProviderWorld();
    const tx = createTxMock();
    world.install(tx);
    const service = new Ss12000V2Service(createPrismaMock(tx) as unknown as PrismaService);
    // 50 % from 11 January, in a school that shares: the autumn's Duty and the spring's.
    world.policy['shareEmploymentWithIntegrations'] = true;
    world.periods.push({
      schoolId: W.school, employmentId: W.emp1, userId: W.t1, academicYearId: W.year,
      validFrom: new Date('2027-01-11T00:00:00.000Z'), validTo: null, employmentPercent: 50, updatedAt: new Date('2026-10-02T08:00:00Z'),
    });
    const spring = dutyStretchId(W.emp1, String(world.employments[0]!['ss12000StretchKey']), '2027-01-11');
    const roles = [
      { duty: { id: W.emp1 }, assignmentRoleType: 'Mentor', startDate: '2026-08-17', endDate: '2027-01-10' },
      { duty: { id: spring }, assignmentRoleType: 'Mentor', startDate: '2027-01-11', endDate: '2027-06-11' },
    ];
    expect((await service.getGroup(caller(), W.c7aSource, { expand: 'assignmentRoles' }))['_embedded']).toEqual({ assignmentRoles: roles });
    // The Duties carry the same, each its own part; the läslogg finds the teacher behind the spring's id.
    const duties = (await service.listDuties(caller(), { person: W.t1, sortkey: 'StartDateAsc' })).data;
    expect(duties.map((d) => [d.id, (d['assignmentRole'] as Array<{ startDate: string; endDate: string }>).map((r) => [r.startDate, r.endDate])])).toEqual([
      [W.emp1, [['2026-08-17', '2027-01-10']]],
      [spring, [['2027-01-11', '2027-06-11']]],
    ]);
    expect(recordedReads(tx).flatMap((read) => read.ids)).toContain(W.t1);
    // A reader of persons alone: the teacher's duty spans the post, from its first day to its last.
    const persons = caller(['persons.read']);
    expect(ids(await service.listPersons(persons, { 'relationship.entity.type': 'duty', 'relationship.startDate.onOrAfter': '2027-01-01' }))).toEqual([]);
    expect(ids(await service.listPersons(persons, { 'relationship.entity.type': 'duty', 'relationship.endDate.onOrBefore': '2027-01-31' }))).toEqual([]);
    expect(ids(await service.listPersons(persons, { 'relationship.entity.type': 'duty', 'relationship.startDate.onOrBefore': '2026-08-17' }))).toContain(W.t1);
    // A teacher filter matches the post's own Duty, never a stretch's: activities and events name the post's.
    const events = caller(['calendarEvents.read']);
    expect(await service.lookupCalendarEvents(events, { teacher: [spring] }, {})).toEqual([]);
    expect((await service.lookupCalendarEvents(events, { teacher: [W.emp1] }, {})).length).toBeGreaterThan(0);
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

describe('review findings (2026-10-11)', () => {
  it('a Duty under the source\'s id carries the source\'s role and dates, and none of SchemaPro\'s HR figures', async () => {
    const { world, service } = setup();
    world.policy['shareEmploymentWithIntegrations'] = true;
    world.dutyLinks[0]!['dutyRole'] = 'Förstelärare';
    world.dutyLinks[0]!['startDate'] = new Date('2026-08-20T00:00:00Z');
    world.employments.push({
      id: '40000000-0000-4000-8000-000000000009', schoolId: W.school, userId: W.t2, academicYearId: W.year, employmentPercent: 50, reductionPercent: 0,
      signature: 'TV', contractKind: 'FERIE', note: null, teachingTargetMinutesPerWeek: null,
      createdAt: new Date('2026-06-01T08:00:00Z'), updatedAt: new Date('2026-09-30T08:00:00Z'),
    });
    const linked = await service.getDuty(caller(), W.duty2Source, {});
    expect(linked).toMatchObject({ id: W.duty2Source, dutyRole: 'Förstelärare', startDate: '2026-08-20' });
    expect(linked['endDate']).toBeUndefined();
    expect(linked['dutyPercent']).toBeUndefined();
    expect(linked['hoursPerYear']).toBeUndefined();
    // SchemaPro's own post keeps toSs12000Duty's shape and the opt-in's figures.
    const own = await service.getDuty(caller(), W.emp1, {});
    expect(own).toMatchObject({ dutyRole: 'Lärare', startDate: '2026-08-17', endDate: '2027-06-11', dutyPercent: 80 });
    // A post with no version row is dated by its creation: an HR-only edit moves no meta.modified.
    expect((linked['meta'] as { modified: string }).modified).toBe('2026-06-01T08:00:00.000Z');
  });

  it('a co-teacher still on the lesson beside a substitute participates; only the replaced teacher is out', async () => {
    const { world, service } = setup();
    // The cover replaced Tove (LEAD) with Tea: assignInTransaction removed Tove's row only.
    const rows = world.lessonTeachers.filter((row) => row['calendarLessonId'] === W.l1);
    rows.find((row) => row['teacherId'] === W.t1)!['teacherId'] = W.t3;
    rows.find((row) => row['teacherId'] === W.t3)!['role'] = 'SUBSTITUTE';
    const event = await service.getCalendarEvent(caller(), W.l1, {});
    // Tor (ASSISTANT, linked duty) still teaches; Tea has no duty to name.
    expect(event['teacherExceptions']).toEqual([{ duty: { id: W.emp1 }, participates: false }]);
  });

  it('an enrolment starts where the unbroken chain starts, over the summer between two läsår but not over a gap inside one', async () => {
    const { world, service } = setup();
    const p1 = await service.getPerson(caller(), W.p1Source, {});
    expect(p1['enrolments']).toEqual([expect.objectContaining({ schoolYear: 7, startDate: '2025-08-18' })]);
    // A gap inside the year is a new enrolment.
    world.enrollments.push(
      { schoolId: W.school, studentId: W.p2, academicYearId: W.pastYear, studentGroupId: W.c6a, gradeLevel: 6, validFrom: new Date('2025-08-18T00:00:00Z'), validTo: new Date('2026-03-01T00:00:00Z') },
    );
    const p2 = await service.getPerson(caller(), W.p2, {});
    expect(p2['enrolments']).toEqual([expect.objectContaining({ startDate: '2026-08-17' })]);
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

describe('the läslogg of a read filtered to a pupil', () => {
  // The answer is the pupil's timetable, though the page names them only
  // where they stand outside the groups: SCHEDULE about them (forPupils).
  const run = async (read: (service: Ss12000V2Service) => Promise<unknown>) => {
    const world = new ProviderWorld();
    const tx = createTxMock();
    world.install(tx);
    await read(new Ss12000V2Service(createPrismaMock(tx) as unknown as PrismaService));
    return recordedReads(tx).filter((entry) => entry.kind === 'SCHEDULE');
  };
  const pupil = [{ kind: 'SCHEDULE', channel: null, ids: [W.p4] }];

  it('activities by member, and their lookup by members', async () => {
    expect(await run((service) => service.listActivities(caller(), { member: W.p4 }))).toEqual(pupil);
    expect(await run((service) => service.lookupActivities(caller(), { members: [W.p4] }, {}))).toEqual(pupil);
  });

  it('calendar events by student, and their lookup by student', async () => {
    expect(await run((service) => service.listCalendarEvents(caller(), { ...WINDOW, student: W.p4 }))).toEqual(pupil);
    expect(await run((service) => service.lookupCalendarEvents(caller(), { student: [W.p4] }, {}))).toEqual(pupil);
  });

  it('nothing for a teacher filter, the unfiltered list, or a pupil with nothing in the window', async () => {
    expect(await run((service) => service.listCalendarEvents(caller(), { ...WINDOW, teacher: W.emp1 }))).toEqual([]);
    expect(await run((service) => service.listActivities(caller(), {}))).toEqual([]);
    expect(
      await run((service) =>
        service.listCalendarEvents(caller(), { 'startTime.onOrAfter': '2026-12-01T00:00:00Z', 'startTime.onOrBefore': '2026-12-02T00:00:00Z', student: W.p4 }),
      ),
    ).toEqual([]);
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

describe('Elevlistan i uppföljningen: an event says who of its groups is not on it', () => {
  // The shared school (src/common/__fixtures__/pupil-list-cases.json): Alva in
  // SvA7, Bo in Stöd7, Cim in 7A only. S1 has no exception on Activity; the
  // event's studentExceptions with participates false is its own way to say
  // that a member of the activity's group is not on this event.
  type Obj = Record<string, unknown>;
  type Ref = { id: string; displayName?: string };
  const DAY = { 'startTime.onOrAfter': '2026-10-19T00:00:00Z', 'startTime.onOrBefore': '2026-10-19T23:59:59Z' };
  const exceptionsOf = (event: Obj | undefined) => (event?.['studentExceptions'] as Array<{ student: Ref; participates: boolean }> | undefined) ?? null;

  it.each([WITH_SVA, WITHOUT].map((school) => [school.name, school] as const))('%s: participates false exactly for the pupils THE RULE takes off', async (_name, school) => {
    const { world, service } = setup();
    world.addPupilList(school);
    const events = new Map((await service.listCalendarEvents(caller(), DAY)).data.map((event) => [event.id, event]));
    for (const lesson of PUPIL_LIST.lessons) {
      const exceptions = exceptionsOf(events.get(lesson.id));
      const off = (exceptions ?? []).filter((entry) => !entry.participates).map((entry) => entry.student.id);
      expect([lesson.name, off]).toEqual([lesson.name, school.expected[lesson.id]!.off]);
      // Every pupil named on a fixture lesson sits in one of its groups: no participates true.
      expect((exceptions ?? []).filter((entry) => entry.participates)).toEqual([]);
      // Without a pupil off, no studentExceptions at all, as main sends it.
      if (school.expected[lesson.id]!.off.length === 0) expect([lesson.name, exceptions]).toEqual([lesson.name, null]);
    }
  });

  it('the school without a replacing group answers every event as before, and the world\'s own events are untouched by either', async () => {
    const plain = setup();
    const before = await plain.service.listCalendarEvents(caller(), WINDOW);
    for (const school of [WITH_SVA, WITHOUT]) {
      const { world, service } = setup();
      world.addPupilList(school);
      const after = await service.listCalendarEvents(caller(), WINDOW);
      const fixtureIds = new Set(PUPIL_LIST.lessons.map((lesson) => lesson.id));
      expect(after.data.filter((event) => !fixtureIds.has(event.id))).toEqual(before.data);
    }
  });

  it('a replaced pupil is read as ROSTER in the läslogg, as a named one is', async () => {
    const world = new ProviderWorld();
    const tx = createTxMock();
    world.install(tx);
    world.addPupilList(WITH_SVA);
    await new Ss12000V2Service(createPrismaMock(tx) as unknown as PrismaService).listCalendarEvents(caller(), DAY);
    expect(recordedReads(tx).filter((read) => read.kind === 'ROSTER').flatMap((read) => read.ids)).toContain(pupilNamed('Alva'));
  });

  it("S1's student filter is group membership or an exception: Alva's events still hold 7A's svenska, which says she does not participate", async () => {
    const { world, service } = setup();
    world.addPupilList(WITH_SVA);
    const alva = pupilNamed('Alva');
    const hers = (await service.listCalendarEvents(caller(), { ...DAY, student: alva })).data;
    const classSvenska = hers.find((event) => event.id === lessonNamed('7A:s svenska').id);
    expect(exceptionsOf(classSvenska)).toEqual([alva, pupilNamed('Eva')].sort().map((id) => ({ student: { id }, participates: false })));
    expect(hers.map((event) => event.id)).toContain(lessonNamed('SvA7:s svenska som andraspråk').id);
  });

  it('a key without groups.read gets the event as before: no participates false, since who leaves 7A\'s svenska is who is in SvA7 (review L5)', async () => {
    const { world, service } = setup();
    world.addPupilList(WITH_SVA);
    const scopes = ALL_V2_SCOPES.filter((scope) => scope !== 'groups.read');
    const events = (await service.listCalendarEvents(caller(scopes), DAY)).data;
    const replaced = events.flatMap((event) => (exceptionsOf(event) ?? []).filter((entry) => !entry.participates));
    expect(replaced).toEqual([]);
    expect(events.find((event) => event.id === lessonNamed('7A:s svenska').id)).not.toHaveProperty('studentExceptions');
    // With groups.read, the same event lists them.
    const full = (await service.listCalendarEvents(caller(), DAY)).data.find((event) => event.id === lessonNamed('7A:s svenska').id);
    expect(exceptionsOf(full)!.map((entry) => entry.participates)).toEqual([false, false]);
  });

  it('orders the exceptions by the student\'s id, participating or not (review L3)', async () => {
    const { world, service } = setup();
    world.addPupilList(WITH_SVA);
    // Fia of 8B, named on 7A's svenska: participates true, with an id after Alva's and Eva's.
    const fia = 'e1e00000-0000-4000-8000-0000000000f6';
    world.users.push({ ...world.users.find((user) => user['id'] === W.p4)!, id: fia, email: 'fia@elev.ekskolan.se', firstName: 'Fia', authId: null });
    world.lessonStudents.push({ schoolId: W.school, calendarLessonId: lessonNamed('7A:s svenska').id, studentId: fia });
    const event = (await service.listCalendarEvents(caller(), DAY)).data.find((item) => item.id === lessonNamed('7A:s svenska').id);
    expect(exceptionsOf(event)).toEqual([
      ...[pupilNamed('Alva'), pupilNamed('Eva')].sort().map((id) => ({ student: { id }, participates: false })),
      { student: { id: fia }, participates: true },
    ]);
  });
});
