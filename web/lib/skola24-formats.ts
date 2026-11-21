/**
 * The Skola24 files a public page says something about (Formatbeskrivare, X3): data, one description per file type.
 *
 * READ THIS BEFORE ADDING ONE. Skola24 publishes no field-level specification for any timetable file, and no page read
 * says a field's WIDTH or a file's CODE PAGE. So `width` and `encoding` are empty here, and stay empty until a page (or a real
 * example file, which is the school's to hand over) says. A column list below is the order a support page prints, no more:
 * the pages show the files as pictures of Excel, so a header row's wording is the page's description, and a header row that
 * a school's own export carries may read differently. That is why every spelling after the first is TOLKAT, and why a file is
 * applied on exact labels only (skola24-format.ts `exact`).
 *
 * Seven pages were read for this, in the browser pane, on 2026-11-21 (`read`). `updated` is the date each page carries.
 *
 * Contract: web/lib/skola24-formats.test.ts holds this to the importers (every `field` is a field of the format's `kind`),
 * to `normalizeHeader` (every synonym is already normalised, the first is the label's), and to its fixtures.
 */

import type { Fact, FactSource, FormatColumn, FormatDescriptor } from "@/lib/skola24-format-types";

const READ = "2026-11-21";
const SUPPORT = "https://www.skola24.com/support/";

interface Page {
  url: string;
  updated: string | null;
}

const PAGE = {
  /** Plattformen: Importera föräldrar CSV. */
  parents: { url: `${SUPPORT}plattformen/kom-igang/importera-foraldrar-csv/`, updated: "2024-04-08" },
  /** Förskola/Fritidshem: Importera personal. */
  staff: { url: `${SUPPORT}forskolafritidshem/kom-igang/importera-personal/`, updated: "2022-02-01" },
  /** Förskola/Fritidshem: Import av uppgifter (föräldrar, barn och personal, kort). */
  imports: { url: `${SUPPORT}forskolafritidshem/kom-igang/import_av_uppgifter/`, updated: "2023-10-16" },
  /** Schema: Elevhantering (elever in via Urklipp). */
  pupils: { url: `${SUPPORT}schema/manualer/elevhantering/`, updated: "2026-06-24" },
  /** Frånvaro: Uttag av frånvaro från Skola24 till Extens. */
  extens: { url: `${SUPPORT}franvaro/franvaro-till-betyg/uttag-av-franvaro-fran-skola24-till-extens/`, updated: "2024-07-11" },
  /** Skola24-hjälp: Export till schema (the platform's export, read into Skola24 Schema as Textfil). */
  exportToSchema: { url: `${SUPPORT}skola24-hjalp/export-till-schema/`, updated: "2024-06-28" },
  /** Export av schemainformation (the older page; it carries no date). */
  exportFromSchema: { url: `${SUPPORT}lasarsstart-old/export-av-schemainformation/`, updated: null },
  /** The release notes of Skola24 Schema. */
  releases: { url: `${SUPPORT}plattformen/uppdateringar-skola24-schema/`, updated: "2026-04-17" },
} as const satisfies Record<string, Page>;

const source = (page: Page, status: FactSource["status"]): FactSource => ({ url: page.url, updated: page.updated, read: READ, status });
/** A page says it. */
const doc = <T>(page: Page, value: T): Fact<T> => ({ value, source: source(page, "DOKUMENTERAT") });
/** Our reading of a page. */
const read = <T>(page: Page, value: T): Fact<T> => ({ value, source: source(page, "TOLKAT") });

/** A column; `synonyms` begins with the label, normalised (the test holds it to normalizeHeader). */
const column = (page: Page, id: string, label: string, synonyms: readonly string[], rest: Omit<FormatColumn, "id" | "label" | "synonyms"> = {}): FormatColumn => ({
  id,
  label: doc(page, label),
  synonyms,
  ...rest,
});

