import type { PlacementRefusalReason } from './placement-judge';
import {
  BLOCK_PLACEMENT_REFUSED,
  BLOCK_PLACEMENTS_STALE,
  blockPlacementRefusedConflict,
  blockPlacementsStaleConflict,
  placementRefusalText,
  placementRefusedConflict,
  placementsStaleConflict,
  REQUIREMENT_PLACEMENT_REFUSED,
  REQUIREMENT_PLACEMENTS_STALE,
} from './placement-refusal';

const other = { otherKind: 'LESSON', className: '7B', subjectName: 'Matematik', day: 2, start: '10:30', end: '11:30' };

describe('placementRefusalText', () => {
  it.each<[PlacementRefusalReason, Record<string, string | number> | undefined, RegExp]>([
    ['SCHOOL_DAY', undefined, /utanför skoldagen/],
    ['OVER_DEMAND', undefined, /redan lagda av låsta lektioner/],
    ['TEACHER', other, /^Läraren har redan Matematik 7B tisdag 10:30–11:30\.$/],
    ['TEACHER', { ...other, otherKind: 'PLACEMENT' }, /^Läraren har redan förläggningen för Matematik 7B tisdag 10:30–11:30\.$/],
    ['ROOM', other, /^Salen är redan upptagen av Matematik 7B/],
    ['GROUP', other, /^Klassen har redan Matematik 7B/],
    ['PUPILS', other, /^Elever i klassen har redan Matematik 7B/],
    ['AVAILABILITY', { resource: 'ROOM' }, /^Salen är inte tillgänglig/],
    ['AVAILABILITY', { resource: 'TEACHER' }, /^Läraren är inte tillgänglig/],
    ['AVAILABILITY', { resource: 'GROUP' }, /^Klassen är inte tillgänglig/],
    ['AVAILABILITY', undefined, /^Läraren, salen eller klassen är inte tillgänglig/],
    ['FRAME', undefined, /ramtid/],
    ['LUNCH', undefined, /lunch/],
    ['GRADE_RULE', undefined, /årskurs/],
    ['OTHER_SCHOOL', { schools: 'Norra skolan, Södra skolan' }, /vid Norra skolan, Södra skolan/],
    ['OTHER_SCHOOL', undefined, /vid en annan skola/],
    ['TEACHER', undefined, /^Läraren har redan en annan lektion\.$/],
  ])('%s says it in a sentence', (reason, params, expected) => {
    expect(placementRefusalText(reason, params)).toMatch(expected);
  });
});

describe('placementRefusedConflict', () => {
  it('is a 409 whose params are flat: the row\'s index, the reason and what the reason carries', () => {
    const conflict = placementRefusedConflict({ index: 2, ok: false, reason: 'TEACHER', params: other });
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toEqual({
      message: 'Förläggning 3: Läraren har redan Matematik 7B tisdag 10:30–11:30.',
      code: REQUIREMENT_PLACEMENT_REFUSED,
      params: { index: 2, reason: 'TEACHER', ...other },
    });
  });

  it('carries a reason without figures as index and reason alone', () => {
    const response = placementRefusedConflict({ index: 0, ok: false, reason: 'LUNCH' }).getResponse() as { params: unknown };
    expect(response.params).toEqual({ index: 0, reason: 'LUNCH' });
  });
});

describe('the sentences of BLOCK and BLOCK_FIT', () => {
  it('PAIR_ROOM says both halves of a pair need a room', () => {
    expect(placementRefusalText('PAIR_ROOM')).toMatch(/båda platserna måste ha en sal/);
  });

  it('BLOCK tells a post in a block to place the block instead', () => {
    expect(placementRefusalText('BLOCK')).toMatch(/^Posten ligger i ett parallellt block/);
    expect(placementRefusalText('BLOCK')).toMatch(/förlägg blocket i stället\.$/);
  });

  it('BLOCK_FIT says the block\'s lessons no longer fit it, and what to do about it, whatever the rule', () => {
    expect(placementRefusalText('BLOCK_FIT')).toMatch(/^Blockets förlagda lektioner passar inte längre blocket\./);
    expect(placementRefusalText('BLOCK_FIT')).toMatch(/ändra eller ta bort förläggningarna\.$/);
    expect(placementRefusalText('BLOCK_FIT', { rule: 'COUNT' })).toBe(placementRefusalText('BLOCK_FIT'));
  });

  it('is a 409 of the plain refusal, with the rule among the params, when a post\'s own verdict is BLOCK_FIT', () => {
    const conflict = placementRefusedConflict({ index: 0, ok: false, reason: 'BLOCK_FIT', params: { rule: 'LENGTH' } });
    expect(conflict.getResponse()).toMatchObject({ code: REQUIREMENT_PLACEMENT_REFUSED, params: { index: 0, reason: 'BLOCK_FIT', rule: 'LENGTH' } });
  });
});

