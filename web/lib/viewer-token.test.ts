import { describe, expect, it } from "vitest";
import { codeForDisplay, TOKEN_PATTERN, viewerAddressOf, viewerTokenOf } from "./viewer-token";

/**
 * The web's copy of the gateway's viewerTokenOf, held to the same rows as
 * src/publication/public-token.spec.ts: a token is taken as it is, a code
 * however it is typed, and anything else is no link.
 */

const CODE = "K7QM2X9DRT4V8WNB5C3H";

describe("viewerTokenOf", () => {
  it("takes a token as it is, case and hyphens included", () => {
    const token = "Tok_en-".padEnd(43, "x");
    expect(TOKEN_PATTERN.test(token)).toBe(true);
    expect(viewerTokenOf(token)).toBe(token);
    const hyphenated = "ab-cdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP";
    expect(hyphenated).toHaveLength(43);
    expect(viewerTokenOf(hyphenated)).toBe(hyphenated);
  });

  it("takes a code however it is typed, to the one canonical spelling", () => {
    const spellings = [CODE, "K7QM2-X9DRT-4V8WN-B5C3H", "k7qm2-x9drt-4v8wn-b5c3h", " K7QM2 X9DRT 4V8WN B5C3H ", "k7qm2x9drt4v8wnb5c3h", "K7QM2\tX9DRT-4V8WN B5C3H"];
    for (const spelling of spellings) expect(viewerTokenOf(spelling)).toBe(CODE);
  });

  it("reads I and L as 1 and O as 0, as the alphabet leaves them out", () => {
    expect(viewerTokenOf("K7QM2-X9DRT-4V8WN-B5C3H".replace("3", "L").replace("7", "I"))).toBe("K1QM2X9DRT4V8WNB5C1H");
    expect(viewerTokenOf("0".repeat(20))).toBe("0".repeat(20));
    expect(viewerTokenOf("O".repeat(20))).toBe("0".repeat(20));
  });

  it.each([
    ["too short", "K7QM2X9DRT4V8WNB5C3"],
    ["too long", "K7QM2X9DRT4V8WNB5C3HH"],
    ["a U, which the alphabet leaves out", "U".repeat(20)],
    ["a symbol outside the alphabet", "K7QM2X9DRT4V8WNB5C3!"],
    ["nothing", ""],
    ["a long string that is neither", "x".repeat(64)],
    ["more than any link is", "A".repeat(65)],
  ])("is no link: %s", (_why, raw) => {
    expect(viewerTokenOf(raw)).toBeNull();
  });

  it.each([[undefined], [null], [42], [[CODE]], [{}]])("is no link: not a string (%p)", (raw) => {
    expect(viewerTokenOf(raw)).toBeNull();
  });
});

describe("viewerAddressOf", () => {
  it("writes a code in four groups of five and leaves a token as it is", () => {
    expect(codeForDisplay("ABCDEFGHJKMNPQRSTVWX")).toBe("ABCDE-FGHJK-MNPQR-STVWX");
    expect(viewerAddressOf("k7qm2 x9drt 4v8wn b5c3h")).toBe("K7QM2-X9DRT-4V8WN-B5C3H");
    const token = "T".repeat(43);
    expect(viewerAddressOf(token)).toBe(token);
  });

  it("reads a path segment that still carries its percent-encoding, once", () => {
    expect(viewerAddressOf("k7qm2%20x9drt%204v8wn%20b5c3h")).toBe("K7QM2-X9DRT-4V8WN-B5C3H");
    expect(viewerAddressOf("%E0%A4%A")).toBeNull();
    // A token has no percent sign, so an encoded one is no token.
    expect(viewerAddressOf(`${"T".repeat(42)}%`)).toBeNull();
  });

  it("is null for anything that is no link", () => {
    for (const raw of ["short", "", "x".repeat(65), undefined, null]) expect(viewerAddressOf(raw)).toBeNull();
  });
});
