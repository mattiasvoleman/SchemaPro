import { ROWS_KEY_LENGTH, ROWS_KEY_PATTERN, rowsKeyOf } from './placement-rows-key';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p-1',
  requirementId: 'req-1',
  dayOfWeek: 2,
  startTime: new Date('1970-01-01T10:00:00.000Z'),
  minutes: 60,
  roomId: 'room-1' as string | null,
  recurrence: 'ALL_WEEKS' as const,
  teacherId: null as string | null,
  ...over,
});

describe('rowsKeyOf', () => {
  it('is a short lower-case hex token the DTO accepts back', () => {
    const key = rowsKeyOf([row()]);
    expect(key).toHaveLength(ROWS_KEY_LENGTH);
    expect(key).toMatch(ROWS_KEY_PATTERN);
  });

  it('is the same for the same rows however they are listed', () => {
    const a = row({ id: 'p-1' });
    const b = row({ id: 'p-2', dayOfWeek: 4 });
    expect(rowsKeyOf([a, b])).toBe(rowsKeyOf([b, a]));
    expect(rowsKeyOf([a, b])).toBe(rowsKeyOf([{ ...a }, { ...b }]));
  });

  it.each<[string, Record<string, unknown>]>([
    ['the row id (every save writes new ids)', { id: 'p-9' }],
    ['the weekday', { dayOfWeek: 3 }],
    ['the start', { startTime: new Date('1970-01-01T10:05:00.000Z') }],
    ['the length', { minutes: 45 }],
    ['the room', { roomId: 'room-2' }],
    ['having no room', { roomId: null }],
    ['the weeks', { recurrence: 'ODD_WEEKS' }],
    ['the teacher of a shared lesson', { teacherId: 'bo' }],
  ])('differs when %s differs', (_what, over) => {
    expect(rowsKeyOf([row(over)])).not.toBe(rowsKeyOf([row()]));
  });

  it('differs for one row more and for one row fewer', () => {
    const one = rowsKeyOf([row()]);
    expect(rowsKeyOf([row(), row({ id: 'p-2', dayOfWeek: 4 })])).not.toBe(one);
    expect(rowsKeyOf([])).not.toBe(one);
  });

  it('is one constant for a post with no rows, whichever post it is', () => {
    expect(rowsKeyOf([])).toBe('e3b0c44298fc1c14');
    expect(rowsKeyOf([])).toMatch(ROWS_KEY_PATTERN);
  });

  it('tells a list another save wrote from the same list: the ids move with every save', () => {
    const read = [row({ id: 'p-1' }), row({ id: 'p-2', dayOfWeek: 4 })];
    const writtenAgain = [row({ id: 'q-1' }), row({ id: 'q-2', dayOfWeek: 4 })];
    expect(rowsKeyOf(writtenAgain)).not.toBe(rowsKeyOf(read));
  });
});
