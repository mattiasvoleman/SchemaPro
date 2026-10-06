import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

/**
 * CSV import over HTTP.
 *
 * The bodies here are the ones web/lib/csv.ts actually posts after parsing a
 * school's file. That is the point of the suite: the service specs prove the
 * row semantics, and these prove the payload survives routing, the global
 * whitelist validation and RBAC on the way in.
 */

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';

const post = (harness: TestHarness, path: string) =>
  request(harness.app.getHttpServer())
    .post(`/api/v1/import/${path}`)
    .set('x-test-user', asUser({}));

describe('CSV import (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await createTestApp();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('routes accept what the browser sends', () => {
    it('imports teachers without emailing a single one of them', async () => {
      // Uploading a staff list is roster preparation, often weeks before term
      // starts. Inviting is a separate, deliberate act — see the invitation
      // routes in portal.e2e-spec.ts.
      harness.tx['user']!['findFirst']!.mockResolvedValue(null);
      harness.tx['user']!['create']!.mockResolvedValue({ id: 'u-1' });

      const response = await post(harness, 'teachers')
        .send({
          rows: [
            { firstName: 'Karin', lastName: 'Ek', email: 'karin.ek@example.com' },
          ],
        })
        .expect(201);

      expect(response.body).toEqual({ created: 1, skipped: 0, errors: [] });
      expect(harness.supabase.inviteUser).not.toHaveBeenCalled();

      const { data } = harness.tx['user']!['create']!.mock.calls[0]?.[0] as {
        data: { invitedAt: Date | null };
      };
      expect(data.invitedAt).toBeNull();
    });

    it('imports a teacher together with their post for the active year', async () => {
      // The post half reads the person back after the people half created them.
      harness.tx['user']!['findFirst']!.mockResolvedValue({ id: 'u-karin' });
      harness.tx['user']!['create']!.mockResolvedValue({ id: 'u-karin' });
      harness.tx['user']!['findMany']!.mockResolvedValue([]);
      harness.tx['academicYear']!['findFirst']!.mockResolvedValue({ id: YEAR_ID, name: '2026/2027' });
      harness.tx['teacherEmployment']!['findMany']!.mockResolvedValue([]);
      harness.tx['teacherEmployment']!['findUnique']!.mockResolvedValue(null);
      harness.tx['teacherEmployment']!['create']!.mockResolvedValue({ id: 'emp-1' });

      const response = await post(harness, 'teachers')
        .send({
          rows: [
            {
              firstName: 'Karin',
              lastName: 'Ek',
              email: 'karin.ek@example.com',
              employmentPercent: 80,
              reductionPercent: 20,
              contractKind: 'FERIE',
              signature: 'KE',
            },
          ],
        })
        .expect(201);

      expect(response.body).toEqual({ created: 1, updated: 0, skipped: 0, errors: [] });
      const { data } = harness.tx['teacherEmployment']!['create']!.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        schoolId: SCHOOL_ID,
        userId: 'u-karin',
        academicYearId: YEAR_ID,
        employmentPercent: 80,
        reductionPercent: 20,
        signature: 'KE',
      });
    });

    it('imports uppdrag for the dialog’s year, resolving teacher by email, group by name and subject by code', async () => {
      harness.tx['user']!['findMany']!.mockResolvedValue([{ id: 'u-karin', email: 'karin.ek@example.com' }]);
      Object.assign(harness.tx, {
        $queryRaw: jest.fn(() => Promise.resolve([{ id: 'u-karin', role: 'TEACHER' }])),
      });
      harness.tx['subject']!['findMany']!.mockResolvedValue([{ id: 'sub-ma', name: 'Matematik', code: 'MA' }]);
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: GROUP_ID, name: '7B' }]);
      harness.tx['teacherDuty']!['findMany']!.mockResolvedValue([]);
      harness.tx['teacherDuty']!['create']!.mockResolvedValue({ id: 'd-1' });

      try {
        const response = await post(harness, 'teacher-duties')
          .send({
            academicYearId: YEAR_ID,
            columns: ['teacherEmail', 'kind', 'label', 'minutesPerWeek', 'countsAsTeaching', 'subject', 'groupName', 'note'],
            rows: [
              {
                teacherEmail: 'karin.ek@example.com',
                kind: 'MENTORSKAP',
                label: 'Mentor 7B',
                minutesPerWeek: 60,
                countsAsTeaching: false,
                subject: null,
                groupName: '7B',
                note: null,
              },
            ],
          })
          .expect(201);

        expect(response.body).toEqual({ created: 1, updated: 0, skipped: 0, errors: [] });
        const { data } = harness.tx['teacherDuty']!['create']!.mock.calls[0]?.[0] as { data: Record<string, unknown> };
        expect(data).toEqual({
          schoolId: SCHOOL_ID,
          userId: 'u-karin',
          academicYearId: YEAR_ID,
          kind: 'MENTORSKAP',
          label: 'Mentor 7B',
          minutesPerWeek: 60,
          countsAsTeaching: false,
          subjectId: null,
          studentGroupId: GROUP_ID,
          note: null,
        });

        // A slot is not something a file can say.
        await post(harness, 'teacher-duties')
          .send({
            academicYearId: YEAR_ID,
            rows: [{ teacherEmail: 'karin.ek@example.com', kind: 'RASTVAKT', label: 'R', minutesPerWeek: 20, blockedSlot: { dayOfWeek: 2, startTime: '10:00', endTime: '10:20' } }],
          })
          .expect(400);
      } finally {
        delete (harness.tx as Record<string, unknown>)['$queryRaw'];
      }
    });

    it('imports a timplan’s two load-percent columns', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: GROUP_ID, name: '7A' }]);
      harness.tx['subject']!['findMany']!.mockResolvedValue([{ id: 'sub-ma', name: 'Matematik', code: 'MA' }]);
      harness.tx['user']!['findMany']!.mockResolvedValue([]);
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([]);
      harness.tx['teachingRequirement']!['create']!.mockResolvedValue({ id: 'r-1' });

      const response = await post(harness, 'requirements')
        .send({
          academicYearId: YEAR_ID,
          columns: ['groupName', 'subject', 'lessonsPerWeek', 'minutesPerLesson', 'teacherLoadPercent', 'coTeacherLoadPercent', 'recurrence'],
          rows: [
            { groupName: '7A', subject: 'MA', lessonsPerWeek: 3, minutesPerLesson: 60, teacherLoadPercent: 150, coTeacherLoadPercent: null, recurrence: 'ALL_WEEKS' },
          ],
        })
        .expect(201);

      expect(response.body).toMatchObject({ created: 1, errors: [] });
      const { data } = harness.tx['teachingRequirement']!['create']!.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(data).toMatchObject({ teacherLoadPercent: 150, coTeacherLoadPercent: 100 });
    });

    it('imports behörigheter, resolving teacher by email and subject by code', async () => {
      harness.tx['user']!['findMany']!.mockResolvedValue([
        { id: 'u-karin', email: 'karin.ek@example.com' },
      ]);
      harness.tx['subject']!['findMany']!.mockResolvedValue([
        { id: 'sub-ma', name: 'Matematik', code: 'MA' },
      ]);
      harness.tx['teacherSubjectQualification']!['findMany']!.mockResolvedValue([]);
      harness.tx['teacherSubjectQualification']!['create']!.mockResolvedValue({ id: 'q-1' });

      const response = await post(harness, 'teacher-qualifications')
        .send({
          rows: [
            {
              teacherEmail: 'karin.ek@example.com',
              subject: 'MA',
              minGrade: 7,
              maxGrade: 9,
              kind: 'LEGITIMATION',
            },
          ],
        })
        .expect(201);

      expect(response.body).toEqual({ created: 1, updated: 0, skipped: 0, errors: [] });
      const { data } = harness.tx['teacherSubjectQualification']!['create']!.mock
        .calls[0]?.[0] as { data: Record<string, unknown> };
      expect(data).toEqual({
        schoolId: SCHOOL_ID,
        userId: 'u-karin',
        subjectId: 'sub-ma',
        minGradeLevel: 7,
        maxGradeLevel: 9,
        kind: 'LEGITIMATION',
      });
    });

    it('imports students, resolving the class by name for the posted year', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([
        { id: GROUP_ID, name: '7A' },
      ]);
      harness.tx['user']!['findFirst']!.mockResolvedValue(null);
      harness.tx['user']!['create']!.mockResolvedValue({ id: 'u-2' });

      const response = await post(harness, 'students')
        .send({
          academicYearId: YEAR_ID,
          rows: [
            {
              firstName: 'Alma',
              lastName: 'Berg',
              email: 'alma@example.com',
              className: '7A',
            },
          ],
        })
        .expect(201);

      expect(response.body).toMatchObject({ created: 1, errors: [] });
      const findArgs = harness.tx['studentGroup']!['findMany']!.mock
        .calls[0]?.[0] as { where: { academicYearId: string } };
      expect(findArgs.where.academicYearId).toBe(YEAR_ID);
    });

    it('imports classes', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([]);
      harness.tx['studentGroup']!['create']!.mockResolvedValue({ id: GROUP_ID });

      await post(harness, 'groups')
        .send({
          academicYearId: YEAR_ID,
          rows: [{ name: '7A', gradeLevel: 7 }],
        })
        .expect(201);
    });

    it('imports teaching-group memberships', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([
        { id: GROUP_ID, name: 'Ma71' },
      ]);
      harness.tx['user']!['findMany']!.mockResolvedValue([
        { id: 'u-3', email: 'alma@example.com' },
      ]);
      harness.tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
      harness.tx['studentGroupMember']!['createMany']!.mockResolvedValue({
        count: 1,
      });

      await post(harness, 'group-members')
        .send({
          academicYearId: YEAR_ID,
          rows: [{ groupName: 'Ma71', email: 'alma@example.com' }],
        })
        .expect(201);
    });

    it('imports a timplan, creating the new row and updating the changed one', async () => {
      // The timplan is the one kind that overwrites: a school edits the file
      // and uploads it again, so row 1 below has to land as an UPDATE of the
      // requirement already stored, not as a skip.
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([
        { id: GROUP_ID, name: '7A' },
      ]);
      harness.tx['subject']!['findMany']!.mockResolvedValue([
        { id: 'sub-ma', name: 'Matematik', code: 'MA' },
        { id: 'sub-sv', name: 'Svenska', code: 'SV' },
      ]);
      harness.tx['user']!['findMany']!.mockResolvedValue([
        { id: 'u-karin', email: 'karin.ek@example.com' },
      ]);
      // Row 2 states a period, so the import reads the year's bounds FOR SHARE,
      // as a raw query. The shared mock would hand back a model proxy for
      // `$queryRaw`, which is not callable.
      Object.assign(harness.tx, {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            startDate: new Date('2026-08-17T00:00:00.000Z'),
            endDate: new Date('2027-06-11T00:00:00.000Z'),
          },
        ]),
      });
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([
        {
          id: 'req-1',
          studentGroupId: GROUP_ID,
          subjectId: 'sub-ma',
          teacherId: null,
          coTeacherId: null,
          lessonsPerWeek: 3,
          minutesPerLesson: 60,
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
        },
      ]);
      harness.tx['teachingRequirement']!['create']!.mockResolvedValue({ id: 'req-2' });
      harness.tx['teachingRequirement']!['update']!.mockResolvedValue({ id: 'req-1' });

      const response = await post(harness, 'requirements')
        .send({
          academicYearId: YEAR_ID,
          rows: [
            {
              groupName: '7A',
              subject: 'MA', // by code
              lessonsPerWeek: 4, // was 3
              minutesPerLesson: 60,
              teacherEmail: 'karin.ek@example.com',
              coTeacherEmail: null,
              recurrence: 'ALL_WEEKS',
              startDate: null,
              endDate: null,
            },
            {
              groupName: '7A',
              subject: 'Svenska', // by name
              lessonsPerWeek: 3,
              minutesPerLesson: 45,
              teacherEmail: null,
              coTeacherEmail: null,
              recurrence: 'ODD_WEEKS',
              startDate: '2026-09-01',
              endDate: '2026-12-20',
            },
          ],
        })
        .expect(201);

      expect(response.body).toEqual({
        created: 1,
        updated: 1,
        skipped: 0,
        errors: [],
        // The staffing policy had nothing to say: no behörighet recorded, no post.
        warnings: [],
      });
      const created = harness.tx['teachingRequirement']!['create']!.mock
        .calls[0]?.[0] as { data: { schoolId: string; subjectId: string } };
      expect(created.data.schoolId).toBe(SCHOOL_ID);
      expect(created.data.subjectId).toBe('sub-sv');
    });

    it('imports a lokal timplan into a draft, reading årskurs F and updating a changed cell', async () => {
      const PLAN_ID = 'abababab-abab-4bab-8bab-abababababab';
      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce({
        id: PLAN_ID,
        name: 'Grundskolan 2024',
        status: 'DRAFT',
      });
      harness.tx['localTimplan']!['update']!.mockResolvedValueOnce({});
      harness.tx['subject']!['findMany']!.mockResolvedValue([
        { id: 'sub-ma', name: 'Matematik', code: 'MA' },
        { id: 'sub-sv', name: 'Svenska', code: 'SV' },
      ]);
      harness.tx['localTimplanEntry']!['findMany']!.mockResolvedValueOnce([
        { id: 'e-1', subjectId: 'sub-ma', gradeLevel: 4, minutesPerWeek: 180, note: null },
      ]);
      harness.tx['localTimplanEntry']!['create']!.mockResolvedValueOnce({});
      harness.tx['localTimplanEntry']!['update']!.mockResolvedValueOnce({});

      const response = await post(harness, 'timplan')
        .send({
          localTimplanId: PLAN_ID,
          columns: ['subject', 'gradeLevel', 'minutesPerWeek', 'note'],
          rows: [
            { subject: 'MA', gradeLevel: '4', minutesPerWeek: 200, note: '' },
            { subject: 'Svenska', gradeLevel: 'F', minutesPerWeek: 120, note: 'läsning' },
            { subject: 'Fysik', gradeLevel: '7', minutesPerWeek: 60 },
          ],
        })
        .expect(201);

      expect(response.body).toEqual({
        created: 1,
        updated: 1,
        skipped: 0,
        errors: [{ row: 3, message: expect.stringContaining('Ämnet "Fysik" finns inte') }],
      });
      expect(harness.tx['localTimplanEntry']!['create']).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          localTimplanId: PLAN_ID,
          subjectId: 'sub-sv',
          gradeLevel: 0,
          minutesPerWeek: 120,
          note: 'läsning',
        },
      });
    });

    it('409s a lokal timplan import into a decided plan, naming it, and writes nothing', async () => {
      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce({
        id: 'abababab-abab-4bab-8bab-abababababab',
        name: 'Grundskolan 2024',
        status: 'DECIDED',
      });

      const response = await post(harness, 'timplan')
        .send({
          localTimplanId: 'abababab-abab-4bab-8bab-abababababab',
          rows: [{ subject: 'MA', gradeLevel: 4, minutesPerWeek: 180 }],
        })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'TIMPLAN_IS_DECIDED' });
      expect(response.body.detail).toContain('"Grundskolan 2024" är beslutad');
      expect(harness.tx['localTimplanEntry']!['create']).not.toHaveBeenCalled();
      expect(harness.tx['localTimplan']!['update']).not.toHaveBeenCalled();
    });

    it('404s a lokal timplan import into a plan RLS hides', async () => {
      harness.tx['localTimplan']!['findUnique']!.mockResolvedValueOnce(null);

      await post(harness, 'timplan')
        .send({
          localTimplanId: 'abababab-abab-4bab-8bab-abababababab',
          rows: [{ subject: 'MA', gradeLevel: 4, minutesPerWeek: 180 }],
        })
        .expect(404);
    });

    it('400s a lokal timplan row with an årskurs outside F..10, before the handler', async () => {
      const response = await post(harness, 'timplan')
        .send({
          localTimplanId: 'abababab-abab-4bab-8bab-abababababab',
          rows: [{ subject: 'MA', gradeLevel: '11', minutesPerWeek: 180 }],
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('årskurs: anges som F (förskoleklass) eller ett heltal 0–10.');
      expect(harness.tx['localTimplan']!['findUnique']).not.toHaveBeenCalled();
    });

    it('400s a lokal timplan file whose rows are a list of lists, before the handler', async () => {
      // ValidateNested descends into an inner list, so [[row]] passed the pipe
      // and the service met a row with no subject (a TypeError, a 500).
      const response = await post(harness, 'timplan')
        .send({
          localTimplanId: 'abababab-abab-4bab-8bab-abababababab',
          rows: [[{ subject: 'MA', gradeLevel: 4, minutesPerWeek: 180 }]],
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('rows: varje rad anges som ett objekt.');
      expect(harness.tx['localTimplan']!['findUnique']).not.toHaveBeenCalled();
    });

    it('reports an unknown group as a row error and imports the rest of the file', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([
        { id: GROUP_ID, name: '7A' },
      ]);
      harness.tx['subject']!['findMany']!.mockResolvedValue([
        { id: 'sub-ma', name: 'Matematik', code: 'MA' },
      ]);
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([]);
      harness.tx['teachingRequirement']!['create']!.mockResolvedValue({ id: 'req-1' });

      const requirement = (groupName: string) => ({
        groupName,
        subject: 'MA',
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        teacherEmail: null,
        coTeacherEmail: null,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      });

      const response = await post(harness, 'requirements')
        .send({
          academicYearId: YEAR_ID,
          rows: [requirement('9Z'), requirement('7A')],
        })
        .expect(201);

      expect(response.body).toMatchObject({ created: 1, updated: 0 });
      expect(response.body.errors).toEqual([
        { row: 1, message: expect.stringContaining('"9Z"') },
      ]);
      // A timplan points at groups; it does not declare them, so a typo must
      // not leave the school with an empty phantom group.
      expect(harness.tx['studentGroup']!['create']).not.toHaveBeenCalled();
    });

    it('imports subjects, resolving the room type by name', async () => {
      harness.tx['subject']!['findMany']!.mockResolvedValue([]);
      harness.tx['roomType']!['findMany']!.mockResolvedValue([
        { id: 'rt-tx', name: 'Textilslöjd' },
      ]);
      harness.tx['subject']!['create']!.mockResolvedValue({ id: 'sub-1' });

      const response = await post(harness, 'subjects')
        .send({
          rows: [
            { name: 'Textilslöjd', code: 'SLTX', color: '#db2777', roomType: 'Textilslöjd' },
            { name: 'Matematik', code: 'MA', color: '#4f46e5', roomType: '' },
          ],
        })
        .expect(201);

      expect(response.body).toMatchObject({ created: 2, errors: [] });
      const first = harness.tx['subject']!['create']!.mock.calls[0]?.[0] as {
        data: { requiredRoomTypeId: string | null; schoolId: string };
      };
      expect(first.data.requiredRoomTypeId).toBe('rt-tx');
      expect(first.data.schoolId).toBe(SCHOOL_ID);
    });

    it('imports a subject with its national code and its flag, through the pipe', async () => {
      // The two timplan columns cross the whitelist here and nowhere else: a
      // DTO spec validates the class, not the pipe that forbids unknown keys.
      // The code is read against NationalSubjects once per file and folded to
      // the table's case, so a hand-typed " ma " lands as MA.
      harness.tx['subject']!['findMany']!.mockResolvedValue([]);
      harness.tx['roomType']!['findMany']!.mockResolvedValue([]);
      harness.tx['nationalSubject']!['findMany']!.mockResolvedValue([{ code: 'MA' }]);
      harness.tx['subject']!['create']!.mockResolvedValue({ id: 'sub-1' });

      const response = await post(harness, 'subjects')
        .send({
          rows: [
            { name: 'Resurs matematik', nationalCode: ' ma ', countsTowardTimplan: false },
            { name: 'Bild', nationalCode: null, countsTowardTimplan: null },
          ],
        })
        .expect(201);

      expect(response.body).toMatchObject({ created: 2, errors: [] });
      const written = harness.tx['subject']!['create']!.mock.calls.map(
        (call) =>
          (call[0] as { data: { nationalCode: string | null; countsTowardTimplan: boolean } })
            .data,
      );
      expect(written).toEqual([
        expect.objectContaining({ nationalCode: 'MA', countsTowardTimplan: false }),
        // An empty cell is the column default, written explicitly.
        expect.objectContaining({ nationalCode: null, countsTowardTimplan: true }),
      ]);
      expect(harness.tx['nationalSubject']!['findMany']).toHaveBeenCalledTimes(1);
    });

    it('fails the row of an unknown national code in Swedish, and creates nothing', async () => {
      harness.tx['subject']!['findMany']!.mockResolvedValue([]);
      harness.tx['roomType']!['findMany']!.mockResolvedValue([]);
      harness.tx['nationalSubject']!['findMany']!.mockResolvedValue([{ code: 'MA' }]);

      const response = await post(harness, 'subjects')
        .send({ rows: [{ name: 'Matte', nationalCode: 'MATTE' }] })
        .expect(201);

      expect(response.body).toMatchObject({ created: 0 });
      expect(response.body.errors).toEqual([
        { row: 1, message: expect.stringMatching(/nationalCode.*"MATTE"/) },
      ]);
      // A subject created without the mapping it was given is one every
      // timplan sum would silently miss.
      expect(harness.tx['subject']!['create']).not.toHaveBeenCalled();
    });

    it('400s a flag that is not a boolean, before the handler', async () => {
      // The browser mapper turns ja/nej into booleans; a client that sends the
      // word must be stopped at the pipe, or "nej" would land as truthy.
      const response = await post(harness, 'subjects')
        .send({ rows: [{ name: 'Resurs', countsTowardTimplan: 'nej' }] })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('countsTowardTimplan');
      expect(harness.tx['subject']!['create']).not.toHaveBeenCalled();
    });

    it('rejects a colour that is not a hex colour', async () => {
      const response = await post(harness, 'subjects')
        .send({ rows: [{ name: 'Bild', color: 'rosa' }] })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('color');
    });

    it('400s if a client sends a year to the subject route', async () => {
      await post(harness, 'subjects')
        .send({ academicYearId: YEAR_ID, rows: [{ name: 'Bild' }] })
        .expect(400);
    });

    it('imports room types with no year in the body at all', async () => {
      // The web dialog omits academicYearId for this kind. With
      // forbidNonWhitelisted validation, sending one anyway would be a 400 —
      // so this route and the client must agree, and here they are checked
      // against each other rather than by inspection.
      harness.tx['roomType']!['findMany']!.mockResolvedValue([]);
      harness.tx['roomType']!['create']!.mockResolvedValue({ id: 'rt-1' });

      const response = await post(harness, 'room-types')
        .send({ rows: [{ name: 'Textilslöjd' }, { name: 'Hemkunskapssal' }] })
        .expect(201);

      expect(response.body).toMatchObject({ created: 2, errors: [] });
      const createArgs = harness.tx['roomType']!['create']!.mock.calls[0]?.[0] as {
        data: { schoolId: string };
      };
      expect(createArgs.data.schoolId).toBe(SCHOOL_ID);
    });

    it('400s if a client does send a year to the room-type route', async () => {
      await post(harness, 'room-types')
        .send({ academicYearId: YEAR_ID, rows: [{ name: 'Bildsal' }] })
        .expect(400);
    });
  });

  describe('validation', () => {
    it('rejects an empty row list rather than reporting a no-op success', async () => {
      await post(harness, 'teachers').send({ rows: [] }).expect(400);
    });

    it('rejects a row list over the cap', async () => {
      const rows = Array.from({ length: 501 }, (_, i) => ({
        firstName: 'A',
        lastName: 'B',
        email: `person${i}@example.com`,
      }));

      await post(harness, 'teachers').send({ rows }).expect(400);
    });

    it('rejects a malformed email, naming the field', async () => {
      const response = await post(harness, 'teachers')
        .send({ rows: [{ firstName: 'A', lastName: 'B', email: 'not-an-email' }] })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('email');
    });

    it('rejects a post over 100 % and a behörighet with no kind, naming the field', async () => {
      const post100 = await post(harness, 'teachers')
        .send({
          rows: [{ firstName: 'A', lastName: 'B', email: 'a@example.com', employmentPercent: 110 }],
        })
        .expect(400);
      expect(JSON.stringify(post100.body)).toContain('över 100 %');

      const noKind = await post(harness, 'teacher-qualifications')
        .send({ rows: [{ teacherEmail: 'a@example.com', subject: 'MA', minGrade: 7, maxGrade: 9 }] })
        .expect(400);
      // The message is the DTO's own sentence, prefixed with the row it is about.
      expect(JSON.stringify(noKind.body)).toContain('rows.0.Behörigheten är LEGITIMATION');
    });

    it('rejects a student row missing its class', async () => {
      await post(harness, 'students')
        .send({
          academicYearId: YEAR_ID,
          rows: [{ firstName: 'A', lastName: 'B', email: 'a@example.com' }],
        })
        .expect(400);
    });

    it('rejects a year that is not a uuid', async () => {
      await post(harness, 'students')
        .send({ academicYearId: '2026/2027', rows: [] })
        .expect(400);
    });

    it('rejects a recurrence that is not one of the three the enum has', async () => {
      const response = await post(harness, 'requirements')
        .send({
          academicYearId: YEAR_ID,
          rows: [
            {
              groupName: '7A',
              subject: 'MA',
              lessonsPerWeek: 3,
              minutesPerLesson: 60,
              recurrence: 'udda', // the Swedish the FILE carries; csv.ts folds it
            },
          ],
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('recurrence');
    });

    it('rejects a period date that is shaped right but does not exist', async () => {
      // 2026-02-30 passes /^\d{4}-\d{2}-\d{2}$/ and rolls over to 2026-03-02
      // in every JavaScript parser downstream — see is-calendar-date.ts.
      const response = await post(harness, 'requirements')
        .send({
          academicYearId: YEAR_ID,
          rows: [
            {
              groupName: '7A',
              subject: 'MA',
              lessonsPerWeek: 3,
              minutesPerLesson: 60,
              recurrence: 'ALL_WEEKS',
              startDate: '2026-02-30',
            },
          ],
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('startDate');
    });

    /*
     * The wire contract for the column set, both directions.
     *
     * The client reports the WHOLE header, because that is what "which columns
     * the file had" means. Narrowing the DTO to the five columns the server
     * actually consults was tried, and it turned an honest four-column upload
     * into a 400 — caught by a client test asserting the request body, which is
     * the only place the two halves meet. This pins it where they meet for
     * real.
     */
    it('accepts every column name the client can report', async () => {
      harness.tx['studentGroup']!['findMany']!.mockResolvedValue([]);
      harness.tx['subject']!['findMany']!.mockResolvedValue([]);
      harness.tx['user']!['findMany']!.mockResolvedValue([]);
      harness.tx['teachingRequirement']!['findMany']!.mockResolvedValue([]);
      Object.assign(harness.tx, { $queryRaw: jest.fn().mockResolvedValue([]) });

      await post(harness, 'requirements')
        .send({
          academicYearId: YEAR_ID,
          columns: [
            'groupName',
            'subject',
            'lessonsPerWeek',
            'minutesPerLesson',
            'teacherEmail',
            'coTeacherEmail',
            'recurrence',
            'startDate',
            'endDate',
          ],
          rows: [
            {
              groupName: '7A',
              subject: 'MA',
              lessonsPerWeek: 3,
              minutesPerLesson: 60,
              recurrence: 'ALL_WEEKS',
            },
          ],
        })
        .expect(201);
    });

    it('refuses a column name that is not a column', async () => {
      const response = await post(harness, 'requirements')
        .send({
          academicYearId: YEAR_ID,
          columns: ['groupName', 'teacherName'],
          rows: [
            {
              groupName: '7A',
              subject: 'MA',
              lessonsPerWeek: 3,
              minutesPerLesson: 60,
              recurrence: 'ALL_WEEKS',
            },
          ],
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('columns');
    });

    it('never lets a body carry the tenant id', async () => {
      await post(harness, 'teachers')
        .send({
          schoolId: 'some-other-school',
          rows: [{ firstName: 'A', lastName: 'B', email: 'a@example.com' }],
        })
        .expect(400);
    });
  });

  describe('RBAC', () => {
    it.each(['TEACHER', 'STUDENT', 'GUARDIAN'])(
      'denies %s on every import route',
      async (role) => {
        for (const path of [
          'subjects',
          'teachers',
          'students',
          'groups',
          'room-types',
          'group-members',
          'requirements',
          'teacher-qualifications',
          'teacher-duties',
          'timplan',
        ]) {
          await request(harness.app.getHttpServer())
            .post(`/api/v1/import/${path}`)
            .set('x-test-user', asUser({ role: role as never }))
            .send({ rows: [{ name: 'x' }] })
            .expect(403);
        }
      },
    );

    it('403s a school admin with no school on the principal', async () => {
      await request(harness.app.getHttpServer())
        .post('/api/v1/import/room-types')
        .set('x-test-user', asUser({ schoolId: undefined }))
        .send({ rows: [{ name: 'Aula' }] })
        .expect(403);
    });
  });
});

describe('CSV import rate limit (e2e)', () => {
  let harness: TestHarness;

  beforeAll(async () => {
    // Its own app: the limiter counts per process, so a shared one would leak
    // into — and be leaked into by — every other spec in this file.
    process.env['THROTTLE_LIMIT'] = '1000';
    harness = await createTestApp({ throttle: true });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('cuts a runaway client off at the 10 imports/minute the controller declares', async () => {
    harness.tx['roomType']!['findMany']!.mockResolvedValue([]);
    harness.tx['roomType']!['create']!.mockResolvedValue({ id: 'rt-1' });

    const send = () =>
      request(harness.app.getHttpServer())
        .post('/api/v1/import/room-types')
        .set('x-test-user', asUser({}))
        .send({ rows: [{ name: 'Aula' }] });

    // The route limit (10) must bind before the global default (1000 in the
    // test environment), or the decorator is not doing anything.
    for (let i = 0; i < 10; i++) {
      await send().expect(201);
    }
    await send().expect(429);
  });
});
