import { crossesWeekEdge } from './draft-publish';

describe('crossesWeekEdge (PUB_WEEK_SPLIT)', () => {
  const MON = 1;
  const TUE = 2;
  const THU = 4;
  const FRI = 5;

  it('a range from a Monday to a Sunday splits no week', () => {
    expect(crossesWeekEdge({ validFrom: '2026-10-19', validTo: '2026-11-29' }, MON, THU)).toBe(false);
  });

  it('a mid-week validFrom splits the week for a move across it, not for one beside it', () => {
    const window = { validFrom: '2026-10-14', validTo: '2026-11-29' }; // Wednesday
    expect(crossesWeekEdge(window, THU, MON)).toBe(true);
    expect(crossesWeekEdge(window, MON, TUE)).toBe(false);
    expect(crossesWeekEdge(window, THU, FRI)).toBe(false);
  });

  it('a mid-week validTo splits the week too: the move Monday → Thursday across a Wednesday end', () => {
    const window = { validFrom: '2026-10-19', validTo: '2026-11-25' }; // Monday .. Wednesday
    expect(crossesWeekEdge(window, MON, THU)).toBe(true);
    expect(crossesWeekEdge(window, MON, TUE)).toBe(false);
  });

  it("the year's last day ends no week that anything follows", () => {
    expect(crossesWeekEdge({ validFrom: '2026-10-19', validTo: '2027-06-09', yearEnd: '2027-06-09' }, MON, THU)).toBe(false);
  });
});
