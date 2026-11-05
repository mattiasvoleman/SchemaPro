import { MAX_DEPTH, XmlError, childNamed, childrenNamed, element, escapeXml, parseXml } from './xml';

describe('parseXml', () => {
  it('reads elements, attributes and text, and drops namespace prefixes', () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- a comment --><x:sheet xmlns:x="urn:a" id="1"><x:row n='2'>hej</x:row><x:row n="3"/></x:sheet>`,
    );
    expect(root.name).toBe('sheet');
    expect(root.attrs).toEqual({ id: '1' });
    expect(childrenNamed(root, 'row').map((r) => r.attrs['n'])).toEqual(['2', '3']);
    expect(childNamed(root, 'row')?.text).toBe('hej');
    expect(childNamed(root, 'nope')).toBeNull();
  });

  it('decodes the five entities and numeric references, and keeps CDATA as it is', () => {
    const root = parseXml('<a t="&lt;&amp;&quot;">&#65;&#x42; &apos;<![CDATA[<raw & text>]]></a>');
    expect(root.attrs['t']).toBe('<&"');
    expect(root.text).toBe("AB '<raw & text>");
  });

  it('strips a byte order mark', () => {
    expect(parseXml('﻿<a/>').name).toBe('a');
  });

  it('refuses a DOCTYPE or an ENTITY declaration outright', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow(XmlError);
    expect(() => parseXml('<a>&x;</a>')).toThrow('Okänd entitet');
  });

  it('refuses a character reference that is no character', () => {
    expect(() => parseXml('<a>&#xD800;</a>')).toThrow('Ogiltig teckenreferens');
    expect(() => parseXml('<a>&#99999999;</a>')).toThrow('Ogiltig teckenreferens');
  });

  it('names what is wrong with a document that is not well formed', () => {
    expect(() => parseXml('<a><b></a>')).toThrow('Sluttaggen </a> hör inte till <b>');
    expect(() => parseXml('<a>')).toThrow('slutar aldrig');
    expect(() => parseXml('<a/><b/>')).toThrow('Mer än ett rotelement');
    expect(() => parseXml('text<a/>')).toThrow('Text utanför rotelementet');
    expect(() => parseXml('<a/>tail')).toThrow('Text efter sista elementet');
    expect(() => parseXml('')).toThrow('Inget rotelement');
    expect(() => parseXml('<a><!-- never')).toThrow('kommentar');
    expect(() => parseXml('<a><![CDATA[never')).toThrow('CDATA');
    expect(() => parseXml('<a><?pi never')).toThrow('instruktion');
    expect(() => parseXml('<a></a')).toThrow('sluttagg');
    expect(() => parseXml('< >')).toThrow('utan namn');
    expect(() => parseXml('<a b="1"')).toThrow('inte avslutad');
    expect(() => parseXml('<![CDATA[x]]>')).toThrow('CDATA utanför');
  });

  it('holds a document to a depth and a size', () => {
    const deep = '<a>'.repeat(MAX_DEPTH + 1) + '</a>'.repeat(MAX_DEPTH + 1);
    expect(() => parseXml(deep)).toThrow('För djup nästling');
    expect(() => parseXml('<a>' + '<b/>'.repeat(400_001) + '</a>')).toThrow('För många element');
  });
});

describe('escapeXml and element', () => {
  it('escapes what XML needs and drops control characters it cannot hold', () => {
    expect(escapeXml('a<b>&"c\u0001d')).toBe('a&lt;b&gt;&amp;&quot;cd');
  });

  it('writes attributes in the order given and leaves null ones out', () => {
    expect(element('p', { a: 1, b: 'x"y', c: null, d: undefined, e: false })).toBe('<p a="1" b="x&quot;y" e="false"/>');
    expect(element('p', {}, ['<q/>'], '  ')).toBe('  <p>\n<q/>\n  </p>');
  });

  it('reads back what it writes', () => {
    const xml = element('a', { t: 'å<ä>&"ö' });
    expect(parseXml(xml).attrs['t']).toBe('å<ä>&"ö');
  });
});
