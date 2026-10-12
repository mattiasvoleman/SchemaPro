import { diffLogEntry } from './employment-log-diff';

describe('diffLogEntry', () => {
  const post = {
    id: 'e1',
    userId: 'u1',
    academicYearId: 'y1',
    employmentPercent: 100,
    reductionPercent: 0,
    contractKind: 'FERIE',
    teachingTargetMinutesPerWeek: null,
    signature: 'ANN',
  };

  it('lists every field of a created post in the form’s order, never its identity', () => {
    expect(diffLogEntry('EMPLOYMENT', null, post).map((change) => change.field)).toEqual([
      'employmentPercent',
      'reductionPercent',
      'contractKind',
      'teachingTargetMinutesPerWeek',
      'signature',
    ]);
    expect(diffLogEntry('EMPLOYMENT', null, post)[0]).toEqual({ field: 'employmentPercent', before: null, after: 100 });
  });

  it('lists only what an update moved, before and after', () => {
    expect(diffLogEntry('EMPLOYMENT', post, { ...post, employmentPercent: 80, reductionPercent: 10 })).toEqual([
      { field: 'employmentPercent', before: 100, after: 80 },
      { field: 'reductionPercent', before: 0, after: 10 },
    ]);
    expect(diffLogEntry('EMPLOYMENT', post, { ...post })).toEqual([]);
  });

  it('lists every field a deleted duty had, in the duty’s order', () => {
    const duty = {
      id: 'd1', userId: 'u1', academicYearId: 'y1', kind: 'MENTORSKAP', label: 'Mentor 7B', minutesPerWeek: 90,
      countsAsTeaching: false, subjectId: null, studentGroupId: 'g7b', blockedConstraintId: null, noteChanged: true,
    };
    expect(diffLogEntry('DUTY', duty, null).map((change) => [change.field, change.before, change.after])).toEqual([
      ['kind', 'MENTORSKAP', null],
      ['label', 'Mentor 7B', null],
      ['minutesPerWeek', 90, null],
      ['countsAsTeaching', false, null],
      ['subjectId', null, null],
      ['studentGroupId', 'g7b', null],
      ['blockedConstraintId', null, null],
      ['noteChanged', true, null],
    ]);
  });

  it('lists a dated uppdrag’s Från and Till in the form’s place, and a version of its times as their count (20261017090000)', () => {
    const duty = {
      id: 'd1', userId: 'u1', academicYearId: 'y1', kind: 'MENTORSKAP', label: 'Mentor 7B', minutesPerWeek: 90,
      countsAsTeaching: false, subjectId: null, studentGroupId: 'g7b', validFrom: null, validTo: '2026-12-18',
    };
    expect(diffLogEntry('DUTY', null, duty).map((change) => change.field)).toEqual([
      'kind', 'label', 'minutesPerWeek', 'countsAsTeaching', 'validFrom', 'validTo', 'subjectId', 'studentGroupId',
    ]);
    expect(diffLogEntry('DUTY', duty, { ...duty, validTo: '2027-06-11' })).toEqual([
      { field: 'validTo', before: '2026-12-18', after: '2027-06-11' },
    ]);
    // The link table's trigger writes the times' version on its own.
    expect(diffLogEntry('DUTY', { slotCount: 1 }, { slotCount: 3 })).toEqual([
      { field: 'slotCount', before: 1, after: 3 },
    ]);
  });

  it('says a note was written, never what it said, in the note’s place in the form', () => {
    const changes = diffLogEntry('EMPLOYMENT', post, { ...post, signature: 'ANS', noteChanged: true });
    expect(changes).toEqual([
      { field: 'signature', before: 'ANN', after: 'ANS' },
      { field: 'noteChanged', before: null, after: true },
    ]);
    expect(JSON.stringify(changes)).not.toContain('"note"');
  });

  it('keeps a key it does not know, last and alphabetical, so an older reader never hides a change', () => {
    expect(diffLogEntry('EMPLOYMENT', post, { ...post, zeta: 1, alpha: 'x', employmentPercent: 90 }).map((c) => c.field)).toEqual([
      'employmentPercent',
      'alpha',
      'zeta',
    ]);
  });

  it('reads a malformed side as absent rather than throwing', () => {
    expect(diffLogEntry('DUTY', 'nonsense', null)).toEqual([]);
  });
});
