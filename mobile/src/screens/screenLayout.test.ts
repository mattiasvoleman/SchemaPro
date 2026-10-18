import * as fs from 'fs';
import * as path from 'path';

/**
 * Every screen lays out for the window it is in (layout/responsive.ts). A
 * screen that forgets is stretched edge to edge on an iPad, and no phone
 * shows it, so the sources are read (as tabScreenEdges.test.ts does).
 */
const MOBILE = path.join(__dirname, '..', '..');
const SCREENS = [
  ...fs.readdirSync(path.join(MOBILE, 'src', 'screens'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('Screen.tsx'))
    .map((name) => path.join('src', 'screens', name)),
  path.join('app', '(auth)', 'login.tsx'),
];

describe('screens lay out for the window', () => {
  it('finds every screen', () => {
    expect(SCREENS.length).toBe(9);
  });

  it.each(SCREENS)('%s takes its width from layout/responsive', (file) => {
    const source = fs.readFileSync(path.join(MOBILE, file), 'utf8');
    expect(source).toMatch(/from '(\.\.\/)+(src\/)?layout\/responsive'/);
  });

  it.each(SCREENS)('%s never reads Dimensions.get, which does not follow a rotation', (file) => {
    expect(fs.readFileSync(path.join(MOBILE, file), 'utf8')).not.toMatch(/Dimensions\.get\(/);
  });

  it.each(SCREENS)("%s sets no width: '100%' without a maxWidth beside it", (file) => {
    const source = fs.readFileSync(path.join(MOBILE, file), 'utf8');
    const blocks = source.match(/\{[^{}]*width: '100%'[^{}]*\}/g) ?? [];
    expect(blocks.filter((block) => !/maxWidth/.test(block))).toEqual([]);
  });
});
