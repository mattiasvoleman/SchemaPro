import { describe, expect, it } from "vitest";
import { decodeCsvBytes } from "@/lib/csv-encoding";
import { readTable } from "@/lib/column-table";
import { findPersonalNumbers } from "@/lib/personal-number";
import { findPersonalData, luhnHolds } from "@/lib/pseudonym-detect";
import { KEEP, mark } from "@/lib/pseudonym-headers";
import { parseSource, parseText, type ParsedInput } from "@/lib/pseudonym-input";
import { pseudonymise, type RunResult } from "@/lib/pseudonym-run";
import { encodeText, type LineEnding, type OutputEncoding } from "@/lib/pseudonym-write";

/*
 * Property tests with a seeded generator (no new package: the disk and the install rule), as lib/column-mapping.property.test.ts
 * has them. Each property runs over ROUNDS random runs; the seed is in the test's name and the failing round says which it was.
 * Every person here is INVENTED: names from a list of first names and surnames, numbers made from random digits with a check digit.
 *
 * THE PROPERTIES.
 *   1. STABILITY. However a person's personnummer, address, telephone number and name are written (with and without century,
 *      with a hyphen, a plus, a blank or nothing, full-width digits, in capitals or small letters, +46 or 0), in any file of the
 *      run, they have ONE marker, and two persons never share one.
 *   2. NOTHING SURVIVES. After the run, in the bytes of every file as a program decodes them: no personnummer, address or telephone number,
 *      and no known name in running text, wherever they stood: in a column the header names, in a column the user kept, in the
 *      text of a cell, in a quoted cell with a delimiter in it, above the header, in the header row, in any encoding, line ending and delimiter.
 *   3. THE STRUCTURE STAYS. The same rows on the same row numbers, the same columns, kept cells that held nothing personal unchanged.
 *   4. THE FORM STAYS. Delimiter, line ending, byte order mark and encoding are read back from the safe file as they were read from the original.
 *   5. RUNNING IT AGAIN CHANGES NOTHING.
 *   6. THE TF NUMBER (Skola24's ÅÅÅÅMMDDTFnn, X3's door of 2026-11-22). Properties 1, 2 and 5 again for it: one marker (TF-nnnn) per number in every spelling
 *      the door counts and in every place it stands, nothing of it left (the date's eight digits least of all), and the second run changes nothing; and the
 *      counts: TF is its own kind in the report, never a personnummer and never a number whose check digit does not hold.
 */

const ROUNDS = 250;
/** 250 rounds of a run each is seconds, not milliseconds: 5 s (vitest's default) is 2.5 times what the CI runner needs and less than a busy laptop does. */
const SLOW = 60_000;

/** mulberry32: a small, good PRNG from a 32-bit seed. */
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
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
  const bool = (p = 0.5): boolean => next() < p;
  return { next, int, pick, bool };
}
type Rng = ReturnType<typeof rng>;

// ---------------------------------------------------------------------------
// Invented people
// ---------------------------------------------------------------------------

const FIRST = ["Anna", "Åke", "Cia", "Dan", "Eva", "Ida", "Jonas", "Kim", "Lena", "Märta", "Nils", "Olle", "Pia", "Rut", "Sven", "Tor", "Ulla", "Vera", "Yngve", "Elin"];
const LAST = ["Svensson", "Lindgren", "Åkesson", "Öberg", "Holmström", "Nyberg", "Dahlin", "Strandberg", "Falk", "Roos"];
/** Words that are not names, for the text round the people. */
const WORDS = ["ringde", "sjuk", "idag", "ska", "till", "skolan", "imorgon", "kommer", "sent", "behöver", "hjälp", "med", "provet"];

interface Person {
  id: number;
  first: string;
  last: string;
  /** Ten digits, the last with its check digit. */
  ten: string;
  century: "19" | "20";
  phone: string;
}

function checkDigitOf(nine: string): string {
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let d = nine.charCodeAt(i) - 48;
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

function people(r: Rng, count: number, samordning: boolean): Person[] {
  const used = new Set<string>();
  const out: Person[] = [];
  for (let id = 0; id < count; id += 1) {
    let ten: string;
    let century: "19" | "20";
    do {
      const year = 1950 + r.int(66);
      century = year < 2000 ? "19" : "20";
      const month = 1 + r.int(12);
      const day = 1 + r.int(28) + (samordning && r.bool(0.2) ? 60 : 0);
      const nine = `${String(year % 100).padStart(2, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}${String(r.int(1000)).padStart(3, "0")}`;
      ten = nine + checkDigitOf(nine);
    } while (used.has(ten));
    used.add(ten);
    // A mobile number whose bare spelling could be read as a personnummer (a date, a check digit that holds) is the one case where two spellings of one
    // number may be two kinds (pseudonym-detect.ts); the generator keeps its numbers out of it so that the property is about spellings.
    let phone: string;
    do phone = `07${r.int(10)}${String(r.int(10_000_000)).padStart(7, "0")}`;
    while (luhnHolds(phone));
    out.push({ id, first: FIRST[id % FIRST.length]!, last: LAST[Math.floor(id / FIRST.length) % LAST.length]!, ten, century, phone });
  }
  return out;
}

const FULLWIDTH = (digits: string): string => digits.replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));

