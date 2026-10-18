import { columnLayout, sideBySide, widthClass, GUTTER, READABLE_MAX, REGISTER_MAX } from './responsive';

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
