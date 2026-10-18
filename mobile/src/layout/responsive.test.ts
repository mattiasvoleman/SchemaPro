import { columnLayout, sideBySide, weekColumns, widthClass, GUTTER, READABLE_MAX, REGISTER_MAX } from './responsive';

describe('window classes', () => {
  it.each([
    [375, 'compact'], [599, 'compact'], [600, 'medium'], [744, 'medium'], [820, 'medium'],
    [834, 'medium'], [840, 'expanded'], [1032, 'expanded'], [1366, 'expanded'],
  ] as const)('%i pt is %s', (width, expected) => {
    expect(widthClass(width)).toBe(expected);
  });
});

describe('the reading column', () => {
  it('keeps the phone gutter on a phone and in Slide Over', () => {
    expect(columnLayout(390).gutter).toBe(GUTTER);
    expect(columnLayout(320).gutter).toBe(GUTTER);
  });
  it.each([744, 820, 1032, 1180, 1366])('is never wider than READABLE_MAX at %i pt', (width) => {
    const { columnWidth, gutter } = columnLayout(width);
    expect(columnWidth).toBeLessThanOrEqual(READABLE_MAX);
    expect(gutter * 2 + columnWidth).toBe(width);
  });
});

describe('the register', () => {
  it('is one centred column, never wider than a name and four 44 pt buttons need', () => {
    for (const width of [390, 744, 820, 1024, 1366]) {
      expect(columnLayout(width, REGISTER_MAX).columnWidth).toBeLessThanOrEqual(REGISTER_MAX);
    }
    expect(columnLayout(1366, REGISTER_MAX).gutter).toBe(323);
  });
});

it('puts a form beside its list only when expanded', () => {
  expect([390, 820, 840, 1366].map(sideBySide)).toEqual([false, false, true, true]);
});

describe("a child's week", () => {
  it.each([
    // A column per school day once five fit; a week with a Saturday or Sunday in it is still five.
    [1366, 5, 5], [1180, 5, 5], [1180, 6, 5], [1180, 7, 5],
    // Two on an expanded window narrower than that (a 13-inch iPad upright, an iPad mini on its side).
    [1179, 5, 2], [1032, 7, 2], [840, 5, 2],
    // One below the expanded class, as on a phone.
    [839, 5, 1], [820, 5, 1], [390, 7, 1],
    // A week not loaded yet has no days, so no grid.
    [1366, 0, 0], [1032, 0, 0],
  ] as const)('at %i pt, %i days are %i columns', (width, days, expected) => {
    expect(weekColumns(width, days)).toBe(expected);
  });
});
