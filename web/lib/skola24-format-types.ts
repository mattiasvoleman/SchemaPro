/**
 * What a description of a Skola24 file is made of (Formatbeskrivare, X3). Types only: no runtime, no imports that run.
 *
 * WHY A DESCRIPTION AND NOT A READER. Skola24 publishes no field-level specification for any timetable file (see
 * docs/manual and the design note x3-design.md). What a public page DOES say is a handful of facts about a handful of
 * files: which columns, in which order, separated by what. Each such fact is written once, here in data, with the page
 * it comes from and the date that page carries, so that a reader of the data can see what is known and how well. When a
 * real file arrives, the work is to fill in a description and to add a fixture, and nobody writes a new reader.
 *
 * EVERY FACT CARRIES ITS SOURCE. A separator, a header row, a column's position, a width: each is a `Fact`, and a fact
 * without a source cannot be written (the type forbids it, and web/lib/skola24-formats.test.ts reads every one). What no
 * page says is `null`, never a guess: there is no field called "probably semicolon".
 *
 *   DOKUMENTERAT   a page at the vendor says it, and the page was read on `read`.
 *   TOLKAT         our reading of a page, or something a page implies and does not say.
 */

import type { TemplateKind } from "@/lib/column-fields";

export type FactStatus = "DOKUMENTERAT" | "TOLKAT";

/** The page a fact comes from. `updated` is the date the page itself carries (null when it carries none); `read` is the day we read it. */
export interface FactSource {
  url: string;
  updated: string | null;
  read: string;
  status: FactStatus;
}

export interface Fact<T> {
  value: T;
  source: FactSource;
}

/**
 * Why Rastra reads nothing from a column the description knows. The page words each reason (messages: columnMapping.format),
 * and a column without a reason that Rastra does not read is a column the description forgot, which the contract test refuses.
 */
export type UnreadReason =
  /** Rastra's imports are per school: the school is the one that is signed in, not a column. */
  | "school"
  /** Skola24's avdelning (a preschool or after-school group): Rastra has no such field. */
  | "department"
  /** Skola24's sekretessmarkering: a row marked 1 is not read at all (see `confidentialMark`), so the column itself is not either. */
  | "confidentialMark"
  /**
   * A signature, which Rastra stores on a teacher's post and the teachers' import refuses without a tjänstgöringsgrad ("signatur utan
   * tjanst_procent", lib/csv.ts mapTeacherRows): a file that has the one and not the other would have every row refused. The user may
   * still place it, and hears the importer's own words if they do.
   */
  | "needsPost"
  /** The file's kind has no import in Rastra, so no column of it is read. */
  | "noImport";

export interface FormatColumn {
  /** Stable within the format; what a message and a test call the column. */
  id: string;
  /** The column as the page names it (the page's own words: for a file with no header row it is a description, not a header). */
  label: Fact<string>;
  /**
   * The spellings a header of this column may have, as `normalizeHeader` (lib/csv-export.ts) writes them. Written out, not
   * computed, so that this module stays data; the contract test holds each to `normalizeHeader`. The page's own label
   * is always among them.
   */
  synonyms: readonly string[];
  /** Skola24's own requirement of the column (a column that must exist may still hold no value). */
  required?: Fact<boolean>;
  /** A width in characters. Empty everywhere until a public source gives one: no page read so far does. */
  width?: Fact<number>;
  /** The column holds personnummer: it is never read, never shown and never sent (web/lib/personal-number.ts). */
  personalNumber?: true;
  /** A row with `1` here is a person Skola24 does not take in; Rastra holds the row back (the user's decision, X3 design §6.1). */
  confidentialMark?: true;
  /** Rastra's field for the column, in the format's `kind`: an id of `FIELDS[kind]` (lib/column-fields.ts). */
  field?: string;
  /** Why no Rastra field reads the column. Required when there is no `field` and the column is not a personnummer column. */
  unread?: UnreadReason;
}

export interface FormatDescriptor {
  /** Stable, stored nowhere but in messages (columnMapping.format.names.<id>) and in tests. */
  id: string;
  /** The vendor's name for the file, in the vendor's own words: not translated. */
  name: string;
  /** The Skola24 product the file belongs to. */
  product: string;
  /** The Rastra import the file is read into; null when Rastra has no import for it. */
  kind: TemplateKind | null;
  /** What a column list is known of: `columns` is null for a file whose layout no page gives (awaiting an example file). */
  separator: Fact<";" | "," | "\t"> | null;
  /** The code page the file is saved in. No page read so far says; null is the honest value. */
  encoding: Fact<string> | null;
  /** Whether the first row is a header row. null: no page says. */
  headerRow: Fact<"yes" | "no"> | null;
  /**
   * The columns, in the order the page lists them. null: no public page lists them.
   *
   * The first synonym of every column is the page's own label, normalised: a file whose headers are all those, and nothing
   * else, matches EXACTLY. Every later synonym is our reading (TOLKAT) of what a real file may call the column.
   */
  columns: readonly FormatColumn[] | null;
  /**
   * That the page states ONE fixed order of the columns, so that a file with no header row can be read on position. null when
   * no page says it, or when a page says it twice differently (Elever: the list and a sentence disagree): such a file is
   * read on its headers only, never on position.
   */
  order: Fact<"fixed"> | null;
  /** Everything else a page says about the file that is not a column (a version marker, a rename, which programs read it). */
  facts: readonly Fact<string>[];
  /** Fixtures under web/lib/__fixtures__/skola24/, synthetic. A description with columns has at least one; one without has none. */
  fixtures: readonly string[];
}