// ---------------------------------------------------------------------------
// A. Föräldrar CSV (Skola24 Plattformen): the guardians of a school's pupils
// ---------------------------------------------------------------------------

const PARENTS: FormatDescriptor = {
  id: "skola24-foraldrar-csv",
  name: "Importera föräldrar CSV",
  product: "Skola24 Plattformen",
  kind: "guardians",
  separator: doc(PAGE.parents, ";"),
  encoding: null,
  // The page describes every row as a pupil and a link to a guardian, and its example row has four values and no header.
  headerRow: read(PAGE.parents, "no"),
  order: doc(PAGE.parents, "fixed"),
  columns: [
    column(PAGE.parents, "pupilPersonalNumber", "Personnummer för elev", ["personnummerforelev"], { required: doc(PAGE.parents, true), personalNumber: true }),
    column(PAGE.parents, "guardianPersonalNumber", "Personnummer för vårdnadshavare", ["personnummerforvardnadshavare"], { required: doc(PAGE.parents, true), personalNumber: true }),
    column(PAGE.parents, "firstName", "Förnamn för vårdnadshavare", ["fornamnforvardnadshavare", "fornamn"], { required: doc(PAGE.parents, true), field: "firstName" }),
    column(PAGE.parents, "lastName", "Efternamn för vårdnadshavare", ["efternamnforvardnadshavare", "efternamn"], { required: doc(PAGE.parents, true), field: "lastName" }),
    column(PAGE.parents, "email", "E-postadress för vårdnadshavare", ["epostadressforvardnadshavare", "epostadress", "epost"], { required: doc(PAGE.parents, false), field: "email" }),
    // The page adds "utan bindestreck eller mellanslag": a number with neither.
    column(PAGE.parents, "mobile", "Mobilnummer för vårdnadshavare", ["mobilnummerforvardnadshavare", "mobilnummer", "mobil"], { required: doc(PAGE.parents, false), field: "phone" }),
  ],
  facts: [
    doc(PAGE.parents, "Varje rad är en elev och kopplingen till en vårdnadshavare. En rad får sluta efter fjärde kolumnen: e-post och mobil får utelämnas."),
    doc(PAGE.parents, "Excels 'CSV, kommaavgränsad' sparar ändå med semikolon."),
    doc(PAGE.parents, "Personnummer får skrivas ÅÅÅÅMMDD-XXXX, ÅÅÅÅMMDDXXXX, ÅÅMMDD-XXXX eller ÅÅMMDDXXXX."),
    // The older page of the Förskola/Fritidshem product lists five columns, without the mobile number. The newer one is followed.
    read(PAGE.imports, "Förskola/Fritidshem-sidan (2023-10-16) räknar upp fem kolumner, utan mobilnummer. Plattformssidan (2024-04-08) räknar upp sex."),
  ],
  fixtures: ["foraldrar.csv"],
};

// ---------------------------------------------------------------------------
// B. Personal CSV (Skola24 Förskola/Fritidshem): the staff of one school
// ---------------------------------------------------------------------------

