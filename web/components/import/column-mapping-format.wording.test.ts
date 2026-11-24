import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * WHAT THE PANEL SAYS OF A SKOLA24 FILE, as a school reads it (granskningen av #379: L-1, L-7).
 *
 * "Känns igen" is the panel's own act: it found the file by its exact headers. A file the user chose to read that way, or took the offer
 * of, is read as they said, and the sentence says that; and a select option that promises recognition promises it only by the headers.
 * The real Swedish and English are formatted here, because a word a school reads is not what the component test's echo says.
 */

const section = (messages: unknown): Record<string, unknown> => (messages as { columnMapping: Record<string, unknown> }).columnMapping;
const say = (messages: unknown, locale: string, path: string[], values: Record<string, unknown> = {}): string => {
  let node: unknown = section(messages);
  for (const key of path) node = (node as Record<string, unknown>)[key];
  return String(new IntlMessageFormat(node as string, locale).format(values));
};

const NAME = "Importera elever till klasser";

describe("a file the panel recognised, and a file the user chose to read as Skola24's", () => {
  it("says a file the panel found by itself as recognised", () => {
    expect(say(sv, "sv", ["format", "recognised"], { name: NAME })).toMatch(/^Filen känns igen som Skola24:s ”Importera elever till klasser”/);
    expect(say(en, "en", ["format", "recognised"], { name: NAME })).toMatch(/^The file is recognised as Skola24's “Importera elever till klasser”/);
  });

  it("says a file the user chose as read as they chose, and never as recognised", () => {
    const swedish = say(sv, "sv", ["format", "read"], { name: NAME });
    const english = say(en, "en", ["format", "read"], { name: NAME });
    expect(swedish).toMatch(/^Filen läses som Skola24:s ”Importera elever till klasser”, som du valde,/);
    expect(english).toMatch(/^The file is read as Skola24's “Importera elever till klasser”, as you chose,/);
    expect(swedish).not.toMatch(/känns igen/);
    expect(english).not.toMatch(/recognised/);
  });

  it("says the same about where the columns stand in both, which is the description's and not the user's", () => {
    expect(say(sv, "sv", ["format", "read"], { name: NAME })).toMatch(/kolumnerna är placerade som Skola24 beskriver den\.$/);
    expect(say(en, "en", ["format", "read"], { name: NAME })).toMatch(/the columns are placed as Skola24 describes it\.$/);
  });

  it("does not promise recognition of a file that has no headers to recognise it by", () => {
    // The default choice applies a description by itself only on its exact documented headers; a file without a header row is offered.
    expect(say(sv, "sv", ["format", "auto"])).toBe("Känn igen på rubrikerna");
    expect(say(en, "en", ["format", "auto"])).toBe("Recognise by the headers");
    expect(say(sv, "sv", ["format", "auto"])).not.toBe("Känn igen själv");
    expect(say(en, "en", ["format", "auto"])).not.toBe("Recognise it");
  });
});

describe("the words of the file, and the words of the app", () => {
  it("says to an English reader that the columns a file lacks are named as Skola24 names them, in Swedish", () => {
    const sentence = say(en, "en", ["format", "missing"], { count: 2, names: "Mobilnummer för vårdnadshavare, avdelning" });
    expect(sentence).toBe("The file lacks the columns that Skola24's description has (Skola24's own Swedish names): Mobilnummer för vårdnadshavare, avdelning.");
    expect(say(en, "en", ["format", "missing"], { count: 1, names: "Klass" })).toBe(
      "The file lacks the column that Skola24's description has (Skola24's own Swedish names): Klass.",
    );
  });

  it("keeps the Swedish sentence as it was: the names are the reader's own words", () => {
    expect(say(sv, "sv", ["format", "missing"], { count: 1, names: "Klass" })).toBe("Filen saknar kolumnen som Skola24:s beskrivning har: Klass.");
    expect(say(sv, "sv", ["format", "missing"], { count: 2, names: "Klass, avdelning" })).toBe(
      "Filen saknar kolumnerna som Skola24:s beskrivning har: Klass, avdelning.",
    );
  });

  it("names the file's mark and the app's word for it in one sentence, in both languages", () => {
    const swedish = say(sv, "sv", ["held"], { count: 1, rows: "2" });
    const english = say(en, "en", ["held"], { count: 1, rows: "2" });
    expect(swedish).toBe("Rad 2 har sekretessmarkering i filen (en skyddad identitet i Rastra) och läses inte in, som i Skola24. Resten av filen läses.");
    expect(english).toBe("Row 2 has a confidentiality mark in the file (a protected identity in Rastra) and is not read, as in Skola24. The rest of the file is read.");
    expect(say(sv, "sv", ["held"], { count: 3, rows: "2, 5, 9" })).toMatch(/^Rader 2, 5, 9 har sekretessmarkering i filen \(en skyddad identitet i Rastra\)/);
    expect(say(en, "en", ["held"], { count: 3, rows: "2, 5, 9" })).toMatch(/^Rows 2, 5, 9 have a confidentiality mark in the file \(a protected identity in Rastra\)/);
  });
});
