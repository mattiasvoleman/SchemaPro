import { ConflictException } from '@nestjs/common';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import type { CalendarService } from '../calendar/calendar.service';
import type { StaffingLoadService } from '../staffing/staffing-load.service';
import type { TimplanCoverageService } from '../timplan/timplan-coverage.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { RealtimeService } from '../realtime/realtime.service';
import {
  PUBLISH_GATES_REFUSED,
  PUBLISH_STALE,
  PUBLISH_WARNINGS_UNACKNOWLEDGED,
  PublicationsService,
} from './publications.service';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const LESSON_ID = '55555555-5555-4555-8555-555555555555';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const time = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m));

const RESULT = { created: 12, cancelled: 1, skipped: 3, fromDate: '2026-10-12', toDate: '2027-06-11' };

function lesson(overrides: Record<string, unknown> = {}) {
  return {
    id: LESSON_ID,
    subjectId: 'sub',
    studentGroupId: 'grp',
    teacherId: 'tea',
    coTeacherId: null,
    roomId: 'room',
    dayOfWeek: 1,
    startTime: time(8),
    endTime: time(9),
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isParked: false,
    extraGroups: [],
    participants: [],
    subject: { name: 'Matematik' },
    studentGroup: { name: '7B' },
    ...overrides,
  };
}

function storedRow(data: Record<string, unknown>) {
  return {
    id: 'pub-1',
    kind: data.kind,
    outcome: data.outcome,
    publishMode: data.publishMode,
    validFrom: data.validFrom,
    validTo: data.validTo,
    publishedAt: new Date('2026-10-12T08:00:00Z'),
    publishedByUserId: data.publishedByUserId ?? null,
    created: data.created ?? 0,
    cancelled: data.cancelled ?? 0,
    skipped: data.skipped ?? 0,
    moved: 0,
    removed: 0,
    adopted: 0,
    lessonCount: null,
    gates: data.gates,
    acknowledgedWarnings: data.acknowledgedWarnings ?? false,
  };
}

