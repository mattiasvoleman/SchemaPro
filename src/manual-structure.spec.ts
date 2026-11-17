import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The three manuals (docs/manual/*.html) are hand-edited HTML, the user manual
 * of more than ten thousand lines, and several branches edit it at once. Nothing
 * held them together except docs/manual/build-pdf.mjs, which finds a missing
 * heading only when somebody builds the PDF. This holds what a merge of two
 * branches can break without a git conflict:
 *
 *   - every tag that opens is closed, in order;
 *   - an id is used once, so a section number taken by two branches shows;
 *   - every table-of-contents entry (data-pg) has a heading to point at, the
 *     entries follow the headings' order and carry their text;
 *   - every in-page link (href="#...") has a target;
 *   - every cross-reference written as (N.N) names a section that exists.
 *
 * It does not say a reference points at the RIGHT section: that is for the
 * reader of the diff. The last describe proves the checker on small documents
 * with one fault each, so that a check that stops looking turns this red.
 */

const ROOT = join(__dirname, '..');
const MANUALS = ['anvandarmanual', 'lararmanual', 'vardnadshavarmanual'] as const;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

const decode = (text: string): string =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&rdquo;/g, '”')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));

const flat = (markup: string): string => decode(markup.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** What is wrong with one manual, as sentences; empty when nothing is. */
function problemsOf(raw: string): string[] {
  const problems: string[] = [];
  const open: string[] = [];
  const ids: string[] = [];
  const pages: string[] = [];
  const links: string[] = [];

  for (const match of raw.matchAll(TOKEN)) {
    if (match[0].startsWith('<!--')) continue;
    const tag = match[2]!.toLowerCase();
    const attributes = match[3] ?? '';
    const id = /\bid="([^"]*)"/.exec(attributes)?.[1];
    if (id !== undefined) ids.push(id);
    const page = /\bdata-pg="([^"]*)"/.exec(attributes)?.[1];
    if (page !== undefined) pages.push(page);
    const link = /\bhref="#([^"]*)"/.exec(attributes)?.[1];
    if (link !== undefined) links.push(link);
    if (VOID.has(tag) || attributes.trimEnd().endsWith('/')) continue;
    if (match[1] === '') {
      open.push(tag);
    } else if (open[open.length - 1] === tag) {
      open.pop();
    } else {
      problems.push(`</${tag}> closes nothing that is open (open: ${open.slice(-3).join(' > ') || 'none'})`);
      const at = open.lastIndexOf(tag);
      if (at >= 0) open.length = at;
    }
  }
  if (open.length > 0) problems.push(`left open at the end: ${open.slice(-3).join(' > ')}`);

  for (const id of new Set(ids)) {
    if (ids.filter((other) => other === id).length > 1) problems.push(`id "${id}" is used more than once`);
  }
  for (const page of pages) if (!ids.includes(page)) problems.push(`data-pg "${page}" has no heading with that id`);
  for (const link of links) if (!ids.includes(link)) problems.push(`the link #${link} has no target`);

  // As build-pdf.mjs finds a heading (deriveAnchors): an <h3> with an id among any attributes, and a contents entry
  // with whitespace between its tags. A label is read as a heading's text is, so a heading with &amp; in it reads the
  // same in both places.
  const headings = [...raw.matchAll(/<h3\b[^>]*?\sid="([^"]+)"[^>]*>([\s\S]*?)<\/h3>/g)].map((m) => ({
    id: m[1]!,
    text: flat(m[2]!).replace(/^(\d+\.\d+)/, '$1 '),
  }));
  const contents = [...raw.matchAll(/<li>\s*<span>([^<]*)<\/span>\s*<span class="dots"><\/span>\s*<span class="pg" data-pg="([^"]+)"/g)].map((m) => ({
    label: flat(m[1]!),
    id: m[2]!,
  }));
  const listed = contents.filter((entry) => headings.some((heading) => heading.id === entry.id));
  if (listed.map((entry) => entry.id).join() !== headings.map((heading) => heading.id).join()) {
    problems.push('the table of contents does not list the headings in the order the document has them');
  }
  for (const entry of listed) {
    const heading = headings.find((candidate) => candidate.id === entry.id)!;
    if (entry.label !== heading.text) problems.push(`the contents say "${entry.label}" where the heading says "${heading.text}"`);
  }

  const numbers = new Set([...raw.matchAll(/<h3\b[^>]*>\s*<span class="num">(\d+\.\d+)<\/span>/g)].map((m) => m[1]));
  for (const group of flat(raw).matchAll(/\(([^()]*)\)/g)) {
    if (!/^\d{1,2}\.\d{1,2}(?:\s*(?:,|och|–|-)\s*\d{1,2}\.\d{1,2})*$/.test(group[1]!)) continue;
    for (const reference of group[1]!.match(/\d{1,2}\.\d{1,2}/g)!) {
      if (!numbers.has(reference)) problems.push(`the reference (${reference}) names a section the manual does not have`);
    }
  }
  return problems;
}

