import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript') as typeof import('typescript');

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

type OS = 'ios' | 'android';
const PLATFORMS: readonly OS[] = ['ios', 'android'];

/**
 * The line of every text field that nothing keeps above the keyboard on
 * `os`. Without help neither platform moves a field: on an iPad on its side
 * the form is shorter than the window, the scroll has no range, and the
 * keyboard covers the field being typed in; Android's edge-to-edge window
 * does not shrink for the keyboard either. A ScrollView that insets itself
 * (automaticallyAdjustKeyboardInsets) keeps a field on iOS only, since
 * Android ignores the prop. A KeyboardAvoidingView keeps it on a platform
 * where its behavior is set: without one it is a plain view and moves
 * nothing, so `behavior={Platform.OS === 'android' ? 'height' : undefined}`
 * counts for Android alone. A behavior written in a way this cannot read
 * does not count: write it as a literal, a ternary on Platform.OS or a
 * Platform.select.
 */
function fieldsUnderTheKeyboard(source: string, os: OS): number[] {
  const file = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  type Node = import('typescript').Node;
  const tagOf = (node: Node) =>
    ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  const attributeOf = (tag: NonNullable<ReturnType<typeof tagOf>>, name: string) =>
    tag.attributes.properties.find(
      (attribute): attribute is import('typescript').JsxAttribute =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(file) === name,
    );
  /** Whether `Platform.OS === 'x'` (or `!==`, either way round) holds on `os`; null when it is no such test. */
  const platformTest = (node: Node): boolean | null => {
    if (!ts.isBinaryExpression(node)) return null;
    const operator = node.operatorToken.kind;
    const equal = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
    const unequal = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
    const [read, named] = node.left.getText(file) === 'Platform.OS' ? [node.left, node.right] : [node.right, node.left];
    if ((!equal && !unequal) || read.getText(file) !== 'Platform.OS' || !ts.isStringLiteral(named)) return null;
    return (named.text === os) === equal;
  };
  /** A behavior's value on `os`: its text, undefined when unset, null when it cannot be read. */
  const valueOn = (node: Node | undefined): string | undefined | null => {
    if (!node) return undefined;
    if (ts.isJsxExpression(node)) return valueOn(node.expression);
    if (ts.isParenthesizedExpression(node)) return valueOn(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isIdentifier(node) && node.text === 'undefined') return undefined;
    if (ts.isConditionalExpression(node)) {
      const holds = platformTest(node.condition);
      return holds === null ? null : valueOn(holds ? node.whenTrue : node.whenFalse);
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === 'Platform.select') {
      const [choices] = node.arguments;
      if (!choices || !ts.isObjectLiteralExpression(choices)) return null;
      const choice = (key: string) =>
        choices.properties.find((p): p is import('typescript').PropertyAssignment =>
          ts.isPropertyAssignment(p) && p.name.getText(file) === key);
      return valueOn((choice(os) ?? choice('default'))?.initializer);
    }
    return null;
  };
  const keepsAbove = (node: Node): boolean => {
    const tag = tagOf(node);
    if (!tag) return false;
    const name = tag.tagName.getText(file);
    if (name === 'KeyboardAvoidingView') return typeof valueOn(attributeOf(tag, 'behavior')?.initializer) === 'string';
    if (name !== 'ScrollView' || os !== 'ios') return false;
    const insets = attributeOf(tag, 'automaticallyAdjustKeyboardInsets');
    return insets !== undefined && insets.initializer?.getText(file) !== '{false}';
  };
  const found: number[] = [];
  const visit = (node: Node): void => {
    if (tagOf(node)?.tagName.getText(file) === 'TextInput') {
      let kept = false;
      for (let parent = node.parent; parent && !kept; parent = parent.parent) kept = keepsAbove(parent);
      if (!kept) found.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

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

  it.each(SCREENS.flatMap((file) => PLATFORMS.map((os) => [file, os] as const)))(
    '%s keeps every text field it draws above the keyboard on %s',
    (file, os) => {
      expect(fieldsUnderTheKeyboard(fs.readFileSync(path.join(MOBILE, file), 'utf8'), os)).toEqual([]);
    },
  );

  it('finds a field the keyboard would cover, and only that', () => {
    const on = (source: string) => ({ ios: fieldsUnderTheKeyboard(source, 'ios'), android: fieldsUnderTheKeyboard(source, 'android') });
    expect(on('<ScrollView>\n<TextInput />\n</ScrollView>')).toEqual({ ios: [2], android: [2] });
    expect(on('<ScrollView automaticallyAdjustKeyboardInsets={false}><TextInput /></ScrollView>')).toEqual({ ios: [1], android: [1] });
    // The insets are iOS's alone.
    expect(on('<ScrollView automaticallyAdjustKeyboardInsets><View>{a ? <TextInput /> : null}</View></ScrollView>')).toEqual({ ios: [], android: [1] });
    // A KeyboardAvoidingView without a behavior is a plain view.
    expect(on('<KeyboardAvoidingView><ScrollView><TextInput /></ScrollView></KeyboardAvoidingView>')).toEqual({ ios: [1], android: [1] });
    expect(on('<KeyboardAvoidingView behavior="padding"><TextInput /></KeyboardAvoidingView>')).toEqual({ ios: [], android: [] });
    expect(on("<KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><TextInput /></KeyboardAvoidingView>")).toEqual({ ios: [], android: [] });
    expect(on("<KeyboardAvoidingView behavior={Platform.OS === 'android' ? 'height' : undefined}><TextInput /></KeyboardAvoidingView>")).toEqual({ ios: [1], android: [] });
    expect(on("<KeyboardAvoidingView behavior={Platform.OS !== 'ios' ? 'height' : undefined}><TextInput /></KeyboardAvoidingView>")).toEqual({ ios: [1], android: [] });
    expect(on("<KeyboardAvoidingView behavior={Platform.select({ ios: 'padding' })}><TextInput /></KeyboardAvoidingView>")).toEqual({ ios: [], android: [1] });
    expect(on('<KeyboardAvoidingView behavior={mode}><TextInput /></KeyboardAvoidingView>')).toEqual({ ios: [1], android: [1] });
    // The guardian forms: the insets on iOS, the view's height on Android.
    expect(on(
      "<KeyboardAvoidingView behavior={Platform.OS === 'android' ? 'height' : undefined}><ScrollView automaticallyAdjustKeyboardInsets><TextInput /></ScrollView></KeyboardAvoidingView>",
    )).toEqual({ ios: [], android: [] });
  });
});
