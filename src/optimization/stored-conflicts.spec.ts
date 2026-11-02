import { notedTeachersOf, notesViewOf } from './stored-conflicts';

const EVA = '22222222-ffff-4fff-8fff-222222222222';
const OLLE = '33333333-ffff-4fff-8fff-333333333333';
const names = new Map([
  [EVA, 'Eva Ek'],
  [OLLE, 'Olle Ås'],
]);

const note = (code: string, subjectIds: string[]) => ({
  category: 'AVAILABILITY' as const,
  code,
  params: { day: 2 },
  message: 'English',
  resourceNames: [],
  subjectIds,
});

describe('a note names its teacher when it is read, except one about a limit on teaching in a row', () => {
  it('names the teacher of a free-day wish for every reader', () => {
    const stored = [note('TEACHER_FREE_DAY_WISH_NOT_KEPT', [EVA])];
    expect(notedTeachersOf(stored)).toEqual([EVA]);
    expect(notesViewOf(stored, names)[0]!.resourceNames).toEqual(['Eva Ek']);
  });

  it('names nobody for a note about a limit on teaching in a row: that is HR data, read back from the post for a reader with HR-läs and nowhere else', () => {
    const stored = [
      note('TEACHER_CONSECUTIVE_TEACHING_NOT_KEPT', [EVA]),
      note('TEACHER_FREE_DAY_WISH_NOT_KEPT', [OLLE]),
    ];
    // The names a reader is given are read for the teachers this list returns:
    // Eva’s is not among them, so her name is not even fetched.
    expect(notedTeachersOf(stored)).toEqual([OLLE]);
    // And were it in the map all the same, it is not put beside the note.
    const view = notesViewOf(stored, names);
    expect(view.map((entry) => entry.resourceNames)).toEqual([[], ['Olle Ås']]);
    expect(JSON.stringify(view)).not.toMatch(/Eva|subjectIds/);
  });
});
