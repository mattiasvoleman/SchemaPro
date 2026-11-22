import { describe, expect, it } from "vitest";
import { hasPersonalNumber } from "@/lib/personal-number";
import { findPersonalData } from "@/lib/pseudonym-detect";
import { isMarker, keyOf, MarkerBook, MARKER_KINDS, markerText, normaliseText, personalNumberKind } from "@/lib/pseudonym-markers";

describe("markerText", () => {
  it("is ASCII, says its kind and numbers from 0001, with an address for e-mail", () => {
    expect(markerText("pnr", 1)).toBe("PNR-0001");
    expect(markerText("sam", 12)).toBe("SAM-0012");
    expect(markerText("tel", 3)).toBe("TEL-0003");
    expect(markerText("namn", 4)).toBe("NAMN-0004");
    expect(markerText("fornamn", 5)).toBe("FORNAMN-0005");
    expect(markerText("efternamn", 6)).toBe("EFTERNAMN-0006");
    expect(markerText("sign", 7)).toBe("SIGN-0007");
    expect(markerText("text", 8)).toBe("TEXT-0008");
    expect(markerText("epost", 9)).toBe("epost-0009@exempel.invalid");
    expect(markerText("namn", 12345)).toBe("NAMN-12345");
  });

  it("has no shape the pseudonymiser looks for, whatever the number: no personnummer, no address that can be delivered to, no telephone number", () => {
    const numbers = [...Array.from({ length: 3000 }, (_, i) => i + 1), 99_999, 123_456, 1_234_567, 80_010_112, 19_800_101_123];
    for (const kind of MARKER_KINDS) {
      for (const n of numbers) {
        const marker = markerText(kind, n);
        expect(/^[\x20-\x7e]+$/.test(marker), marker).toBe(true);
        expect(hasPersonalNumber(marker), marker).toBe(false);
        expect(findPersonalData(marker), marker).toEqual([]);
      }
    }
  });
});

describe("isMarker", () => {
  it("is true for exactly one marker, with blanks round it, and false for anything else", () => {
    for (const kind of MARKER_KINDS) expect(isMarker(markerText(kind, 12)), kind).toBe(true);
    expect(isMarker("  NAMN-0003 ")).toBe(true);
    expect(isMarker("NAMN-0003 NAMN-0004")).toBe(false);
    expect(isMarker("Anna NAMN-0003")).toBe(false);
    expect(isMarker("NAMN-3")).toBe(false);
    expect(isMarker("")).toBe(false);
  });
});

describe("keyOf: what counts as the same value", () => {
  it("makes one personnummer of every way of writing it", () => {
    for (const spelling of ["800101-1234", "19800101-1234", "8001011234", "198001011234", "800101 1234", "800101+1234", "１９８００１０１－１２３４".replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))]) {
      expect(keyOf("pnr", spelling)).toBe("8001011234");
    }
    expect(keyOf("pnr", "800101-1235")).not.toBe(keyOf("pnr", "800101-1234"));
  });

  it("makes one telephone number of +46, 0046 and 0, and keeps a foreign number as it is", () => {
    expect(new Set(["070-123 45 67", "+46 70 123 45 67", "0046 70 123 45 67", "0701234567"].map((v) => keyOf("tel", v))).size).toBe(1);
    expect(keyOf("tel", "+47 22 33 44 55")).toBe("+4722334455");
    expect(keyOf("tel", "070")).toBe("070");
  });

  it("makes one address of upper and lower case, mailto: and blanks around it", () => {
    expect(keyOf("epost", " MailTo:Anna@Skola.SE ")).toBe("anna@skola.se");
  });

  it("makes one name of upper and lower case, extra blanks and the same letters composed or decomposed, and not of two names", () => {
    expect(keyOf("namn", "SVENSSON,  Anna")).toBe(keyOf("namn", "svensson, anna"));
    expect(keyOf("namn", "Å")).toBe(keyOf("namn", "Å"));
    expect(keyOf("namn", "Anna Svensson")).not.toBe(keyOf("namn", "Anna Svenson"));
    expect(normaliseText("  Åke \t Öst  ")).toBe("åke öst");
  });

  it("reads the day of a whole-cell number: a samordningsnummer when it is 61 to 91", () => {
    expect(personalNumberKind("800101-1234")).toBe("pnr");
    expect(personalNumberKind("19800161-1234")).toBe("sam");
    expect(personalNumberKind("abc")).toBe("pnr");
  });
});

describe("MarkerBook", () => {
  it("gives a value the same marker every time, in the order values are first met, and a new value the next", () => {
    const book = new MarkerBook();
    expect(book.marker("namn", "anna")).toBe("NAMN-0001");
    expect(book.marker("namn", "bo")).toBe("NAMN-0002");
    expect(book.marker("namn", "anna")).toBe("NAMN-0001");
    expect(book.distinct("namn")).toBe(2);
  });

  it("numbers each kind on its own, and keeps one key of two kinds apart", () => {
    const book = new MarkerBook();
    expect(book.marker("fornamn", "anna")).toBe("FORNAMN-0001");
    expect(book.marker("efternamn", "anna")).toBe("EFTERNAMN-0001");
    expect(book.marker("tel", "0701234567")).toBe("TEL-0001");
    expect(book.distinct("fornamn")).toBe(1);
    expect(book.distinct("sign")).toBe(0);
  });

  it("gives different values different markers: no two keys of a kind share one", () => {
    const book = new MarkerBook();
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i += 1) seen.add(book.marker("pnr", `key${i}`));
    expect(seen.size).toBe(5000);
  });
});
