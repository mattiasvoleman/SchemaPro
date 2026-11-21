import { describe, expect, it } from "vitest";
import { formatMessage } from "@/lib/pseudonym-message";

describe("formatMessage", () => {
  it("fills in a name, leaves text without braces alone, and shows a name it has no value for as it stands", () => {
    expect(formatMessage("Fil {n} av {total}", { n: 2, total: 5 })).toBe("Fil 2 av 5");
    expect(formatMessage("Ingen klammer här")).toBe("Ingen klammer här");
    expect(formatMessage("Saknar {värde}", {})).toBe("Saknar {värde}");
  });

  it("picks the plural form by the language's own rules, with # for the number", () => {
    const sv = "{count, plural, one {# fil} other {# filer}}";
    expect(formatMessage(sv, { count: 1 }, "sv")).toBe("1 fil");
    expect(formatMessage(sv, { count: 0 }, "sv")).toBe("0 filer");
    expect(formatMessage(sv, { count: 3 }, "sv")).toBe("3 filer");
    const en = "{count, plural, one {# file} other {# files}}";
    expect(formatMessage(en, { count: 1 }, "en")).toBe("1 file");
    expect(formatMessage(en, { count: 2 }, "en")).toBe("2 files");
  });

  it("takes an exact =0 form before the category, and a name inside a plural's branch", () => {
    const message = "{count, plural, =0 {Ingen fil i {place}} one {# fil i {place}} other {# filer i {place}}}";
    expect(formatMessage(message, { count: 0, place: "listan" })).toBe("Ingen fil i listan");
    expect(formatMessage(message, { count: 1, place: "listan" })).toBe("1 fil i listan");
    expect(formatMessage(message, { count: 7, place: "listan" })).toBe("7 filer i listan");
  });

  it("holds text before and after, several fields and a plural together", () => {
    expect(formatMessage("{a} och {n, plural, one {en rad} other {# rader}} sist", { a: "x", n: 4 })).toBe("x och 4 rader sist");
  });

  it("leaves an unclosed brace as it is rather than throwing", () => {
    expect(formatMessage("Ett {hål", { hål: 1 })).toBe("Ett {hål");
  });
});
