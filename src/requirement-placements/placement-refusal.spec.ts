import type { PlacementRefusalReason } from './placement-judge';
import { placementRefusalText, placementRefusedConflict, REQUIREMENT_PLACEMENT_REFUSED } from './placement-refusal';

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
