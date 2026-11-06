import { createHash } from 'node:crypto';
import { readZip } from '../schedule-exchange/zip';
import { Audit, buildArchive, partPath, type BuildContext } from './build';
import type { DataFile } from './data-files';
import { tableFiles } from './person-tables';
import { StreamingZip, type ByteSink } from './zip-stream';

class MemorySink implements ByteSink {
  readonly parts: Buffer[] = [];
  async write(chunk: Buffer): Promise<void> {
    this.parts.push(chunk);
  }
  get all(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** A data file of `count` rows, yielded one at a time, that says when it has been read to the end. */
function counting(path: string, count: number, onDone?: () => void): DataFile {
  return {
    path,
    title: 'Räknade rader',
    source: 'inget',
    columns: [{ name: 'n', doc: 'Radens nummer.' }, { name: 'text', doc: 'Text.' }],
    async *rows() {
      for (let n = 1; n <= count; n += 1) yield [String(n), n % 3 === 0 ? `"citat"; ${n}` : `=rad ${n}`];
      onDone?.();
    },
  };
}

const context = (over: Partial<BuildContext>): BuildContext => ({
  schoolId: '99999999-9999-4999-8999-999999999999',
  schoolName: 'Provskolan',
  now: new Date('2026-11-05T12:00:00.000Z'),
  kind: 'school',
  scope: { ids: null },
  marked: [],
  exempt: [],
  markedNames: [],
  read: async () => {
    throw new Error('no database here');
  },
  checkpoint: async () => undefined,
  dataFiles: [],
  ...over,
});

async function build(over: Partial<BuildContext>) {
  const sink = new MemorySink();
  const zip = new StreamingZip(sink);
  const audit = new Audit();
  const result = await buildArchive(zip, context(over), audit);
  return { result, files: readZip(sink.all, { maxEntryBytes: 1 << 28, maxTotalBytes: 1 << 29, maxEntries: 500 }), audit };
}

describe('partPath', () => {
  it('keeps the first part\'s name and numbers the rest from two', () => {
    expect(partPath('data/narvaro.csv', 1)).toBe('data/narvaro.csv');
    expect(partPath('data/narvaro.csv', 2)).toBe('data/narvaro-2.csv');
    expect(partPath('data/person/x.y.csv', 3)).toBe('data/person/x.y-3.csv');
  });
});

describe('buildArchive', () => {
  it('opens with README and FORMAT, ends with the manifest, and says each file\'s SHA-256, rows and bytes', async () => {
    const { result, files } = await build({ dataFiles: [counting('data/a.csv', 4)] });
    expect([...files.keys()]).toEqual(['README.txt', 'FORMAT.md', 'data/a.csv', 'manifest.json']);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
      format: string; version: number; kind: string; created: string; files: Array<{ path: string; rader: number; byte: number; sha256: string }>;
    };
    expect(manifest).toMatchObject({ format: 'rastra-skolexport', version: 1, kind: 'skola', created: '2026-11-05T12:00:00Z' });
    for (const entry of manifest.files) {
      const content = files.get(entry.path)!;
      expect(entry.byte).toBe(content.length);
      expect(entry.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    }
    expect(manifest.files.find((f) => f.path === 'data/a.csv')!.rader).toBe(4);
    expect(result.summary.find((f) => f.path === 'data/a.csv')).toEqual({ path: 'data/a.csv', rows: 4, bytes: files.get('data/a.csv')!.length });
  });

  it('writes the file as the dialect the pages write: BOM, header, semicolons, CRLF, formula guard, quoted cells', async () => {
    const { files } = await build({ dataFiles: [counting('data/a.csv', 3)] });
    expect(files.get('data/a.csv')!.toString('utf8')).toBe('﻿n;text\r\n1;\'=rad 1\r\n2;\'=rad 2\r\n3;"""citat""; 3"\r\n');
  });

  it('splits a file at the row limit and writes no part with only a header', async () => {
    const six = await build({ dataFiles: [counting('data/a.csv', 6)], rowsPerPart: 3 });
    expect([...six.files.keys()].filter((name) => name.startsWith('data/'))).toEqual(['data/a.csv', 'data/a-2.csv']);
    expect(six.files.get('data/a-2.csv')!.toString('utf8').split('\r\n').filter(Boolean)).toHaveLength(1 + 3);
    expect(six.files.get('data/a-2.csv')!.toString('utf8').startsWith('﻿n;text\r\n')).toBe(true);

    const seven = await build({ dataFiles: [counting('data/a.csv', 7)], rowsPerPart: 3 });
    expect([...seven.files.keys()].filter((name) => name.startsWith('data/'))).toEqual(['data/a.csv', 'data/a-2.csv', 'data/a-3.csv']);

    const none = await build({ dataFiles: [counting('data/a.csv', 0)], rowsPerPart: 3 });
    expect(none.files.get('data/a.csv')!.toString('utf8')).toBe('﻿n;text\r\n');
  });

  it('reads a data file to its end, in order, one after another', async () => {
    const order: string[] = [];
    await build({
      dataFiles: [counting('data/a.csv', 2, () => order.push('a')), counting('data/b.csv', 2, () => order.push('b'))],
    });
    expect(order).toEqual(['a', 'b']);
  });

  it('beats the checkpoint after the documents and stops when the checkpoint throws', async () => {
    let beats = 0;
    await build({ dataFiles: [counting('data/a.csv', 1)], checkpoint: async () => void (beats += 1) });
    expect(beats).toBeGreaterThanOrEqual(1);
    await expect(
      build({
        dataFiles: [counting('data/a.csv', 1)],
        checkpoint: async () => {
          throw new Error('withdrawn');
        },
      }),
    ).rejects.toThrow('withdrawn');
  });

  it('counts what the files held out and blanked, once, on the file\'s first part, and the marked persons in the summary', async () => {
    const held: DataFile = {
      ...counting('data/h.csv', 5),
      async *rows(env) {
        env.held('data/h.csv', 'rows', 2);
        env.held('data/h.csv', 'blanked', 1);
        env.named('PEOPLE', ['a', 'b', undefined, null, 'a']);
        env.named('ATTENDANCE', ['a']);
        yield* [['1', 'x'], ['2', 'y'], ['3', 'z'], ['4', 'w'], ['5', 'v']];
      },
    };
    const { result, files, audit } = await build({
      dataFiles: [held],
      marked: ['m1', 'm2', 'm3'],
      rowsPerPart: 3,
    });
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as {
      heldOut: { skyddadIdentitetPersoner: number };
      files: Array<{ path: string; utelamnadeRader?: number; tommaCeller?: number }>;
    };
    expect(manifest.heldOut.skyddadIdentitetPersoner).toBe(3);
    expect(manifest.files.find((f) => f.path === 'data/h.csv')).toMatchObject({ utelamnadeRader: 2, tommaCeller: 1 });
    expect(manifest.files.find((f) => f.path === 'data/h-2.csv')?.utelamnadeRader).toBeUndefined();
    expect(result.heldOut.people).toBe(3);
    expect(result.readAbout).toEqual({ PEOPLE: ['a', 'b'], ATTENDANCE: ['a'] });
    expect(audit.heldRows.get('data/h.csv')).toBe(2);
  });

  it('exempts the person a registerutdrag is about from the held-out people, and says what it is', async () => {
    const { result, files } = await build({
      kind: 'person',
      marked: ['me', 'other'],
      exempt: ['me'],
      scope: { ids: ['me'] },
      dataFiles: [counting('data/a.csv', 1)],
    });
    expect(result.heldOut.people).toBe(0);
    expect(JSON.parse(files.get('manifest.json')!.toString('utf8')).kind).toBe('registerutdrag');
    expect(files.get('README.txt')!.toString('utf8')).toContain('Personen har en markering för skyddad identitet');
    expect(files.has('csv/amnen.csv')).toBe(false);
  });

  it('writes the lists and the schedule a school has, between the documents and the data', async () => {
    const { files } = await build({
      lists: async () => ({ files: [{ path: 'csv/amnen.csv', content: 'x;y\r\n', rows: 0 }, { path: 'csv/lokal_timplan/a.csv', content: 'q\r\n', rows: 0 }], linksHeldOut: 2 }),
      schema: async () => ({ path: 'schema/grundschema.csv', body: Buffer.from('s\r\n') }),
      dataFiles: [counting('data/a.csv', 1)],
    });
    expect([...files.keys()]).toEqual(['README.txt', 'FORMAT.md', 'csv/amnen.csv', 'csv/lokal_timplan/a.csv', 'schema/grundschema.csv', 'data/a.csv', 'manifest.json']);
    expect(JSON.parse(files.get('manifest.json')!.toString('utf8')).heldOut.kopplingar).toBe(2);
  });

  it('writes no schema when the school has none to give', async () => {
    const { files } = await build({ schema: async () => null, dataFiles: [] });
    expect([...files.keys()]).toEqual(['README.txt', 'FORMAT.md', 'manifest.json']);
  });
});

describe('buildArchive notes', () => {
  it('says in the manifest what a part could not do, and only when there is something to say', async () => {
    const quiet = await build({ notes: [] });
    expect(JSON.parse(quiet.files.get('manifest.json')!.toString('utf8'))).not.toHaveProperty('anmarkningar');
    const noisy = await build({ notes: ['Grundschemat skrevs inte (TypeError).'] });
    expect(JSON.parse(noisy.files.get('manifest.json')!.toString('utf8')).anmarkningar).toEqual(['Grundschemat skrevs inte (TypeError).']);
  });

  it('says it in the README, first, and on the export\'s own row, and does not name the schema folder when there is none', async () => {
    const notes: string[] = [];
    const missing = await build({
      notes,
      schema: async () => {
        notes.push('Grundschemat (schema/grundschema.csv) skrevs inte (TypeError). Resten av filen är hel.');
        return null;
      },
      lists: async () => ({ files: [], linksHeldOut: 0 }),
    });
    const readme = missing.files.get('README.txt')!.toString('utf8');
    expect(readme).toContain('Delar som saknas');
    expect(readme).toContain('Grundschemat (schema/grundschema.csv) skrevs inte (TypeError)');
    expect(readme.indexOf('Delar som saknas')).toBeLessThan(readme.indexOf('Vad som finns var'));
    expect(readme).not.toContain('schema/      Grundschemat som en tabell');
    expect(missing.result.heldOut.notes).toEqual(notes);

    const whole = await build({ schema: async () => ({ path: 'schema/grundschema.csv', body: Buffer.from('s\r\n') }), lists: async () => ({ files: [], linksHeldOut: 0 }) });
    const complete = whole.files.get('README.txt')!.toString('utf8');
    expect(complete).toContain('schema/      Grundschemat som en tabell');
    expect(complete).not.toContain('Delar som saknas');
    expect(whole.result.heldOut).not.toHaveProperty('notes');
  });
});

describe('buildArchive for a protected person', () => {
  const SUBJECT = '22222222-2222-4222-8222-222222222222';
  const STRANGER = '33333333-3333-4333-8333-333333333333';
  const MARKED_OTHER = '44444444-4444-4444-8444-444444444444';

  /** A data file that says what it was told about the persons it may name. */
  const probing = (seen: Array<{ isolate: boolean; markedOut: readonly string[] }>): DataFile => ({
    ...counting('data/a.csv', 0),
    async *rows(env) {
      seen.push({ isolate: env.isolate, markedOut: env.markedOut });
    },
  });

  it('tells the data files to name nobody else, and the README says so, only when the person asked for is protected', async () => {
    const seen: Array<{ isolate: boolean; markedOut: readonly string[] }> = [];
    const protectedPerson = await build({ kind: 'person', marked: [SUBJECT, MARKED_OTHER], exempt: [SUBJECT], scope: { ids: [SUBJECT] }, dataFiles: [probing(seen)] });
    const unprotected = await build({ kind: 'person', marked: [MARKED_OTHER], exempt: [SUBJECT], scope: { ids: [SUBJECT] }, dataFiles: [probing(seen)] });
    const school = await build({ marked: [MARKED_OTHER], dataFiles: [probing(seen)] });
    expect(seen).toEqual([
      { isolate: true, markedOut: [MARKED_OTHER] },
      { isolate: false, markedOut: [MARKED_OTHER] },
      { isolate: false, markedOut: [MARKED_OTHER] },
    ]);
    expect(protectedPerson.files.get('README.txt')!.toString('utf8')).toContain('ingen annan person pekas ut i det');
    expect(unprotected.files.get('README.txt')!.toString('utf8')).not.toContain('ingen annan person pekas ut i det');
    expect(unprotected.files.get('README.txt')!.toString('utf8')).toContain('Andra personer i utdraget');
    expect(school.files.get('README.txt')!.toString('utf8')).not.toContain('Andra personer i utdraget');
  });

  it('empties, in the table files, every cell that carries another user of the school, whatever the column, and counts them', async () => {
    const table = tableFiles().find((file) => file.table === 'ScheduleChangeLogs')!;
    const tx = {
      $queryRaw: jest.fn(async (sql: { strings?: string[] } | TemplateStringsArray) => {
        const text = Array.isArray(sql) ? (sql as TemplateStringsArray).join('?') : ((sql as { strings: string[] }).strings ?? []).join('?');
        if (text.includes('FROM "Users"')) return [{ id: SUBJECT }, { id: STRANGER }, { id: MARKED_OTHER }];
        return [{ j: JSON.stringify({ id: 'r1', actorId: STRANGER, note: `flyttade ${STRANGER} till rum 4`, userId: SUBJECT, lessonId: '55555555-5555-4555-8555-555555555555' }) }];
      }),
    };
    const { files, result } = await build({
      kind: 'person', marked: [SUBJECT, MARKED_OTHER], exempt: [SUBJECT], scope: { ids: [SUBJECT] }, dataFiles: [], tables: [table],
      read: (fn) => fn(tx as never),
    });
    const csv = files.get(table.path)!.toString('utf8');
    expect(csv).toBe('﻿id;actorId;note;userId;lessonId\r\nr1;;;22222222-2222-4222-8222-222222222222;55555555-5555-4555-8555-555555555555\r\n');
    expect(result.files.find((file) => file.path === table.path)?.blankedCells).toBe(2);
  });
});
