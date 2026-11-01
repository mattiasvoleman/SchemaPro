import * as fs from 'fs';
import * as path from 'path';

/**
 * Every colour the app paints comes from the theme (theme/tokens.ts), so both
 * appearances are measured (theme/contrast.test.ts) and a screen cannot stay
 * dark on a light phone. Screens are not rendered in this runner
 * (jest.config.js), so the sources are read, as i18n/noLiterals.test.ts does
 * for words: outside src/theme, no string or template literal may be a colour
 * (#rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl(), hsla()) or start as one
 * (`rgba(0,0,0,${alpha})`, `#000000${alpha}`), no colour prop or style key
 * may take a named colour ('white', 'black', ...) or a number (React Native
 * reads 0xrrggbbaa as a colour), also through what passes a value on to it:
 * an object or array (a Switch's trackColor { false, true }, a
 * RefreshControl's colors), either branch of a ternary, ?? || &&,
 * parentheses, an `as`, and a Platform.select's choices. A value handed to
 * any other call is that call's to colour (pick('primary') names a role), so
 * nothing is read through one. No template may glue an alpha onto a colour
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
/** A template whose fixed start is a colour's: `rgba(0,0,0,${a})`, `#000000${a}`, `#${hex}`. */
const COLOUR_HEAD = /^\s*((rgb|hsl)a?\(|#[0-9a-f]{0,8}$)/i;
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
  /** Whether `parent` hands the value `here` on as its own: what a key above it then takes. */
  const passesOn = (parent: import('typescript').Node, here: import('typescript').Node): boolean => {
    if (ts.isArrayLiteralExpression(parent) || ts.isParenthesizedExpression(parent)) return true;
    if (ts.isAsExpression(parent)) return parent.expression === here;
    // A branch is a value; the condition is not.
    if (ts.isConditionalExpression(parent)) return parent.whenTrue === here || parent.whenFalse === here;
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      return (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      );
    }
    return (
      ts.isCallExpression(parent) &&
      parent.expression.getText(file) === 'Platform.select' &&
      ts.isObjectLiteralExpression(here) &&
      parent.arguments.includes(here)
    );
  };
  /** The keys a literal sits under, nearest first, up through whatever passes it on. */
  const keysOf = (node: import('typescript').Node): string[] => {
    const keys: string[] = [];
    for (let here = node; ; ) {
      const attribute = attributeOf(here);
      if (attribute) return [...keys, attribute.name.getText(file)];
      const parent = here.parent;
      if (ts.isPropertyAssignment(parent) && parent.initializer === here) {
        keys.push(parent.name.getText(file));
        here = parent.parent;
      } else if (passesOn(parent, here)) {
        here = parent;
      } else {
        return keys;
      }
    }
  };
  const colourKeyOf = (node: import('typescript').Node): string | undefined =>
    keysOf(node).find((name) => COLOUR_KEY.test(name));
  const visit = (node: import('typescript').Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const key = colourKeyOf(node);
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
      if (COLOUR_HEAD.test(node.head.text) || node.templateSpans.some((span) => ALPHA_SUFFIX.test(span.literal.text))) {
        at(node, node.getText(file));
      }
    } else if (ts.isNumericLiteral(node)) {
      const key = colourKeyOf(node);
      if (key) at(node, `${key}: ${node.getText(file)}`);
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

  it('would catch a named colour, a number or a colour template reached through what passes a value on', () => {
    const before = `<ActivityIndicator color={busy ? 'white' : colors.primary} />
      <View style={{ backgroundColor: on ? colors.surface : 'black' }} />
      <Text style={{ color: tone ?? 'grey' }} />
      <Switch thumbColor={Platform.OS === 'android' ? 'white' : undefined} />
      <Text style={{ color: Platform.select({ ios: 'white', default: colors.text }) }} />
      <View style={{ backgroundColor: \`rgba(0,0,0,\${alpha})\` }} />
      <View style={{ backgroundColor: \`#000000\${alpha}\` }} />
      <Text style={{ color: 0x888896ff }} />
      <Text style={{ color: (strong && 'red') as ColorValue }} />
      <Text style={{ color: tone || 'blue' }} />
      <View style={{ shadowColor: \`hsla(\${hue}, 50%, 50%, 0.4)\` }} />
      <View style={{ borderColor: \`#\${hex}\` }} />`;
    expect(hardcodedColours(before)).toEqual([
      "1: color: 'white'",
      "2: backgroundColor: 'black'",
      "3: color: 'grey'",
      "4: thumbColor: 'white'",
      "5: color: 'white'",
      '6: `rgba(0,0,0,${alpha})`',
      '7: `#000000${alpha}`',
      '8: color: 0x888896ff',
      "9: color: 'red'",
      "10: color: 'blue'",
      '11: `hsla(${hue}, 50%, 50%, 0.4)`',
      '12: `#${hex}`',
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
      <StatusBar style={theme.statusBar} />
      <Text style={{ fontWeight: bold ? 'bold' : 'normal', opacity: faded ? 0.45 : 1, width: 16 }} />
      <Text style={{ color: (mode || 'auto') ? colors.text : colors.textMuted }} />
      <Switch thumbColor={Platform.OS === 'android' ? colors.surface : undefined} />
      <KeyboardAvoidingView behavior={Platform.select({ ios: 'padding', default: 'height' })} />
      <Badge tintColor={pick('primary')} color={colors[on ? 'primary' : 'textMuted']} />
      <View style={{ backgroundColor: \`\${tone}\` }} />`;
    expect(hardcodedColours(code)).toEqual([]);
  });
});
