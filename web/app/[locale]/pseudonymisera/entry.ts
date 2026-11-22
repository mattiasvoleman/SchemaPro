import type { Treatment } from "@/lib/pseudonym-headers";
import type { ParsedInput } from "@/lib/pseudonym-input";
import type { MarkerKind } from "@/lib/pseudonym-markers";
import type { FilePlan } from "@/lib/pseudonym-run";

/** One table to make safe: a file, or one sheet of a workbook, or a paste. It lives in memory on this page and nowhere else. */
export interface Entry {
  id: number;
  /** What the person calls it on this screen: the file's name and the sheet's. It is NOT written to the safe file or the report. */
  name: string;
  input: ParsedInput;
  plan: FilePlan;
  /** What the user chose, by column; a column not in it has its proposal. */
  treatments: Record<number, Treatment>;
  headersAreNames: boolean;
  /** The name the safe file is offered under (the user may change it). */
  outName: string;
}

/** The kinds a user may mark a column as. A samordningsnummer is read from the day and a TF number from its form, so neither has a choice of its own: a column marked personnummer gives each its own marker. */
export const CHOOSABLE_KINDS: readonly MarkerKind[] = ["namn", "fornamn", "efternamn", "sign", "epost", "tel", "pnr", "text"];

/** A treatment as the value of an option, and back. "" is no choice. */
export function treatmentKey(treatment: Treatment | null): string {
  if (treatment === null) return "";
  return treatment.kind === "mark" ? `mark:${treatment.marker}` : treatment.kind;
}

export function treatmentOf(key: string): Treatment | null {
  if (key === "keep") return { kind: "keep" };
  if (key === "clear") return { kind: "clear" };
  if (key.startsWith("mark:")) {
    const marker = key.slice(5) as MarkerKind;
    return CHOOSABLE_KINDS.includes(marker) ? { kind: "mark", marker } : null;
  }
  return null;
}

/** The name a safe file is first offered under: neutral, with the extension of what it was made from. The original's name is not used: a name of a file can hold a name. */
export function defaultOutName(n: number, input: ParsedInput, originalName: string): string {
  if (input.facts.origin === "xlsx") return `exempelfil-${n}.csv`;
  const extension = /\.(csv|tsv|txt)$/i.exec(originalName)?.[1]?.toLowerCase();
  if (extension !== undefined) return `exempelfil-${n}.${extension}`;
  return input.facts.delimiter === "\t" ? `exempelfil-${n}.tsv` : `exempelfil-${n}.${input.facts.origin === "paste" ? "txt" : "csv"}`;
}
