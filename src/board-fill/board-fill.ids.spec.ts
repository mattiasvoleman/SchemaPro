import type { TrayBrick } from '../board-tray/board-tray.service';
import { fillIdOf, lessonOfBrick } from './board-fill.service';

/*
 * The id a brick has as a lesson that stands nowhere. The fill puts the lessons it lays into the judge's reads under these ids, and the judge names a lesson
 * its clash rule meets by looking its row up with the id (lesson-judge.ts namesOf, `WHERE id IN (...)` on a uuid column). An id that is no uuid reaches
 * Postgres as one and the whole proposal answers 500 (P2007: invalid input syntax for type uuid). A brick's id must therefore be a uuid in form, the same
 * every time for one brick and another for another.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const brick = (over: Partial<TrayBrick> = {}): TrayBrick => ({
  postId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  nth: 1,
  partKey: 'p'.repeat(16),
  lessonId: null,
  studentGroupId: 'c1',
  subjectId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  teacherId: '44444444-4444-4444-8444-444444444444',
  coTeacherId: null,
  minutes: 60,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  blockId: null,
  cannotPlace: null,
  possibleTimes: null,
  ...over,
});

describe('the id of a brick as a lesson that stands nowhere', () => {
  it('is a uuid, so that the judge can look it up without Postgres refusing it', () => {
    expect(lessonOfBrick(brick()).id).toMatch(UUID);
    expect(lessonOfBrick(brick({ teacherId: null, nth: 12, minutes: 45 })).id).toMatch(UUID);
  });

  it('is the same for one brick and another for another', () => {
    const one = lessonOfBrick(brick()).id;
    expect(lessonOfBrick(brick()).id).toBe(one);
    expect(new Set([one, lessonOfBrick(brick({ nth: 2 })).id, lessonOfBrick(brick({ minutes: 45 })).id, lessonOfBrick(brick({ teacherId: null })).id, lessonOfBrick(brick({ postId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })).id]).size).toBe(5);
    expect(fillIdOf('x')).toMatch(UUID);
  });
});
