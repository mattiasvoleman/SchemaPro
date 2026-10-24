import { shareBreaches, shareWarning, type ShareWeekLesson } from './share-warnings';
import type { SharedRow } from '../common/lesson-shares';

const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CILLA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** 9A's matematik: three lessons, Bo takes one, Anna the rest. */
const MATTE: SharedRow = {
  teacherId: ANNA,
  coTeacherId: null,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  shares: [{ teacherId: BO, lessons: 1, minutes: 60 }],
};

const lesson = (id: string, teacherId: string | null, extra: Partial<ShareWeekLesson> = {}): ShareWeekLesson => ({
  id,
  teacherId,
  dayOfWeek: 1,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...extra,
});

describe('delade lektioner on a hand edit: each teacher against their share', () => {
  it('says nothing while the week gives Anna two and Bo one', () => {
    const week = [lesson('a1', ANNA), lesson('a2', ANNA, { dayOfWeek: 3 }), lesson('b1', BO, { dayOfWeek: 5 })];
    expect(shareBreaches(MATTE, week, 'a2', [{ role: 'LESSON', teacherId: ANNA }])).toEqual([]);
  });

  it('tells a lesson moved from Anna to Bo both: Bo has two of his one, Anna one of her two', () => {
    const week = [lesson('a1', ANNA), lesson('a2', BO, { dayOfWeek: 3 }), lesson('b1', BO, { dayOfWeek: 5 })];
    expect(
      shareBreaches(MATTE, week, 'a2', [
        { role: 'LESSON', teacherId: BO },
        { role: 'PREVIOUS', teacherId: ANNA },
      ]),
    ).toEqual([
      { role: 'LESSON', lessons: 2, share: 1 },
      { role: 'PREVIOUS', lessons: 1, share: 2 },
    ]);
  });

  it('gives a teacher with no part of the post a share of 0', () => {
    const week = [lesson('a1', ANNA), lesson('a2', CILLA, { dayOfWeek: 3 }), lesson('b1', BO, { dayOfWeek: 5 })];
    expect(
      shareBreaches(MATTE, week, 'a2', [
        { role: 'LESSON', teacherId: CILLA },
        { role: 'PREVIOUS', teacherId: ANNA },
      ]),
    ).toEqual([
      { role: 'LESSON', lessons: 1, share: 0 },
      { role: 'PREVIOUS', lessons: 1, share: 2 },
    ]);
  });

  it('counts a week short of a lesson only for a teacher over their share', () => {
    // One of Anna's two is on the tray, so the week holds two of three: Anna's
    // one is the tray's to tell, and Bo's one is his share.
    const short = [lesson('a1', ANNA), lesson('b1', BO, { dayOfWeek: 5 })];
    expect(shareBreaches(MATTE, short, 'a1', [{ role: 'LESSON', teacherId: ANNA }])).toEqual([]);
    // Bo given Anna's remaining one: two of his one, whatever the week lacks.
    const given = [lesson('a1', BO), lesson('b1', BO, { dayOfWeek: 5 })];
    expect(
      shareBreaches(MATTE, given, 'a1', [
        { role: 'LESSON', teacherId: BO },
        { role: 'PREVIOUS', teacherId: ANNA },
      ]),
    ).toEqual([{ role: 'LESSON', lessons: 2, share: 1 }]);
  });

  it('asks only the weeks the edited lesson runs in', () => {
    // A/B weeks: Bo's one every odd week, and in the even weeks an extra Anna
    // lesson the school locked there by hand. The even weeks give Anna three
    // and Bo none; the odd weeks are as shared.
    const week = [
      lesson('a1', ANNA),
      lesson('a2', ANNA, { dayOfWeek: 3 }),
      lesson('b-odd', BO, { dayOfWeek: 5, recurrence: 'ODD_WEEKS' }),
      lesson('a-even', ANNA, { dayOfWeek: 5, recurrence: 'EVEN_WEEKS' }),
    ];
    expect(shareBreaches(MATTE, week, 'b-odd', [{ role: 'LESSON', teacherId: BO }])).toEqual([]);
    expect(shareBreaches(MATTE, week, 'a-even', [{ role: 'LESSON', teacherId: ANNA }])).toEqual([
      { role: 'LESSON', lessons: 3, share: 2 },
    ]);
  });

  it('asks a teacher once, and nobody never', () => {
    const week = [lesson('a1', null), lesson('a2', ANNA, { dayOfWeek: 3 }), lesson('b1', BO, { dayOfWeek: 5 })];
    expect(
      shareBreaches(MATTE, week, 'a1', [
        { role: 'LESSON', teacherId: null },
        { role: 'PREVIOUS', teacherId: ANNA },
      ]),
    ).toEqual([{ role: 'PREVIOUS', lessons: 1, share: 2 }]);
    expect(
      shareBreaches(MATTE, [lesson('a1', BO), lesson('b1', BO)], 'a1', [
        { role: 'LESSON', teacherId: BO },
        { role: 'PREVIOUS', teacherId: BO },
      ]),
    ).toEqual([{ role: 'LESSON', lessons: 2, share: 1 }]);
  });

  it('sums a teacher’s shares of two lengths, and names the post in the warning', () => {
    const idrott: SharedRow = {
      teacherId: ANNA,
      lessonsPerWeek: 3,
      minutesPerLesson: 80,
      lessonLengths: [80, 80, 40],
      shares: [
        { teacherId: BO, lessons: 1, minutes: 80 },
        { teacherId: BO, lessons: 1, minutes: 40 },
      ],
    };
    const week = [lesson('a1', ANNA), lesson('b1', BO, { dayOfWeek: 3 }), lesson('b2', BO, { dayOfWeek: 5 })];
    expect(shareBreaches(idrott, week, 'b2', [{ role: 'LESSON', teacherId: BO }])).toEqual([]);
    const [breach] = shareBreaches(idrott, [...week.slice(0, 2), lesson('b2', ANNA, { dayOfWeek: 5 })], 'b2', [
      { role: 'LESSON', teacherId: ANNA },
    ]);
    expect(shareWarning(breach!, 'Idrott för 8A')).toEqual({
      code: 'SHARE_LESSONS_DIFFER',
      params: { requirement: 'Idrott för 8A', role: 'LESSON', lessons: 2, share: 1 },
    });
  });
});
