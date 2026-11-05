import { BadRequestException } from '@nestjs/common';
import { ENCODING_UNSUPPORTED, decodeText, readingScore } from './text-encoding';

/**
 * The same table is in web/lib/csv-encoding-parity.test.ts, against the web's
 * decodeCsvBytes (#260). The two cannot share code, so they share the files:
 * each is a byte string as hex, what it must be read as, and the text it gives.
 * A rule changed in one place breaks a row here or there.
 */
const FILES: Array<{ name: string; hex: string; encoding: string; refused: boolean; text: string }> = [
  { name: "ascii only", hex: "4b6c6173733b416d6e65", encoding: "utf-8", refused: false, text: "Klass;Amne" },
  { name: "utf-8 with names", hex: "c3856b653b537472c3b66d3b4dc3a47274610d0a", encoding: "utf-8", refused: false, text: "Åke;Ström;Märta\r\n" },
  { name: "utf-8 with a BOM", hex: "efbbbfc3856b653b537472c3b66d0d0a", encoding: "utf-8", refused: false, text: "Åke;Ström\r\n" },
  { name: "windows-1252 names", hex: "c56b653b537472f66d3b4de47274610d0a37413bd67374656e3bc56e67737472f66d0d0a", encoding: "windows-1252", refused: false, text: "Åke;Ström;Märta\r\n7A;Östen;Ångström\r\n" },
  { name: "mac roman names", hex: "816b653b5374729a6d3b4d8a7274610d0a37413b857374656e3b816e677374729a6d0d0a", encoding: "macintosh", refused: false, text: "Åke;Ström;Märta\r\n7A;Östen;Ångström\r\n" },
  { name: "windows-1252 names with a notes column of dashes and quotes", hex: "c56b653bc56b20379639209620946b6c6172943b537472f66d0d0ad67374656e3b9366617320329420853b4de47274610d0a", encoding: "windows-1252", refused: false, text: "Åke;Åk 7–9 – ”klar”;Ström\r\nÖsten;“fas 2” …;Märta\r\n" },
  { name: "mac roman names with a notes column of dashes and quotes", hex: "816b653b816b2037d03920d020d36b6c6172d33b5374729a6d0d0a857374656e3bd26661732032d320c93b4d8a7274610d0a", encoding: "macintosh", refused: false, text: "Åke;Åk 7–9 – ”klar”;Ström\r\nÖsten;“fas 2” …;Märta\r\n" },
  { name: "windows-1252 with euro signs and ellipses", hex: "507269733bc56b6520803b537472f66d20850d0a4de47274613bd67374656e3bc56e67737472f66d0d0a", encoding: "windows-1252", refused: false, text: "Pris;Åke €;Ström …\r\nMärta;Östen;Ångström\r\n" },
  { name: "mac roman with Ærø and Ø", hex: "ae72bf3baf737465723b8173610d0a", encoding: "macintosh", refused: false, text: "Ærø;Øster;Åsa\r\n" },
  { name: "windows-1252 czech names beside swedish ones", hex: "44759a616e3b8a656869633b48e56b616e3b8e616e6574613bc573613b537472f66d0d0a", encoding: "windows-1252", refused: false, text: "Dušan;Šehic;Håkan;Žaneta;Åsa;Ström\r\n" },
  { name: "a utf-8 file with one stray byte", hex: "c3856b653b537472c3b66d3b4dc3a47274613bc3967374656e0d0ae50d0a", encoding: "utf-8", refused: false, text: "Åke;Ström;Märta;Östen\r\n�\r\n" },
  { name: "utf-16 le with a BOM", hex: "fffec5006b0065003b00530074007200f6006d000d000a00", encoding: "utf-16", refused: true, text: "" },
  { name: "utf-16 be with a BOM", hex: "feff00c5006b0065000d000a", encoding: "utf-16", refused: true, text: "" },
  { name: "utf-16 le without a BOM", hex: "4b006c006100730073003b00c4006d006e0065003b004400610067000d000a00370041003b004d006100740065006d006100740069006b003b004d00e5006e000d000a00", encoding: "utf-16", refused: true, text: "" },
  { name: "code page 850", hex: "8f6b653b537472946d3b4d847274610d0a997374656e3b8f6e67737472946d0d0a", encoding: "cp850", refused: true, text: "" },
  { name: "empty", hex: "", encoding: "utf-8", refused: false, text: "" },
];

describe('decodeText, the same answer as the web for the same file', () => {
  it.each(FILES.filter((f) => !f.refused))('reads $name as $encoding', ({ hex, encoding, text }) => {
    const got = decodeText(Buffer.from(hex, 'hex'));
    expect(got.encoding).toBe(encoding);
    expect(got.text).toBe(text);
    expect(got.legacyEncoding).toBe(encoding !== 'utf-8');
  });

  it.each(FILES.filter((f) => f.refused))('refuses $name, with what to do instead', ({ hex, encoding }) => {
    let error: unknown;
    try {
      decodeText(Buffer.from(hex, 'hex'));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as { code: string; message: string };
    expect(response.code).toBe(ENCODING_UNSUPPORTED);
    expect(response.message).toContain(encoding === 'utf-16' ? 'UTF-16' : 'MS-DOS');
    expect(response.message).toContain('UTF-8');
  });

  it('says a UTF-8 file that lost a byte was read lossily, and a clean one was not', () => {
    const stray = FILES.find((f) => f.name === 'a utf-8 file with one stray byte')!;
    expect(decodeText(Buffer.from(stray.hex, 'hex')).lossy).toBe(true);
    expect(decodeText(Buffer.from('Åke', 'utf8')).lossy).toBe(false);
  });

  it('keeps the bytes of a file that is mostly not UTF-8 as a legacy reading, not as a lossy UTF-8 one', () => {
    // More lost bytes than kept letters: every å is a single E5, so reading it as UTF-8 would keep none of them.
    const got = decodeText(Buffer.from('e5e4f6e5e4f6e5e4f6', 'hex'));
    expect(got.encoding).toBe('windows-1252');
    expect(got.lossy).toBe(false);
    expect(got.text).toBe('åäöåäöåäö');
  });
});

describe('readingScore', () => {
  it('rewards names and punishes what a wrong reading makes of them', () => {
    expect(readingScore('Åke Ström')).toBeGreaterThan(readingScore('≈ke Str÷m'));
    expect(readingScore('Ærø José')).toBeGreaterThan(0);
    expect(readingScore('Dušan Šehic')).toBeGreaterThan(0);
  });

  it('loses a point for a letter with no letter beside it, a control character and a capital after a small letter', () => {
    expect(readingScore('a ñ b')).toBe(-1);
    expect(readingScore('a\u0085b')).toBe(-1);
    expect(readingScore('osvÖ')).toBe(-1);
  });

  it('counts nothing for plain ASCII and for a symbol away from letters', () => {
    expect(readingScore('Klass;Ämne'.replace('Ä', 'A'))).toBe(0);
    expect(readingScore(' ≈ ')).toBe(0);
  });
});
