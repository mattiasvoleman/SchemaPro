/**
 * Schemat som tabell och i öppna format, as the page sees it: the gateway's
 * types (src/schedule-exchange/exchange.service.ts), the formats and the few
 * browser chores around a file. The parsing is the gateway's, not this
 * module's: a file is sent as it is, in base64, and read there, so the page
 * carries no spreadsheet or XML reader.
 */

export const EXCHANGE_FORMATS = ["TABLE_CSV", "TABLE_XLSX", "UNTIS_GPU", "ASC_XML"] as const;
export type ExchangeFormat = (typeof EXCHANGE_FORMATS)[number];

export interface ExchangeSummary {
  academicYearId: string;
  yearName: string;
  publishMode: "DIRECT" | "DRAFT";
  lessons: number;
  parked: number;
  teachers: number;
  teachersWithoutSignature: number;
}

export interface PlanRefusal {
  code: string;
  params: Record<string, string | number>;
  detail: string;
}

export interface PlanRowDto {
  ref: string;
  label: string;
  action: "CREATE" | "UNCHANGED" | "REFUSED";
  refusals: PlanRefusal[];
  changes: string[];
}

export interface PlanWarningDto {
  code: string;
  params: Record<string, string | number>;
  detail: string;
}

export interface RequirementPlanDto {
  groupName: string;
  subjectName: string;
  action: "CREATE" | "KEEP" | "SKIP";
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
  recurrence: "ALL" | "ODD" | "EVEN";
  block: string | null;
}

export interface ImportPlanDto {
  format: ExchangeFormat;
  yearName: string;
  summary: { rows: number; create: number; unchanged: number; refused: number; unreadable: number; notInFile: number };
  rows: PlanRowDto[];
  unreadable: { ref: string; code: string; message: string }[];
  requirements: RequirementPlanDto[];
  newBlocks: string[];
  warnings: PlanWarningDto[];
  notes: string[];
  canApply: boolean;
  fingerprint: string;
}

export interface ImportResultDto {
  created: number;
  unchanged: number;
  requirementsCreated: number;
  blocksCreated: number;
}

export interface UploadedFileBody {
  name: string;
  contentBase64: string;
}

/** The format a set of file names is, by extension; null when they are not one format's. */
export function formatOfFileNames(names: readonly string[]): ExchangeFormat | null {
  if (names.length === 0) return null;
  const lower = names.map((name) => name.toLowerCase());
  if (lower.length === 1) {
    if (lower[0]!.endsWith(".xlsx")) return "TABLE_XLSX";
    if (lower[0]!.endsWith(".csv")) return "TABLE_CSV";
    if (lower[0]!.endsWith(".xml")) return "ASC_XML";
    if (lower[0]!.endsWith(".zip")) return "UNTIS_GPU";
  }
  return lower.every((name) => /gpu\d+(\.txt)?$/.test(name)) ? "UNTIS_GPU" : null;
}

/** base64 of a file's bytes, in pieces: a spread over a large array overflows the stack. */
export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** A download of base64 bytes, by an anchor on a blob URL, as lib/csv-export.ts does for text. */
export function saveBase64(filename: string, contentType: string, contentBase64: string): void {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * The most the gateway takes in one request is 1 MB of JSON (MAX_BODY_SIZE),
 * base64 being a third larger than the bytes: so a file over this is turned
 * back here, with a sentence, before it is sent to be refused with a status.
 */
export const MAX_UPLOAD_BYTES = 700 * 1024;
