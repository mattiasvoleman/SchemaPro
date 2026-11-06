import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AccessKind } from '../access-log/access-log';
import { CSV_BOM, csvLine } from './csv-writer';
import type { DataEnv, DataFile, DataScope } from './data-files';
import { formatDocument, readmeText } from './docs';
import type { ListFile } from './lists';
import { cellOf, excludedTables, readTable, type CellRules, type TableFile } from './person-tables';
import {
  FORMAT_VERSION,
  ROWS_PER_PART,
  type FileSummary,
  type HeldOutSummary,
  type ManifestFile,
  type ReadAbout,
} from './school-export';
import { StreamingZip, type EntryWriter } from './zip-stream';

/**
 * Writes the archive: the one routine the whole-school export (the job) and
 * the registerutdrag (the request) share. What differs is what they pass in:
 * the lists and the schedule only a school has, the scope of the data files
 * (the school, or some persons), and the extra files only a person has.
 *
 * Order in the zip: README.txt and FORMAT.md first, so a reader who opens the
 * file finds what it is before the data; then the lists, the schedule and the
 * data files; manifest.json last, because it holds what the others turned out
 * to hold (rows, bytes, SHA-256, what was held out). The lists and the schedule
 * are made before the README is written, since they are held in memory anyway
 * and the README must not name a part that could not be made.
 *
 * Memory: a text file the lists make is held (they are small: a school's
 * people are thousands of rows); a data file is a generator written as it is
 * read, a batch at a time, so a year of attendance never is.
 */

export interface BuildContext {
  schoolId: string;
  schoolName: string;
  now: Date;
  kind: 'school' | 'person';
  scope: DataScope;
  /** Every marked person of the school. */
  marked: readonly string[];
  /** Whom the scope is about: not held out of their own file. */
  exempt: readonly string[];
  /** Marked persons' full names, lower-cased, for the notices. */
  markedTerms: readonly string[];
  read: <T>(fn: (tx: PrismaClient) => Promise<T>) => Promise<T>;
  checkpoint: () => Promise<void>;
  /** The lists, built when the archive reaches them. School export only. */
  lists?: () => Promise<{ files: ListFile[]; linksHeldOut: number }>;
  /** The grundschema as a table. School export only; null when the school has no active year. */
  schema?: () => Promise<{ path: string; body: Buffer } | null>;
  /** What the data files are to include: the school's seven, and for a person the extras. */
  dataFiles: readonly DataFile[];
  /** The tables a registerutdrag dumps beside the data files (person-tables.ts). Person kind only. */
  tables?: readonly TableFile[];
  /** Rows a data file's part holds before the next part begins. ROWS_PER_PART; lowered by the specs. */
  rowsPerPart?: number;
  /** What a part of the archive could not do and the rest went on without; the manifest says it. Filled while the archive is built. */
  notes?: string[];
}

export interface BuildResult {
  files: ManifestFile[];
  summary: FileSummary[];
  heldOut: HeldOutSummary;
  readAbout: ReadAbout;
  manifest: string;
}

/** Text is written to the entry in blocks this size, not row by row. */
const BLOCK = 64 * 1024;

class Blocks {
  private text = '';
  private bytes = 0;
  private readonly hash = createHash('sha256');
  constructor(private readonly writer: EntryWriter) {}

  async add(chunk: string): Promise<void> {
    this.text += chunk;
    if (this.text.length >= BLOCK) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.text === '') return;
    const buffer = Buffer.from(this.text, 'utf8');
    this.text = '';
    this.bytes += buffer.length;
    this.hash.update(buffer);
    await this.writer.write(buffer);
  }

  done(): { bytes: number; sha256: string } {
    return { bytes: this.bytes, sha256: this.hash.digest('hex') };
  }
}

/** The part's name: the first keeps the file's, the rest are numbered from 2. */
export function partPath(path: string, part: number): string {
  if (part === 1) return path;
  const dot = path.lastIndexOf('.');
  return `${path.slice(0, dot)}-${part}${path.slice(dot)}`;
}

export class Audit {
  readonly about = new Map<AccessKind, Set<string>>();
  readonly heldRows = new Map<string, number>();
  readonly blankedCells = new Map<string, number>();

