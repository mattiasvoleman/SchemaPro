/**
 * A small XML reader and writer for the exchange formats (aSc XML, and the
 * parts of an Excel file). Written here rather than bought, for two reasons:
 * the files are a school's own and small, and a general parser brings entity
 * expansion, external references and a dependency chain this feature has no use
 * for.
 *
 * WHAT IT READS: elements, attributes, text, CDATA, comments, the XML
 * declaration and processing instructions (both skipped). The five predefined
 * entities and numeric character references are decoded.
 *
 * WHAT IT REFUSES, by name: a DOCTYPE or an ENTITY declaration (no entity is
 * ever defined, so none can expand — the billion-laughs and external-entity
 * attacks have nothing to stand on), a tag that never closes or closes the
 * wrong element, text outside the root element, more than one root, a document
 * deeper than MAX_DEPTH or with more than MAX_NODES elements, and a source
 * longer than MAX_CHARS.
 *
 * NAMESPACES. A prefix is dropped: `<x:row>` is read as `row`. The formats
 * read here use the prefix for nothing but the namespace, and a reader that
 * keeps the prefix breaks on the same file saved by another program.
 */

export const MAX_CHARS = 32 * 1024 * 1024;
export const MAX_DEPTH = 64;
export const MAX_NODES = 400_000;

export interface XmlNode {
  /** The element name without any prefix. */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** The element's own text, concatenated, entities decoded. */
  text: string;
}

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return codePoint(parseInt(body.slice(2), 16), whole);
    if (body.startsWith('#')) return codePoint(parseInt(body.slice(1), 10), whole);
    const known = ENTITIES[body];
    if (known === undefined) throw new XmlError(`Okänd entitet ${whole}.`);
    return known;
  });
}

function codePoint(value: number, whole: string): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    throw new XmlError(`Ogiltig teckenreferens ${whole}.`);
  }
  return String.fromCodePoint(value);
}

function localName(qname: string): string {
  const at = qname.indexOf(':');
  return at < 0 ? qname : qname.slice(at + 1);
}

const NAME = /[^\s/>=]+/y;
const ATTR = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;

export function parseXml(source: string): XmlNode {
  if (source.length > MAX_CHARS) throw new XmlError('Filen är för stor.');
  let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  // One buffer per open element: text between tags belongs to the element it sits in.
  const textBuffers: string[][] = [];

  while (pos < source.length) {
    const lt = source.indexOf('<', pos);
    if (lt < 0) {
      const tail = source.slice(pos);
      if (tail.trim() !== '') throw new XmlError('Text efter sista elementet.');
      break;
    }
    if (lt > pos) {
      const text = source.slice(pos, lt);
      const top = stack[stack.length - 1];
      if (top) textBuffers[textBuffers.length - 1]!.push(decode(text));
      else if (text.trim() !== '') throw new XmlError('Text utanför rotelementet.');
    }
    pos = lt;
    if (source.startsWith('<!--', pos)) {
      const end = source.indexOf('-->', pos + 4);
      if (end < 0) throw new XmlError('En kommentar som aldrig slutar.');
      pos = end + 3;
    } else if (source.startsWith('<![CDATA[', pos)) {
      const end = source.indexOf(']]>', pos + 9);
      if (end < 0) throw new XmlError('En CDATA som aldrig slutar.');
      const top = stack[stack.length - 1];
      if (!top) throw new XmlError('CDATA utanför rotelementet.');
      textBuffers[textBuffers.length - 1]!.push(source.slice(pos + 9, end));
      pos = end + 3;
    } else if (source.startsWith('<?', pos)) {
      const end = source.indexOf('?>', pos + 2);
      if (end < 0) throw new XmlError('En instruktion som aldrig slutar.');
      pos = end + 2;
    } else if (source.startsWith('<!', pos)) {
      // <!DOCTYPE and <!ENTITY: refused outright (see the header).
      throw new XmlError('DOCTYPE och ENTITY tas inte emot.');
    } else if (source.startsWith('</', pos)) {
      const end = source.indexOf('>', pos);
      if (end < 0) throw new XmlError('En sluttagg som aldrig slutar.');
      const name = localName(source.slice(pos + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name) throw new XmlError(`Sluttaggen </${name}> hör inte till ${open ? `<${open.name}>` : 'något element'}.`);
      open.text = textBuffers.pop()!.join('');
      pos = end + 1;
    } else {
      pos += 1;
      NAME.lastIndex = pos;
      const nameMatch = NAME.exec(source);
      if (!nameMatch) throw new XmlError('En tagg utan namn.');
      const node: XmlNode = { name: localName(nameMatch[0]), attrs: {}, children: [], text: '' };
      pos = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = pos;
        const attr = ATTR.exec(source);
        if (!attr) break;
        const key = localName(attr[1]!);
        // xmlns declarations are namespace plumbing, not data.
        if (attr[1] !== 'xmlns' && !attr[1]!.startsWith('xmlns:')) node.attrs[key] = decode(attr[2] ?? attr[3] ?? '');
        pos = ATTR.lastIndex;
      }
      while (pos < source.length && /\s/.test(source[pos]!)) pos += 1;
      const selfClosing = source.startsWith('/>', pos);
      if (!selfClosing && source[pos] !== '>') throw new XmlError(`Taggen <${node.name}> är inte avslutad.`);
      pos += selfClosing ? 2 : 1;
      nodes += 1;
      if (nodes > MAX_NODES) throw new XmlError('För många element.');
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root) throw new XmlError('Mer än ett rotelement.');
      else root = node;
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new XmlError('För djup nästling.');
        stack.push(node);
        textBuffers.push([]);
      }
    }
  }
  if (stack.length > 0) throw new XmlError(`Elementet <${stack[stack.length - 1]!.name}> slutar aldrig.`);
  if (!root) throw new XmlError('Inget rotelement.');
  return root;
}

/** The direct children with this name. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/** The first direct child with this name, or null. */
export function childNamed(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((child) => child.name === name) ?? null;
}

/** Text and attribute values for output: the five characters XML needs escaped, and the control characters it cannot hold dropped. */
export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `<name a="1" b="2"/>` (or with children), attributes in the order given, undefined and null attributes left out. */
export function element(
  name: string,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
  children: string[] | null = null,
  indent = '',
): string {
  const rendered = Object.entries(attrs)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`)
    .join('');
  if (children === null || children.length === 0) return `${indent}<${name}${rendered}/>`;
  return `${indent}<${name}${rendered}>\n${children.join('\n')}\n${indent}</${name}>`;
}
