import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import staticConfig from '../../app.json';
import { BRAND_TILE, NOTIFICATION_ACCENT, PALETTES } from './tokens';

/**
 * The colours the phone paints before a line of JavaScript has run live in
 * app.json as literals (the splash, the root view, the notification accent,
 * the adaptive icon's ground), and in the brand script the icons are drawn
 * from. They follow the palette here, so a token moved in tokens.ts cannot
 * leave the splash a different colour from the first screen.
 */
const MOBILE = join(__dirname, '..', '..');
const expo = staticConfig.expo as Record<string, unknown> & typeof staticConfig.expo;
type PluginEntry = string | [string, Record<string, unknown>];
const plugin = (name: string): Record<string, unknown> => {
  const entry = (expo.plugins as PluginEntry[]).find((p) => Array.isArray(p) && p[0] === name);
  if (!Array.isArray(entry)) throw new Error(`${name} is not configured with options in app.json`);
  return entry[1];
};

it('follows the phone: one appearance setting, no platform overriding it', () => {
  expect(expo.userInterfaceStyle).toBe('automatic');
  expect((expo.ios as Record<string, unknown>).userInterfaceStyle).toBeUndefined();
  expect((expo.android as Record<string, unknown>).userInterfaceStyle).toBeUndefined();
});

it('opens on the splash in the page colour of either appearance, with one image for both', () => {
  const splash = plugin('expo-splash-screen');
  expect(splash.backgroundColor).toBe(PALETTES.light.background);
  expect(splash.dark).toEqual({ backgroundColor: PALETTES.dark.background });
});

it('gives the root view a page colour until the theme sets its own', () => {
  expect([PALETTES.light.background, PALETTES.dark.background]).toContain(expo.backgroundColor);
});

it('keeps the notification accent, the adaptive icon and the brand script on the theme’s values', () => {
  expect(plugin('expo-notifications').color).toBe(NOTIFICATION_ACCENT);
  expect(expo.android.adaptiveIcon.backgroundColor).toBe(BRAND_TILE);
  const script = readFileSync(join(MOBILE, 'scripts', 'render-brand-assets.mjs'), 'utf8');
  expect(script).toContain(`const PRIMARY = '${BRAND_TILE}';`);
});