describe('blockPlacementRefusedConflict', () => {
  it('is a 409 whose params are flat: the lesson\'s index, the member it is found on, the reason and what the reason carries', () => {
    const conflict = blockPlacementRefusedConflict({ index: 2, requirementId: 'req-7', ok: false, reason: 'TEACHER', params: other });
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toEqual({
      message: 'Förläggning 3: Läraren har redan Matematik 7B tisdag 10:30–11:30.',
      code: BLOCK_PLACEMENT_REFUSED,
      params: { index: 2, requirementId: 'req-7', reason: 'TEACHER', ...other },
    });
  });

  it('has a code of its own, which is not the post\'s', () => {
    expect(BLOCK_PLACEMENT_REFUSED).toBe('BLOCK_PLACEMENT_REFUSED');
    expect(BLOCK_PLACEMENT_REFUSED).not.toBe(REQUIREMENT_PLACEMENT_REFUSED);
  });

  it('carries a reason without figures as index, member and reason alone, and counts lessons from one in its sentence', () => {
    const response = blockPlacementRefusedConflict({ index: 0, requirementId: 'req-7', ok: false, reason: 'LUNCH' }).getResponse() as { message: string; params: unknown };
    expect(response.params).toEqual({ index: 0, requirementId: 'req-7', reason: 'LUNCH' });
    expect(response.message).toMatch(/^Förläggning 1: /);
  });

  it('tells a verdict with no reason as the school day, as the post\'s does', () => {
    const response = blockPlacementRefusedConflict({ index: 1, requirementId: 'req-7', ok: false }).getResponse() as { message: string; params: unknown };
    expect(response.params).toEqual({ index: 1, requirementId: 'req-7', reason: 'SCHOOL_DAY' });
    expect(response.message).toMatch(/utanför skoldagen/);
  });

  it('carries a block that does not fit its lessons (BLOCK_FIT) with the rule beside the reason', () => {
    const conflict = blockPlacementRefusedConflict({ index: 0, requirementId: 'req-7', ok: false, reason: 'BLOCK_FIT', params: { rule: 'COUNT' } });
    expect(conflict.getResponse()).toMatchObject({
      message: expect.stringContaining('passar inte längre blocket'),
      params: { index: 0, requirementId: 'req-7', reason: 'BLOCK_FIT', rule: 'COUNT' },
    });
  });

  it('keeps every param a short flat value, which is all the exception filter forwards', () => {
    const response = blockPlacementRefusedConflict({ index: 4, requirementId: 'req-7', ok: false, reason: 'OTHER_SCHOOL', params: { schools: 'Norra skolan' } }).getResponse() as {
      params: Record<string, unknown>;
    };
    for (const value of Object.values(response.params)) expect(typeof value === 'string' || typeof value === 'number').toBe(true);
  });
});

describe('blockPlacementsStaleConflict', () => {
  it('is a 409 with a code of its own and a sentence that says to read the block again, and no params', () => {
    const conflict = blockPlacementsStaleConflict();
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toEqual({
      message: 'Blockets förläggningar har ändrats sedan du läste dem. Läs om blocket och gör om ändringen.',
      code: BLOCK_PLACEMENTS_STALE,
    });
    expect(BLOCK_PLACEMENTS_STALE).toBe('BLOCK_PLACEMENTS_STALE');
  });

  it('is a new exception each time, so that nothing is shared between two refusals', () => {
    expect(blockPlacementsStaleConflict()).not.toBe(blockPlacementsStaleConflict());
  });
});

describe('placementsStaleConflict', () => {
  it('is a 409 with its own code and flat params naming the post', () => {
    const conflict = placementsStaleConflict('post-1');
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toEqual({
      message: 'Postens förläggningar har ändrats sedan du läste dem. Läs om dem och försök igen.',
      code: REQUIREMENT_PLACEMENTS_STALE,
      params: { requirementId: 'post-1' },
    });
  });
});
