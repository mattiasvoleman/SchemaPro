import {
  TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
  consecutiveNoteMessage,
  hideConsecutiveNotes,
  unkeptConsecutiveWishes,
  type ConsecutiveWish,
} from './consecutive-wishes';
import { TEACHER_CONSECUTIVE_TEACHING_HIDDEN } from './work-days';
import { timetableWith, type TimedLesson } from './free-day-wishes';

const EVA = '22222222-ffff-4fff-8fff-222222222222';
const OLLE = '33333333-ffff-4fff-8fff-333333333333';

const clock = (value: string): number => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours! * 60 + minutes!;
};

const wish = (overrides: Partial<ConsecutiveWish> = {}): ConsecutiveWish => ({
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

  it('names a limit a stretch breaks, in a conflict’s shape, with the weekday and the length and none of the limit: Eva only server-side', () => {
    const notes = unkeptConsecutiveWishes([wish()], [lesson('08:00', '10:00'), lesson('10:10', '12:10')]);
    expect(notes).toEqual([
      {
        category: 'AVAILABILITY',
        code: TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT,
        params: { day: 1, minutes: 250 },
        message: consecutiveNoteMessage({ day: 1, minutes: 250 }),
        requirementIds: [],
        roomIds: [],
        constraintIds: [],
        resourceIds: [],
        resourceNames: [],
        // Server-only: the job view reads the limit back from the post, and
        // names her, for a reader with HR-läs (work-days.ts) and no other.
        subjectIds: [EVA],
      },
    ]);
    // HR data: not the limit, not the pause, in no field of the note.
    expect(JSON.stringify(notes)).not.toMatch(/180|"max"|breakMinutes|"30"/);
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
    expect(notes[0]!.params).toEqual({ day: 5, minutes: 240 });
    const tied = unkeptConsecutiveWishes(
      [wish()],
      [lesson('08:00', '11:30', { dayOfWeek: 4 }), lesson('08:00', '11:30', { dayOfWeek: 2 })],
    );
    expect(tied[0]!.params).toEqual({ day: 2, minutes: 210 });
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

  it('orders several notes by weekday, then by teacher, so two reads of one run say it in one order', () => {
    // Eva sorts before Olle, and Olle’s stretch is on the earlier day: the
    // weekday decides, and the teacher only breaks a tie.
    const notes = unkeptConsecutiveWishes(
      [wish({ userId: OLLE }), wish()],
      [
        lesson('08:00', '12:00', { dayOfWeek: 3 }),
        lesson('08:00', '12:00', { dayOfWeek: 1, teacherId: OLLE }),
      ],
    );
    expect(notes.map((note) => [note.params!['day'], note.subjectIds![0]])).toEqual([
      [1, OLLE],
      [3, EVA],
    ]);

    // Two stretches on one day, the wishes given in the other order: by teacher.
    const tied = unkeptConsecutiveWishes(
      [wish({ userId: OLLE }), wish()],
      [
        lesson('08:00', '12:00', { dayOfWeek: 3, teacherId: OLLE }),
        lesson('08:00', '12:00', { dayOfWeek: 3 }),
      ],
    );
    expect(tied.map((note) => note.subjectIds![0])).toEqual([EVA, OLLE]);
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

describe('consecutiveNoteMessage', () => {
  it('says the stretch and the weekday in English, and nothing of the limit', () => {
    const message = consecutiveNoteMessage({ day: 2, minutes: 240 });
    expect(message).toBe(
      'A teacher with a limit on teaching in a row has 240 minutes in a row on Tuesdays in the new timetable, ' +
        'over the limit. The generator tries to keep the limit but weighs it against the rest of the week, and ' +
        'gives way where keeping it would cost more.',
    );
  });
});

describe('hideConsecutiveNotes: what a schemaförslag stores', () => {
  const note = (code: string, overrides: Record<string, unknown> = {}) => ({
    category: 'AVAILABILITY' as const,
    code,
    params: { day: 1, minutes: 250 },
    message: 'English',
    requirementIds: [],
    roomIds: [],
    constraintIds: [],
    resourceIds: [],
    resourceNames: [],
    subjectIds: [EVA],
    ...overrides,
  });

  it('replaces every note about a limit with one hidden note: no params, no teacher, no figure, in the first one’s place', () => {
    const wishNote = note('TEACHER_FREE_DAY_WISH_NOT_KEPT', { subjectIds: [OLLE] });
    const out = hideConsecutiveNotes([
      wishNote,
      note(TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT),
      note(TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT, { subjectIds: [OLLE] }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(wishNote);
    expect(out[1]).toMatchObject({ category: 'AVAILABILITY', code: TEACHER_CONSECUTIVE_TEACHING_HIDDEN, params: {} });
    expect(out[1]).not.toHaveProperty('subjectIds');
    expect(JSON.stringify(out[1])).not.toMatch(new RegExp(`${EVA}|${OLLE}|250`));
  });

  it('changes nothing when no note is about a limit', () => {
    const notes = [note('TEACHER_FREE_DAY_WISH_NOT_KEPT')];
    expect(hideConsecutiveNotes(notes)).toEqual(notes);
    expect(hideConsecutiveNotes([])).toEqual([]);
  });
});
