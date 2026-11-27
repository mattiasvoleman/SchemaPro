import { describe, expect, it } from "vitest";
import { KEEP, type Treatment } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { planFile, pseudonymise } from "@/lib/pseudonym-run";

/*
 * THE LEAK ORACLE (the review of #398: every number the search misses is a number left in a file that is sent on).
 *
 * WHAT IS INDEPENDENT. This file imports no search: not lib/pseudonym-detect.ts, not lib/personal-number.ts, not the gateway's file-safety.ts, and none of their
 * expressions is copied here. It makes a file with an invented person's number in it, written in a way a person writes it, sends the file through the page's own way
 * in (parseText, planFile, pseudonymise) and asks ONE question of what comes out: could a reader who ignores everything but letters and digits still read any of
 * the number? The answer is given by `squash` below, which is not the pseudonymiser's search and does not look like it: it does not look for a shape at all, it
 * looks for the invented digits themselves, so a shape the search has never heard of is found by the oracle all the same.
 *
 * WHAT IT SAYS. A spelling is written, in a place, and the safe file is read:
 *   - ZERO LEAKS: no six digits of the number (its date, or its last six), no part of a telephone number, no part of an address survives, however it was written.
 *   - ONE VALUE, ONE MARKER: the same number written two ways has one marker in the safe file.
 *   - NOTHING HARMLESS IS TAKEN: a course code, a room, a time, a version number, an id that is no person's is left as it was written.
 *
 * X1b ADDS THE SPELLINGS THE REVIEW OF #403 AND THE FIX OF #398 LEFT: a symbol (* | • · ~ # = ;) between the date and the last four; a control character among the digits; a line break of two characters inside a quoted
 * cell; a number written with an exponent (8.001011234E9) in a CSV; a telephone number with full stops and blanks or hyphens mixed.
 *
 * THE SPELLINGS ARE THE ONES THE REVIEWS NAMED (#383, #396, #398): a separator of : , or ' between the date and the last four of a personnummer; invisible
 * characters, any number of them, anywhere between the digits; a telephone number with no plus (46701234567) or with full stops (070.123.45.67); an address with its
 * local part in quotes; a line break in the middle of a number in running text. And every spelling the page already took, so that a change that fixes one does not undo another.
 * Everything here is INVENTED: random digits, random letters, and no name of a person.
 *
 * WHAT IT DOES NOT SAY. A number split over two CELLS is a limit the page lists; a break of a line in a table of several columns is one too. The frames here do not put a number there.
 */

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/** mulberry32 from a 32-bit seed: the same seed is the same files, so a failing round can be played again. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return { int, pick: <T>(list: readonly T[]): T => list[int(list.length)]!, bool: (p = 0.5): boolean => next() < p };
}
type Rng = ReturnType<typeof rng>;

const digits = (rand: Rng, n: number): string => Array.from({ length: n }, () => String(rand.int(10))).join("");
const letters = (rand: Rng, n: number): string => Array.from({ length: n }, () => String.fromCharCode(97 + rand.int(26))).join("");
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** What a number is hidden by: pieces of its digits (or letters) that must be gone, whatever else is left of the text. */
interface Spelled {
  text: string;
  hides: string[];
  /** The value's identity, so that two spellings of one value can be told to have one marker. */
  value: string;
}

/** Characters that show nothing: a reader cannot see them between two digits, and a program that looks for a shape may. Format characters, joiners, bidi marks, selectors, fillers. */
const INVISIBLE = [
  "\u00ad", "\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u2060", "\u2061", "\u2062", "\u2063", "\u2064", "\u2066", "\u2067", "\u2068", "\u2069",
  "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u061c", "\u034f", "\ufe0f", "\ufe00", "\u180e", "\ufeff", "\u3164",
  // Control characters (X1b, the review of #403 L-6 c): nothing shows between two digits.
  "\u0001", "\u0002", "\u0007", "\u001b", "\u001f", "\u007f", "\u0090",
];

/** Runs of invisible characters at random places in a text: none, one, or up to three runs of one to three. */
function withInvisibles(rand: Rng, text: string): string {
  let out = text;
  const runs = rand.pick([0, 0, 1, 2, 3]);
  for (let i = 0; i < runs; i += 1) {
    const at = 1 + rand.int(Math.max(1, out.length - 1));
    const run = Array.from({ length: 1 + rand.int(3) }, () => rand.pick(INVISIBLE)).join("");
    out = out.slice(0, at) + run + out.slice(at);
  }
  return out;
}

