import { over } from './contrast';

/**
 * The app's colours, one palette per appearance. Every colour a screen, a
 * layout or a native prop (ActivityIndicator, RefreshControl, placeholder,
 * the tab bar, the status bar, the root view) shows comes from here, by role;
 * no screen names a hex value (theme/noHardcodedColours.test.ts).
 *
 * Light is the web's light theme (web/app/globals.css :root, DESIGN.md
 * Colors). Dark keeps the app's own navy ground and slate ink and takes the
 * web's dark accent hue, lifted where the app's lighter card needs it. Every
 * text and control pair is measured in theme/contrast.test.ts.
 */
export type SchemeName = 'light' | 'dark';

/** A state's colour family: one meaning per colour, as web/lib/status-variants.ts. */
export type Tone = 'success' | 'warning' | 'danger' | 'neutral';

export interface Palette {
  /** The page behind everything, and the root view under it. */
  readonly background: string;
  /** Cards, list rows and the sign-in fields. */
  readonly surface: string;
  readonly tabBar: string;
  /** Hairline between rows, above the tab bar and round a list card. Decoration only. */
  readonly borderSubtle: string;
  /** Edge of a card, chip or stepper whose label already identifies it. Decoration only. */
  readonly border: string;
  /** Edge of a text field: 3:1 against every surface a field sits on (SC 1.4.11). */
  readonly borderStrong: string;
  readonly text: string;
  /** Subtitles, meta lines, hints, placeholders, inactive tabs: 4.5:1 everywhere it is written. */
  readonly textMuted: string;
  /** The accent: primary buttons, the selected chip, links, the active tab, spinners, focus. */
  readonly primary: string;
  /** Label and spinner on a primary fill. */
  readonly onPrimary: string;
  /** Ink and fill per tone. */
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly neutral: string;
  /** Label on any tone's fill. */
  readonly onTone: string;
  /** A tone at 10% over the surface (the web Notice's tint): the sync banner's ground. */
  readonly toneTint: Readonly<Record<Tone, string>>;
  readonly lunchSurface: string;
  readonly lunchBorder: string;
  readonly lunchText: string;
  readonly breakSurface: string;
  readonly breakBorder: string;
  readonly breakText: string;
  /** The veil over a list while it is busy. */
  readonly scrim: string;
}

const TINT = 0.1;

function tints(p: Omit<Palette, 'toneTint'>): Record<Tone, string> {
  return {
    success: over(p.success, TINT, p.surface),
    warning: over(p.warning, TINT, p.surface),
    danger: over(p.danger, TINT, p.surface),
    neutral: over(p.neutral, TINT, p.surface),
  };
}

function palette(p: Omit<Palette, 'toneTint'>): Palette {
  return { ...p, toneTint: tints(p) };
}

export const PALETTES: Readonly<Record<SchemeName, Palette>> = {
  light: palette({
    background: '#f4f4f5', // web --muted, 240 5% 96%
    surface: '#ffffff', // web --card
    tabBar: '#ffffff',
    borderSubtle: '#e4e4e7', // web --border, 240 6% 90%
    border: '#e4e4e7',
    borderStrong: '#888896', // web --input-strong, 240 6% 56%
    text: '#121216', // web --foreground, 240 10% 8%
    textMuted: '#696972', // web --muted-foreground, 240 4% 43%
    primary: '#5048e5', // web --primary, 243 75% 59%
    onPrimary: '#ffffff',
    success: '#156540', // web --success-strong, 152 65% 24%
    warning: '#864e0e', // 32 81% 29%: web --warning-foreground's hue, light enough to read as amber
    danger: '#c52020', // web --destructive-hover, 0 72% 45% (--destructive is 4.36:1 on the page)
    neutral: '#696972',
    onTone: '#ffffff',
    lunchSurface: '#fef5e7', // web's lunch band: --warning at 10% over white
    lunchBorder: '#fce2b6', // --warning at 30%
    lunchText: '#864e0e',
    breakSurface: '#f0f9ff',
    breakBorder: '#bae6fd',
    breakText: '#075985',
    scrim: 'rgba(244,244,245,0.7)',
  }),
  dark: palette({
    background: '#0f0f1a',
    surface: '#1a1a2e',
    tabBar: '#0f0f1a',
    borderSubtle: '#1e1e3a',
    border: '#2d2d4a',
    borderStrong: '#64748b',
    text: '#e2e8f0',
    textMuted: '#94a3b8',
    primary: '#817bf4', // web dark --primary's 243 85%, at 72% (70% is 4.44:1 on this card)
    onPrimary: '#0f0f1a',
    success: '#34d399',
    warning: '#fbbf24',
    danger: '#f87171',
    neutral: '#94a3b8',
    onTone: '#0f0f1a',
    lunchSurface: '#1c1a12',
    lunchBorder: '#3a3418',
    lunchText: '#fbbf24',
    breakSurface: '#141a1c',
    breakBorder: '#1e3038',
    breakText: '#7dd3fc',
    scrim: 'rgba(15,15,26,0.55)',
  }),
};

/** A disabled control fades; WCAG 2.1 SC 1.4.3 and 1.4.11 exempt an inactive control. */
export const DISABLED_OPACITY = 0.45;

/**
 * The brand tile the icons and splash draw (scripts/render-brand-assets.mjs):
 * white glyph on it measures 6.18:1 whatever the ground, so the tile works on
 * the light and the dark splash alike.
 */
export const BRAND_TILE = '#5048e5';

/**
 * Android's accent for a notification: the small icon's tint and the
 * channel's light (expo-notifications' `color` in app.json, and
 * services/pushRegistration.ts). The system draws the shade in its own
 * appearance and adjusts an accent's contrast against it, so one value
 * serves both; app.json carries it as a literal and theme/nativeColours.test.ts
 * keeps the two equal.
 */
export const NOTIFICATION_ACCENT = '#6366f1';
