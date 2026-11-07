import { encodeWindows1252 } from './windows-1252';

const decode = (bytes: Buffer): string => new TextDecoder('windows-1252').decode(bytes);

describe('encodeWindows1252', () => {
  it('writes the Swedish letters as the single bytes Excel for Windows reads', () => {
    const { bytes, replaced } = encodeWindows1252('åäöÅÄÖé');
    expect([...bytes]).toEqual([0xe5, 0xe4, 0xf6, 0xc5, 0xc4, 0xd6, 0xe9]);
    expect(replaced).toBe(0);
  });

  it('writes ASCII as it is and the euro sign, the dashes and the curly quotes where Windows put them', () => {
    expect([...encodeWindows1252('A1;"x"\r\n').bytes]).toEqual([0x41, 0x31, 0x3b, 0x22, 0x78, 0x22, 0x0d, 0x0a]);
    expect([...encodeWindows1252('€–—“”‘’…•™').bytes]).toEqual([0x80, 0x96, 0x97, 0x93, 0x94, 0x91, 0x92, 0x85, 0x95, 0x99]);
    expect([...encodeWindows1252('ŠšŽž').bytes]).toEqual([0x8a, 0x9a, 0x8e, 0x9e]);
  });

  it("reads back, through a windows-1252 decoder, as the text it was given", () => {
    const text = 'Östen Ånström; Zoë Šebek – “klar” € 12,50\r\n';
    const { bytes, replaced } = encodeWindows1252(text);
    expect(decode(bytes)).toBe(text);
    expect(replaced).toBe(0);
  });

  it("writes a letter with no byte as its base letter where Unicode gives one, and counts it", () => {
    const { bytes, replaced } = encodeWindows1252('Łukasz Dąbrowski Ősz Đorđe');
    expect(decode(bytes)).toBe('Lukasz Dabrowski Osz Dorde');
    expect(replaced).toBe(5);
  });

  it("writes '?' for what has no nearer letter (a character of another script), once for each", () => {
    const { bytes, replaced } = encodeWindows1252('A中B😀C');
    expect(decode(bytes)).toBe('A?B?C');
    expect(replaced).toBe(2);
  });

  it('writes a C1 control character, which windows-1252 has no use for, as a question mark', () => {
    const { bytes, replaced } = encodeWindows1252('a\u0085b'.replace('\u0085', '\u0081'));
    expect(decode(bytes)).toBe('a?b');
    expect(replaced).toBe(1);
  });

  it('is empty for no text', () => {
    expect(encodeWindows1252('')).toEqual({ bytes: Buffer.alloc(0), replaced: 0 });
  });
});
