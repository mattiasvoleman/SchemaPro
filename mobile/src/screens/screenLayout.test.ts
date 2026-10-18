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

/**
 * The line of every text field that nothing keeps above the keyboard. A
 * field is kept when it sits in a ScrollView that insets itself for the
 * keyboard (automaticallyAdjustKeyboardInsets) or in a KeyboardAvoidingView.
 * Without either, iOS moves nothing: on an iPad on its side the form is
 * shorter than the window, the scroll has no range, and the keyboard covers
 * the field being typed in.
 */
function fieldsUnderTheKeyboard(source: string): number[] {
  const file = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tagOf = (node: import('typescript').Node) =>
    ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  const keepsAbove = (node: import('typescript').Node): boolean => {
    const tag = tagOf(node);
    const name = tag?.tagName.getText(file);
    if (name === 'KeyboardAvoidingView') return true;
    return name === 'ScrollView' && tag!.attributes.properties.some((attribute) =>
      ts.isJsxAttribute(attribute) &&
      attribute.name.getText(file) === 'automaticallyAdjustKeyboardInsets' &&
      attribute.initializer?.getText(file) !== '{false}');
  };
  const found: number[] = [];
  const visit = (node: import('typescript').Node): void => {
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

  it.each(SCREENS)('%s keeps every text field it draws above the keyboard', (file) => {
    expect(fieldsUnderTheKeyboard(fs.readFileSync(path.join(MOBILE, file), 'utf8'))).toEqual([]);
  });

  it('finds a field the keyboard would cover, and only that', () => {
    expect(fieldsUnderTheKeyboard('<ScrollView>\n<TextInput />\n</ScrollView>')).toEqual([2]);
    expect(fieldsUnderTheKeyboard('<ScrollView automaticallyAdjustKeyboardInsets={false}><TextInput /></ScrollView>')).toEqual([1]);
    expect(fieldsUnderTheKeyboard('<ScrollView automaticallyAdjustKeyboardInsets><View>{a ? <TextInput /> : null}</View></ScrollView>')).toEqual([]);
    expect(fieldsUnderTheKeyboard('<KeyboardAvoidingView><ScrollView><TextInput /></ScrollView></KeyboardAvoidingView>')).toEqual([]);
  });
});