const STAFF: FormatDescriptor = {
  id: "skola24-personal-csv",
  name: "Importera personal",
  product: "Skola24 Förskola/Fritidshem",
  kind: "teachers",
  separator: doc(PAGE.staff, ";"),
  encoding: null,
  headerRow: null,
  order: doc(PAGE.staff, "fixed"),
  columns: [
    column(PAGE.staff, "school", "skolans namn", ["skolansnamn", "skola"], { required: read(PAGE.staff, true), unread: "school" }),
    // "kolumn obligatorisk, men värde frivilligt": the column must be there, its cells may be empty.
    column(PAGE.staff, "department", "avdelning", ["avdelning"], { required: doc(PAGE.staff, true), unread: "department" }),
    column(PAGE.staff, "personalNumber", "personnummer", ["personnummer"], { required: read(PAGE.staff, true), personalNumber: true }),
    column(PAGE.staff, "firstName", "förnamn", ["fornamn"], { required: read(PAGE.staff, true), field: "firstName" }),
    column(PAGE.staff, "lastName", "efternamn", ["efternamn"], { required: read(PAGE.staff, true), field: "lastName" }),
    // Not read BY DEFAULT: the teachers' import refuses a signature without a tjänstgöringsgrad, and this file has none, so placing it
    // would refuse every row that has one (X3 design §6, a decision for the user). The user can place it; S1 reads signatures on their own.
    column(PAGE.staff, "signature", "signatur", ["signatur"], { required: doc(PAGE.staff, true), unread: "needsPost" }),
    column(PAGE.staff, "email", "e-postadress", ["epostadress", "epost"], { required: doc(PAGE.staff, false), field: "email" }),
    column(PAGE.staff, "confidentialMark", "sekretessmarkering", ["sekretessmarkering"], { required: doc(PAGE.staff, false), confidentialMark: true, unread: "confidentialMark" }),
  ],
  facts: [
    doc(PAGE.staff, "En fil per skola, och filen ska innehålla all personal på skolan. Skolnamnet i filen ska stämma med skolans namn i Skola24."),
    doc(PAGE.staff, "En person med sekretessmarkering (siffran 1 i sista kolumnen) tas inte in av Skola24; dialogen visar vilka rader som inte lästes in."),
    doc(PAGE.imports, "Samma kolumner i samma ordning står på sidan Import av uppgifter (2023-10-16). Excels 'CSV (kommaavgränsad)' sparar med semikolon."),
  ],
  fixtures: ["personal.csv"],
};

// ---------------------------------------------------------------------------
// B2. Barn CSV (Skola24 Förskola/Fritidshem): the children of a school's groups
// ---------------------------------------------------------------------------

const CHILDREN: FormatDescriptor = {
  id: "skola24-barn-csv",
  name: "Importera barn förskola/fritids",
  product: "Skola24 Förskola/Fritidshem",
  // Rastra has no import of children of a preschool or an after-school home: the file is described so that it is named, not read.
  kind: null,
  separator: doc(PAGE.imports, ";"),
  encoding: null,
  headerRow: null,
  order: doc(PAGE.imports, "fixed"),
  columns: [
    column(PAGE.imports, "school", "skolans namn", ["skolansnamn", "skola"], { unread: "noImport" }),
    column(PAGE.imports, "department", "avdelning", ["avdelning"], { unread: "noImport" }),
    column(PAGE.imports, "personalNumber", "barnets personnummer", ["barnetspersonnummer"], { personalNumber: true }),
    column(PAGE.imports, "firstName", "förnamn", ["fornamn"], { unread: "noImport" }),
    column(PAGE.imports, "lastName", "efternamn", ["efternamn"], { unread: "noImport" }),
    column(PAGE.imports, "confidentialMark", "sekretessmarkering", ["sekretessmarkering"], { required: doc(PAGE.imports, false), confidentialMark: true, unread: "confidentialMark" }),
  ],
  facts: [
    doc(PAGE.imports, "En person med sekretessmarkering (siffran 1 i sista fältet) tas inte in av Skola24. Nya avdelningar kan läggas till via filen."),
    read(PAGE.imports, "Sidan ger inte skolnamnets, avdelningens, namnens eller personnumrets krav, bara att sekretessmarkeringen är frivillig."),
  ],
  fixtures: ["barn.csv"],
};

// ---------------------------------------------------------------------------
// C. Elever, Klass – Elev (Skola24 Schema, via Urklipp)
// ---------------------------------------------------------------------------

