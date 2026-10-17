#!/usr/bin/env node
/**
 * Render the app's icons and splash mark into mobile/assets/images/.
 *
 * The PNGs are committed, and this script is their source: change the mark
 * here and run it again rather than editing a PNG. PRODUCT.md (Brand
 * Commitments) says SchemaPro has no logo or app icon, and that the web's
 * stock calendar icon and the app's "SP" letters are placeholders. This is
 * that placeholder carried over to the native assets, so it stays provisional
 * until a real mark is drawn.
 *
 * The mark is the web's brand tile: web/components/layout/app-shell.tsx draws
 * lucide's CalendarRange in primary-foreground on a bg-primary square, with
 * the glyph (size-4) filling half the tile (h-8 w-8). The colours:
 *   #5048e5  --primary in light, hsl(243 75% 59%), web/app/globals.css
 *   #7871f4  --primary in .dark, hsl(243 85% 70%), web/app/globals.css
 *   #ffffff  --primary-foreground in light
 *   #0f0f1a  the background every mobile screen paints (login.tsx and the
 *            rest); the splash screen's backgroundColor, set in app config
 *
 * The glyph is CalendarRange exactly as lucide ships it: a 24-unit viewBox,
 * stroke 2, round caps and joins. Its ink spans x 2–22 and y 1–23 (the
 * rect's stroke, and the round caps on the two rings). Lucide is ISC
 * licensed, © Lucide Icons and Contributors (https://lucide.dev); the web
 * already ships it as lucide-react.
 *
 * The files, all square:
 *   icon.png              1024 px, opaque RGB. The app icon: Expo's `icon`,
 *                         and iOS's light one. #5048e5 to the edges, white glyph
 *                         in the central 512 px box: translate(256 256)
 *                         scale(21.3333), the web tile's proportion. iOS
 *                         rejects an icon with an alpha channel, so it is
 *                         flattened and the channel removed.
 *   icon-dark.png         1024 px, RGBA. The iOS 18 dark icon: the glyph in
 *                         #7871f4 on transparency, same transform; the system
 *                         draws its own dark backdrop.
 *   icon-tinted.png       1024 px, opaque. The iOS 18 tinted icon: white
 *                         glyph on black, same transform. iOS tints it from
 *                         its luminance, so it must be greyscale and opaque.
 *   adaptive-icon.png     1024 px = 108 dp, RGBA. The Android adaptive
 *                         icon's foreground and its monochrome layer (the
 *                         background colour, #5048e5, is set in app config).
 *                         White glyph at translate(320 320) scale(16): a
 *                         384 px box whose ink is 320 × 352 px, ≈ 34 × 37 dp,
 *                         well inside the 66 dp circle every launcher mask
 *                         keeps: no inked pixel lies more than 219 px (23 dp)
 *                         from the centre, against the circle's 313 px.
 *   splash-icon.png       1024 px, RGBA. The splash image, shown at
 *                         imageWidth 128 on #0f0f1a: a #5048e5 tile with
 *                         rx 320 (40 dp at 128 dp), white glyph at the icon's
 *                         transform. Android 12+ shows only the central
 *                         192 dp circle of its 288 dp icon slot; the tile's
 *                         farthest point is 24√2 + 40 ≈ 74 dp from the centre,
 *                         inside the circle's 96. The login screen shows the
 *                         same file as its brand tile.
 *   notification-icon.png 96 px = 24 dp at xxxhdpi, RGBA. The Android
 *                         status-bar icon for expo-notifications: white glyph
 *                         on transparency at scale(4), nothing else, because
 *                         Android draws only the alpha.
 *
 * Each SVG is rendered at its native size by the sharp the web package
 * installs, so the app needs no image dependency of its own.
 *
 * Usage:  node mobile/scripts/render-brand-assets.mjs
 *         (needs web/node_modules: `npm ci` in web/, or in a worktree a
 *         symlink to the main checkout's web/node_modules)
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_PACKAGE = path.resolve(here, '..', '..', 'web', 'package.json');
const OUT_DIR = path.resolve(here, '..', 'assets', 'images');

let sharp;
try {
  sharp = createRequire(WEB_PACKAGE)('sharp');
} catch (error) {
  console.error(
    `Cannot load sharp from ${path.dirname(WEB_PACKAGE)}/node_modules (${error.code ?? error.message}).\n` +
      'Run `npm ci` in web/ first, or in a worktree symlink the main checkout\'s web/node_modules.',
  );
  process.exit(1);
}

const PRIMARY = '#5048e5';
const PRIMARY_DARK = '#7871f4';
const WHITE = '#ffffff';
const BLACK = '#000000';

/** lucide CalendarRange, element for element. */
const CALENDAR_RANGE = [
  '<rect x="3" y="4" width="18" height="18" rx="2"/>',
  '<path d="M16 2v4"/>',
  '<path d="M3 10h18"/>',
  '<path d="M8 2v4"/>',
  '<path d="M17 14h-6"/>',
  '<path d="M13 18H7"/>',
  '<path d="M7 14h.01"/>',
  '<path d="M17 18h.01"/>',
].join('');

/** The 24-unit glyph into a 512 px box centred on a 1024 canvas. */
const CENTRAL = 'translate(256 256) scale(21.3333)';

function glyph(colour, transform) {
  return (
    `<g transform="${transform}" fill="none" stroke="${colour}" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${CALENDAR_RANGE}</g>`
  );
}

function svg(size, body) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">${body}</svg>`
  );
}

/** `opaque` names the colour to flatten onto; the rest keep their alpha. */
const ASSETS = [
  {
    file: 'icon.png',
    size: 1024,
    opaque: PRIMARY,
    body: `<rect width="1024" height="1024" fill="${PRIMARY}"/>${glyph(WHITE, CENTRAL)}`,
  },
  {
    file: 'icon-dark.png',
    size: 1024,
    body: glyph(PRIMARY_DARK, CENTRAL),
  },
  {
    file: 'icon-tinted.png',
    size: 1024,
    opaque: BLACK,
    body: `<rect width="1024" height="1024" fill="${BLACK}"/>${glyph(WHITE, CENTRAL)}`,
  },
  {
    file: 'adaptive-icon.png',
    size: 1024,
    body: glyph(WHITE, 'translate(320 320) scale(16)'),
  },
  {
    file: 'splash-icon.png',
    size: 1024,
    body: `<rect width="1024" height="1024" rx="320" fill="${PRIMARY}"/>${glyph(WHITE, CENTRAL)}`,
  },
  {
    file: 'notification-icon.png',
    size: 96,
    body: glyph(WHITE, 'scale(4)'),
  },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const { file, size, opaque, body } of ASSETS) {
  const out = path.join(OUT_DIR, file);
  let image = sharp(Buffer.from(svg(size, body)));
  image = opaque ? image.flatten({ background: opaque }).removeAlpha() : image.ensureAlpha();
  await image.png({ compressionLevel: 9 }).toFile(out);

  // The two promises the stores hold us to: the size, and no alpha on an
  // icon iOS takes as opaque. A change above that breaks either stops here.
  const { width, height, channels, hasAlpha } = await sharp(out).metadata();
  if (width !== size || height !== size || hasAlpha !== !opaque) {
    console.error(`${file}: ${width}×${height}, ${channels} channels, alpha ${hasAlpha}; expected ${size}×${size}, alpha ${!opaque}`);
    process.exit(1);
  }
  console.log(`${path.relative(process.cwd(), out)}  ${width}×${height}  ${channels} channels`);
}
