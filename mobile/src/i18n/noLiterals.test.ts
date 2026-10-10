import * as fs from 'fs';
import * as path from 'path';

/**
 * Every word a screen shows comes from the catalogue.
 *
 * A screen that writes "Submit request" inline is a screen a Swedish reader
 * cannot read, and nothing else in this runner would notice — screens are not
 * rendered here (jest.config.js). So the sources are read instead: JSX text
 * with a letter in it, a string-literal prop that is read aloud or shown
 * (placeholder, accessibilityLabel, title), and an Alert with a literal title
 * or body all fail. Glyphs (›, ✓, 🔔) and punctuation are not words and pass.
 */

const ROOT = path.join(__dirname, '..', '..');
const DIRS = [path.join(ROOT, 'app'), path.join(ROOT, 'src', 'screens')];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [full] : [];
  });
}

const LETTER = /[A-Za-zÅÄÖåäöÉé]/;

/** Text between a JSX tag's end and the next tag or expression. */
function jsxText(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/>([^<>{}]*)</g)) {
    const text = match[1]!.trim();
    // `a > b` and generics also have '>' and '<' around them; prose has spaces
    // or starts a word. A comparison such as `x > 0 && y <` has no letter run
    // that is not code, so keep to lines that look like JSX children.
    if (text && LETTER.test(text) && !/(=>|&&|\|\||;|===|!==|\s=\s|\?\s)/.test(text)) found.push(text);
  }
  return found;
}

function literalProps(source: string): string[] {
  return [...source.matchAll(/\b(placeholder|accessibilityLabel|accessibilityHint|title)=["']([^"']*)["']/g)]
    .map((match) => `${match[1]}="${match[2]}"`)
    .filter((prop) => LETTER.test(prop.slice(prop.indexOf('"'))));
}

function literalAlerts(source: string): string[] {
  return [...source.matchAll(/Alert\.alert\(\s*(['"`])([^'"`]*)\1/g)].map((match) => match[2]!);
}

function literalOptionTitles(source: string): string[] {
  return [...source.matchAll(/\btitle:\s*(['"`])([^'"`]*)\1/g)].map((match) => match[2]!).filter((text) => LETTER.test(text));
}

describe('screens take their words from the catalogue', () => {
  const files = DIRS.flatMap(sources);

  it('finds the screens it checks', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(DIRS.flatMap(sources).map((file) => [path.relative(ROOT, file), file]))('%s writes no prose inline', (_name, file) => {
    const source = fs.readFileSync(file, 'utf8');
    expect({
      text: jsxText(source),
      props: literalProps(source),
      alerts: literalAlerts(source),
      tabTitles: literalOptionTitles(source),
    }).toEqual({ text: [], props: [], alerts: [], tabTitles: [] });
  });

  it('would catch the English the screens used to carry', () => {
    const before = `<Text style={styles.title}>Leave requests</Text>
      <Text style={styles.label}>Date (full day)</Text>
      <TextInput placeholder="Family trip, …" />
      Alert.alert('Leave', 'Pick a child and write a reason.');
      options={{ title: 'Alerts' }}`;
    expect(jsxText(before)).toEqual(['Leave requests', 'Date (full day)']);
    expect(literalProps(before)).toEqual(['placeholder="Family trip, …"']);
    expect(literalAlerts(before)).toEqual(['Leave']);
    expect(literalOptionTitles(before)).toEqual(['Alerts']);
  });
});