const fullWidth = (text: string): string => text.replace(/[0-9]/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0)).replace(/[TtFf]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

/** What can stand between the date and the last four of a personnummer. The first twelve the page took before; the rest it did not. */
const PNR_SEPARATORS_KNOWN = ["-", "+", " ", "", "\u00a0", "\u202f", "\u2011", "\u2013", "\u2212", "\uff0d", "\u3000", ".", "/", "_", " - ", "\u0085"];
const PNR_SEPARATORS_NEW = [":", ",", "'", "\u2019", "\u2018", "\u00b4", "`", "\u02bc", "\u2032"];
/** What someone puts between the date and the last four who has masked or struck the number out (X1b, the review of #403 L-6 a). */
const PNR_SEPARATORS_SYMBOLS = ["*", "|", "\u2022", "\u00b7", "~", "#", "=", ";"];

interface PnrOptions {
  separators: readonly string[];
  invisibles: boolean;
  /** The last digit is the number's check digit, as a real personnummer has it (a symbol between the date and the last four is taken for a separator only then). */
  luhn?: boolean;
}

/** The check digit of the first nine digits of a personnummer, made by the rule and not by the page's search. */
function luhnCheckDigit(nine: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let digit = Number(nine[i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return String((10 - (sum % 10)) % 10);
}

function personnummer(rand: Rng, options: PnrOptions): Spelled {
  const date = pad2(rand.int(100)) + pad2(1 + rand.int(12)) + pad2(1 + rand.int(28) + (rand.bool(0.15) ? 60 : 0));
  const drawn = digits(rand, 4);
  const last = options.luhn === true ? drawn.slice(0, 3) + luhnCheckDigit(date + drawn.slice(0, 3)) : drawn;
  const century = rand.pick(["", "", "19", "20"]);
  let head = century + date;
  // The shape the page already takes: one blank between two digits of the date.
  if (rand.bool(0.15)) {
    const at = 1 + rand.int(head.length - 1);
    head = `${head.slice(0, at)} ${head.slice(at)}`;
  }
  let text = head + rand.pick(options.separators) + last;
  if (options.invisibles) text = withInvisibles(rand, text);
  if (rand.bool(0.08)) text = fullWidth(text);
  const ten = date + last;
  return { text, hides: [ten.slice(0, 6), ten.slice(4)], value: ten };
}

/**
 * A personnummer of ten digits that a spreadsheet or an exporter has written as a number with an exponent: 8.001011234E9, 8,001011234E+09, in either case of the E, and what Excel in Swedish settings makes of it,
 * 8,00101E+09, with six digits kept (what is left is the date and a part of the rest). The first digit is the decade, so the personnummer is of someone born 1940-1999 and has no zero to lose.
 */
function exponentNumber(rand: Rng): Spelled {
  const date = String(4 + rand.int(6)) + String(rand.int(10)) + pad2(1 + rand.int(12)) + pad2(1 + rand.int(28));
  const last = digits(rand, 4);
  const ten = date + last;
  const point = rand.pick([".", ","]);
  const e = rand.pick(["E", "e"]);
  const plus = rand.pick(["", "+"]);
  const lossy = rand.bool(0.3);
  const kept = lossy ? 6 : 10;
  const mantissa = `${ten[0]}${point}${ten.slice(1, kept)}`;
  const exponent = rand.pick(["9", "09"]);
  return { text: `${mantissa}${e}${plus}${exponent}`, hides: lossy ? [ten.slice(0, 6)] : [ten.slice(0, 6), ten.slice(4)], value: ten };
}

interface TfOptions {
  invisibles: boolean;
}

function tfNumber(rand: Rng, options: TfOptions): Spelled {
  const date = rand.pick(["19", "20"]) + pad2(rand.int(100)) + pad2(1 + rand.int(12)) + pad2(1 + rand.int(28));
  const nn = pad2(1 + rand.int(98));
  const inDate = ["", " ", "-", ".", "/", "_", "  ", " -", "\u00a0"];
  const before = () => Array.from({ length: rand.int(5) }, () => rand.pick([" ", "-", "+", ".", "/", "_"])).join("");
  const after = () => Array.from({ length: rand.int(5) }, () => rand.pick([" ", "-", ".", "/", "_"])).join("");
  const tf = rand.pick(["TF", "tf", "Tf", "tF"]);
  const split = rand.bool(0.15) ? `${tf[0]}${rand.pick([" ", "-"])}${tf[1]}` : tf;
  let text = `${date.slice(0, 4)}${rand.pick(inDate)}${date.slice(4, 6)}${rand.pick(inDate)}${date.slice(6)}${rand.bool(0.4) ? "" : before()}${split}${after()}${nn}`;
  if (options.invisibles) text = withInvisibles(rand, text);
  if (rand.bool(0.08)) text = fullWidth(text);
  return { text, hides: [date.slice(0, 6), date.slice(2)], value: `${date}TF${nn}` };
}

interface TelOptions {
  /** The forms the page did not take: no plus, and full stops. */
  wide: boolean;
  /** Full stops among blanks and hyphens (X1b, the review of #403 L-6 b): never one separator alone. */
  mixed?: boolean;
}

/** A Swedish mobile or Stockholm number as the groups of its digits after the 0 or the country code, in a few common groupings. */
function telephone(rand: Rng, options: TelOptions): Spelled {
  const mobile = rand.bool(0.65);
  const national = mobile ? `7${rand.pick(["0", "2", "3", "6", "9"])}${digits(rand, 7)}` : `8${digits(rand, rand.pick([7, 8]))}`;
  const sizes = mobile ? rand.pick([[2, 3, 2, 2], [2, 7], [2, 3, 4], [9]]) : national.length === 8 ? rand.pick([[1, 3, 2, 2], [1, 7], [8]]) : rand.pick([[1, 3, 3, 2], [1, 8], [9]]);
  const groups: string[] = [];
  let at = 0;
  for (const size of sizes) {
    groups.push(national.slice(at, at + size));
    at += size;
  }
  const prefix = rand.pick(options.wide ? ["0", "0", "+46", "0046", "46", "46"] : ["0", "0", "+46", "0046"]);
  const tokens = prefix === "0" ? [`0${groups[0]}`, ...groups.slice(1)] : [prefix, ...groups];
  // Full stops only where there are enough groups to be told from a decimal number or a date.
  const separators = options.wide && tokens.length >= 4 ? ["-", " ", "", ".", "/", " - "] : ["-", " ", "", "/", " - "];
  const same = rand.pick(separators);
  // A number is written with one separator, or with blanks and hyphens mixed; never full stops among others, unless the number is of the mixed kind.
  const mixed = same !== "." && same !== "/";
  let text = tokens.map((token, i) => (i === 0 ? token : (!mixed || rand.bool(0.8) ? same : rand.pick([" ", "-"])) + token)).join("");
  if (options.mixed === true && tokens.length >= 4) {
    // Full stops where some of the gaps were, and the others as they are: a number copied from two sources.
    const gaps = tokens.length - 1;
    const stop = 1 + rand.int(gaps);
    text = tokens.map((token, i) => (i === 0 ? token : (i === stop || rand.bool(0.4) ? "." : rand.pick([" ", "-", " "])) + token)).join("");
  }
  return { text, hides: [national.slice(0, 6), national.slice(-6)], value: `0${national}` };
}

interface AddressOptions {
  quoted: boolean;
}

function address(rand: Rng, options: AddressOptions): Spelled {
  const first = letters(rand, 5 + rand.int(4));
  const second = letters(rand, 5 + rand.int(4));
  const domain = `${letters(rand, 6)}.se`;
  const forms: string[] = [`${first}.${second}@${domain}`, `${first}@${domain}`, `Namn <${first}.${second}@${domain}>`, `mailto:${first}.${second}@${domain}`];
  if (options.quoted) {
    forms.push(`"${first}.${second}"@${domain}`, `"${first} ${second}"@${domain}`, `\u201c${first}.${second}\u201d@${domain}`, `Namn <"${first}.${second}"@${domain}>`, `"${first}"@[10.20.30.40]`, `${first}@[10.20.30.40]`);
  }
  const text = rand.pick(forms);
  return { text, hides: [first, ...(text.includes(second) ? [second] : [])], value: `${first}.${second}@${domain}` };
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

/** A marker the page writes: its digits are the marker's, not a person's. */
const MARKERS = /(?:pnr|sam|tf|tel|namn|fornamn|efternamn|sign|text)-\d{4,}|epost-\d{4,}@exempel\.invalid/g;

/** What a reader sees who ignores everything but letters and digits: markers become a wall, everything else is run together, in lower case and with the width and the shapes of the digits unified. */
function squash(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(MARKERS, "|").replace(/[^0-9a-z|]/g, "");
}

const leaked = (output: string, hides: readonly string[]): boolean => {
  const seen = squash(output);
  return hides.some((piece) => seen.includes(piece));
};

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

const quote = (cell: string): string => `"${cell.replace(/"/g, '""')}"`;

/** A text round the number: each is a file, and none of them is told what the number is. */
const FRAMES: [string, (cell: string) => string][] = [
  ["a column the user kept", (c) => `Klass;Notis\r\n7A;${quote(c)}\r\n7B;ok\r\n`],
  ["running text in a kept column", (c) => `Klass;Notis\r\n7A;${quote(`Se ${c} igen, tack`)}\r\n7B;ok\r\n`],
  ["a personnummer column", (c) => `Personnummer;Klass\r\n${quote(c)};7A\r\n19900101-1239;7B\r\n`],
  ["a title above the header", (c) => `${quote(`Export för ${c}`)}\r\nKlass;Notis\r\n7A;ok\r\n7B;ok\r\n`],
  ["the header row", (c) => `Klass;${quote(c)}\r\n7A;x\r\n7B;y\r\n`],
  ["a text that is not a table", (c) => `Brev till vårdnadshavare\r\nVi har noterat att eleven ${c} saknas;idag\r\nTack;för;hjälpen;nu\r\nVälkommen;igen\r\nMed vänlig hälsning;skolan;rektor;Ma\r\n`],
  ["a list of one column", (c) => `Brev om eleven\r\nVi har noterat att eleven ${c} saknas idag.\r\nHälsningar skolan\r\n`],
];

interface Run {
  output: string;
  report: string;
  checkPassed: boolean;
}

/** The page's way: read the text, keep every column the page has no opinion on, run. */
function run(text: string): Run {
  const input = parseText(text, "file", "UTF-8", false);
  if (input === null) throw new Error("nothing to read");
  const plan = planFile(input);
  const treatments: Record<number, Treatment> = {};
  for (const column of plan.columns) if (column.proposal === null) treatments[column.index] = KEEP;
  const result = pseudonymise([input], { files: [{ treatments }] });
  if (!result.ok) throw new Error("undecided");
  return { output: result.files[0]!.text, report: JSON.stringify(result.report), checkPassed: result.check.passed };
}

/** Spellings in places: what leaked, as lines a failing test prints. */
function leaksOf(family: string, rounds: number, seed: number, make: (rand: Rng) => Spelled, frames = FRAMES): string[] {
  const rand = rng(seed);
  const found: string[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const spelled = make(rand);
    for (const [name, frame] of frames) {
      const result = run(frame(spelled.text));
      if (leaked(result.output, spelled.hides) || leaked(result.report, spelled.hides)) found.push(`${family} | ${name} | ${JSON.stringify(spelled.text)}`);
      else if (!result.checkPassed) found.push(`${family} | ${name} | the check failed on ${JSON.stringify(spelled.text)}`);
    }
  }
  return found;
}

const ROUNDS = 60;

describe("the frames are what they say they are", () => {
  it("the last two are a text that is not a table and a table of one column", () => {
    const shapeOf = (frame: (cell: string) => string) => parseText(frame("x"), "file", "UTF-8", false)!.body.shape;
    expect(shapeOf(FRAMES[5]![1])).toBe("lines");
    expect(shapeOf(FRAMES[6]![1])).toBe("table");
    expect(FRAMES.slice(0, 5).every(([, frame]) => shapeOf(frame) === "table")).toBe(true);
  });
});

describe("no personnummer is left, however it was written", () => {
  it("the spellings the page took before (a regression oracle)", () => {
    expect(leaksOf("pnr known", ROUNDS, 11, (rand) => personnummer(rand, { separators: PNR_SEPARATORS_KNOWN, invisibles: false }))).toEqual([]);
  });

  it("a colon, a comma or an apostrophe between the date and the last four", () => {
    expect(leaksOf("pnr :,'", ROUNDS, 12, (rand) => personnummer(rand, { separators: PNR_SEPARATORS_NEW, invisibles: false }))).toEqual([]);
  });

  it("invisible characters between the digits, any number of them, with every separator", () => {
    expect(leaksOf("pnr invisible", ROUNDS, 13, (rand) => personnummer(rand, { separators: [...PNR_SEPARATORS_KNOWN, ...PNR_SEPARATORS_NEW], invisibles: true }))).toEqual([]);
  });
});

describe("no personnummer is left that is written with a symbol, a control character or an exponent (X1b)", () => {
  it("a symbol between the date and the last four: * | \u2022 \u00b7 ~ # = ;", () => {
    expect(leaksOf("pnr symbols", ROUNDS, 14, (rand) => personnummer(rand, { separators: PNR_SEPARATORS_SYMBOLS, invisibles: false, luhn: true }))).toEqual([]);
  });

  it("control characters between the digits, with every separator and the symbols too", () => {
    expect(leaksOf("pnr controls", ROUNDS, 15, (rand) => personnummer(rand, { separators: [...PNR_SEPARATORS_KNOWN, ...PNR_SEPARATORS_NEW, ...PNR_SEPARATORS_SYMBOLS], invisibles: true, luhn: true }))).toEqual([]);
  });

  it("a number written with an exponent, as a spreadsheet or an exporter writes a long number, in every place a number can stand (a column a header calls an id, running text, the header row)", () => {
    expect(leaksOf("pnr exponent", ROUNDS, 16, exponentNumber)).toEqual([]);
  });
});

describe("no TF number is left, however it was written", () => {
  it("every spelling, with invisible characters between its parts", () => {
    expect(leaksOf("tf", ROUNDS, 21, (rand) => tfNumber(rand, { invisibles: true }))).toEqual([]);
  });
});

describe("no telephone number is left, however it was written", () => {
  it("the spellings the page took before (a regression oracle)", () => {
    expect(leaksOf("tel known", ROUNDS, 31, (rand) => telephone(rand, { wide: false }))).toEqual([]);
  });

  it("with no plus (46701234567) and with full stops (070.123.45.67)", () => {
    expect(leaksOf("tel wide", ROUNDS, 32, (rand) => telephone(rand, { wide: true }))).toEqual([]);
  });

  it("with full stops among blanks and hyphens (070.123 45 67, 070-123.45.67), the review of #403 L-6 b", () => {
    expect(leaksOf("tel mixed", ROUNDS, 33, (rand) => telephone(rand, { wide: true, mixed: true }))).toEqual([]);
  });
});

describe("no e-mail address is left, however it was written", () => {
  it("plain, in angle brackets and after mailto:", () => {
    expect(leaksOf("address known", ROUNDS, 41, (rand) => address(rand, { quoted: false }))).toEqual([]);
  });

  it("with the local part in quotes, and a domain written as an address in brackets", () => {
    expect(leaksOf("address quoted", ROUNDS, 42, (rand) => address(rand, { quoted: true }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A line break in the middle of a number
// ---------------------------------------------------------------------------

/** The two places a hard-wrapped text may cut a number: at any character, so that "19000" and "101TF01" are two lines. */
const BREAKS = ["\n", "\r\n"];
const WRAPPED: [string, (a: string, b: string, eol: string) => string][] = [
  ["lines of a letter", (a, b, eol) => ["Brev till vårdnadshavare;a", `Vi har noterat att eleven med id ${a}${eol}${b} inte har kommit idag.`, "Tack;för;hjälpen;nu", "Välkommen;igen", "Med vänlig hälsning;skolan;rektor;Ma", ""].join(eol)],
  ["a list of one column", (a, b, eol) => ["Brev om eleven", `Vi har noterat att eleven med id ${a}${eol}${b} inte har kommit idag.`, "Hälsningar skolan", ""].join(eol)],
];

function brokenLeaks(family: string, spellings: Spelled[]): string[] {
  const found: string[] = [];
  for (const spelled of spellings) {
    // Not at the first or the last character of the number (that would not cut it), and not inside a pair of the text's own line break.
    for (let at = 1; at < spelled.text.length; at += 1) {
      for (const eol of BREAKS) {
        for (const [name, frame] of WRAPPED) {
          const result = run(frame(spelled.text.slice(0, at), spelled.text.slice(at), eol));
          if (leaked(result.output, spelled.hides) || leaked(result.report, spelled.hides)) found.push(`${family} | ${name} | ${JSON.stringify(eol)} | ${JSON.stringify(spelled.text.slice(0, at))} / ${JSON.stringify(spelled.text.slice(at))}`);
          else if (!result.checkPassed) found.push(`${family} | ${name} | the check failed on ${JSON.stringify(spelled.text)} cut at ${at}`);
        }
      }
    }
  }
  return found;
}

const some = <T>(seed: number, n: number, make: (rand: Rng) => T): T[] => {
  const rand = rng(seed);
  return Array.from({ length: n }, () => make(rand));
};

/**
 * A number cut by a line break INSIDE a quoted cell (X1b, the review of #403 L-5 b: 8001<LF>011234 was found and 8001<CR><LF>011234 was not). A cell is searched as one text, so the line break is
 * a blank, and a number whose own separators are already at the most the shape takes, or that is cut inside its last four, is not found with a blank more: the seam search that joins a line break in
 * running text has nothing to join in a cell. What the page promises is that the two kinds of line break are alike, and that is what this holds: the safe file is the same, cut for cut, whether the break is
 * written with one character or with two.
 */
function cellBreakDiffers(family: string, spellings: Spelled[]): string[] {
  const found: string[] = [];
  for (const spelled of spellings) {
    for (let at = 1; at < spelled.text.length; at += 1) {
      for (const frameOf of [
        (cell: string) => `Klass;Notis\r\n7A;${quote(cell)}\r\n7B;ok\r\n7C;ok\r\n7D;ok\r\n`,
        (cell: string) => `Notis;Klass\r\nok;7A\r\n${quote(cell)};7B\r\nok;7C\r\nok;7D\r\n`,
      ]) {
        const cell = (eol: string): string => `Se ${spelled.text.slice(0, at)}${eol}${spelled.text.slice(at)} igen`;
        const alone = run(frameOf(cell("\n"))).output.replace(/\r\n/g, "\n");
        const doubled = run(frameOf(cell("\r\n"))).output.replace(/\r\n/g, "\n");
        if (alone !== doubled) found.push(`${family} | ${JSON.stringify(spelled.text.slice(0, at))} / ${JSON.stringify(spelled.text.slice(at))}`);
      }
    }
  }
  return found;
}

describe("a line break of two characters inside a quoted cell does to a number what a line break of one does, at every place it can be cut (X1b)", () => {
  it("a personnummer", () => {
    expect(cellBreakDiffers("pnr cell", some(54, 6, (rand) => personnummer(rand, { separators: [...PNR_SEPARATORS_KNOWN, ...PNR_SEPARATORS_NEW], invisibles: false })))).toEqual([]);
  });

  it("a TF number", () => {
    expect(cellBreakDiffers("tf cell", some(55, 6, (rand) => tfNumber(rand, { invisibles: false })))).toEqual([]);
  });

  it("a telephone number", () => {
    expect(cellBreakDiffers("tel cell", some(56, 6, (rand) => telephone(rand, { wide: true })))).toEqual([]);
  });

  it("and a number with no separator the break can crowd out, cut anywhere, is found whichever the break is", () => {
    const plain = some(57, 6, (rand) => personnummer(rand, { separators: ["-", "+", ""], invisibles: false })).filter((spelled) => /^[0-9]{6}(?:[0-9]{2})?[-+]?[0-9]{4}$/.test(spelled.text));
    expect(plain.length).toBeGreaterThan(0);
    const leaks: string[] = [];
    for (const spelled of plain) {
      for (let at = 1; at < spelled.text.length; at += 1) {
        // Not between the last four and not right after the separator's side: the cuts a blank can stand at in a number (the shape takes a blank between any two digits of the date and next to the hyphen).
        for (const eol of BREAKS) {
          const out = run(`Klass;Notis\r\n7A;${quote(`Se ${spelled.text.slice(0, at)}${eol}${spelled.text.slice(at)} igen`)}\r\n7B;ok\r\n7C;ok\r\n7D;ok\r\n`).output;
          if (leaked(out, spelled.hides)) leaks.push(`${JSON.stringify(eol)} ${JSON.stringify(spelled.text.slice(0, at))} / ${JSON.stringify(spelled.text.slice(at))}`);
        }
      }
    }
    // A break inside the last four is one the shape does not take with one character either, and those are the ones left (the comparison above says the two kinds are alike).
    const insideLastFour = (line: string): boolean => /\/ "[0-9]{1,3}"$/.test(line);
    expect(leaks.filter((line) => !insideLastFour(line))).toEqual([]);
  });
});

describe("a number cut by a line break in running text is found at every place it can be cut", () => {
  it("a TF number", () => {
    expect(brokenLeaks("tf broken", some(51, 6, (rand) => tfNumber(rand, { invisibles: false })))).toEqual([]);
  });

  it("a personnummer", () => {
    expect(brokenLeaks("pnr broken", some(52, 6, (rand) => personnummer(rand, { separators: [...PNR_SEPARATORS_KNOWN, ...PNR_SEPARATORS_NEW], invisibles: false })))).toEqual([]);
  });

  it("a telephone number", () => {
    expect(brokenLeaks("tel broken", some(53, 6, (rand) => telephone(rand, { wide: true })))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// One value, one marker
// ---------------------------------------------------------------------------

const MARKER_OF_A_VALUE = /(?:PNR|SAM|TF|TEL)-\d{4}|epost-\d{4}@exempel\.invalid/g;

/** The markers in a safe file, by the order they stand in. */
const markersIn = (text: string): string[] => [...text.matchAll(MARKER_OF_A_VALUE)].map((m) => m[0]);

describe("one value, one marker, however each was written", () => {
  const twice = (family: string, make: (rand: Rng) => { a: string; b: string }): string[] => {
    const rand = rng(61);
    const bad: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const { a, b } = make(rand);
      // In a text that is not a table: a column that is mostly addresses is marked whole by the page, by its whole cell, and that is not what is asked here.
      const output = run(`Brev till vårdnadshavare;a\r\nSe ${a} nu\r\nTack;för;hjälpen;nu\r\nVälkommen;igen\r\nMed vänlig hälsning;skolan;rektor;Ma\r\nOch ${b} igen\r\n`).output;
      const found = markersIn(output);
      if (found.length !== 2 || found[0] !== found[1]) bad.push(`${family} | ${JSON.stringify(a)} and ${JSON.stringify(b)} became ${JSON.stringify(found)}`);
    }
    return bad;
  };

  it("a personnummer in a spelling the page did not take and in one it did", () => {
    expect(
      twice("pnr", (rand) => {
        const date = pad2(rand.int(100)) + pad2(1 + rand.int(12)) + pad2(1 + rand.int(28));
        const last = digits(rand, 4);
        return { a: withInvisibles(rand, `${date}${rand.pick(PNR_SEPARATORS_NEW)}${last}`), b: `${rand.pick(["", "19"])}${date}${rand.pick(["-", "+"])}${last}` };
      }),
    ).toEqual([]);
  });

  it("a telephone number with no plus and the same one with a plus and with a 0", () => {
    expect(
      twice("tel", (rand) => {
        const national = `7${rand.pick(["0", "2", "3", "6", "9"])}${digits(rand, 7)}`;
        return { a: rand.pick([`46${national}`, `46 ${national.slice(0, 2)} ${national.slice(2, 5)} ${national.slice(5)}`, `0${national.slice(0, 2)}.${national.slice(2, 5)}.${national.slice(5, 7)}.${national.slice(7)}`]), b: rand.pick([`+46${national}`, `0${national.slice(0, 2)}-${national.slice(2)}`]) };
      }),
    ).toEqual([]);
  });

  it("an address in quotes and the same one without", () => {
    expect(
      twice("address", (rand) => {
        const local = `${letters(rand, 6)}.${letters(rand, 6)}`;
        const domain = `${letters(rand, 6)}.se`;
        return { a: `"${local}"@${domain}`, b: `${local.toUpperCase()}@${domain}` };
      }),
    ).toEqual([]);
  });

  it("a TF number cut by a line break in running text and the same one whole", () => {
    const rand = rng(62);
    const bad: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const date = `19${pad2(rand.int(100))}${pad2(1 + rand.int(12))}${pad2(1 + rand.int(28))}`;
      const nn = pad2(1 + rand.int(98));
      const output = run(`Brev om eleven\r\nVi har noterat att eleven med id ${date}\r\nTF${nn} inte har kommit idag.\r\nHälsningar skolan\r\nOch ${date}TF${nn} igen.\r\n`).output;
      const found = markersIn(output);
      if (found.length !== 2 || found[0] !== found[1]) bad.push(`${date}TF${nn} became ${JSON.stringify(found)}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What is not a number is left alone
// ---------------------------------------------------------------------------

/** Strings no person's number is written as. Every one is kept as it stands: a false hit costs a marker where a school did not want one, and a timetable of them is a ruined file. */
const HARMLESS = [
  // course codes
  "MATMAT01", "ENGENG06", "SVASVA01", "TEKTEK01", "MA1c", "NAKNAK01", "7ATF12", "NV20TF12", "TE21TF 12", "SA19 TF 12", "Ma7 TF12", "TF2026", "TFTF1234", "MA1c:2", "Ma 1:1234", "SA:1234",
  // rooms
  "Sal 2026 TF 12", "Sal TF12", "TF-salen 12", "B 12 TF", "Rum 1900 0101 A", "Hus 12 TF 12", "Aula TF 20261121", "TF 20261121 12", "Sal 20 TF 12", "Gymnastiksal TF 01", "Sal A:101", "Sal 4,2",
  // ids
  "d2f3a1b4-5c6d-4e7f-8a9b-0c1d2e3f4a5b", "L20261121T0810", "UUID 12345678-1234-1234-1234-123456789abc", "e0d1c2b3a4f5061728394a5b6c7d8e9f", "2026112108100910", "ts=1763712000000",
  "a7c9e1f3-0b2d-4f68-9a1b-3c5d7e9f1a2b", "4b8e2c6a-90f1-4d3e-8c7b-2a5f9d1e3b60",
  // dates with text after, and clock times
  "2026-11-21 Tis", "2026-11-21 Torsdag 12", "2026-11-21 Fre 08:10", "2026-11-21 Tfn 12", "2026-11-21 Tis-Fre 12", "Sat 2026-11-21 Fri 12", "2026-11-21 Fredag 12", "2026-11-21 tor fre",
  "Tors 2026-11-26 Fre 12", "17/8 2026 Tf 12", "2026 08 17 Tfn 1", "2026-08-17 - 2026-12-18", "2026-08-17 till 2026-12-18 tf", "08:10-09:10 TF 12", "Vecka 47 TF 12 Sal 4", "2026 vecka 47 tf 12",
  "10:12:15 1234", "08:10:00", "12:30,45", "kl. 08:10, 09:10", "2026-11-21 08:10:15", "07.08.2026", "17.8.2026",
  // numbers
  "Betyg 5,0", "Pris 1234,56", "0.1234567", "1.234.567", "1.5.2026", "v1.2.3.4", "10.0.0.1", "192.168.0.1", "Tfn 2026 11 21", "IP 010.001.002.003x",
  // a 46 that is no country code, and short digit runs
  "46 elever", "Ma 46", "Klass 46 70", "id 46123", "461234567", "Sal 4612 3456", "4670", "12 46 70 1", "Hej 46 hej",
  // quotes and addresses that are none
  "Han sa \"hej\" och gick", "Citat \"Hej\" @ här", "mail till mig @ skolan", "Hej @alla", "anna@",
];

describe("nothing harmless is taken for a number", () => {
  it.each(HARMLESS)("%s", (cell) => {
    // The page writes a cell with a comma, a quote or a semicolon in quotes: the same cell, written the way a file writes it.
    const written = /[;,"\r\n]/.test(cell) ? quote(cell) : cell;
    const text = `Klass;Notis\r\n7A;${written}\r\n`;
    expect(run(text).output).toBe(text);
  });
});
