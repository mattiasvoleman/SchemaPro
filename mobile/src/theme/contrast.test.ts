import { contrast, over } from './contrast';
import { PALETTES, type Palette, type SchemeName, type Tone } from './tokens';

/**
 * WCAG 2.1 AA in both appearances (PRODUCT.md, Accessibility): 4.5:1 for
 * text (SC 1.4.3; nothing in the app is large text, so no pair takes the
 * 3:1 allowance), 3:1 for the parts of a control and its state that say it
 * is there (SC 1.4.11). Screens are not rendered in this runner
 * (jest.config.js), so the pairs a screen paints are listed here by role,
 * and a token moved under its floor fails here instead of on a phone.
 */
const TEXT = 4.5;
const UI = 3;
const TONES: readonly Tone[] = ['success', 'warning', 'danger', 'neutral'];

type Pair = readonly [what: string, fg: (p: Palette) => string, bg: (p: Palette) => string, min: number];

const PAIRS: readonly Pair[] = [
  // Running text and its muted tier, on every ground it is written on.
  ...(['background', 'surface', 'tabBar', 'lunchSurface', 'breakSurface'] as const).flatMap((ground): Pair[] => [
    [`text on ${ground}`, (p) => p.text, (p) => p[ground], TEXT],
    [`textMuted on ${ground}`, (p) => p.textMuted, (p) => p[ground], TEXT],
  ]),
  ...TONES.map((tone): Pair => [`text on the ${tone} banner`, (p) => p.text, (p) => p.toneTint[tone], TEXT]),
  // The accent as ink: links, the active tab's label, the language switch.
  ['primary on background', (p) => p.primary, (p) => p.background, TEXT],
  ['primary on surface', (p) => p.primary, (p) => p.surface, TEXT],
  ['primary on tabBar', (p) => p.primary, (p) => p.tabBar, TEXT],
  ['onPrimary on primary', (p) => p.onPrimary, (p) => p.primary, TEXT],
  // Tones as ink (error text, leave status, badges, the cached-list note).
  ...TONES.flatMap((tone): Pair[] => [
    [`${tone} on background`, (p) => p[tone], (p) => p.background, TEXT],
    [`${tone} on surface`, (p) => p[tone], (p) => p.surface, TEXT],
    [`onTone on ${tone}`, (p) => p.onTone, (p) => p[tone], TEXT],
    [`${tone} glyph on its banner`, (p) => p[tone], (p) => p.toneTint[tone], TEXT],
    // A selected attendance button: its fill against the row's ground.
    [`${tone} fill against background`, (p) => p[tone], (p) => p.background, UI],
  ]),
  ['lunchText on lunchSurface', (p) => p.lunchText, (p) => p.lunchSurface, TEXT],
  ['breakText on breakSurface', (p) => p.breakText, (p) => p.breakSurface, TEXT],
  // SC 1.4.11: a field's edge against the ground outside it and its own fill.
  ['borderStrong against background', (p) => p.borderStrong, (p) => p.background, UI],
  ['borderStrong against surface', (p) => p.borderStrong, (p) => p.surface, UI],
  // The selected chip's fill against the card it sits on; the unread card's and
  // the school-account button's primary edge against their grounds.
  ['primary against surface', (p) => p.primary, (p) => p.surface, UI],
  ['primary against background', (p) => p.primary, (p) => p.background, UI],
  // The switch: track on and off against the card, the thumb against both.
  ['switch off track against surface', (p) => p.borderStrong, (p) => p.surface, UI],
  ['iOS switch thumb (white) against the off track', () => '#ffffff', (p) => p.borderStrong, UI],
  ['iOS switch thumb (white) against the on track', () => '#ffffff', (p) => p.primary, UI],
  ['Android switch thumb (surface) against the off track', (p) => p.surface, (p) => p.borderStrong, UI],
  ['Android switch thumb (surface) against the on track', (p) => p.surface, (p) => p.primary, UI],
  // A cancelled lesson's card takes the page's ground and keeps its ink.
  ['textMuted on a cancelled card (background)', (p) => p.textMuted, (p) => p.background, TEXT],
  // The busy veil: the spinner over the veiled page.
  ['spinner on the scrim', (p) => p.primary, (p) => scrimOver(p, p.background), UI],
  ['spinner on the scrim over a card', (p) => p.primary, (p) => scrimOver(p, p.surface), UI],
];

function scrimOver(p: Palette, ground: string): string {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(p.scrim);
  if (!m) throw new Error(`scrim is not rgba(): ${p.scrim}`);
  const hex = `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`;
  return over(hex, Number(m[4]), ground);
}

describe.each(Object.keys(PALETTES) as SchemeName[])('the %s palette', (scheme) => {
  const p = PALETTES[scheme];

  it.each(PAIRS.map(([what, fg, bg, min]) => [what, fg, bg, min] as const))('%s', (_what, fg, bg, min) => {
    expect(Number(contrast(fg(p), bg(p)).toFixed(2))).toBeGreaterThanOrEqual(min);
  });

  it('names every colour as #rrggbb, so the measure above can read it', () => {
    const flat = Object.entries(p).flatMap(([key, value]) =>
      typeof value === 'string' ? [[key, value]] : Object.entries(value as Record<string, string>).map(([k, v]) => [`${key}.${k}`, v]),
    );
    for (const [key, value] of flat) {
      if (key === 'scrim') continue;
      expect(`${key} ${value}`).toMatch(/ #[0-9a-f]{6}$/);
    }
  });
});

it('gives both palettes the same roles', () => {
  expect(Object.keys(PALETTES.light).sort()).toEqual(Object.keys(PALETTES.dark).sort());
});

it('would catch the dark colours the screens painted before the theme', () => {
  // #475569 on #0f0f1a: the inactive tab and the placeholders; #6366f1 on
  // #1a1a2e: links and the selected chip on a card; white on #6366f1: every
  // primary button's label; white on #22c55e: a selected "present".
  expect(contrast('#475569', '#0f0f1a')).toBeLessThan(TEXT);
  expect(contrast('#6366f1', '#1a1a2e')).toBeLessThan(TEXT);
  expect(contrast('#ffffff', '#6366f1')).toBeLessThan(TEXT);
  expect(contrast('#ffffff', '#22c55e')).toBeLessThan(TEXT);
});

// Printed when THEME_TABLE=1, for the comment beside a token or the runbook.
if (process.env.THEME_TABLE) {
  it('prints the table', () => {
    const lines = PAIRS.map(([what, fg, bg, min]) =>
      `| ${what} | ${min} | ${contrast(fg(PALETTES.light), bg(PALETTES.light)).toFixed(2)} | ${contrast(fg(PALETTES.dark), bg(PALETTES.dark)).toFixed(2)} |`,
    );
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  });
}