describe('PublicationsService (DIRECT)', () => {
  let tx: TxMock;
  let service: PublicationsService;
  let calendar: { materialise: jest.Mock };
  let coverage: { scheduled: jest.Mock; planned: jest.Mock };
  let load: { load: jest.Mock };
  let notifications: { recipientsForLessons: jest.Mock; notifyUsers: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-12T08:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    tx = createTxMock();
    tx.academicYear.findUnique.mockResolvedValue({
      id: YEAR_ID,
      startDate: day('2026-08-17'),
      endDate: day('2027-06-11'),
      school: { timezone: 'Europe/Stockholm' },
    });
    tx.publicationSettings.findUnique.mockResolvedValue(null);
    tx.masterLesson.findMany.mockResolvedValue([lesson()]);
    tx.lunchSetting.findUnique.mockResolvedValue({ lunchEnabled: true });
    tx.staffingPolicy.findUnique.mockResolvedValue(null);
    tx.timetablePublication.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      storedRow(data),
    );
    calendar = { materialise: jest.fn().mockResolvedValue(RESULT) };
    coverage = {
      scheduled: jest.fn().mockResolvedValue({ groups: [] }),
      planned: jest.fn().mockResolvedValue({ verdicts: [] }),
    };
    load = { load: jest.fn() };
    notifications = { recipientsForLessons: jest.fn(async () => []), notifyUsers: jest.fn() };
    service = new PublicationsService(
      createPrismaMock(tx) as unknown as PrismaService,
      calendar as unknown as CalendarService,
      coverage as unknown as TimplanCoverageService,
      load as unknown as StaffingLoadService,
      notifications as unknown as NotificationsService,
      { notifyMasterTimetableChanged: jest.fn() } as unknown as RealtimeService,
    );
  });

  afterEach(() => jest.useRealTimers());

  const created = () => tx.timetablePublication.create.mock.calls.map(([arg]) => arg.data);

  it('a DRAFT publish tells each changed lesson’s roster once — its classes, groups and named pupils — with the first lesson that reaches them', async () => {
    notifications.recipientsForLessons
      .mockResolvedValueOnce(['ada', 'ada-guardian'])
      .mockResolvedValueOnce(['ada', 'ada-guardian', 'eli']);
    const first = lesson({ id: 'm1', extraGroups: [{ studentGroupId: 'Ma7' }] });
    const second = lesson({ id: 'm2', studentGroupId: '8B', participants: [{ studentId: 'eli' }], subject: { name: 'Bild' } });
    const tell = (service as unknown as { tellClasses: (...args: unknown[]) => Promise<void> }).tellClasses.bind(service);
    await tell(tx, SCHOOL_ID, [first, second], ['m1', 'm2', 'gone']);
    expect(notifications.recipientsForLessons.mock.calls.map(([, scopes]) => scopes)).toEqual([
      [{ groupIds: ['grp', 'Ma7'], participantIds: [] }],
      [{ groupIds: ['8B'], participantIds: ['eli'] }],
    ]);
    expect(notifications.notifyUsers.mock.calls.map(([, options]) => [options.userIds, options.meta.subjectName])).toEqual([
      [['ada', 'ada-guardian'], 'Matematik'],
      [['eli'], 'Bild'],
    ]);
  });

  it('publishes the window the old route would, and logs it with its validity', async () => {
    const outcome = await service.publish({ academicYearId: YEAR_ID }, testUser());
    expect(calendar.materialise).toHaveBeenCalledWith(tx, SCHOOL_ID, {
      academicYearId: YEAR_ID,
      fromDate: '2026-10-12',
      toDate: '2027-06-11',
    });
    expect(outcome.result).toEqual(RESULT);
    expect(created()).toEqual([
      expect.objectContaining({
        kind: 'PUBLISH',
        outcome: 'PUBLISHED',
        publishMode: 'DIRECT',
        validFrom: day('2026-10-12'),
        validTo: day('2027-06-11'),
        created: 12,
        cancelled: 1,
        skipped: 3,
        acknowledgedWarnings: false,
      }),
    ]);
    expect(outcome.publication.validFrom).toBe('2026-10-12');
  });

  it('asks for "Publicera ändå" when a check warns, and logs nothing until it is given', async () => {
    tx.masterLesson.findMany.mockResolvedValue([lesson({ roomId: null })]);
    const error = await service.publish({ academicYearId: YEAR_ID }, testUser()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: PUBLISH_WARNINGS_UNACKNOWLEDGED,
      params: { warnings: 'PUB_NO_ROOM' },
    });
    expect(created()).toEqual([]);

    const outcome = await service.publish({ academicYearId: YEAR_ID, acknowledgeWarnings: true }, testUser());
    expect(outcome.gates.map((gate) => [gate.code, gate.severity])).toContainEqual(['PUB_NO_ROOM', 'WARN']);
    expect(created()[0]).toMatchObject({ outcome: 'PUBLISHED', acknowledgedWarnings: true });
  });

  it('refuses what the school set to REFUSE, logs the refusal, and says which check', async () => {
    tx.publicationSettings.findUnique.mockResolvedValue({ publishMode: 'DIRECT', gateMissingRoom: 'REFUSE' });
    tx.masterLesson.findMany.mockResolvedValue([lesson({ roomId: null })]);
    const error = await service
      .publish({ academicYearId: YEAR_ID, acknowledgeWarnings: true }, testUser())
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: PUBLISH_GATES_REFUSED,
      params: { refused: 'PUB_NO_ROOM', publicationId: 'pub-1' },
    });
    expect(created()).toEqual([
      expect.objectContaining({ kind: 'PUBLISH', outcome: 'REFUSED', validFrom: day('2026-10-12') }),
    ]);
    expect(created()[0]).not.toHaveProperty('created');
  });

  it('refuses a publish whose grundschema changed since the preview', async () => {
    const preview = await service.preview({ academicYearId: YEAR_ID }, testUser());
    tx.masterLesson.findMany.mockResolvedValue([lesson({ dayOfWeek: 2 })]);
    const error = await service
      .publish({ academicYearId: YEAR_ID, expectedDigest: preview.digest }, testUser())
      .catch((e: unknown) => e);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: PUBLISH_STALE });
    expect(created()).toEqual([]);
  });

  it('previews the materialiser\'s own counts and writes no log row', async () => {
    const preview = await service.preview({ academicYearId: YEAR_ID }, testUser());
    expect(preview).toMatchObject({ result: RESULT, refused: false, needsAcknowledgement: false, validFrom: '2026-10-12' });
    expect(preview.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(created()).toEqual([]);
  });

  it('turns a dry run the database refused into a REFUSE gate', async () => {
    calendar.materialise.mockRejectedValue(new Error('conflicting key value violates exclusion constraint'));
    const preview = await service.preview({ academicYearId: YEAR_ID }, testUser());
    expect(preview.refused).toBe(true);
    expect(preview.gates[0]).toMatchObject({ code: 'PUB_CALENDAR_REFUSED', severity: 'REFUSE' });
  });

  it('says so when a publish would change nothing, without asking anything', async () => {
    calendar.materialise.mockResolvedValue({ ...RESULT, created: 0, cancelled: 0 });
    const preview = await service.preview({ academicYearId: YEAR_ID }, testUser());
    expect(preview.gates).toEqual([expect.objectContaining({ code: 'PUB_NOTHING_TO_PUBLISH', severity: 'INFO' })]);
    expect(preview.needsAcknowledgement).toBe(false);
  });

  it('warns about a range starting before the school\'s today', async () => {
    const preview = await service.preview({ academicYearId: YEAR_ID, validFrom: '2026-10-01' }, testUser());
    expect(preview.gates.find((gate) => gate.code === 'PUB_FROM_IN_PAST')).toMatchObject({
      severity: 'WARN',
      params: { validFrom: '2026-10-01', today: '2026-10-12' },
    });
  });

  it('reads the timplan layers and staffing through their own services', async () => {
    coverage.scheduled.mockResolvedValue({
      groups: [
        {
          studentGroupId: 'grp',
          lines: [{ subjectId: 'sub', status: 'SHORT', requirementIds: ['req'], scheduledMinutesPerWeek: 60, plannedMinutesPerWeek: 120 }],
        },
      ],
    });
    tx.subject.findMany.mockResolvedValue([{ id: 'sub', name: 'Matematik' }]);
    tx.studentGroup.findMany.mockResolvedValue([{ id: 'grp', name: '7B' }]);
    coverage.planned.mockResolvedValue({ verdicts: [{ severity: 'warning', message: 'Åk 7 saknar timplan.' }, { severity: 'notice', message: 'x' }] });
    tx.staffingPolicy.findUnique.mockResolvedValue({
      qualificationMode: 'REFUSE',
      overAllocationMode: 'WARN',
      overAllocationTolerancePercent: 10,
      fullTimeTeachingMinutesPerWeek: null,
      unstaffedGeneration: 'ALLOW',
    });
    load.load.mockResolvedValue({
      unqualifiedAssignments: [{ requirementId: 'req', userId: 'tea', subjectName: 'Matematik', groupName: '7B' }],
      teachers: [],
    });
    tx.user.findMany.mockResolvedValue([{ id: 'tea', firstName: 'Anna', lastName: 'Ek' }]);
    const preview = await service.preview({ academicYearId: YEAR_ID }, testUser());
    const byCode = Object.fromEntries(preview.gates.map((gate) => [gate.code, gate]));
    expect(byCode.PUB_UNPLACED.items[0].label).toBe('Matematik för 7B: 60 av 120 min/vecka');
    expect(byCode.PUB_TIMPLAN).toMatchObject({ count: 1, items: [{ label: 'Åk 7 saknar timplan.' }] });
    expect(byCode.PUB_STAFFING_REFUSE.items[0].label).toBe('Anna Ek saknar behörighet: Matematik för 7B');
    // The report and both timplan layers are read to judge, unrecorded; the
    // läslogg names only the teacher the check stops on, with the names read
    // in the same transaction.
    expect(load.load).toHaveBeenCalledWith(YEAR_ID, 'planned', testUser(), { record: false, travel: false });
    expect(coverage.scheduled).toHaveBeenCalledWith({ academicYearId: YEAR_ID }, testUser(), { record: false });
    expect(coverage.planned).toHaveBeenCalledWith({ academicYearId: YEAR_ID }, testUser(), { record: false });
    expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: null, ids: ['tea'] }]);
  });

  it('names the worst period of a post that changes during the year, and the year for one that does not', async () => {
    tx.staffingPolicy.findUnique.mockResolvedValue({
      qualificationMode: 'WARN',
      overAllocationMode: 'REFUSE',
      overAllocationTolerancePercent: 10,
      fullTimeTeachingMinutesPerWeek: null,
      unstaffedGeneration: 'ALLOW',
    });
    const stretch = (from: string, to: string, extra: Record<string, unknown>) => ({
      from,
      to,
      kind: 'PERIOD',
      effectiveFrom: from,
      effectiveTo: to,
      teachingWeeks: 10,
      targetMinutesPerWeek: 600,
      countedMinutesPerWeek: 600,
      balanceMinutesPerWeek: 0,
      status: 'OK',
      ...extra,
    });
    load.load.mockResolvedValue({
      unqualifiedAssignments: [],
      teachers: [
        {
          userId: 'tea',
          status: 'OVER',
          countedMinutesPerWeek: 640,
          targetMinutesPerWeek: 620,
          periods: [
            stretch('2026-08-17', '2026-11-01', { kind: 'BASE' }),
            stretch('2026-11-02', '2026-12-20', { targetMinutesPerWeek: 300, countedMinutesPerWeek: 360, balanceMinutesPerWeek: -60, status: 'OVER' }),
            // Jullov: all lov, judged by nothing, whatever its own status says.
            stretch('2026-12-21', '2027-01-10', { teachingWeeks: 0, targetMinutesPerWeek: 100, balanceMinutesPerWeek: -500, status: 'OVER' }),
            stretch('2027-01-11', '2027-06-11', { targetMinutesPerWeek: 300, countedMinutesPerWeek: 340, balanceMinutesPerWeek: -40, status: 'OVER' }),
          ],
        },
        { userId: 'bo', status: 'OVER', countedMinutesPerWeek: 700, targetMinutesPerWeek: 600, periods: [] },
      ],
    });
    tx.user.findMany.mockResolvedValue([
      { id: 'tea', firstName: 'Anna', lastName: 'Ek' },
      { id: 'bo', firstName: 'Bo', lastName: 'Alm' },
    ]);
    const preview = await service.preview({ academicYearId: YEAR_ID }, testUser());
    const gate = preview.gates.find((entry) => entry.code === 'PUB_STAFFING_REFUSE')!;
    expect(gate.items.map((item: { label: string }) => item.label)).toEqual([
      'Anna Ek över mål 2026-11-02–2026-12-20: 360 av 300 min/vecka',
      'Bo Alm över mål: 700 av 600 min/vecka',
    ]);
  });

  it('does not ask for the load report when no staffing check refuses', async () => {
    await service.preview({ academicYearId: YEAR_ID }, testUser());
    expect(load.load).not.toHaveBeenCalled();
  });

  describe('the old POST /calendar/publish', () => {
    it('answers exactly what it answered and logs a LEGACY_PUBLISH row in the same transaction', async () => {
      const dto = { academicYearId: YEAR_ID, fromDate: '2026-09-01' };
      await expect(service.legacyPublish(dto, testUser())).resolves.toEqual(RESULT);
      expect(calendar.materialise).toHaveBeenCalledWith(tx, SCHOOL_ID, dto);
      expect(created()).toEqual([
        expect.objectContaining({
          kind: 'LEGACY_PUBLISH',
          outcome: 'PUBLISHED',
          validFrom: day(RESULT.fromDate),
          validTo: day(RESULT.toDate),
          gates: [],
        }),
      ]);
      // No REFUSE set: the gates are not even asked.
      expect(coverage.scheduled).not.toHaveBeenCalled();
      expect(tx.masterLesson.findMany).not.toHaveBeenCalled();
    });

    it('is refused only by a check the school set to REFUSE', async () => {
      tx.publicationSettings.findUnique.mockResolvedValue({ publishMode: 'DIRECT', gateParked: 'REFUSE' });
      tx.masterLesson.findMany.mockResolvedValue([lesson({ roomId: null })]);
      await expect(service.legacyPublish({ academicYearId: YEAR_ID }, testUser())).resolves.toEqual(RESULT);

      tx.masterLesson.findMany.mockResolvedValue([lesson({ isParked: true })]);
      const error = await service.legacyPublish({ academicYearId: YEAR_ID }, testUser()).catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: PUBLISH_GATES_REFUSED });
      expect(created().map((row) => [row.kind, row.outcome])).toEqual([
        ['LEGACY_PUBLISH', 'PUBLISHED'],
        ['LEGACY_PUBLISH', 'REFUSED'],
      ]);
    });
  });

  it('shows which publication is valid when, refills and refusals aside', async () => {
    const row = (id: string, kind: string, outcome: string, at: string, from: string, to: string) => ({
      ...storedRow({ kind, outcome, publishMode: 'DIRECT', validFrom: day(from), validTo: day(to), gates: [] }),
      id,
      publishedAt: new Date(at),
    });
    tx.timetablePublication.findMany.mockResolvedValue([
      row('ht', 'PUBLISH', 'PUBLISHED', '2026-08-10T08:00:00Z', '2026-08-17', '2027-06-11'),
      row('no', 'PUBLISH', 'REFUSED', '2026-09-10T08:00:00Z', '2026-09-14', '2027-06-11'),
      row('vt', 'LEGACY_PUBLISH', 'PUBLISHED', '2026-10-01T08:00:00Z', '2027-01-11', '2027-06-11'),
      row('fill', 'REFILL', 'PUBLISHED', '2026-10-02T08:00:00Z', '2026-10-12', '2027-06-11'),
    ]);
    const timeline = await service.timeline(YEAR_ID, testUser());
    expect(timeline.segments).toEqual([
      { publicationId: 'ht', from: '2026-08-17', to: '2027-01-10' },
      { publicationId: 'vt', from: '2027-01-11', to: '2027-06-11' },
    ]);
    expect(timeline).toMatchObject({ today: '2026-10-12', validNow: 'ht' });
    expect(timeline.publications).toHaveLength(4);
    // No gate names a teacher: nothing to record.
    expect(recordedReads(tx)).toEqual([]);
  });

  it("records the teachers a refused publication's staffing gate names, when the timeline reads it back (Läsbehörighet)", async () => {
    const staffing = {
      code: 'PUB_STAFFING_REFUSE',
      severity: 'REFUSE',
      count: 2,
      items: [
        { label: 'Anna Berg saknar behörighet: Matematik för 7B', teacherId: 'teacher-anna', requirementId: 'r1' },
        { label: 'Bo Ek över mål: 900 av 800 min/vecka', teacherId: 'teacher-bo' },
      ],
      params: {},
    };
    const clash = { code: 'PUB_TEACHER_CLASH', severity: 'WARN', count: 1, items: [{ label: 'Matematik · 7B, mån 08:00', teacherId: 'teacher-cy' }], params: {} };
    tx.timetablePublication.findMany.mockResolvedValue([
      { ...storedRow({ kind: 'PUBLISH', outcome: 'REFUSED', publishMode: 'DIRECT', validFrom: day('2026-09-14'), validTo: day('2027-06-11'), gates: [staffing, clash] }), id: 'no', publishedAt: new Date('2026-09-10T08:00:00Z') },
    ]);
    await service.timeline(YEAR_ID, testUser({ channel: 'WEB' }));
    // The staffing gate's teachers, as the publish recorded them; another
    // gate's lesson line is the timetable layer, not recorded.
    expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: ['teacher-anna', 'teacher-bo'] }]);
  });

  it('answers the defaults for a school with no settings row', async () => {
    await expect(service.settings(testUser())).resolves.toMatchObject({
      publishMode: 'DIRECT',
      gateClashes: 'WARN',
      gateDayOpsLost: 'WARN',
      stored: false,
    });
  });
});
