import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * Delade lokaler och lärare, the second half over HTTP: the publish check
 * against another school of the huvudman under its own policy column, and a
 * room booking that would take a lent room's window. Each a round trip
 * through the real guards, pipes and handlers to the mocked database; what
 * the reads return under RLS is sections 276–279c, and the same reads
 * against Postgres are the probe's (dl-f).
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const NORRA = '77777777-7777-4777-8777-777777777777';
const TEACHER = '22222222-2222-4222-8222-222222222222';
const ROOM = '66666666-6666-4666-8666-666666666666';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const clock = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);

describe('Delade lokaler och lärare: publicering och bokning (e2e)', () => {
  let harness: TestHarness;
  const http = () => harness.app.getHttpServer();
  const admin = () => asUser({ role: 'SCHOOL_ADMIN' as never });

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  /** The database's narrow reads, by the function a statement calls. */
  const sharing = (busy: unknown[]) =>
    harness.tx.$queryRaw.mockImplementation(async (query: unknown) => {
      const text = typeof query === 'object' && query !== null && 'sql' in query ? String((query as { sql: string }).sql) : '';
      if (text.includes('app.sibling_schools()')) return [{ school_id: NORRA, name: 'Norraskolan' }];
      if (text.includes('app.shared_teacher_busy(')) return busy;
      return [];
    });

  beforeEach(() => {
    const { tx } = harness;
    jest.clearAllMocks();
    tx.$queryRaw.mockReset().mockResolvedValue([]);
    tx.academicYear.findUnique.mockResolvedValue({
      id: YEAR_ID,
      startDate: day('2026-08-17'),
      endDate: day('2027-06-11'),
      isActive: true,
      predecessorId: null,
      school: { timezone: 'Europe/Stockholm' },
    });
    tx.publicationSettings.findUnique.mockResolvedValue(null);
    tx.lunchSetting.findUnique.mockResolvedValue({ lunchEnabled: true });
    tx.staffingPolicy.findUnique.mockResolvedValue(null);
    tx.timetablePublication.findMany.mockResolvedValue([]);
    tx.user.findMany.mockResolvedValue([{ id: TEACHER, firstName: 'Anna', lastName: 'Lind' }]);
    tx.room.findMany.mockResolvedValue([]);
    tx.masterLesson.findMany.mockResolvedValue([
      {
        id: '55555555-5555-4555-8555-555555555555',
        subjectId: 'sub',
        studentGroupId: 'grp',
        teacherId: TEACHER,
        coTeacherId: null,
        roomId: ROOM,
        dayOfWeek: 1,
        startTime: clock('08:00'),
        endTime: clock('09:00'),
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
        isParked: false,
        extraGroups: [],
        participants: [],
        subject: { name: 'Matematik' },
        studentGroup: { name: '7B' },
      },
    ]);
  });

  const preview = () =>
    request(http())
      .post('/api/v1/publications/preview')
      .set('x-test-user', admin())
      .send({ academicYearId: YEAR_ID, validFrom: '2026-11-02', validTo: '2026-12-18' })
      .expect(200);
  const gate = (body: { gates?: Array<{ code: string }> }) => body.gates?.find((item) => item.code === 'PUB_OTHER_SCHOOL');

  it('says nothing for a school without another school of its huvudman', async () => {
    const response = await preview();
    expect(gate(response.body)).toBeUndefined();
  });

  it('warns about a shared teacher’s lesson that meets the teacher’s lesson at the other school, the walk counted', async () => {
    sharing([
      {
        teacher_id: TEACHER,
        school_id: NORRA,
        day_of_week: 1,
        start_time: clock('09:10'),
        end_time: clock('10:00'),
        recurrence: 'ALL_WEEKS',
        start_date: day('2026-08-17'),
        end_date: day('2027-06-11'),
        travel_minutes: 15,
      },
    ]);
    const response = await preview();
    expect(gate(response.body)).toMatchObject({
      code: 'PUB_OTHER_SCHOOL',
      severity: 'WARN',
      count: 1,
      items: [
        {
          label: 'Matematik · 7B, mån 08:00–09:00: Anna Lind har en lektion på Norraskolan mån 09:10–10:00, restid 15 min',
          masterLessonId: '55555555-5555-4555-8555-555555555555',
          teacherId: TEACHER,
        },
      ],
    });
    // The window the publish materialises bounds what is asked of the other school.
    const asked = harness.tx.$queryRaw.mock.calls
      .map((call: unknown[]) => call[0] as { sql?: string; values?: unknown[] })
      .find((query: { sql?: string }) => query.sql?.includes('shared_teacher_busy'));
    expect(asked?.values).toEqual(['2026-11-02', '2026-12-18']);
  });

  it('stops the publish when the school sets the check to REFUSE, and the setting takes the column', async () => {
    harness.tx.publicationSettings.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      publishMode: 'DIRECT',
      ...create,
    }));
    const put = await request(http())
      .put('/api/v1/publication-settings')
      .set('x-test-user', admin())
      .send({ gateOtherSchool: 'REFUSE' })
      .expect(200);
    expect(harness.tx.publicationSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { gateOtherSchool: 'REFUSE' } }));
    expect(put.body).toMatchObject({ gateOtherSchool: 'REFUSE' });

    harness.tx.publicationSettings.findUnique.mockResolvedValue({ publishMode: 'DIRECT', gateOtherSchool: 'REFUSE' });
    sharing([
      {
        teacher_id: TEACHER,
        school_id: NORRA,
        day_of_week: 1,
        start_time: clock('08:30'),
        end_time: clock('09:30'),
        recurrence: 'ALL_WEEKS',
        start_date: day('2026-08-17'),
        end_date: day('2027-06-11'),
        travel_minutes: null,
      },
    ]);
    const response = await preview();
    expect(gate(response.body)).toMatchObject({ severity: 'REFUSE', count: 1 });
    expect(response.body.refused).toBe(true);

    await request(http())
      .put('/api/v1/publication-settings')
      .set('x-test-user', admin())
      .send({ gateOtherSchool: 'IGNORE' })
      .expect(400);
  });

  it('refuses a booking of a room in the window it is lent to another school, and takes it back', async () => {
    const { tx } = harness;
    tx.room.findUnique.mockResolvedValue({ id: ROOM, requiresApproval: false });
    tx.calendarLesson.findFirst.mockResolvedValue(null);
    tx.roomBooking.create.mockResolvedValue({ id: 'b1', status: 'APPROVED' });
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.roomLoan.findMany.mockResolvedValue([
      {
        status: 'APPROVED',
        roomId: ROOM,
        localRoomId: '88888888-8888-4888-8888-888888888888',
        dayOfWeek: 2,
        startTime: clock('10:00'),
        endTime: clock('11:30'),
        startDate: day('2030-08-19'),
        endDate: day('2031-06-13'),
      },
    ]);
    // 2030-09-03 is a Tuesday; 08:30Z is 10:30 in Stockholm.
    const refused = await request(http())
      .post('/api/v1/room-bookings')
      .set('x-test-user', asUser({ role: 'TEACHER' as never }))
      .send({ roomId: ROOM, title: 'Repetition', startsAt: '2030-09-03T08:30:00.000Z', endsAt: '2030-09-03T09:00:00.000Z' })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'ROOM_LENT_TO_OTHER_SCHOOL' });
  });
});
