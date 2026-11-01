import {
  TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
  consecutiveWishMessage,
  unkeptConsecutiveWishes,
  type ConsecutiveWish,
} from './consecutive-wishes';
import { timetableWith, type TimedLesson } from './free-day-wishes';

const EVA = '22222222-ffff-4fff-8fff-222222222222';
const OLLE = '33333333-ffff-4fff-8fff-333333333333';
const RULE_EVA = '77777777-ffff-4fff-8fff-777777777771';
const RULE_OLLE = '77777777-ffff-4fff-8fff-777777777772';

const clock = (value: string): number => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours! * 60 + minutes!;
};

const wish = (overrides: Partial<ConsecutiveWish> = {}): ConsecutiveWish => ({
  ruleId: RULE_EVA,
  userId: EVA,
  maxMinutes: 180,
  breakMinutes: 30,
  ...overrides,
});

let next = 0;
const lesson = (start: string, end: string, overrides: Partial<TimedLesson> = {}): TimedLesson => ({
  id: `l-${++next}`,
  teacherId: EVA,
  coTeacherId: null,
  dayOfWeek: 1,
  startMinutes: clock(start),
  endMinutes: clock(end),
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...overrides,
});

describe('unkeptConsecutiveWishes', () => {
  it('keeps a limit no stretch of the teacher’s is longer than', () => {
    expect(
      unkeptConsecutiveWishes(
        [wish()],
        [
          // Exactly the limit, then a break of exactly the pause, then another hour.
          lesson('08:00', '11:00'),
          lesson('11:30', '12:30'),
          // Somebody else's long Tuesday.
          lesson('08:00', '14:00', { teacherId: OLLE, dayOfWeek: 2 }),
        ],
      ),
    ).toEqual([]);
  });

  it('names a limit a stretch breaks, in a conflict’s shape: the figures in the sentence, Eva beside it, nobody named', () => {
    expect(unkeptConsecutiveWishes([wish()], [lesson('08:00', '10:00'), lesson('10:10', '12:10')])).toEqual([
      {
        category: 'AVAILABILITY',
        code: TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
        params: { day: 1, minutes: 250, max: 180, breakMinutes: 30 },
        message: consecutiveWishMessage({ day: 1, minutes: 250, max: 180, breakMinutes: 30 }),
        requirementIds: [],
        roomIds: [],
        constraintIds: [],
        resourceIds: [RULE_EVA],
        resourceNames: [],
        // Server-only: the job view names her from it when the run is read.
        subjectIds: [EVA],
      },
    ]);
  });

  it('counts a lesson she co-teaches: it keeps her in the room as surely', () => {
    expect(
      unkeptConsecutiveWishes(
        [wish()],
        [lesson('08:00', '10:00', { teacherId: OLLE, coTeacherId: EVA }), lesson('10:00', '12:00')],
      ),
    ).toHaveLength(1);
  });

  it('says one note per teacher, about the longest stretch, the earliest weekday when two are as long', () => {
    const notes = unkeptConsecutiveWishes(
      [wish()],
      [
        lesson('08:00', '11:30', { dayOfWeek: 4 }),
        lesson('08:00', '11:30', { dayOfWeek: 2 }),
        lesson('08:00', '11:00', { dayOfWeek: 1 }),
        lesson('08:00', '12:00', { dayOfWeek: 5 }),
      ],
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.params).toEqual({ day: 5, minutes: 240, max: 180, breakMinutes: 30 });
    const tied = unkeptConsecutiveWishes(
      [wish()],
      [lesson('08:00', '11:30', { dayOfWeek: 4 }), lesson('08:00', '11:30', { dayOfWeek: 2 })],
    );
    expect(tied[0]!.params).toMatchObject({ day: 2, minutes: 210 });
  });

  it('breaks a limit by hand-made or locked lessons alone: the note is the school’s to act on', () => {
    // The generator could do nothing about it; the teacher is in the room all the same.
    expect(unkeptConsecutiveWishes([wish()], [lesson('08:00', '12:00')])).toHaveLength(1);
  });

  it('does not put an odd week’s lesson beside an even week’s', () => {
    expect(
      unkeptConsecutiveWishes(
        [wish({ maxMinutes: 120 })],
        [
          lesson('08:00', '10:00', { recurrence: 'ODD_WEEKS' }),
          lesson('10:00', '12:00', { recurrence: 'EVEN_WEEKS' }),
        ],
      ),
    ).toEqual([]);
  });

  it('orders several notes by weekday, then by rule, so two reads of one run say it in one order', () => {
    const notes = unkeptConsecutiveWishes(
      [wish({ ruleId: RULE_OLLE, userId: OLLE }), wish()],
      [
        lesson('08:00', '12:00', { dayOfWeek: 3, teacherId: OLLE }),
        lesson('08:00', '12:00', { dayOfWeek: 3 }),
        lesson('13:00', '17:00', { dayOfWeek: 1 }),
      ],
    );
    expect(notes.map((note) => [note.params!['day'], note.resourceIds[0]])).toEqual([
      [1, RULE_EVA],
      [3, RULE_OLLE],
    ]);
  });

  it('says nothing for a teacher who teaches nothing, or for no wishes', () => {
    expect(unkeptConsecutiveWishes([wish()], [])).toEqual([]);
    expect(unkeptConsecutiveWishes([], [lesson('08:00', '14:00')])).toEqual([]);
  });
});

describe('timetableWith feeds it the post’s own window and the solved hour', () => {
  it('reads a candidate’s lessons as the apply would write them', () => {
    const rows = [
      { id: 'req-ma', teacherId: EVA, coTeacherId: null, recurrence: 'ALL_WEEKS' as const, startDate: null, endDate: null },
    ];
    const timetable = timetableWith([], rows, [
      { requirementId: 'req-ma', dayOfWeek: 2, startTime: '08:00:00', endTime: '10:00:00' },
      { requirementId: 'req-ma', dayOfWeek: 2, startTime: '10:00:00', endTime: '12:00:00' },
    ]);
    expect(unkeptConsecutiveWishes([wish({ maxMinutes: 180 })], timetable)).toMatchObject([
      { params: { day: 2, minutes: 240 } },
    ]);
  });
});

describe('consecutiveWishMessage', () => {
  it('says the limit, the pause, the stretch and the weekday in the catalogue’s English', () => {
    expect(consecutiveWishMessage({ day: 2, minutes: 240, max: 180, breakMinutes: 30 })).toBe(
      'A teacher should teach at most 180 minutes in a row before 30 minutes free, and the new timetable ' +
        'gives them 240 minutes in a row on Tuesdays. The generator tries to keep the limit but weighs it ' +
        'against the rest of the week, and gives way where keeping it would cost more.',
    );
  });
});
