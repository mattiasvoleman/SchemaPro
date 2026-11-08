import request from 'supertest';
import { CalendarLessonsService } from '../src/calendar/calendar-lessons.service';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const CLASS = 'a1111111-1111-4111-8111-111111111111';
const YEAR = 'a2222222-2222-4222-8222-222222222222';
const TEACHER = 'a3333333-3333-4333-8333-333333333333';
const LESSON = 'a4444444-4444-4444-8444-444444444444';
const MASTER = 'a5555555-5555-4555-8555-555555555555';
const ROOM = 'a6666666-6666-4666-8666-666666666666';
const CHANGE = 'a7777777-7777-4777-8777-777777777777';
const ADMIN = 'a8888888-8888-4888-8888-888888888888';
const VERSION = 'f'.repeat(32);

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const ADMIN_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];

const row = (over: Record<string, unknown> = {}) => ({
  id: CHANGE,
  schoolId: 's',
  academicYearId: YEAR,
  studentGroupId: CLASS,
  authorId: TEACHER,
  kind: 'OCCASION_CANCEL',
  status: 'DRAFT',
  masterLessonId: null,
  calendarLessonId: LESSON,
  date: day('2027-03-22'),
  targetDate: null,
  targetDayOfWeek: null,
  targetStart: null,
  targetEnd: null,
  targetRoomId: null,
  keepEnd: null,
  note: null,
  baseVersion: VERSION,
  baseSnapshot: {},
  rev: 1,
  publishedAt: null,
  publishedByUserId: null,
  createdAt: new Date('2027-03-15T08:00:00.000Z'),
  updatedAt: new Date('2027-03-15T08:00:00.000Z'),
  ...over,
});

/**
 * Klasslärarens schema's routes: who reaches them, what a request must be, and
 * that an administrator goes the whole way through the controller to the
 * service and back. The mocks stand in for the database, so these hold the
 * role and area gates, the validation and the shape of the answers; row
 * security and the frame are RLS sections 425-429 and the adapter probe.
 */