  named(kind: AccessKind, ids: Iterable<string | null | undefined>): void {
    const set = this.about.get(kind) ?? new Set<string>();
    for (const id of ids) if (typeof id === 'string' && id !== '') set.add(id);
    if (set.size > 0) this.about.set(kind, set);
  }

  held(file: string, what: 'rows' | 'blanked', count: number): void {
    if (count <= 0) return;
    const map = what === 'rows' ? this.heldRows : this.blankedCells;
    map.set(file, (map.get(file) ?? 0) + count);
  }

  readAbout(): ReadAbout {
    const out: ReadAbout = {};
    for (const [kind, ids] of this.about) out[kind] = [...ids];
    return out;
  }
}

async function writeText(zip: StreamingZip, path: string, content: string | Buffer): Promise<ManifestFile> {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  await zip.addFile(path, async (writer) => writer.write(buffer));
  return {
    path,
    title: path,
    rows: 0,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

/** One data file: its parts, split at ROWS_PER_PART, each with a header. */
async function writeParts(
  zip: StreamingZip,
  file: DataFile,
  rows: AsyncGenerator<string[]>,
  rowsPerPart: number,
): Promise<ManifestFile[]> {
  const header = CSV_BOM + csvLine(file.columns.map((column) => column.name));
  const parts: ManifestFile[] = [];
  let pending: IteratorResult<string[]> | null = null;
  let finished = false;
  for (let part = 1; !finished; part += 1) {
    const path = partPath(file.path, part);
    let count = 0;
    let sums = { bytes: 0, sha256: '' };
    await zip.addFile(path, async (writer) => {
      const blocks = new Blocks(writer);
      await blocks.add(header);
      while (count < rowsPerPart) {
        const next: IteratorResult<string[]> = pending ?? (await rows.next());
        pending = null;
        if (next.done) {
          finished = true;
          break;
        }
        await blocks.add(csvLine(next.value));
        count += 1;
      }
      await blocks.flush();
      sums = blocks.done();
    });
    if (!finished) {
      // A full part: is there a row for the next? A part that would hold only the header is not written.
      pending = await rows.next();
      if (pending.done) finished = true;
    }
    parts.push({ path, title: file.title, rows: count, bytes: sums.bytes, sha256: sums.sha256 });
  }
  return parts;
}

export async function buildArchive(zip: StreamingZip, ctx: BuildContext, audit: Audit): Promise<BuildResult> {
  const exempt = new Set(ctx.exempt);
  const markedOut = ctx.marked.filter((id) => !exempt.has(id));
  const subjectIsMarked = ctx.exempt.some((id) => ctx.marked.includes(id));
  // The extract of a protected person names nobody else (data-files.ts): the receiver may be the person the protection is from.
  const isolate = ctx.kind === 'person' && subjectIsMarked;
  const files: ManifestFile[] = [];

  // The parts only a school has are made first and written after the README, which says which of them there are.
  let linksHeldOut = 0;
  let lists: ListFile[] = [];
  if (ctx.lists) {
    const built = await ctx.lists();
    linksHeldOut = built.linksHeldOut;
    lists = built.files;
    await ctx.checkpoint();
  }
  const schema = ctx.schema ? await ctx.schema() : null;
  if (ctx.schema) await ctx.checkpoint();

  files.push(
    await writeText(
      zip,
      'README.txt',
      readmeText({
        schoolName: ctx.schoolName,
        createdAt: ctx.now,
        kind: ctx.kind,
        markedPeople: ctx.kind === 'person' ? 0 : markedOut.length,
        subjectIsMarked,
        hasSchema: schema !== null,
        notes: ctx.notes ?? [],
        excluded: ctx.kind === 'person' ? excludedTables() : [],
      }),
    ),
  );
  files.push(await writeText(zip, 'FORMAT.md', formatDocument(ctx.dataFiles, ctx.tables ?? [])));
  await ctx.checkpoint();

  for (const list of lists) {
    const written = await writeText(zip, list.path, list.content);
    files.push({ ...written, rows: list.rows });
  }
  if (schema) files.push(await writeText(zip, schema.path, schema.body));

  const env: DataEnv = {
    schoolId: ctx.schoolId,
    scope: ctx.scope,
    markedOut,
    markedTerms: ctx.markedTerms,
    isolate,
    read: ctx.read,
    named: (kind, ids) => audit.named(kind, ids),
    held: (file, what, count) => audit.held(file, what, count),
    checkpoint: ctx.checkpoint,
  };
  for (const file of ctx.dataFiles) {
    const parts = await writeParts(zip, file, file.rows(env), ctx.rowsPerPart ?? ROWS_PER_PART);
    const rowsHeld = audit.heldRows.get(file.path);
    const cellsBlanked = audit.blankedCells.get(file.path);
    parts.forEach((part, index) => {
      // The held-out counts belong to the file; they are said once, on its first part.
      files.push(index === 0 ? { ...part, heldOutRows: rowsHeld, blankedCells: cellsBlanked } : part);
    });
  }

  if (ctx.tables && ctx.scope.ids !== null) {
    const ids = [...ctx.scope.ids];
    const idSet = new Set(ids);
    // In a protected person's extract every other user of the school is a stranger to it: their ids are not written.
    const strangers = isolate
      ? new Set(
          (
            await ctx.read((tx) =>
              tx.$queryRaw<Array<{ id: string }>>`SELECT "id"::text AS id FROM "Users" WHERE "schoolId" = ${ctx.schoolId}::uuid`,
            )
          )
            .map((row) => row.id)
            .filter((id) => !idSet.has(id)),
        )
      : undefined;
    const rules: CellRules = { markedOut: new Set(markedOut), markedTerms: ctx.markedTerms, strangers };
    for (const table of ctx.tables) {
      const rows = await ctx.read((tx) => readTable(tx, ctx.schoolId, table, ids));
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]!);
      let emptied = 0;
      const lines = rows.map((row) =>
        csvLine(
          columns.map((column) => {
            const made = cellOf(column, row[column], rules);
            if (made.held) emptied += 1;
            return made.text;
          }),
        ),
      );
      const content = CSV_BOM + csvLine(columns) + lines.join('');
      const written = await writeText(zip, table.path, content);
      files.push({ ...written, title: table.table, rows: rows.length, blankedCells: emptied > 0 ? emptied : undefined });
      for (const column of table.dump.columns) {
        audit.named(table.dump.kind, rows.map((row) => row[column]).filter((value): value is string => typeof value === 'string' && idSet.has(value)));
      }
      await ctx.checkpoint();
    }
  }

  // README and FORMAT are the first two entries; "rows" is meaningful for the tables only.
  const heldOut: HeldOutSummary = {
    people: ctx.kind === 'person' ? 0 : markedOut.length,
    links: audit.heldRows.get('data/kopplingar.csv') ?? linksHeldOut,
    ...(ctx.notes && ctx.notes.length > 0 ? { notes: [...ctx.notes] } : {}),
  };
  const manifest = JSON.stringify(
    {
      format: 'rastra-skolexport',
      version: FORMAT_VERSION,
      kind: ctx.kind === 'person' ? 'registerutdrag' : 'skola',
      created: ctx.now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      school: { name: ctx.schoolName, id: ctx.schoolId },
      heldOut: { skyddadIdentitetPersoner: heldOut.people, kopplingar: heldOut.links },
      ...(ctx.notes && ctx.notes.length > 0 ? { anmarkningar: ctx.notes } : {}),
      files: files.map((file) => ({
        path: file.path,
        beskrivning: file.title,
        rader: file.rows,
        byte: file.bytes,
        sha256: file.sha256,
        ...(file.heldOutRows ? { utelamnadeRader: file.heldOutRows } : {}),
        ...(file.blankedCells ? { tommaCeller: file.blankedCells } : {}),
      })),
    },
    null,
    2,
  );
  await zip.addFile('manifest.json', async (writer) => writer.write(manifest + '\n'));
  await zip.finish();

  return {
    files,
    summary: files.map((file) => ({ path: file.path, rows: file.rows, bytes: file.bytes })),
    heldOut,
    readAbout: audit.readAbout(),
    manifest,
  };
}
