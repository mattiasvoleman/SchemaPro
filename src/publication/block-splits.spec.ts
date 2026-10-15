import { DEFAULT_GATE_POLICY, settleGates } from './publication-gates';
import { blockSplits, type BlockPost, type GateLesson } from './publication-gates.reader';

/**
 * PUB_BLOCK_SPLIT: a parallel block whose lessons do not all stand together.
 * Språkval åk 7 holds Tyska för Ty7 and Franska för Fr7; Elevens val åk 7 holds
 * Bild för Bi7 and Musik för Mu7.
 */

const lesson = (
  id: string,
  studentGroupId: string,
  subjectId: string,
  dayOfWeek: number,
  startTime: string,
  overrides: Partial<GateLesson> = {},
): GateLesson => ({
  id,
  subjectId,
  studentGroupId,
  teacherId: null,
  coTeacherId: null,
  roomId: null,
  dayOfWeek,
  startTime,
  endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, '0')}:${startTime.slice(3)}`,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  extraGroupIds: [],
  studentIds: [],
  subjectName: { de: 'Tyska', fr: 'Franska', bi: 'Bild', mu: 'Musik' }[subjectId] ?? subjectId,
  groupName: studentGroupId,
  ...overrides,
});

const posts: BlockPost[] = [
  { studentGroupId: 'Ty7', subjectId: 'de', blockId: 'sv', blockName: 'Språkval åk 7' },
  { studentGroupId: 'Fr7', subjectId: 'fr', blockId: 'sv', blockName: 'Språkval åk 7' },
  { studentGroupId: 'Bi7', subjectId: 'bi', blockId: 'ev', blockName: 'Elevens val åk 7' },
  { studentGroupId: 'Mu7', subjectId: 'mu', blockId: 'ev', blockName: 'Elevens val åk 7' },
];

/** Both blocks together: two cards each. */
const together = [
  lesson('ty1', 'Ty7', 'de', 1, '10:00'),
  lesson('fr1', 'Fr7', 'fr', 1, '10:00'),
  lesson('ty2', 'Ty7', 'de', 3, '10:00'),
  lesson('fr2', 'Fr7', 'fr', 3, '10:00'),
  lesson('bi1', 'Bi7', 'bi', 2, '13:00'),
  lesson('mu1', 'Mu7', 'mu', 2, '13:00'),
];

describe('blockSplits', () => {
  it('finds nothing while every block stands together', () => {
    expect(blockSplits(together, posts)).toEqual({ code: 'PUB_BLOCK_SPLIT', count: 0, entries: [], info: true });
  });

  it('counts and names the lessons standing apart, after their block', () => {
    const moved = together.map((row) => (row.id === 'fr2' ? { ...row, dayOfWeek: 4 } : row));

    expect(blockSplits(moved, posts)).toEqual({
      code: 'PUB_BLOCK_SPLIT',
      count: 2,
      entries: [
        { label: 'Språkval åk 7: Franska · Fr7, tors 10:00–11:00', masterLessonId: 'fr2' },
        { label: 'Språkval åk 7: Tyska · Ty7, ons 10:00–11:00', masterLessonId: 'ty2' },
      ],
      info: true,
    });
  });

  it('reads other weeks at the same clock as apart', () => {
    const odd = together.map((row) => (row.id === 'mu1' ? { ...row, recurrence: 'ODD_WEEKS' as const } : row));

    expect(blockSplits(odd, posts).count).toBe(2);
    expect(blockSplits(odd, posts).entries?.map((entry) => entry.masterLessonId).sort()).toEqual(['bi1', 'mu1']);
  });

  it('leaves an unplaced or parked member to the checks that name those', () => {
    const withoutFranska = together.filter((row) => row.studentGroupId !== 'Fr7');
    // On the tray, remembering Friday: it stands nowhere.
    const parked = together.map((row) => (row.id === 'mu1' ? { ...row, isParked: true, dayOfWeek: 5 } : row));

    expect(blockSplits(withoutFranska, posts).count).toBe(0);
    expect(blockSplits(parked, posts).count).toBe(0);
  });

  it('is information the publish shows and never asks about', () => {
    const moved = together.map((row) => (row.id === 'fr2' ? { ...row, dayOfWeek: 4 } : row));
    const [item] = settleGates([blockSplits(moved, posts)], DEFAULT_GATE_POLICY);

    expect(item).toMatchObject({ code: 'PUB_BLOCK_SPLIT', severity: 'INFO', count: 2 });
  });
});