describe('klasslärarens schema (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());
  const teacher = asUser({ role: 'TEACHER' as never, userId: TEACHER });
  const admin = (adminProfile = 'FULL') => asUser({ adminProfile: adminProfile as never, userId: ADMIN });

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const tx = harness.tx;
    tx['classTeacherAppointment']!['findFirst']!.mockResolvedValue({ id: 'appointment-1' });
    tx['classTeacherSettings']!['findUnique']!.mockResolvedValue({ selfPublish: true });
    tx['studentGroup']!['findUnique']!.mockResolvedValue({ id: CLASS, name: '4A', academicYearId: YEAR });
    tx['school']!['findUnique']!.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx['classTeacherChange']!['updateMany']!.mockResolvedValue({ count: 1 });
    tx.$queryRaw.mockImplementation(async (statement: { strings: string[] }) => {
      const text = statement.strings.join('?');
      if (text.includes('class_teacher_frame')) return [{ reason: null }];
      if (text.includes('_version')) return [{ version: VERSION, snapshot: { status: 'SCHEDULED' } }];
      if (text.includes('class_teacher_actor')) {
        return [{ userId: ADMIN, authId: '11111111-1111-4111-8111-111111111111', adminProfile: 'SCHEMALAGGARE', hrRead: false }];
      }
      return [];
    });
  });

  describe('who reaches what', () => {
    it.each(['STUDENT', 'GUARDIAN'])('gives %s nothing of either side', async (role) => {
      const as = asUser({ role: role as never });
      await http().get('/api/v1/class-teacher/mine').set('x-test-user', as).expect(403);
      await http().get(`/api/v1/class-teacher/classes/${CLASS}/week`).set('x-test-user', as).expect(403);
      await http().get(`/api/v1/class-teachers/appointments?academicYearId=${YEAR}`).set('x-test-user', as).expect(403);
      await http().post('/api/v1/class-teachers/appointments').set('x-test-user', as).send({ studentGroupId: CLASS, userId: TEACHER }).expect(403);
      expect(harness.tx['classTeacherAppointment']!['create']).not.toHaveBeenCalled();
    });

    it('refuses a request with no token', async () => {
      await http().get('/api/v1/class-teacher/mine').expect(401);
      await http().get(`/api/v1/class-teachers/drafts`).expect(401);
    });

    it('keeps a teacher out of the administrators’ routes and an administrator out of the teacher’s', async () => {
      await http().get(`/api/v1/class-teachers/appointments?academicYearId=${YEAR}`).set('x-test-user', teacher).expect(403);
      await http().put('/api/v1/class-teachers/settings').set('x-test-user', teacher).send({ selfPublish: true }).expect(403);
      await http().post(`/api/v1/class-teachers/classes/${CLASS}/publish`).set('x-test-user', teacher).send({}).expect(403);
      await http().get('/api/v1/class-teacher/mine').set('x-test-user', admin()).expect(403);
      await http().post(`/api/v1/class-teacher/classes/${CLASS}/publish`).set('x-test-user', admin()).send({}).expect(403);
    });

    it('lets every administrator profile read, and refuses the writes of an area it does not hold by name', async () => {
      harness.tx['classTeacherAppointment']!['findMany']!.mockResolvedValue([]);
      for (const profile of ADMIN_PROFILES) {
        await http().get(`/api/v1/class-teachers/appointments?academicYearId=${YEAR}`).set('x-test-user', admin(profile)).expect(200);
        await http().get('/api/v1/class-teachers/settings').set('x-test-user', admin(profile)).expect(200);
        await http().get(`/api/v1/class-teachers/open-times?academicYearId=${YEAR}`).set('x-test-user', admin(profile)).expect(200);
        await http().get('/api/v1/class-teachers/drafts').set('x-test-user', admin(profile)).expect(200);
      }
      for (const profile of ['EXPEDITION', 'LASARE']) {
        const appoint = await http().post('/api/v1/class-teachers/appointments').set('x-test-user', admin(profile)).send({ studentGroupId: CLASS, userId: TEACHER }).expect(403);
        expect(appoint.body.code).toBe('AREA_NOT_YOURS');
        const settings = await http().put('/api/v1/class-teachers/settings').set('x-test-user', admin(profile)).send({ selfPublish: true }).expect(403);
        await http().post(`/api/v1/class-teachers/classes/${CLASS}/publish`).set('x-test-user', admin(profile)).send({}).expect(403);
        await http().delete(`/api/v1/class-teachers/drafts/${CHANGE}`).set('x-test-user', admin(profile)).expect(403);
      }
      expect(harness.tx['classTeacherSettings']!['upsert']).not.toHaveBeenCalled();
    });
  });

  describe('an administrator, all the way through', () => {
    it('appoints a klasslärare, in their own name, and reads the list back', async () => {
      const tx = harness.tx;
      tx['studentGroup']!['findUnique']!.mockResolvedValue({ academicYearId: YEAR });
      tx['classTeacherAppointment']!['findFirst']!.mockResolvedValue(null);
      tx['classTeacherAppointment']!['findMany']!.mockResolvedValue([
        { id: 'a1', academicYearId: YEAR, studentGroupId: CLASS, userId: TEACHER, appointedByUserId: ADMIN },
      ]);
      tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: CLASS, name: '4A' }]);
      tx['user']!['findMany']!.mockResolvedValue([
        { id: TEACHER, firstName: 'Anna', lastName: 'Andersson', role: 'TEACHER', isActive: true, adminProfile: null },
        { id: ADMIN, firstName: 'Sara', lastName: 'Schema', role: 'SCHOOL_ADMIN', isActive: true, adminProfile: 'SCHEMALAGGARE' },
      ]);
      const appointed = await http().post('/api/v1/class-teachers/appointments').set('x-test-user', admin('SCHEMALAGGARE')).send({ studentGroupId: CLASS, userId: TEACHER }).expect(200);
      expect(appointed.body).toEqual([
        { id: 'a1', academicYearId: YEAR, studentGroupId: CLASS, className: '4A', userId: TEACHER, teacherName: 'Anna Andersson', appointedByUserId: ADMIN, runs: true },
      ]);
      expect(tx['classTeacherAppointment']!['create']).toHaveBeenCalledWith({
        data: expect.objectContaining({ studentGroupId: CLASS, userId: TEACHER, appointedByUserId: ADMIN }),
      });
      const listed = await http().get(`/api/v1/class-teachers/appointments?academicYearId=${YEAR}`).set('x-test-user', admin()).expect(200);
      expect(listed.body).toHaveLength(1);
      tx['classTeacherAppointment']!['deleteMany']!.mockResolvedValue({ count: 1 });
      await http().delete('/api/v1/class-teachers/appointments/a9999999-9999-4999-8999-999999999999').set('x-test-user', admin()).expect(204);
      tx['classTeacherAppointment']!['deleteMany']!.mockResolvedValue({ count: 0 });
      const gone = await http().delete('/api/v1/class-teachers/appointments/a9999999-9999-4999-8999-999999999999').set('x-test-user', admin()).expect(404);
      expect(gone.body.code).toBe('CLASS_TEACHER_GONE');
    });

    it('opens hours, merging the ones that touch, and reads them back', async () => {
      const tx = harness.tx;
      tx['classTeacherOpenTime']!['findMany']!.mockResolvedValue([
        { id: 'o1', academicYearId: YEAR, studentGroupId: null, dayOfWeek: 1, startTime: time('08:00'), endTime: time('12:00') },
      ]);
      const saved = await http()
        .put('/api/v1/class-teachers/open-times')
        .set('x-test-user', admin())
        .send({ academicYearId: YEAR, studentGroupId: null, spans: [{ dayOfWeek: 1, startTime: '08:00', endTime: '10:00' }, { dayOfWeek: 1, startTime: '10:00', endTime: '12:00' }] })
        .expect(200);
      expect(saved.body).toEqual([{ id: 'o1', academicYearId: YEAR, studentGroupId: null, dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }]);
      expect(tx['classTeacherOpenTime']!['createMany']).toHaveBeenCalledWith({
        data: [expect.objectContaining({ dayOfWeek: 1, startTime: time('08:00'), endTime: time('12:00'), studentGroupId: null })],
      });
      await http().get(`/api/v1/class-teachers/open-times?academicYearId=${YEAR}`).set('x-test-user', admin('LASARE')).expect(200);
    });

    it('decides whether a klasslärare publishes, off for a school that has not said', async () => {
      const tx = harness.tx;
      tx['classTeacherSettings']!['findUnique']!.mockResolvedValue(null);
      expect((await http().get('/api/v1/class-teachers/settings').set('x-test-user', admin()).expect(200)).body).toEqual({ selfPublish: false });
      tx['classTeacherSettings']!['upsert']!.mockResolvedValue({ selfPublish: true });
      expect((await http().put('/api/v1/class-teachers/settings').set('x-test-user', admin('SCHEMALAGGARE')).send({ selfPublish: true }).expect(200)).body).toEqual({ selfPublish: true });
      await http().put('/api/v1/class-teachers/settings').set('x-test-user', admin()).send({ selfPublish: 'ja' }).expect(400);
    });

    it('reads the waiting drafts with the check’s verdict, publishes a class and discards a draft', async () => {
      const tx = harness.tx;
      tx['classTeacherChange']!['findMany']!.mockResolvedValue([row()]);
      tx['classTeacherChange']!['findUnique']!.mockResolvedValue(row());
      tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: CLASS, name: '4A' }]);
      tx['user']!['findMany']!.mockResolvedValue([{ id: TEACHER, firstName: 'Anna', lastName: 'Andersson' }]);
      tx['calendarLesson']!['findMany']!.mockResolvedValue([{ id: LESSON, subject: { name: 'Matte' } }]);
      const drafts = await http().get(`/api/v1/class-teachers/drafts?studentGroupId=${CLASS}`).set('x-test-user', admin()).expect(200);
      expect(drafts.body).toEqual([
        {
          change: expect.objectContaining({ id: CHANGE, kind: 'OCCASION_CANCEL', date: '2027-03-22', rev: 1 }),
          className: '4A',
          authorName: 'Anna Andersson',
          subjectName: 'Matte',
          verdict: { state: 'OK' },
        },
      ]);

      // The editor's own cancel is the editor's to test (and the adapter probe's, against a real database): here it is asked, as the administrator.
      const cancel = jest.spyOn(harness.app.get(CalendarLessonsService, { strict: false }), 'cancel').mockResolvedValue({ id: LESSON, status: 'CANCELLED', note: null } as never);
      try {
        const published = await http().post(`/api/v1/class-teachers/classes/${CLASS}/publish`).set('x-test-user', admin()).send({ changeIds: [CHANGE] }).expect(200);
        expect(published.body).toEqual({ outcomes: [{ id: CHANGE, outcome: 'PUBLISHED' }] });
        expect(cancel).toHaveBeenCalledWith(LESSON, expect.objectContaining({ cause: 'MANUAL' }), expect.objectContaining({ userId: ADMIN }));
      } finally {
        cancel.mockRestore();
      }

      tx['classTeacherChange']!['deleteMany']!.mockResolvedValue({ count: 1 });
      await http().delete(`/api/v1/class-teachers/drafts/${CHANGE}`).set('x-test-user', admin('SCHEMALAGGARE')).expect(204);
      tx['classTeacherChange']!['deleteMany']!.mockResolvedValue({ count: 0 });
      await http().delete(`/api/v1/class-teachers/drafts/${CHANGE}`).set('x-test-user', admin()).expect(404);
    });

    it('refuses a request that is not a request', async () => {
      await http().post('/api/v1/class-teachers/appointments').set('x-test-user', admin()).send({ studentGroupId: 'x', userId: TEACHER }).expect(400);
      await http().post('/api/v1/class-teachers/appointments').set('x-test-user', admin()).send({ studentGroupId: CLASS, userId: TEACHER, extra: 1 }).expect(400);
      await http().put('/api/v1/class-teachers/open-times').set('x-test-user', admin()).send({ academicYearId: YEAR, spans: [{ dayOfWeek: 6, startTime: '08:00', endTime: '09:00' }] }).expect(400);
      await http().put('/api/v1/class-teachers/open-times').set('x-test-user', admin()).send({ academicYearId: YEAR, spans: [{ dayOfWeek: 1, startTime: '8:00', endTime: '9:00' }] }).expect(400);
      await http().get('/api/v1/class-teachers/appointments').set('x-test-user', admin()).expect(400);
      await http().delete('/api/v1/class-teachers/drafts/not-a-uuid').set('x-test-user', admin()).expect(400);
    });
  });

  describe('a klasslärare', () => {
    it('reads the classes they are klasslärare of', async () => {
      harness.tx['classTeacherAppointment']!['findMany']!.mockResolvedValue([{ studentGroupId: CLASS }]);
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: CLASS, name: '4A', academicYearId: YEAR }]);
      const mine = await http().get('/api/v1/class-teacher/mine').set('x-test-user', teacher).expect(200);
      expect(mine.body).toEqual({ classes: [{ id: CLASS, name: '4A', academicYearId: YEAR }], selfPublish: true });
    });

    it('reads a week of the class with the frame’s verdict on every lesson', async () => {
      const tx = harness.tx;
      tx['classTeacherOpenTime']!['findMany']!.mockResolvedValue([{ dayOfWeek: 1, startTime: time('08:00'), endTime: time('12:00') }]);
      tx['classTeacherChange']!['findMany']!.mockResolvedValue([row()]);
      tx['calendarLesson']!['findMany']!.mockResolvedValue([
        { id: LESSON, date: day('2027-03-22'), startsAt: new Date('2027-03-22T07:30:00.000Z'), endsAt: new Date('2027-03-22T08:30:00.000Z'), status: 'SCHEDULED', roomId: ROOM, subjectId: MASTER, subject: { name: 'Matte' }, studentGroup: { name: '4A' }, teachers: [{ teacherId: TEACHER }] },
      ]);
      tx.$queryRaw.mockImplementation(async (statement: { strings: string[] }) => {
        const text = statement.strings.join('?');
        if (text.includes('class_teacher_calendar_states')) return [{ calendarLessonId: LESSON, version: VERSION, refusal: null }];
        return [];
      });
      const week = await http().get(`/api/v1/class-teacher/classes/${CLASS}/week?from=2027-03-24`).set('x-test-user', teacher).expect(200);
      expect(week.body).toMatchObject({
        classId: CLASS,
        weekStart: '2027-03-22',
        openTimes: [{ dayOfWeek: 1, start: '08:00', end: '12:00' }],
        occasions: [{ id: LESSON, start: '08:30', end: '09:30', mine: true, version: VERSION, refusal: null, draftId: CHANGE }],
      });
      await http().get(`/api/v1/class-teacher/classes/${CLASS}/week?from=morgon`).set('x-test-user', teacher).expect(400);
    });

    it('is 403 with a code for a class they are not klasslärare of', async () => {
      harness.tx['classTeacherAppointment']!['findFirst']!.mockResolvedValue(null);
      const refused = await http().get(`/api/v1/class-teacher/classes/${CLASS}/week`).set('x-test-user', teacher).expect(403);
      expect(refused.body.code).toBe('CLASS_TEACHER_NOT_APPOINTED');
    });

    it('writes a draft, edits it at its revision, and is told when someone else got there first', async () => {
      const tx = harness.tx;
      tx['classTeacherChange']!['create']!.mockResolvedValue(row({ note: 'Studiebesök' }));
      const created = await http()
        .post(`/api/v1/class-teacher/classes/${CLASS}/changes`)
        .set('x-test-user', teacher)
        .send({ kind: 'OCCASION_CANCEL', calendarLessonId: LESSON, baseVersion: VERSION, note: 'Studiebesök' })
        .expect(201);
      expect(created.body).toMatchObject({ id: CHANGE, kind: 'OCCASION_CANCEL', rev: 1, note: 'Studiebesök' });

      tx['classTeacherChange']!['findFirst']!.mockResolvedValue(row({ rev: 2 }));
      tx['classTeacherChange']!['findUnique']!.mockResolvedValue(row({ rev: 3, note: 'Ny' }));
      const updated = await http().patch(`/api/v1/class-teacher/classes/${CLASS}/changes/${CHANGE}`).set('x-test-user', teacher).send({ rev: 2, note: 'Ny' }).expect(200);
      expect(updated.body.rev).toBe(3);
      const lost = await http().patch(`/api/v1/class-teacher/classes/${CLASS}/changes/${CHANGE}`).set('x-test-user', teacher).send({ rev: 1, note: 'Sen' }).expect(409);
      expect(lost.body).toMatchObject({ code: 'CLASS_TEACHER_REV', params: { rev: 2 } });

      tx['classTeacherChange']!['deleteMany']!.mockResolvedValue({ count: 1 });
      await http().delete(`/api/v1/class-teacher/classes/${CLASS}/changes/${CHANGE}?rev=2`).set('x-test-user', teacher).expect(204);
      await http().delete(`/api/v1/class-teacher/classes/${CLASS}/changes/${CHANGE}`).set('x-test-user', teacher).expect(400);
    });

    it('is refused by name outside the frame, and 409 for a lesson that has changed', async () => {
      const tx = harness.tx;
      tx.$queryRaw.mockImplementation(async (statement: { strings: string[] }) => {
        if (statement.strings.join('?').includes('class_teacher_frame')) return [{ reason: 'BLOCK' }];
        return [];
      });
      const outside = await http()
        .post(`/api/v1/class-teacher/classes/${CLASS}/changes`)
        .set('x-test-user', teacher)
        .send({ kind: 'OCCASION_CANCEL', calendarLessonId: LESSON, baseVersion: VERSION })
        .expect(403);
      expect(outside.body).toMatchObject({ code: 'CLASS_TEACHER_OUTSIDE_FRAME', params: { reason: 'BLOCK' } });
      expect(tx['classTeacherChange']!['create']).not.toHaveBeenCalled();

      tx.$queryRaw.mockImplementation(async (statement: { strings: string[] }) => {
        const text = statement.strings.join('?');
        if (text.includes('class_teacher_frame')) return [{ reason: null }];
        return [{ version: 'e'.repeat(32), snapshot: { status: 'CANCELLED' } }];
      });
      const stale = await http()
        .post(`/api/v1/class-teacher/classes/${CLASS}/changes`)
        .set('x-test-user', teacher)
        .send({ kind: 'OCCASION_CANCEL', calendarLessonId: LESSON, baseVersion: VERSION })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'CLASS_TEACHER_STALE', params: { version: 'e'.repeat(32) } });
    });

    it('refuses a draft that is not one', async () => {
      const as = (body: Record<string, unknown>) => http().post(`/api/v1/class-teacher/classes/${CLASS}/changes`).set('x-test-user', teacher).send(body);
      await as({ kind: 'OCCASION_CANCEL', calendarLessonId: LESSON }).expect(400);
      await as({ kind: 'OCCASION_CANCEL', calendarLessonId: LESSON, baseVersion: 'x' }).expect(400);
      await as({ kind: 'SOMETHING_ELSE', calendarLessonId: LESSON, baseVersion: VERSION }).expect(400);
      await as({ kind: 'OCCASION_CANCEL', baseVersion: VERSION }).expect(400);
      await as({ kind: 'OCCASION_MOVE', calendarLessonId: LESSON, baseVersion: VERSION, targetDate: '2027-03-23', targetStart: '25:00', targetEnd: '11:00' }).expect(400);
      await as({ kind: 'TEMPLATE_MOVE', masterLessonId: MASTER, baseVersion: VERSION, targetDayOfWeek: 6, targetStart: '10:00', targetEnd: '11:00' }).expect(400);
      await as({ kind: 'OCCASION_CANCEL', calendarLessonId: LESSON, baseVersion: VERSION, targetRoomId: ROOM }).expect(400);
      expect(harness.tx['classTeacherChange']!['create']).not.toHaveBeenCalled();
    });

    it('checks the drafts and tries a change as the administrator the appointment runs as, and publishes where the school lets them', async () => {
      const tx = harness.tx;
      tx['classTeacherChange']!['findMany']!.mockResolvedValue([row()]);
      tx['classTeacherChange']!['findUnique']!.mockResolvedValue(row());
      const checked = await http().get(`/api/v1/class-teacher/classes/${CLASS}/check`).set('x-test-user', teacher).expect(200);
      expect(checked.body).toEqual([{ change: expect.objectContaining({ id: CHANGE }), verdict: { state: 'OK' } }]);
      const tried = await http()
        .post(`/api/v1/class-teacher/classes/${CLASS}/preview`)
        .set('x-test-user', teacher)
        .send({ kind: 'OCCASION_ROOM', calendarLessonId: LESSON, targetRoomId: ROOM })
        .expect(200);
      expect(tried.body).toEqual({ verdict: { state: 'OK' } });
      expect(tx['classTeacherChange']!['create']).not.toHaveBeenCalled();
      const cancel = jest.spyOn(harness.app.get(CalendarLessonsService, { strict: false }), 'cancel').mockResolvedValue({ id: LESSON, status: 'CANCELLED', note: null } as never);
      try {
        const published = await http().post(`/api/v1/class-teacher/classes/${CLASS}/publish`).set('x-test-user', teacher).send({}).expect(200);
        expect(published.body).toEqual({ outcomes: [{ id: CHANGE, outcome: 'PUBLISHED' }] });
        expect(cancel).toHaveBeenCalledWith(LESSON, expect.objectContaining({ cause: 'MANUAL' }), expect.objectContaining({ userId: ADMIN }));
      } finally {
        cancel.mockRestore();
      }
      expect((harness.prisma.withRls as jest.Mock).mock.calls.some((call) => (call[0] as { userId: string }).userId === ADMIN)).toBe(true);
    });

    it('does not publish for a school that has not said yes', async () => {
      harness.tx['classTeacherSettings']!['findUnique']!.mockResolvedValue({ selfPublish: false });
      const refused = await http().post(`/api/v1/class-teacher/classes/${CLASS}/publish`).set('x-test-user', teacher).send({}).expect(403);
      expect(refused.body.code).toBe('CLASS_TEACHER_PUBLISH_OFF');
    });

    it('is told, with a code, when the administrator the appointment runs as has gone', async () => {
      harness.tx.$queryRaw.mockImplementation(async (statement: { strings: string[] }) => {
        if (statement.strings.join('?').includes('class_teacher_actor')) return [];
        return [];
      });
      const gone = await http().get(`/api/v1/class-teacher/classes/${CLASS}/check`).set('x-test-user', teacher).expect(409);
      expect(gone.body.code).toBe('CLASS_TEACHER_APPOINTER_GONE');
    });
  });
});
