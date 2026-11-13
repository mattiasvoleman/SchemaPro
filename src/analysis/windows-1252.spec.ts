import { encodeWindows1252 as encodeCodePage } from '../common/windows-1252';
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

  // LÅG-5 of the review of #280: a NUL or a BEL in a name reached the file as itself, and a NUL is what makes Excel
  // call a CSV corrupt. The code page's own encoder (D8's, common/windows-1252.ts) writes a space for each.
  it('writes a NUL in a name as a space, as the code page encoder does, and counts it', () => {
    const { bytes, replaced } = encodeWindows1252('Ek\u0000ström');
    expect([...bytes]).toEqual([...Buffer.from('Ek ström', 'latin1')]);
    expect(bytes.includes(0x00)).toBe(false);
    expect(decode(bytes)).toBe('Ek ström');
    expect(replaced).toBe(1);
  });

  it('writes a BEL, a backspace and the rest of the control characters as spaces, but keeps tab, line feed and carriage return', () => {
    const { bytes, replaced } = encodeWindows1252('a\u0007b\u0008c\u001bd\te\nf\rg');
    expect(decode(bytes)).toBe('a b c d\te\nf\rg');
    expect(replaced).toBe(3);
  });

  it('writes every character below a space exactly as the code page encoder does, so the two cannot come to differ', () => {
    for (let code = 0; code < 0x20; code += 1) {
      const char = String.fromCharCode(code);
      const { bytes, replaced } = encodeWindows1252(`x${char}y`);
      expect([...bytes]).toEqual([...Buffer.concat([Buffer.from('x'), encodeCodePage(char), Buffer.from('y')])]);
      expect(replaced).toBe(code === 0x09 || code === 0x0a || code === 0x0d ? 0 : 1);
    }
  });

  it('counts a control character with the letters that have no byte, each once', () => {
    const { bytes, replaced } = encodeWindows1252('Łu\u0000k\u0007');
    expect(decode(bytes)).toBe('Lu k ');
    expect(replaced).toBe(3);
  });

  it('is empty for no text', () => {
    expect(encodeWindows1252('')).toEqual({ bytes: Buffer.alloc(0), replaced: 0 });
  });
});
