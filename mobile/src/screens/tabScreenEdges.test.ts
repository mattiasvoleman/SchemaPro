import * as fs from 'fs';
import * as path from 'path';
import { TAB_SCREEN_EDGES } from './tabScreenEdges';

/**
 * Every screen here is a tab, and the tab bar pads the bottom inset itself.
 * A SafeAreaView that leaves out `edges` pads all four, and the bottom inset
 * then appears twice: an empty strip above the tab bar that no test renders
 * (jest.config.js) and only a phone shows. So the sources are read instead.
 */
const SCREENS = __dirname;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

/** Each `<SafeAreaView …>` opening tag, attributes included. */
function safeAreaViews(source: string): string[] {
  return source.match(/<SafeAreaView\b[^>]*>/g) ?? [];
}

describe('tab screens leave the bottom inset to the tab bar', () => {
  const files = sources(SCREENS);

  it('pads the top and the sides, never the bottom', () => {
    expect([...TAB_SCREEN_EDGES].sort()).toEqual(['left', 'right', 'top']);
  });

  it('finds the safe-area views it checks', () => {
    expect(files.flatMap((file) => safeAreaViews(fs.readFileSync(file, 'utf8'))).length).toBeGreaterThanOrEqual(16);
  });

  it.each(files.map((file) => [path.relative(SCREENS, file), file]))('%s gives every SafeAreaView the tab edges', (_name, file) => {
    const views = safeAreaViews(fs.readFileSync(file, 'utf8'));
    expect(views.filter((tag) => !tag.includes('edges={TAB_SCREEN_EDGES}'))).toEqual([]);
  });

  it('would catch a SafeAreaView without edges', () => {
    expect(safeAreaViews('<SafeAreaView style={styles.container}>')).toEqual(['<SafeAreaView style={styles.container}>']);
  });
});
