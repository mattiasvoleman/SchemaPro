import { compareSwedish, sortByDisplayName } from './sorting';

/**
 * The same rule the web app applies, in a package that shares no code with it.
 * If these two ever disagree, a teacher marking attendance on the phone reads
 * the class in a different order from the same class on the screen — which is
 * exactly how a name gets ticked twice.
 */
describe('Swedish ordering', () => {
  it('puts å, ä and ö after z, where Swedish puts them', () => {
    // PostgreSQL under C sorts them before b; under en_US it folds them into a
    // and o. Neither is Swedish, and neither is what a register looks like.
    const names = ['Öberg', 'Andersson', 'Zetterlund', 'Åkesson', 'Ängström'];

    expect([...names].sort(compareSwedish)).toEqual([
      'Andersson',
      'Zetterlund',
      'Åkesson',
      'Ängström',
      'Öberg',
    ]);
  });

  it('orders numbered names by value, not by digit', () => {
    expect(['Grupp 10', 'Grupp 2'].sort(compareSwedish)).toEqual([
      'Grupp 2',
      'Grupp 10',
    ]);
  });

  it('leaves the input untouched', () => {
    // The roster is rendered from the same array the caller keeps.
    const students = [{ displayName: 'Öberg Nils' }, { displayName: 'Ahmed Ali' }];
    const sorted = sortByDisplayName(students);

    expect(students[0]!.displayName).toBe('Öberg Nils');
    expect(sorted[0]!.displayName).toBe('Ahmed Ali');
  });
});