/** One of the ways a school writes a personnummer. */
function spellPnr(p: Person, r: Rng): string {
  const { ten, century } = p;
  const date = ten.slice(0, 6);
  const tail = ten.slice(6);
  const forms = [
    `${date}-${tail}`,
    `${century}${date}-${tail}`,
    ten,
    `${century}${ten}`,
    `${date} ${tail}`,
    `${date}+${tail}`,
    `${century}${date} ${tail}`,
    `${century}${date.slice(0, 2)}-${date.slice(2, 4)}-${date.slice(4)}-${tail}`,
    FULLWIDTH(`${century}${date}`) + "－" + FULLWIDTH(tail),
  ];
  return r.pick(forms);
}

function spellPhone(p: Person, r: Rng): string {
  const d = p.phone;
  return r.pick([`${d.slice(0, 3)}-${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`, `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`, `+46 ${d.slice(1, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}`, `+46${d.slice(1)}`, `0046${d.slice(1)}`, d.slice(0, 3) + "-" + d.slice(3)]);
}

function spellEmail(p: Person, r: Rng): string {
  const address = `${p.first}.${p.last}@skola${p.id % 3}.se`;
  return r.pick([address, address.toLowerCase(), address.toUpperCase(), `mailto:${address}`]);
}

function spellName(p: Person, r: Rng): string {
  const full = `${p.first} ${p.last}`;
  return r.pick([full, full.toUpperCase(), full.toLowerCase(), `${p.first}  ${p.last}`, ` ${full} `]);
}

// ---------------------------------------------------------------------------
// Tables of them
// ---------------------------------------------------------------------------

interface Form {
  delimiter: ";" | "," | "\t";
  eol: LineEnding;
  encoding: OutputEncoding;
  bom: boolean;
  finalEol: boolean;
}

const randomForm = (r: Rng): Form => {
  const encoding = r.pick<OutputEncoding>(["UTF-8", "UTF-8", "Windows-1252"]);
  return { delimiter: r.pick([";", ",", "\t"] as const), eol: r.pick<LineEnding>(["\r\n", "\n", "\r"]), encoding, bom: encoding === "UTF-8" && r.bool(0.4), finalEol: r.bool(0.7) };
};

