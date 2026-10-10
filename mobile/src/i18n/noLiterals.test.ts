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
 *
 * Inside a JSX expression ({...} as a child, or as one of those props) the
 * TypeScript parser reads the source: a string or template literal with a
 * letter in a position that is shown — the expression itself, a ternary's
 * branch, the right of &&, either side of || ?? or + — fails. A literal that
 * is an argument (t('a.b')), compared (view === 'today') or a key is code.
 * The contexts and hooks are read too: they carry no JSX, but an Alert there
 * would be shown all the same.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript') as typeof import('typescript');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = [
  path.join(ROOT, 'app'),
  path.join(ROOT, 'src', 'screens'),
  path.join(ROOT, 'src', 'context'),
  path.join(ROOT, 'src', 'hooks'),
];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
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

const SHOWN_PROPS = new Set(['placeholder', 'accessibilityLabel', 'accessibilityHint', 'title']);

/** String and template literals with a letter in a shown position of a JSX expression. */
function expressionLiterals(source: string): string[] {
  const file = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const keep = (text: string): void => {
    if (LETTER.test(text)) found.push(text);
  };
  const shown = (node: import('typescript').Node): void => {
    if (ts.isParenthesizedExpression(node)) return shown(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return keep(node.text);
    if (ts.isTemplateExpression(node)) {
      keep(node.head.text);
      for (const span of node.templateSpans) {
        keep(span.literal.text);
        shown(span.expression);
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      shown(node.whenTrue);
      shown(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return shown(node.right);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
        shown(node.left);
        shown(node.right);
      }
    }
    // Calls, comparisons, member access, arrays and objects are code.
  };
  const visit = (node: import('typescript').Node): void => {
    if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent;
      if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) shown(node.expression);
      else if (ts.isJsxAttribute(parent) && SHOWN_PROPS.has(parent.name.getText(file))) shown(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Everything the scan finds in one source. The JSX-text regex is for screens
 * only: in a context or hook, `=> Promise<void>` looks like text between tags.
 */
function prose(source: string, kind: 'screen' | 'tsx' | 'ts' = 'screen'): string[] {
  return [
    ...(kind === 'screen' ? jsxText(source) : []),
    ...literalProps(source),
    ...literalAlerts(source),
    ...literalOptionTitles(source),
    ...(kind === 'ts' ? [] : expressionLiterals(source)),
  ].sort();
}

const SCREEN_DIRS = DIRS.slice(0, 2);
const kindOf = (file: string): 'screen' | 'tsx' | 'ts' =>
  !file.endsWith('.tsx') ? 'ts' : SCREEN_DIRS.some((dir) => file.startsWith(dir + path.sep)) ? 'screen' : 'tsx';

describe('screens take their words from the catalogue', () => {
  const files = DIRS.flatMap(sources);

  it('finds the screens it checks', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(DIRS.flatMap(sources).map((file) => [path.relative(ROOT, file), file]))('%s writes no prose inline', (_name, file) => {
    const source = fs.readFileSync(file, 'utf8');
    expect(prose(source, kindOf(file))).toEqual([]);
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

  it('would catch prose inside a JSX expression: a literal, a ternary branch, a concatenation, a template, a prop', () => {
    const before = `<Text>{'Submit request'}</Text>
      <Text>{cancelled ? ' · CANCELLED' : ''}</Text>
      <Text>{ready && 'Ready'}</Text>
      <Text>{count + ' lessons'}</Text>
      <Text>{\`\${minutes} minutes left\`}</Text>
      <TextInput placeholder={'Family trip'} />`;
    expect(prose(before)).toEqual([' · CANCELLED', 'Family trip', 'Ready', 'Submit request', ' lessons', ' minutes left'].sort());
  });

  it('lets code inside a JSX expression through: keys, comparisons, styles, glyphs', () => {
    const code = `<Text>{t('childSchedule.today')}</Text>
      <Text>{view === 'today' ? t('a') : t('b')}</Text>
      <View style={[styles.chip, active && styles.on]}>{entry.kind === 'LUNCH' ? lunch : name}</View>
      <Text>{\`\${entry.start}–\${entry.end}\`}</Text>
      <Text>{open ? '›' : '✓'}</Text>
      <Icon name={'chevron-right'} />`;
    expect(prose(code)).toEqual([]);
  });
});
