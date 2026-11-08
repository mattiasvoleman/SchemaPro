import { encodeWindows1252 } from './windows-1252';

const encode = (text: string) => [...encodeWindows1252(text)];

describe('encodeWindows1252', () => {
  it('writes ASCII as it is, and the Swedish letters as one byte each', () => {
    expect(encode('Klass 7A;12')).toEqual([...Buffer.from('Klass 7A;12', 'latin1')]);
    expect(encode('åäöÅÄÖé')).toEqual([0xe5, 0xe4, 0xf6, 0xc5, 0xc4, 0xd6, 0xe9]);
  });

  it('writes the 27 characters that 1252 puts where Latin-1 has controls', () => {
    expect(encode('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ')).toEqual([
      0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8e, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
      0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f,
    ]);
  });

  it('keeps the high Latin-1 block, where 1252 and Latin-1 agree', () => {
    expect(encode(' ¡£©°±º»¿×ÿ')).toEqual([0xa0, 0xa1, 0xa3, 0xa9, 0xb0, 0xb1, 0xba, 0xbb, 0xbf, 0xd7, 0xff]);
  });

  it('writes a character with no byte as a question mark, one for a code point', () => {
    expect(encode('a→b')).toEqual([0x61, 0x3f, 0x62]);
    expect(encode('😀')).toEqual([0x3f]);
    expect(encode('Ж')).toEqual([0x3f]);
  });

  it('writes a C1 control, which 1252 leaves unassigned, as a question mark and not as its Latin-1 byte', () => {
    expect(encode('\u0081')).toEqual([0x3f]);
    expect(encode('\u009f')).toEqual([0x3f]);
  });

  it('keeps tab, line feed and carriage return and turns any other control character into a space', () => {
    expect(encode('a\tb\r\nc')).toEqual([0x61, 0x09, 0x62, 0x0d, 0x0a, 0x63]);
    expect(encode('a\u0000b\u0007c')).toEqual([0x61, 0x20, 0x62, 0x20, 0x63]);
  });

  it('writes nothing for nothing', () => {
    expect(encodeWindows1252('')).toHaveLength(0);
  });
});
