import { describe, expect, it } from "vitest";
import { decodeCsvBytes } from "@/lib/csv-encoding";
import { readTable } from "@/lib/column-table";
import { findPersonalNumbers } from "@/lib/personal-number";
import { findPersonalData, luhnHolds } from "@/lib/pseudonym-detect";
import { KEEP } from "@/lib/pseudonym-headers";
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
 */

const ROUNDS = 250;

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

async function inputOf(g: Generated): Promise<ParsedInput> {
  const encoded = encodeText(g.text, g.form.encoding, g.form.bom);
  const parsed = await parseSource({ file: new File([encoded.bytes as unknown as BlobPart], "x.csv") });
  if (!parsed.ok) throw new Error(`the generated file was not read: ${parsed.reason}`);
  return parsed.inputs[0]!;
}

/** The marker text left in a cell once the markers are taken out: what a search of the output must not find anything in. */
const MARKERS = /\b(?:PNR|SAM|TEL|NAMN|FORNAMN|EFTERNAMN|SIGN|TEXT)-\d{4,}\b|\bepost-\d{4,}@exempel\.invalid/gi;

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
  it("gives every spelling of a person's personnummer, address, number and name one marker, and two persons never one", async () => {
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
  it("leaves nothing a search finds, in the decoded bytes of any file, wherever it stood and however it was written", async () => {
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
  it("keeps the rows on their numbers, the columns, kept cells and empty ones as they were, and the delimiter, line ending, byte order mark and encoding", async () => {
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
  it("gives the same text the second time, with the same choices", async () => {
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
