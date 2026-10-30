import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';

/**
 * How wide the screens lay out, from the window's width alone: a phone, an
 * iPad in Split View or Slide Over, an iPad or Android tablet in either
 * orientation, a Stage Manager window that is resized while it is open.
 *
 * The window, never the screen: on an iPad the app's window is often a part
 * of the screen, and React Native reports the key window's bounds as
 * `window` (RCTDeviceInfo). useWindowDimensions re-renders on every change,
 * so a rotation or a dragged divider lays the screen out again; a read of
 * Dimensions.get would not (screenLayout.test.ts stops one).
 *
 * The classes are Material 3's window size classes, in dp, which are iOS
 * points too: compact below 600, medium to 840, expanded from 840.
 */

export type WidthClass = 'compact' | 'medium' | 'expanded';

export const MEDIUM_MIN = 600;
export const EXPANDED_MIN = 840;

/** The phone's side margin, the one every screen has today. */
export const GUTTER = 16;
/** A column of reading text: about 70 characters at the screens' 13–16 pt. */
export const READABLE_MAX = 680;
/** A form: no input or button wider than this. */
export const FORM_MAX = 480;
/** Two columns side by side (a form and its list): each gets about half. */
export const TWO_COLUMN_MAX = 1080;
/**
 * The register: one column of pupils, a name and four 44 pt buttons, centred.
 * Two to a row would fit from about 1000 pt, but a grid reads row by row
 * (pupil 1 | 2, 3 | 4) and a register is read down, so it stays one column.
 */
export const REGISTER_MAX = 720;

export function widthClass(width: number): WidthClass {
  if (width >= EXPANDED_MIN) return 'expanded';
  if (width >= MEDIUM_MIN) return 'medium';
  return 'compact';
}

export interface ColumnLayout {
  readonly widthClass: WidthClass;
  /** Side padding for a list's contentContainerStyle or a screen's header. */
  readonly gutter: number;
  /** What is left between the gutters. */
  readonly columnWidth: number;
}

/**
 * The gutter that centres a column at most `max` wide, never narrower than
 * the phone's. A list keeps the whole window as its scroll area (a swipe in
 * the margin still scrolls), and only its content is centred.
 */
export function columnLayout(width: number, max: number = READABLE_MAX): ColumnLayout {
  const gutter = Math.max(GUTTER, Math.round((width - max) / 2));
  return { widthClass: widthClass(width), gutter, columnWidth: Math.max(0, width - 2 * gutter) };
}

export function useColumnLayout(max: number = READABLE_MAX): ColumnLayout {
  const { width } = useWindowDimensions();
  return useMemo(() => columnLayout(width, max), [width, max]);
}

/** A form beside its list from the expanded class on; above it below that. */
export function sideBySide(width: number): boolean {
  return widthClass(width) === 'expanded';
}

/** The child's week as a grid: a column per school day once five fit, two on a 13-inch iPad held upright. */
export const WEEK_GRID_MIN = 1180;
export function weekColumns(width: number, days: number): number {
  if (width >= WEEK_GRID_MIN) return Math.min(days, 5);
  if (widthClass(width) === 'expanded') return Math.min(days, 2);
  return 1;
}