describe('the manuals hold together', () => {
  for (const name of MANUALS) {
    it(`${name}.html`, () => {
      expect(problemsOf(readFileSync(join(ROOT, 'docs', 'manual', `${name}.html`), 'utf8'))).toEqual([]);
    });
  }
});

describe('the check finds what it is for', () => {
  const toc = (...entries: Array<[string, string]>): string =>
    `<ol>${entries.map(([label, id]) => `<li><span>${label}</span><span class="dots"></span><span class="pg" data-pg="${id}"></span></li>`).join('')}</ol>`;
  const document = (body: string, contents = toc(['1.1 Ett', 's11'], ['1.2 Två', 's12'])): string =>
    `${contents}<section><h3 id="s11"><span class="num">1.1</span>Ett</h3><p>se (1.2).</p>${body}<h3 id="s12"><span class="num">1.2</span>Två</h3></section>`;

  it('finds nothing in a document that holds together', () => {
    expect(problemsOf(document('<p>en <a href="#s12">länk</a><br></p><!-- <div> i en kommentar -->'))).toEqual([]);
  });

  // What a hand edit may do without breaking anything the build or the reader depends on.
  it('finds nothing in a heading with a class, in either place, nor in one with &amp; in its text', () => {
    const entries = toc(['1.1 Ett', 's11'], ['1.2 Två &amp; tre', 's12']);
    const classed = `${entries}<section><h3 class="x" id="s11"><span class="num">1.1</span>Ett</h3><p>se (1.2).</p>` +
      '<h3 id="s12" class="y"><span class="num">1.2</span>Två &amp; tre</h3></section>';
    expect(problemsOf(classed)).toEqual([]);
  });

  it('finds nothing in a contents entry written over several lines', () => {
    const entries = '<ol><li>\n  <span>1.1 Ett</span>\n  <span class="dots"></span>\n  <span class="pg" data-pg="s11"></span>\n</li></ol>';
    expect(problemsOf(`${entries}<h3 id="s11"><span class="num">1.1</span>Ett</h3>`)).toEqual([]);
  });

  const faults: Array<[string, string]> = [
    ['a tag left open', document('<div><p>öppen</p>')],
    ['a tag closed that is not open', document('<p>stängd</p></div>')],
    ['an id used twice', document('<p id="s11">igen</p>')],
    ['a contents entry with no heading', document('', toc(['1.1 Ett', 's11'], ['1.2 Två', 's12'], ['1.3 Tre', 's13']))],
    ['contents in another order than the headings', document('', toc(['1.2 Två', 's12'], ['1.1 Ett', 's11']))],
    ['a contents label that is not the heading', document('', toc(['1.1 Ett', 's11'], ['1.2 Tvåa', 's12']))],
    ['a link with no target', document('<p><a href="#saknas">länk</a></p>')],
    ['a reference to a section that is not there', document('<p>(9.9)</p>')],
    ['a reference in a list of references', document('<p>(1.1, 1.2 och 3.4)</p>')],
  ];
  it.each(faults)('finds %s', (_, markup) => {
    expect(problemsOf(markup)).not.toEqual([]);
  });
});