const PUPILS: FormatDescriptor = {
  id: "skola24-elever-klass",
  name: "Importera elever till klasser (Arkiv – Import – Urklipp – Klass/elev)",
  product: "Skola24 Schema",
  kind: "students",
  // "Programmet har känt igen den första typen, som är tab-separerad": a table copied out of Excel.
  separator: doc(PAGE.pupils, "\t"),
  encoding: null,
  // The example has headers on the first row ("Utelämna första raden" is ticked). One example is not a rule.
  headerRow: read(PAGE.pupils, "yes"),
  // The page gives the order twice, differently (see the first fact): never read on position.
  order: null,
  columns: [
    column(PAGE.pupils, "personalNumber", "Personnummer", ["personnummer"], { personalNumber: true }),
    column(PAGE.pupils, "lastName", "Efternamn", ["efternamn"], { field: "lastName" }),
    column(PAGE.pupils, "firstName", "Förnamn", ["fornamn"], { field: "firstName" }),
    column(PAGE.pupils, "className", "Klass", ["klass"], { field: "className" }),
  ],
  facts: [
    read(PAGE.pupils, "Sidan anger kolumnernas ordning två gånger olika: listan säger personnummer, efternamn, förnamn, klass; en mening säger klass, personnummer, efternamn och förnamn. Filen läses därför bara på rubrik, aldrig på läge."),
    doc(PAGE.pupils, "Efternamn och förnamn får ligga i samma kolumn. En sådan kolumn är ingen av de två här: den namnges och placeras av användaren."),
    doc(PAGE.pupils, "Klasser och grupper måste heta exakt likadant i elevregistret och i schemat."),
  ],
  fixtures: ["elever-klass.tsv"],
};

// ---------------------------------------------------------------------------
// D. Extens frånvarofil (Skola24 Frånvaro → Extens betygsutskrifter)
// ---------------------------------------------------------------------------

const EXTENS_ABSENCE: FormatDescriptor = {
  id: "skola24-extens-franvaro",
  name: "Frånvarodata till Extens",
  product: "Skola24 Frånvaro",
  // Rastra has no import of hours of absence summed per pupil: the file is described so that it is named, and its personnummer column dropped.
  kind: null,
  separator: doc(PAGE.extens, ";"),
  encoding: null,
  headerRow: read(PAGE.extens, "no"),
  order: doc(PAGE.extens, "fixed"),
  columns: [
    column(PAGE.extens, "unitId", "EnhetsID", ["enhetsid"], { unread: "noImport" }),
    column(PAGE.extens, "personalNumber", "Personnummer", ["personnummer"], { personalNumber: true }),
    column(PAGE.extens, "hours", "Summerat antal timmar oanmäld frånvaro för perioden", ["summeratantaltimmaroanmaldfranvaroforperioden"], { unread: "noImport" }),
  ],
  facts: [
    doc(PAGE.extens, "En rad per elev; elever utan frånvaro är utelämnade."),
    doc(PAGE.extens, "Personnumret skrivs tiosiffrigt med bindestreck, som Extens kräver. Samordningsnummer och TF-nummer ingår."),
    doc(PAGE.extens, "Timmarna är ett heltal eller ett decimaltal, och decimalen skrivs med punkt."),
    doc(PAGE.extens, "Filen görs av en Excelmall (Omformatering av frånvarodata Extens, högst 2 500 elever) ur Skola24:s rapport Summerad frånvaro per elev, visningsformat Export (*.txt), med fälten Lektionstid totalt (tim), Personnummer och Ej anm.(tim). Fältordningen i rapporten står bara i en bild på sidan."),
  ],
  fixtures: ["extens-franvaro.txt"],
};

// ---------------------------------------------------------------------------
// Files whose layout no public page gives: described so that they are named, and so that a real file is a description and a fixture
// ---------------------------------------------------------------------------

