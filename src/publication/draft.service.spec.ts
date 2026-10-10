import { diffDraft } from './draft.service';
import type { PublishedMaster } from './published-grundschema';

const time = (h: number) => new Date(Date.UTC(1970, 0, 1, h));
const lesson = (id: string, overrides: Partial<PublishedMaster> = {}): PublishedMaster => ({
  id,
  academicYearId: 'y',
  subjectId: 'ma',
  studentGroupId: '7a',
  teacherId: 't',
  coTeacherId: null,
  roomId: 'r',
  dayOfWeek: 1,
  startTime: time(8),
  endTime: time(9),
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  isLocked: false,
  isGenerated: true,
  extraGroups: [],
  participants: [],
  subject: { id: 'ma', name: 'Ma' },
  studentGroup: { id: '7a', name: '7A' },
  ...overrides,
});

describe('diffDraft', () => {
  it('reads a regeneration that recreated the same timetable under new ids as no change', () => {
    const published = [lesson('old-1'), lesson('old-2', { dayOfWeek: 3 }), lesson('old-3', { subjectId: 'sv' })];
    const regenerated = [lesson('new-1'), lesson('new-2', { dayOfWeek: 3 }), lesson('new-3', { subjectId: 'sv' })];
    expect(diffDraft(published, regenerated)).toEqual({ added: [], changed: [], removed: [] });
  });

  it('shows a re-keyed lesson that moved as moved, and only the rest as added or removed', () => {
    const published = [lesson('old-1'), lesson('old-2', { dayOfWeek: 3 }), lesson('old-3', { subjectId: 'sv' })];
    const regenerated = [
      lesson('new-1'),
      lesson('new-2', { dayOfWeek: 4, startTime: time(10), endTime: time(11) }),
      lesson('new-4', { subjectId: 'en' }),
    ];
    const diff = diffDraft(published, regenerated);
    expect(diff.changed.map((pair) => [pair.before.id, pair.after.id])).toEqual([['old-2', 'new-2']]);
    expect(diff.added.map((row) => row.id)).toEqual(['new-4']);
    expect(diff.removed.map((row) => row.id)).toEqual(['old-3']);
  });

  it('still pairs by id first: an edited lesson is changed, a deleted one removed, a new one added', () => {
    const diff = diffDraft(
      [lesson('a'), lesson('b', { subjectId: 'sv' })],
      [lesson('a', { roomId: 'r2' }), lesson('c', { subjectId: 'en' })],
    );
    expect(diff.changed.map((pair) => pair.after.id)).toEqual(['a']);
    expect(diff.added.map((row) => row.id)).toEqual(['c']);
    expect(diff.removed.map((row) => row.id)).toEqual(['b']);
  });
});