const quote = (cell: string, form: Form): string => (/[";,\t\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

const HEADERS = ["Namn", "Personnummer", "E-post", "Telefon", "Klass", "Ämne", "Info"] as const;

/**
 * Text with persons in it, and words that are not names. The digits of every personnummer and telephone number it puts in are pushed
 * on `secrets`, so that a property can look for a FRAGMENT of one in the output: the last bugs found left the end of a number, which is no number.
 */
function sentence(r: Rng, ps: Person[], secrets: string[] = []): string {
  const parts: string[] = [];
  const total = 2 + r.int(4);
  for (let i = 0; i < total; i += 1) {
    const roll = r.int(6);
    const p = r.pick(ps);
    if (roll === 0) parts.push(r.pick([p.first, p.first.toUpperCase(), p.first.toLowerCase(), `${p.first}s`, p.last, `${p.last}s`]));
    else if (roll === 1) {
      parts.push(spellPnr(p, r));
      secrets.push(p.ten);
    } else if (roll === 2) parts.push(spellEmail(p, r));
    else if (roll === 3) {
      parts.push(spellPhone(p, r));
      secrets.push(p.phone);
    } else parts.push(r.pick(WORDS));
  }
  return parts.join(" ");
}

interface Generated {
  /** The text of the file, before encoding. */
  text: string;
  form: Form;
  /** Per row: the person, and the cells as written (Namn, Personnummer, E-post, Telefon, Klass, Ämne, Info), and the digits of every number in them. */
  rows: { person: Person; cells: string[]; secrets: string[] }[];
  /** The row number of the header. */
  headerRow: number;
  titleRows: string[];
  /** The digits of the numbers in the title row. */
  titleSecrets: string[];
}

function generate(r: Rng, ps: Person[], rowCount: number, form: Form): Generated {
  const titleRows: string[] = [];
  const titleSecrets: string[] = [];
  const lines: string[] = [];
  if (r.bool(0.6)) {
    const p = r.pick(ps);
    const withNumber = r.bool(0.5);
    const title = withNumber ? `Rapport för ${p.first} ${p.last} ${spellPnr(p, r)}` : r.pick([`Skola ${p.id}`, `Kontakt ${spellEmail(p, r)}`]);
    if (withNumber) titleSecrets.push(p.ten);
    titleRows.push(title);
    lines.push(quote(title, form) + form.delimiter + quote("sida 1", form));
  }
  const headerRow = lines.length + 1;
  lines.push(HEADERS.map((h) => quote(h, form)).join(form.delimiter));
  const rows: Generated["rows"] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const person = r.pick(ps);
    const secrets = [person.ten, person.phone];
    const cells = [
      spellName(person, r),
      spellPnr(person, r),
      spellEmail(person, r),
      spellPhone(person, r),
      `7${r.pick(["A", "B", "C"])}`,
      r.pick(["Svenska", "Idrott och hälsa", "Matematik", "Bild", "Engelska"]),
      sentence(r, ps, secrets),
    ];
    // A blank row, now and then: it keeps its number.
    if (r.bool(0.1)) lines.push("");
    rows.push({ person, cells, secrets });
    lines.push(cells.map((c) => quote(c, form)).join(form.delimiter));
  }
  const text = lines.join(form.eol) + (form.finalEol ? form.eol : "");
  return { text, form, rows, headerRow, titleRows, titleSecrets };
}

async function inputOf(g: Pick<Generated, "text" | "form">): Promise<ParsedInput> {
  const encoded = encodeText(g.text, g.form.encoding, g.form.bom);
  const parsed = await parseSource({ file: new File([encoded.bytes as unknown as BlobPart], "x.csv") });
  if (!parsed.ok) throw new Error(`the generated file was not read: ${parsed.reason}`);
  return parsed.inputs[0]!;
}

/** The marker text left in a cell once the markers are taken out: what a search of the output must not find anything in. */
const MARKERS = /\b(?:PNR|SAM|TF|TEL|NAMN|FORNAMN|EFTERNAMN|SIGN|TEXT)-\d{4,}\b|\bepost-\d{4,}@exempel\.invalid/gi;

const DECODED = (bytes: Uint8Array): string => {
  const decoded = decodeCsvBytes(bytes);
  if (decoded.problem !== null) throw new Error(decoded.problem);
  return decoded.text;
};

const run = (inputs: ParsedInput[]): Extract<RunResult, { ok: true }> => {
  const result = pseudonymise(inputs, { files: inputs.map(() => ({ treatments: { 6: KEEP } })) });
  if (!result.ok) throw new Error(`undecided: ${JSON.stringify(result.undecided)}`);
  return result;
};

// ---------------------------------------------------------------------------
// 1. Stability
// ---------------------------------------------------------------------------

describe("property 1: a person is one marker, however they are written, in every file of a run (seed 1301)", () => {
  it("gives every spelling of a person's personnummer, address, number and name one marker, and two persons never one", { timeout: SLOW }, async () => {
    const r = rng(1301);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = people(r, 6 + r.int(24), true);
      const files = 1 + r.int(3);
      const generated = Array.from({ length: files }, () => generate(r, ps, 3 + r.int(10), randomForm(r)));
      const result = run(await Promise.all(generated.map(inputOf)));

      // Column 0 Namn, 1 Personnummer, 2 E-post, 3 Telefon: the marker each person got, in each.
      const byPerson = [0, 1, 2, 3].map(() => new Map<number, string>());
      const byMarker = [0, 1, 2, 3].map(() => new Map<string, number>());
      generated.forEach((g, f) => {
        const out = readTable(DECODED(result.files[f]!.bytes));
        const body = out.rows.slice(out.rowNumbers.indexOf(g.headerRow) + 1);
        expect(body.length, `round ${round}`).toBe(g.rows.length);
        g.rows.forEach((row, i) => {
          [0, 1, 2, 3].forEach((c) => {
            // Blanks round a name are kept as they were; the marker is what stands between them.
            const marker = body[i]![c]!.trim();
            const known = byPerson[c]!.get(row.person.id);
            if (known === undefined) byPerson[c]!.set(row.person.id, marker);
            else expect(marker, `round ${round}: person ${row.person.id} column ${c}: "${row.cells[c]}"`).toBe(known);
            const owner = byMarker[c]!.get(marker);
            if (owner === undefined) byMarker[c]!.set(marker, row.person.id);
            else expect(owner, `round ${round}: marker ${marker} in column ${c} stands for two persons`).toBe(row.person.id);
          });
        });
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Nothing survives
// ---------------------------------------------------------------------------

/** Every ten-digit number the people have, and the digits of each as a program would write them. */
const digitsOf = (ps: Person[]): string[] => ps.map((p) => p.ten);

describe("property 2: no personnummer, address, number or known name survives (seed 2302)", () => {
  it("leaves nothing a search finds, in the decoded bytes of any file, wherever it stood and however it was written", { timeout: SLOW }, async () => {
    const r = rng(2302);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = people(r, 4 + r.int(20), true);
      const generated = Array.from({ length: 1 + r.int(2) }, () => generate(r, ps, 3 + r.int(10), randomForm(r)));
      const result = run(await Promise.all(generated.map(inputOf)));
      expect(result.check, `round ${round}`).toEqual({ passed: true, failures: [] });

      // The names that are KNOWN: those of the persons who stand in a name column of the run. A person who is only mentioned in text is not known, and stays.
      const known = new Set(generated.flatMap((g) => g.rows.map((row) => row.person)));
      const tokens = [...new Set([...known].flatMap((p) => [p.first, p.last]).filter((t) => t.length >= 3))];
      generated.forEach((g, f) => {
        const text = DECODED(result.files[f]!.bytes);
        const where = `round ${round}, file ${f}`;

        // By shape, cell by cell: the output cells, markers taken out.
        for (const row of readTable(text).rows) {
          for (const cell of row) {
            const bare = cell.replace(MARKERS, " ");
            expect(findPersonalNumbers(bare), `${where}: "${cell}"`).toEqual([]);
            expect(findPersonalData(bare), `${where}: "${cell}"`).toEqual([]);
          }
        }
        // By fragment, row by row: no six-digit tail of any personnummer or telephone number put into a row is left in that row's cells (the end of a number is no number).
        const out = readTable(text);
        const body = out.rows.slice(out.rowNumbers.indexOf(g.headerRow) + 1);
        g.rows.forEach((row, i) => {
          const digitsOfRow = body[i]!.join(" ").replace(MARKERS, " ").replace(/\D/g, "");
          for (const secret of row.secrets) expect(digitsOfRow, `${where}, row ${i}: the end of ${secret.slice(0, 2)}…`).not.toContain(secret.slice(-6));
        });
        if (g.titleSecrets.length > 0) {
          const title = out.rows[out.rowNumbers.indexOf(g.headerRow) - 1]!.join(" ").replace(MARKERS, " ").replace(/\D/g, "");
          for (const secret of g.titleSecrets) expect(title, `${where}, title`).not.toContain(secret.slice(-6));
        }
        // By value, over everything: not one of the numbers' digits in order, and not an address's local part.
        const digits = text.replace(MARKERS, " ").replace(/\D/g, "");
        for (const ten of digitsOf(ps)) expect(digits, `${where}: ${ten.slice(0, 2)}…`).not.toContain(ten);
        expect(text.replace(MARKERS, " ").toLowerCase(), where).not.toMatch(/@skola\d\.se|mailto:/);
        // Known names are not left in text of two words or more (a cell of one word is a code or a name in its own column, and is replaced there).
        const rows = readTable(text).rows;
        const infoColumn = rows.map((row) => row[6] ?? "");
        for (const cell of infoColumn) {
          const bare = cell.replace(MARKERS, " ");
          if ((bare.match(/[\p{L}]{2,}/gu) ?? []).length < 2) continue;
          for (const token of tokens) {
            expect(new RegExp(`(^|[^\\p{L}])${token}s?($|[^\\p{L}])`, "iu").test(bare), `${where}: ${token} in "${cell}"`).toBe(false);
          }
        }
      });
    }
  });

  it("holds when the personnummer is in the header row, and in a column no header names and the user kept, and in a title above", async () => {
    const r = rng(2303);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = people(r, 3 + r.int(8), true);
      const p = r.pick(ps);
      const header = `Elev ${spellPnr(p, r)}`;
      const lines = [`Utskrift ${spellPnr(r.pick(ps), r)};sida`, `Klass;${header};Zz`];
      for (let i = 0; i < 4; i += 1) lines.push(`7A;${spellPnr(r.pick(ps), r)};${sentence(r, ps)}`);
      const parsed = parseText(lines.join("\n") + "\n", "file", "UTF-8", false)!;
      const result = pseudonymise([parsed], { files: [{ treatments: { 0: KEEP, 2: KEEP } }] });
      if (!result.ok) throw new Error(`round ${round}: ${JSON.stringify(result.undecided)}`);
      for (const ten of digitsOf(ps)) expect(result.files[0]!.text.replace(/\D/g, ""), `round ${round}`).not.toContain(ten);
      expect(result.check.passed).toBe(true);
    }
  });

  it("holds for a text that is not a table, line by line, with the user's words for the names", () => {
    const r = rng(2304);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = people(r, 3 + r.int(6), true);
      const lines = Array.from({ length: 3 + r.int(6) }, () => sentence(r, ps));
      const parsed: ParsedInput = {
        facts: { origin: "file", encoding: "UTF-8", bom: false, eol: "\n", finalEol: true, delimiter: null, sheet: null, unterminated: false },
        body: { shape: "lines", lines: [...lines, ""] },
      };
      const result = pseudonymise([parsed], { words: ps.map((p) => `${p.first} ${p.last}`), files: [{}] });
      if (!result.ok) throw new Error(`round ${round}: undecided ${JSON.stringify(result.undecided)}`);
      const text = result.files[0]!.text.replace(MARKERS, " ");
      for (const ten of digitsOf(ps)) expect(result.files[0]!.text.replace(/\D/g, ""), `round ${round}`).not.toContain(ten);
      expect(findPersonalData(text), `round ${round}`).toEqual([]);
      for (const p of ps) {
        for (const token of [p.first, p.last]) expect(new RegExp(`(^|[^\\p{L}])${token}s?($|[^\\p{L}])`, "iu").test(text), `round ${round}: ${token}`).toBe(false);
      }
      expect(result.check.passed, `round ${round}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3, 4, 5. Structure, form, and running it again
// ---------------------------------------------------------------------------

describe("property 3 and 4: the structure and the form of the file stay (seed 3303)", () => {
  it("keeps the rows on their numbers, the columns, kept cells and empty ones as they were, and the delimiter, line ending, byte order mark and encoding", { timeout: SLOW }, async () => {
    const r = rng(3303);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = people(r, 4 + r.int(12), false);
      const g = generate(r, ps, 3 + r.int(10), randomForm(r));
      const input = await inputOf(g);
      const result = run([input]);
      const where = `round ${round}`;

      const before = input.body.shape === "table" ? input.body : null;
      expect(before, where).not.toBeNull();
      const parsed = await parseSource({ file: new File([result.files[0]!.bytes as unknown as BlobPart], "y.csv") });
      if (!parsed.ok) throw new Error(`${where}: the safe file was not read: ${parsed.reason}`);
      const after = parsed.inputs[0]!;
      // The form.
      expect(after.facts, where).toMatchObject({ delimiter: input.facts.delimiter, eol: input.facts.eol, bom: input.facts.bom, encoding: input.facts.encoding, finalEol: input.facts.finalEol });
      // The rows, on their numbers, and as wide as they were.
      if (after.body.shape !== "table") throw new Error(`${where}: the safe file is not a table`);
      expect(after.body.rowNumbers, where).toEqual(before!.rowNumbers);
      expect(after.body.rows.map((row) => row.length), where).toEqual(before!.rows.map((row) => row.length));
      // Klass (column 4) and Ämne (column 5) held nothing personal and are as they were.
      const headerAt = before!.rowNumbers.indexOf(g.headerRow);
      for (let i = headerAt + 1; i < before!.rows.length; i += 1) {
        expect(after.body.rows[i]![4], where).toBe(before!.rows[i]![4]);
        expect(after.body.rows[i]![5], where).toBe(before!.rows[i]![5]);
      }
      // The header row, whose words are structure and names of columns.
      expect(after.body.rows[headerAt], where).toEqual(before!.rows[headerAt]);
    }
  });
});

describe("property 5: running the safe file through again changes nothing (seed 5305)", () => {
  it("gives the same text the second time, with the same choices", { timeout: SLOW }, async () => {
    const r = rng(5305);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = people(r, 4 + r.int(12), false);
      const g = generate(r, ps, 3 + r.int(10), { ...randomForm(r), encoding: "UTF-8", bom: false });
      const first = run([await inputOf(g)]);
      const again = run([parseText(first.files[0]!.text, "file", "UTF-8", false)!]);
      expect(again.files[0]!.text, `round ${round}`).toBe(first.files[0]!.text);
    }
  });
});


// ---------------------------------------------------------------------------
// 6. The TF number
// ---------------------------------------------------------------------------

/** A person with an invented TF number: eight digits of a date and two after TF (Skola24 writes ÅÅÅÅMMDDTFnn). It has no check digit and is no personnummer. */
interface TfPerson extends Person {
  tfDate: string;
  tfNo: string;
}

/** The persons of a run, each with a TF number of their own. The numbers come from the generator of this property alone, so that no earlier property's data moves. */
function tfPeople(r: Rng, count: number): TfPerson[] {
  const used = new Set<string>();
  return people(r, count, false).map((p) => {
    let date: string;
    let no: string;
    do {
      date = `${1960 + r.int(60)}${String(1 + r.int(12)).padStart(2, "0")}${String(1 + r.int(28)).padStart(2, "0")}`;
      no = String(1 + r.int(99)).padStart(2, "0");
    } while (used.has(date + no));
    used.add(date + no);
    return { ...p, tfDate: date, tfNo: no };
  });
}

/** What may stand between the date and TF, and the letters, as the door counts them (the case of TF is free; one blank or hyphen at most; the dash-like and invisible are folded first). */
const TF_BETWEEN = ["", "", "", "-", " ", "/", "_", ".", " ", "​", "–"] as const;
/** The letters in any case, and full-width as the digits can be (the door folds both: the TF PR's review, 2026-11-22). */
const TF_LETTERS = ["TF", "TF", "tf", "Tf", "tF", "ＴＦ", "ｔｆ"] as const;

/**
 * What may stand in the spellings only the pseudonymiser's wide search counts (lib/pseudonym-detect.ts, findLooseTfNumbers; the follow-up to the TF PR): one or two blanks or hyphens
 * between year, month and day, up to four blanks, hyphens or a plus before TF, a line break, and up to four blanks or hyphens between TF and the two digits.
 */
const TF_DATE_GAP = ["", "-", " ", ".", "/", "  "] as const;
const TF_BEFORE_WIDE = ["", " ", "-", "+", "  ", " - ", "\u00a0", "\r\n", "\t", " +"] as const;
const TF_AFTER_WIDE = ["", " ", "-", " - ", "  ", "\r\n", "\u00a0"] as const;

/** One of the spellings of a TF number: the door's (the case, the separator, full-width digits), and now and then one only the pseudonymiser's wide search counts. */
function spellTf(p: TfPerson, r: Rng): string {
  const wide = r.bool(0.15);
  const digits = (d: string): string => (wide ? FULLWIDTH(d) : d);
  if (r.bool(0.35)) {
    const date = `${digits(p.tfDate.slice(0, 4))}${r.pick(TF_DATE_GAP)}${digits(p.tfDate.slice(4, 6))}${r.pick(TF_DATE_GAP)}${digits(p.tfDate.slice(6))}`;
    return `${date}${r.pick(TF_BEFORE_WIDE)}${r.pick(TF_LETTERS)}${r.pick(TF_AFTER_WIDE)}${digits(p.tfNo)}`;
  }
  return `${digits(p.tfDate)}${r.pick(TF_BETWEEN)}${r.pick(TF_LETTERS)}${digits(p.tfNo)}`;
}

/** The TF markers of a text, in order. */
const tfMarkersIn = (text: string): string[] => text.match(/TF-\d{4,6}/g) ?? [];

interface TfRow {
  /** The persons whose TF numbers stand in the cells, as written: the child's, the guardian's, and those the note mentions, in the order they stand. */
  child: TfPerson;
  guardian: TfPerson;
  mentioned: TfPerson[];
  /** Whether the id column holds the child's personnummer (a mixed column) and not the child's TF number. */
  idIsPnr: boolean;
  cells: string[];
}

interface TfFile {
  text: string;
  form: Form;
  rows: TfRow[];
  /** The header row's number, or null for a file like Skola24's course files that has none. */
  headerRow: number | null;
}

/** A note with TF numbers in it, among words and names, and now and then with letters stuck to the number: "ID19800101TF01", "19800101TF01x". */
function tfNote(r: Rng, ps: TfPerson[], mentioned: TfPerson[]): string {
  const parts: string[] = [];
  for (let i = 0, total = 2 + r.int(4); i < total; i += 1) {
    const roll = r.int(5);
    if (roll === 0 || roll === 1) {
      const p = r.pick(ps);
      mentioned.push(p);
      parts.push(r.pick([spellTf(p, r), spellTf(p, r), `ID${spellTf(p, r)}`, `${spellTf(p, r)}x`, `Se ${spellTf(p, r)}.`]));
    } else if (roll === 2) parts.push(r.pick(FIRST));
    else parts.push(r.pick(WORDS));
  }
  return parts.join(" ");
}

function tfFile(r: Rng, ps: TfPerson[], rowCount: number, form: Form, withHeader: boolean, mixed: boolean): TfFile {
  const lines: string[] = [];
  let headerRow: number | null = null;
  if (withHeader) {
    headerRow = 1;
    lines.push([r.pick(["Id", "Elev", "Nummer", "Klass"]), "Kod", "Förnamn", "Efternamn", "Anteckning"].map((h) => quote(h, form)).join(form.delimiter));
  }
  const rows: TfRow[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const child = r.pick(ps);
    const guardian = r.pick(ps);
    const mentioned: TfPerson[] = [];
    const idIsPnr = mixed && r.bool(0.4);
    // Now and then the number has text round it in its cell ("ID 19000101TF01", "19000101TF01 (kopia)"): the cell of a personnummer column is then replaced whole, and
    // the number in it must still have the marker it has on its own, TF-nnnn (the TF PR's review found a second marker, PNR-nnnn, there). No digit in the text.
    const withText = (cell: string): string => (r.bool(0.2) ? r.pick([`ID ${cell}`, `${cell} (kopia)`, `Elev ${cell} vikarie`]) : cell);
    const cells = [idIsPnr ? spellPnr(child, r) : withText(spellTf(child, r)), withText(spellTf(guardian, r)), child.first, child.last, tfNote(r, ps, mentioned)];
    rows.push({ child, guardian, mentioned, idIsPnr, cells });
    lines.push(cells.map((c) => quote(c, form)).join(form.delimiter));
  }
  const text = lines.join(form.eol) + (form.finalEol ? form.eol : "");
  // A hard blank and an en dash are ONE byte each in Windows-1252 (0xA0, 0x96). In a file whose only bytes above 127 are those, the reader's guess at the encoding
  // (lib/csv-encoding.ts, which counts readable letters) has nothing to go on and may read them as Mac Roman (a dagger, ñ), which is no separator: the number is then
  // not a TF number. That is the reader's, not the TF number's; a file with any å, ä or ö in it is read right. The generator keeps these two out of that guess.
  return { text, form: /[ –]/.test(text) ? { ...form, encoding: "UTF-8" } : form, rows, headerRow };
}

/** The choices for a file of that kind: the user decides the columns the header or the content cannot, and says there is no header row when there is none. */
const tfChoices = (f: TfFile) => ({
  headerRow: f.headerRow,
  treatments: { 0: mark("pnr"), 1: mark("pnr"), 2: mark("fornamn"), 3: mark("efternamn"), 4: KEEP },
});

/** The body rows of a safe file, whatever the form: the rows after the header, or all of them. */
const bodyRowsOf = (text: string, f: TfFile) => {
  const out = readTable(text);
  return out.rows.slice(f.headerRow === null ? 0 : out.rowNumbers.indexOf(f.headerRow) + 1);
};

const tfRun = async (files: TfFile[]): Promise<Extract<RunResult, { ok: true }>> => {
  const inputs = await Promise.all(files.map(inputOf));
  const result = pseudonymise(inputs, { files: files.map(tfChoices) });
  if (!result.ok) throw new Error(`undecided: ${JSON.stringify(result.undecided)}`);
  return result;
};

describe("property 6: a TF number is one marker, and nothing of it is left (seed 6306)", () => {
  it("gives a number one TF-nnnn however it is written, in every column, note and file, and two numbers never one", { timeout: SLOW }, async () => {
    const r = rng(6306);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = tfPeople(r, 6 + r.int(20));
      const files = Array.from({ length: 1 + r.int(3) }, () => tfFile(r, ps, 3 + r.int(10), randomForm(r), r.bool(0.5), false));
      const result = await tfRun(files);
      const where = `round ${round}`;

      const markerOf = new Map<number, string>();
      const ownerOf = new Map<string, number>();
      const see = (person: TfPerson, marker: string, what: string): void => {
        expect(marker, `${where}: ${what}`).toMatch(/^TF-\d{4}$/);
        const known = markerOf.get(person.id);
        if (known === undefined) markerOf.set(person.id, marker);
        else expect(marker, `${where}: person ${person.id}, ${what}`).toBe(known);
        const owner = ownerOf.get(marker);
        if (owner === undefined) ownerOf.set(marker, person.id);
        else expect(owner, `${where}: ${marker} stands for two persons (${what})`).toBe(person.id);
      };
      let occurrences = 0;
      files.forEach((f, n) => {
        const body = bodyRowsOf(result.files[n]!.text, f);
        expect(body.length, where).toBe(f.rows.length);
        f.rows.forEach((row, i) => {
          see(row.child, body[i]![0]!.trim(), `child, "${row.cells[0]}"`);
          see(row.guardian, body[i]![1]!.trim(), `guardian, "${row.cells[1]}"`);
          // The note keeps its words and puts the marker where the number stood, in the order the numbers stood.
          const inNote = tfMarkersIn(body[i]![4]!);
          expect(inNote.length, `${where}: note "${row.cells[4]}" became "${body[i]![4]}"`).toBe(row.mentioned.length);
          row.mentioned.forEach((p, k) => see(p, inNote[k]!, `note, "${row.cells[4]}"`));
          occurrences += 2 + row.mentioned.length;
        });
      });
      // The report counts what was put in: every number once per place, and one per person among the numbers.
      expect(result.report.totals.tf, where).toEqual({ occurrences, distinct: markerOf.size });
      // A TF number is no personnummer: never counted as one, never a number whose check digit does not hold, never a spelling of ÅÅMMDD-NNNN.
      expect(result.report.totals.pnr, where).toEqual({ occurrences: 0, distinct: 0 });
      expect(result.report.totals.sam, where).toEqual({ occurrences: 0, distinct: 0 });
      expect(result.report.checkDigit, where).toEqual({ pnr: { holds: 0, fails: 0 }, sam: { holds: 0, fails: 0 } });
      expect(result.report.spellings.every((s) => /^ÅÅÅÅ[ -]*MM[ -]*DD[ +-]*(?:TF|tf|Tf|tF)[ -]*NN$/.test(s.spelling)), `${where}: ${JSON.stringify(result.report.spellings)}`).toBe(true);
    }
  });

  it("keeps a TF number and a personnummer apart in one column: each cell gets the marker of its own kind and counts under it", { timeout: SLOW }, async () => {
    const r = rng(6307);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = tfPeople(r, 4 + r.int(12));
      const f = tfFile(r, ps, 4 + r.int(10), randomForm(r), r.bool(0.5), true);
      const result = await tfRun([f]);
      const where = `round ${round}`;
      const body = bodyRowsOf(result.files[0]!.text, f);
      const own = new Map<string, number>();
      f.rows.forEach((row, i) => {
        const marker = body[i]![0]!.trim();
        expect(marker, `${where}: "${row.cells[0]}"`).toMatch(row.idIsPnr ? /^PNR-\d{4}$/ : /^TF-\d{4}$/);
        // One person, one marker of each kind: the same person's TF number and personnummer are two numbers and have two markers.
        const key = `${row.idIsPnr ? "pnr" : "tf"}:${row.child.id}`;
        const known = own.get(key);
        if (known === undefined) own.set(key, i);
        else expect(marker, `${where}: ${key}`).toBe(body[known]![0]!.trim());
      });
      const pnrCells = f.rows.filter((row) => row.idIsPnr).length;
      const tfCells = f.rows.length - pnrCells + f.rows.length + f.rows.reduce((sum, row) => sum + row.mentioned.length, 0);
      expect(result.report.totals.tf.occurrences, where).toBe(tfCells);
      expect(result.report.totals.pnr.occurrences, where).toBe(pnrCells);
      // The numbers whose check digit is looked at are the personnummer alone.
      expect(result.report.checkDigit.pnr.holds + result.report.checkDigit.pnr.fails, where).toBe(pnrCells);
    }
  });

  it("leaves nothing of a TF number: not as a number, not as its date, not as the TF and its two digits, in any encoding and form", { timeout: SLOW }, async () => {
    const r = rng(6308);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = tfPeople(r, 4 + r.int(20));
      const files = Array.from({ length: 1 + r.int(2) }, () => tfFile(r, ps, 3 + r.int(10), randomForm(r), r.bool(0.5), r.bool(0.3)));
      const result = await tfRun(files);
      expect(result.check, `round ${round}`).toEqual({ passed: true, failures: [] });
      files.forEach((f, n) => {
        const text = DECODED(result.files[n]!.bytes);
        const where = `round ${round}, file ${n}`;
        for (const cell of readTable(text).rows.flat()) {
          // (A marker with letters stuck to it, IDTF-0006, has no word boundary in front: take every TF-nnnn out, not only those MARKERS finds.)
          const bare = cell.replace(MARKERS, " ").replace(/TF-\d{4,6}/g, " ");
          // By shape: the door's own finder and the tool's.
          expect(findPersonalNumbers(bare), `${where}: "${cell}"`).toEqual([]);
          expect(findPersonalData(bare), `${where}: "${cell}"`).toEqual([]);
          // By fragment: no TF followed by two digits, whatever stood between (a number's end is no number, and the note's own words hold no TF).
          expect(bare, `${where}: "${cell}"`).not.toMatch(/[tｔ][fｆ][\s\-_./ ​–]?[\d０-９]{2}/i);
        }
        // By value, over everything: not one of the dates of the persons' numbers, as eight digits in a row (what a half-done replacement would leave).
        const bare = text.replace(MARKERS, " ");
        for (const p of ps) expect(bare, `${where}: ${p.tfDate.slice(0, 2)}…`).not.toMatch(new RegExp(`(?<!\\d)(?:${p.tfDate}|${FULLWIDTH(p.tfDate)})(?!\\d)`));
      });
    }
  });

  it("changes nothing the second time: a safe file of TF markers is a safe file, with the same choices", { timeout: SLOW }, async () => {
    const r = rng(6309);
    for (let round = 0; round < ROUNDS; round += 1) {
      const ps = tfPeople(r, 4 + r.int(12));
      const f = tfFile(r, ps, 3 + r.int(10), { ...randomForm(r), encoding: "UTF-8", bom: false }, r.bool(0.5), r.bool(0.3));
      const first = await tfRun([f]);
      const again = pseudonymise([parseText(first.files[0]!.text, "file", "UTF-8", false)!], { files: [tfChoices(f)] });
      if (!again.ok) throw new Error(`round ${round}: ${JSON.stringify(again.undecided)}`);
      expect(again.files[0]!.text, `round ${round}`).toBe(first.files[0]!.text);
    }
  });
});

describe("what the page says it cannot judge about TF numbers stays true", () => {
  /*
   * The page (limit3) and the manual's row say which TF numbers are NOT found. The shared door counts what Skola24's files have shown, and the pseudonymiser looks wider than the door
   * (lib/pseudonym-detect.ts, findLooseTfNumbers: blanks and hyphens in the date and around TF, a plus, a line break), because a number left in a file that is sent on costs more than a
   * marker too many. What is still not found is a date of six digits and more separators than the search takes. If the search learns another form, the first test
   * falls; if it forgets one, the second does; and the page text (messages: pseudonymiserare.report.limit3) and the manual's row are to be changed with it.
   */
  const kept = (forms: readonly string[]) => {
    const text = ["Id;Anteckning", ...forms.map((form) => `${form};x`), ""].join("\n");
    const result = pseudonymise([parseText(text, "file", "UTF-8", false)!], { files: [{ treatments: { 0: KEEP, 1: KEEP } }] });
    if (!result.ok) throw new Error(JSON.stringify(result.undecided));
    return result;
  };

  it("leaves the forms the wide search does not take, in a column the user kept, and counts none", () => {
    const forms = ["800101TF01", "800101 TF 01", "19800101TF1", "19800101 TF 1", "1980   0101TF01", "19800101     TF01", "19800101TF     01", "19 800101TF01"];
    const result = kept(forms);
    expect(result.report.totals.tf).toEqual({ occurrences: 0, distinct: 0 });
    for (const form of forms) expect(result.files[0]!.text, form).toContain(form);
  });

  it("takes the forms the page no longer lists: blanks between TF and the digits, a date written with hyphens or blanks, and counts them as TF", () => {
    const forms = ["19800101 TF 01", "19800101TF 01", "19800101-TF-01", "1980 0101TF01", "1980-01-01-TF01", "19800101+TF01"];
    const result = kept(forms);
    expect(result.report.totals.tf).toEqual({ occurrences: forms.length, distinct: 1 });
    for (const form of forms) expect(result.files[0]!.text, form).not.toContain(form);
    expect(result.check.passed).toBe(true);
  });
});