const GROUP_PUPIL: FormatDescriptor = {
  id: "skola24-grupp-elev",
  name: "Importera elever till grupper (Arkiv – Import – Urklipp – Grupp/Elev)",
  product: "Skola24 Schema",
  kind: null,
  separator: null,
  encoding: null,
  headerRow: read(PAGE.pupils, "yes"),
  order: null,
  // Two layouts of the same two columns (a group and a pupil per row, or a pupil and all groups of the pupil): no column list is one of them.
  columns: null,
  facts: [
    doc(PAGE.pupils, "Två lägen: gruppens namn i vänstra kolumnen och elevens personnummer i den högra (en rad per grupp och elev), eller personnumret till vänster och alla elevens grupper till höger med kommatecken emellan."),
    doc(PAGE.pupils, "Exemplet har rubriker på första raden."),
  ],
  fixtures: [],
};

const TEXTFIL: FormatDescriptor = {
  id: "skola24-textfil",
  name: "Textfil Gr, Gy eller Vux (förr Procapita)",
  product: "Skola24 Schema",
  kind: null,
  separator: null,
  encoding: null,
  headerRow: null,
  order: null,
  columns: null,
  facts: [
    doc(PAGE.exportToSchema, "Kan innehålla salar, lärare, elever, grupper, kurser, ämnen och kopplingar grupp/elev. Kurs bara för skolor som använder kurskoder."),
    doc(PAGE.exportToSchema, "'ID för skola' läses ur textfilen när den importeras i ett schema."),
    doc(PAGE.exportFromSchema, "Skapas av Arkiv – Export – Textfil (Gr, Gy el. Vux) som en .txt-fil, för bland andra Edlevo och Schoolsoft. 'ID för skola' vid export får vara valfria tecken, men något måste anges."),
    doc(PAGE.releases, "Namnet byttes från Procapita till Textfil i release 2020-08-04. Formatet fungerar som förut och används av flera system."),
    doc(PAGE.releases, "Under Inställningar – Export/Import går det att byta till Version 2, som tar med veckosuffixen A och B (kalenderns första och sista vecka) i exportfilerna. Utan Version 2 saknas de."),
  ],
  fixtures: [],
};

const MDB: FormatDescriptor = {
  id: "skola24-mdb-extens",
  name: "Databasfil (.mdb), Arkiv – Export – Extens",
  product: "Skola24 Schema",
  kind: null,
  separator: null,
  encoding: null,
  headerRow: null,
  order: null,
  columns: null,
  facts: [
    doc(PAGE.exportFromSchema, "Skapas av Arkiv – Export – Extens som en .mdb-fil (en databasfil, inte en avgränsad text), för bland andra Dexter/Extens, Vklass och InfoMentor."),
    doc(PAGE.exportFromSchema, "'ID för skola (standard)' får vara valfria tecken, utom vid export till Dexter/Extens där det ska vara Extens Skol-ID."),
  ],
  fixtures: [],
};

const TABLE_LESSON: FormatDescriptor = {
  id: "skola24-tabell-lektion",
  name: "Tabell ▸ Lektion, kopierad till Excel",
  product: "Skola24 Schema",
  kind: null,
  separator: null,
  encoding: null,
  headerRow: null,
  order: null,
  columns: null,
  facts: [],
  fixtures: [],
};

const TABLE_STAFFING: FormatDescriptor = {
  id: "skola24-tabell-tjanstefordelning",
  name: "Tabell ▸ Tjänstefördelning, kopierad till Excel",
  product: "Skola24 Schema",
  kind: null,
  separator: null,
  encoding: null,
  headerRow: null,
  order: null,
  columns: null,
  facts: [],
  fixtures: [],
};

/** Every description, the ones with columns first. The ones without are awaiting an example file. */
export const SKOLA24_FORMATS: readonly FormatDescriptor[] = [PARENTS, STAFF, CHILDREN, PUPILS, EXTENS_ABSENCE, GROUP_PUPIL, TEXTFIL, MDB, TABLE_LESSON, TABLE_STAFFING];

export function formatById(id: string): FormatDescriptor | undefined {
  return SKOLA24_FORMATS.find((format) => format.id === id);
}
