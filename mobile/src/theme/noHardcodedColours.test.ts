import * as fs from 'fs';
import * as path from 'path';

/**
 * Every colour the app paints comes from the theme (theme/tokens.ts), so both
 * appearances are measured (theme/contrast.test.ts) and a screen cannot stay
 * dark on a light phone. Screens are not rendered in this runner
 * (jest.config.js), so the sources are read, as i18n/noLiterals.test.ts does
 * for words: outside src/theme, no string or template literal may be a colour
 * (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla()), no colour prop or
 * style key may take a named colour ('white', 'black', ...), also through an
 * object or array under it (a Switch's trackColor { false, true }, a
 * RefreshControl's colors), no template may glue an alpha onto a colour
 * (`${tone}22`), and no StatusBar may fix its style, written "light" or
 * {'light'}. Comments are not code and are not read.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript') as typeof import('typescript');

const ROOT = path.join(__dirname, '..', '..');
const THEME = __dirname;
const DIRS = [path.join(ROOT, 'app'), path.join(ROOT, 'src')];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === THEME ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const COLOUR = /^\s*(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\(.*\))\s*$/i;
const COLOUR_KEY = /(^color$|Color$|^tint|^colors$)/;
const NAMED_OK = new Set(['transparent']);
const ALPHA_SUFFIX = /^[0-9a-f]{2}(?![0-9a-z])/i;
/** A status bar fixed to one appearance stays light-on-light on the other. */
const FIXED_BAR = /^(light|dark)$/;

/** `line: text` for every colour written as a literal. */
export function hardcodedColours(source: string, fileName = 'screen.tsx'): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const at = (node: import('typescript').Node, text: string): void => {
    found.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${text}`);
  };
  /** The JSX attribute a node is the value of, written "..." or {...}. */
  const attributeOf = (node: import('typescript').Node): import('typescript').JsxAttribute | null => {
    const parent = node.parent;
    if (ts.isJsxAttribute(parent)) return parent;
    if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) return parent.parent;
    return null;
  };
  /** The keys a literal sits under, nearest first, up through object and array literals. */
  const keysOf = (node: import('typescript').Node): string[] => {
    const keys: string[] = [];
    for (let here = node; ; ) {
      const attribute = attributeOf(here);
      if (attribute) return [...keys, attribute.name.getText(file)];
      const parent = here.parent;
      if (ts.isPropertyAssignment(parent) && parent.initializer === here) {
        keys.push(parent.name.getText(file));
        here = parent.parent;
      } else if (ts.isArrayLiteralExpression(parent)) {
        here = parent;
      } else {
        return keys;
      }
    }
  };
  const visit = (node: import('typescript').Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const key = keysOf(node).find((name) => COLOUR_KEY.test(name));
      const attribute = attributeOf(node);
      if (COLOUR.test(node.text)) at(node, node.text);
      else if (key && /^[a-z]+$/i.test(node.text) && !NAMED_OK.has(node.text)) at(node, `${key}: '${node.text}'`);
      else if (
        attribute?.name.getText(file) === 'style' &&
        attribute.parent.parent.tagName.getText(file) === 'StatusBar' &&
        FIXED_BAR.test(node.text)
      ) {
        at(node, `StatusBar style="${node.text}"`);
      }
    } else if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        if (ALPHA_SUFFIX.test(span.literal.text)) at(node, node.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('no colour is written outside the theme', () => {
  const files = DIRS.flatMap(sources);

  it('finds the screens, layouts and services it checks', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it.each(files.map((file) => [path.relative(ROOT, file), file]))('%s names its colours by role', (_name, file) => {
    expect(hardcodedColours(fs.readFileSync(file, 'utf8'), file)).toEqual([]);
  });

  it('would catch the colours the screens carried before the theme', () => {
    const before = `const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#0f0f1a' }, overlay: { backgroundColor: 'rgba(15,15,26,0.55)' } });
      <ActivityIndicator size="large" color="#6366f1" />
      <TextInput placeholderTextColor="#475569" />
      <RefreshControl tintColor={'#6366f1'} />
      <View style={{ backgroundColor: \`\${cfg.color}22\` }} />
      <ActivityIndicator color="white" />
      <StatusBar style="light" />`;
    expect(hardcodedColours(before)).toEqual([
      "1: #0f0f1a",
      '1: rgba(15,15,26,0.55)',
      '2: #6366f1',
      '3: #475569',
      '4: #6366f1',
      '5: `${cfg.color}22`',
      "6: color: 'white'",
      '7: StatusBar style="light"',
    ]);
  });

  it('would catch a named colour reached through an object or array, and a fixed bar written as an expression', () => {
    const before = `<Switch trackColor={{ false: 'grey', true: 'blue' }} />
      <RefreshControl colors={['blue']} />
      <StatusBar style={'light'} />`;
    expect(hardcodedColours(before)).toEqual([
      "1: trackColor: 'grey'",
      "1: trackColor: 'blue'",
      "2: colors: 'blue'",
      '3: StatusBar style="light"',
    ]);
  });

  it('lets code through: a role, a comment, an id that looks like hex, a key', () => {
    const code = `// the page was #0f0f1a before the theme
      const styles = useStyles(); <View style={{ backgroundColor: colors.background }} />
      <ActivityIndicator color={colors.onPrimary} />
      t('settings.pushTitle'); const id = \`\${lessonId}-\${studentId}\`; const hash = '#section';
      <View style={{ backgroundColor: 'transparent' }} />
      <Switch trackColor={{ false: colors.borderStrong, true: colors.primary }} />
      <Text style={[styles.label, { fontWeight: 'bold', textAlign: 'center' }]} />
      <StatusBar style={theme.statusBar} />`;
    expect(hardcodedColours(code)).toEqual([]);
  });
});
