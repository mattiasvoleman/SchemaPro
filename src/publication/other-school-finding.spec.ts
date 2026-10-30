import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { otherSchoolFinding } from './other-school-finding';
import type { GateLesson } from './publication-gates.reader';

/**
 * PUB_OTHER_SCHOOL as a publish reads it: the school's own lessons in the
 * window against the other school's (by times and weeks only) and the loans
 * between them, labelled with the school's own names.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const NORRA = '44444444-4444-4444-8444-444444444444';
const ANNA = 'a0000000-0000-4000-8000-000000000001';
const HALL = 'b0000000-0000-4000-8000-000000000002';
const LOCAL = 'c0000000-0000-4000-8000-000000000003';

const time = (clock: string) => new Date(`1970-01-01T${clock}:00.000Z`);
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);
const WINDOW = { from: '2030-08-19', to: '2031-06-13', yearStart: '2030-08-15', yearEnd: '2031-06-15' };

const lesson = (patch: Partial<GateLesson>): GateLesson => ({
  id: 'L1',
  subjectId: 's',
  studentGroupId: 'g',
  teacherId: ANNA,
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 2,
  startTime: '09:00',
  endTime: '10:00',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  extraGroupIds: [],
  studentIds: [],
  subjectName: 'Matematik',
  groupName: '7B',
  ...patch,
});

describe('otherSchoolFinding', () => {
  let tx: TxMock;
  const find = (lessons: GateLesson[]) => otherSchoolFinding(tx as unknown as PrismaClient, SCHOOL, lessons, WINDOW);
  const sharing = (busy: unknown[]) =>
    tx.$queryRaw.mockImplementation(async (query: unknown) => {
      const text = typeof query === 'object' && query !== null && 'sql' in query ? String((query as { sql: string }).sql) : '';
      if (text.includes('app.sibling_schools()')) return [{ school_id: NORRA, name: 'Norraskolan' }];
      if (text.includes('app.shared_teacher_busy(')) return busy;
      return [];
    });

  beforeEach(() => {
    tx = createTxMock();
    tx.user.findMany.mockResolvedValue([{ id: ANNA, firstName: 'Anna', lastName: 'Lind' }]);
    tx.room.findMany.mockResolvedValue([
      { id: HALL, name: 'Idrottshallen' },
      { id: LOCAL, name: 'Idrottshallen (Norraskolan)' },
    ]);
  });

  it('finds nothing, and reads no more, for a school without another school of its huvudman', async () => {
    await expect(find([lesson({})])).resolves.toEqual({ code: 'PUB_OTHER_SCHOOL', count: 0 });
    expect(tx.roomLoan.findMany).not.toHaveBeenCalled();
  });

  it('names a shared teacher’s lesson that meets the teacher’s lesson at the other school, the walk counted', async () => {
    sharing([
      {
        teacher_id: ANNA,
        school_id: NORRA,
        day_of_week: 2,
        start_time: time('10:10'),
        end_time: time('11:00'),
        recurrence: 'ALL_WEEKS',
        start_date: date('2030-08-15'),
        end_date: date('2031-06-15'),
        travel_minutes: 15,
      },
    ]);
    const finding = await find([lesson({}), lesson({ id: 'parked', isParked: true })]);
    expect(finding).toEqual({
      code: 'PUB_OTHER_SCHOOL',
      count: 1,
      entries: [
        {
          label: 'Matematik · 7B, tis 09:00–10:00: Anna Lind har en lektion på Norraskolan tis 10:10–11:00, restid 15 min',
          masterLessonId: 'L1',
          teacherId: ANNA,
        },
      ],
    });
    // The window bounds the other school's lessons it asks for.
    const asked = tx.$queryRaw.mock.calls.map((call) => call[0] as { sql: string; values: unknown[] }).find((q) => q.sql.includes('shared_teacher_busy'));
    expect(asked!.values).toEqual(['2030-08-19', '2031-06-13']);
  });

  it('names a lesson in a lent room in the window and one in a borrowed room outside the loan', async () => {
    sharing([]);
    tx.roomLoan.findMany.mockResolvedValue([
      {
        id: 'lent',
        status: 'APPROVED',
        ownerSchoolId: SCHOOL,
        borrowerSchoolId: NORRA,
        roomId: HALL,
        localRoomId: 'x0000000-0000-4000-8000-000000000009',
        dayOfWeek: 2,
        startTime: time('09:30'),
        endTime: time('11:00'),
        startDate: date('2030-08-19'),
        endDate: date('2031-06-13'),
      },
      {
        id: 'borrowed',
        status: 'APPROVED',
        ownerSchoolId: NORRA,
        borrowerSchoolId: SCHOOL,
        roomId: 'y0000000-0000-4000-8000-000000000008',
        localRoomId: LOCAL,
        dayOfWeek: 3,
        startTime: time('08:00'),
        endTime: time('09:00'),
        startDate: date('2030-08-19'),
        endDate: date('2031-06-13'),
      },
    ]);
    const finding = await find([
      lesson({ id: 'in-lent', teacherId: null, roomId: HALL }),
      lesson({ id: 'in-borrowed-ok', teacherId: null, roomId: LOCAL, dayOfWeek: 3, startTime: '08:00', endTime: '09:00' }),
      lesson({ id: 'in-borrowed-late', teacherId: null, roomId: LOCAL, dayOfWeek: 3, startTime: '08:30', endTime: '09:30' }),
    ]);
    expect(finding.entries).toEqual([
      { label: 'Matematik · 7B, tis 09:00–10:00: Idrottshallen är utlånad till Norraskolan tis 09:30–11:00', masterLessonId: 'in-lent' },
      {
        label: 'Matematik · 7B, ons 08:30–09:30: Idrottshallen (Norraskolan) är lånad av Norraskolan, och inget godkänt lån täcker lektionen',
        masterLessonId: 'in-borrowed-late',
      },
    ]);
  });

  it('reads a request not yet approved as no room of the school\'s: it holds nothing, and names no lesson', async () => {
    sharing([]);
    tx.roomLoan.findMany.mockResolvedValue([
      {
        id: 'waiting',
        status: 'PENDING',
        ownerSchoolId: NORRA,
        borrowerSchoolId: SCHOOL,
        roomId: 'y0000000-0000-4000-8000-000000000008',
        localRoomId: null,
        dayOfWeek: 3,
        startTime: time('08:00'),
        endTime: time('09:00'),
        startDate: date('2030-08-19'),
        endDate: date('2031-06-13'),
      },
    ]);
    const finding = await find([lesson({ id: 'anywhere', teacherId: null, roomId: LOCAL, dayOfWeek: 3, startTime: '10:00', endTime: '11:00' })]);
    expect(finding).toEqual({ code: 'PUB_OTHER_SCHOOL', count: 0 });
  });
});
