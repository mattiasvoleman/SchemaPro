import { blankLesson, MAX_EXCHANGE_BYTES, MAX_EXCHANGE_LESSONS, type ExchangeDocument, type ExchangeLesson, type TeacherRef } from './exchange-model';
import { highSchoolDocument, smallSchoolDocument } from './__fixtures__/documents';
import { hasPersonalNumber } from './file-safety';
import { decodeUntisBytes, listSafeChanges, readUntisGpu, writeUntisGpu, type UntisPeriod } from './untis-gpu';

/**
 * The Untis GPU001/GPU002 codec. One describe per concern; the "CHOICE n"
 * blocks pin the numbered choices in the header of untis-gpu.ts, so a change
 * to a choice fails a test that names it.
 */

const CRLF = '\r\n';

/** Rows joined the way Untis ends its lines. */
const text = (...rows: string[]): string => rows.join(CRLF) + CRLF;

/** A GPU001 line in the minute-based form (08:30, 45 minutes) unless told otherwise; text fields quoted as Untis does. */
function row001(no: string, klass: string, teacher: string, subject: string, room: string, day: string, stunde = '510', length = '00:45'): string {
  return [no, `"${klass}"`, `"${teacher}"`, `"${subject}"`, `"${room}"`, day, stunde, length].join(',');
}

const TEXT_FIELDS_002 = new Set([5, 6, 7, 8, 12, 42]);

/** A GPU002 row of 45 fields with only the numbered fields set; the text fields quoted. */
function row002(values: Record<number, string>): string {
  const out = new Array<string>(45).fill('');
  for (const [field, value] of Object.entries(values)) {
    out[Number(field) - 1] = TEXT_FIELDS_002.has(Number(field)) ? `"${value}"` : value;
  }
  return out.join(',');
}

/** Splits one written DIF line on commas outside quotes (the codec's own reader is not used to check its writer). */
function splitDif(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

const bodyLines = (file: string): string[] => file.split(CRLF).slice(0, -1);

/** What the round trip must preserve (the task's list); ref and ids are not part of it. */
function signature(l: ExchangeLesson): string {
  return JSON.stringify({
    group: l.group,
    extraGroups: l.extraGroups,
    subject: l.subject,
    teachers: l.teachers.map((t) => t.short),
    room: l.room,
    day: l.day,
    start: l.start,
    end: l.end,
    weeks: l.weeks,
    from: l.from,
    to: l.to,
  });
}

const multiset = (lessons: ExchangeLesson[]): string[] => lessons.map(signature).sort();

const codes = (result: { problems: { code: string }[] }): string[] => result.problems.map((p) => p.code);

const countNotes = (notes: string[], fragment: string): number => notes.filter((n) => n.includes(fragment)).length;

const teacher = (short: string, name: string, email: string | null): TeacherRef => ({ short, name, email, id: null });

const ABE = teacher('ABE', 'Anna Berg', 'anna.berg@skolan.example');
const BLU = teacher('BLU', 'Bo Lund', null);
const CAN = teacher('CAN', 'Cia Andersson', null);

/** Small enough to pin the whole layout: co-teachers, two classes, a half class, an A-week with term dates, a lesson with nothing. */
function snapshotDocument(): ExchangeDocument {
  return {
    school: 'Provskolan',
    year: { name: '2026/2027', start: '2026-08-17', end: '2027-06-11' },
    groups: [
      { name: '7A', kind: 'CLASS', gradeLevel: 7, halfOf: null },
      { name: '7B', kind: 'CLASS', gradeLevel: 7, halfOf: null },
      { name: '7A-1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOf: '7A' },
      { name: '8B', kind: 'CLASS', gradeLevel: 8, halfOf: null },
    ],
    subjects: [],
    rooms: [],
    teachers: [ABE, BLU, CAN],
    // Deliberately not in output order: the writer, not the caller, orders the file.
    lessons: [
      blankLesson({ ref: '', group: '8B', subject: 'Engelska', subjectCode: 'EN', teachers: [], room: null, day: 5, start: '10:30', end: '11:30' }),
      blankLesson({ ref: '', group: '7A', extraGroups: ['7B'], subject: 'Matematik', subjectCode: 'MA', teachers: [ABE, BLU], room: 'A101', day: 3, start: '08:30', end: '09:15' }),
      blankLesson({
        ref: '',
        group: '7A-1',
        subject: 'Bild',
        subjectCode: 'BL',
        teachers: [CAN],
        room: 'Bildsalen',
        day: 2,
        start: '13:00',
        end: '14:20',
        weeks: 'ODD',
        from: '2026-08-17',
        to: '2026-12-18',
      }),
      blankLesson({ ref: '', group: '7A', extraGroups: ['7B'], subject: 'Matematik', subjectCode: 'MA', teachers: [ABE, BLU], room: 'A101', day: 1, start: '08:30', end: '09:15' }),
    ],
  };
}

describe('writeUntisGpu', () => {
  it('pins the exact GPU001 text of a small timetable', () => {
    const { gpu001 } = writeUntisGpu(snapshotDocument());
    expect(gpu001).toBe(
      [
        '1,"7A,7B","ABE","Matematik","A101",1,510,00:45',
        '1,"7A,7B","BLU","Matematik","A101",1,510,00:45',
        '1,"7A,7B","ABE","Matematik","A101",3,510,00:45',
        '1,"7A,7B","BLU","Matematik","A101",3,510,00:45',
        '2,"7A","CAN","Bild","Bildsalen",2,780,01:20',
        '3,"8B","","Engelska","",5,630,01:00',
        '',
      ].join(CRLF),
    );
  });

  it('pins the exact GPU002 text of the same timetable', () => {
    const { gpu002 } = writeUntisGpu(snapshotDocument());
    expect(gpu002).toBe(
      [
        '1,2,2,2,"7A,7B","ABE","Matematik","A101",,,,"",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,"",,,',
        '1,2,0,2,"7A,7B","BLU","Matematik","A101",,,,"",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,"",,,',
        '2,1,1,1,"7A","CAN","Bild","Bildsalen",,,,"A-vecka",,,20260817,20261218,,,,,,,,,,,,,,,,,,,,,,,,,,"7A-1",,,',
        '3,1,1,0,"8B","","Engelska","",,,,"",,,,,,,,,,,,,,,,,,,,,,,,,,,,,,"",,,',
        '',
      ].join(CRLF),
    );
  });

  it('puts every value in the field number the Untis pages give it', () => {
    const { gpu001, gpu002 } = writeUntisGpu(snapshotDocument());
    for (const line of bodyLines(gpu001)) expect(splitDif(line)).toHaveLength(8);
    for (const line of bodyLines(gpu002)) expect(splitDif(line)).toHaveLength(45);

    // GPU001 (S4): 1 Unterr.-Nr., 2 Klasse, 3 Lehrer, 4 Fach, 5 Raum, 6 Tag, 7 Stunde, 8 Stundenlänge.
    expect(splitDif(bodyLines(gpu001)[4]!)).toEqual(['2', '7A', 'CAN', 'Bild', 'Bildsalen', '2', '780', '01:20']);

    // GPU002 (S5): 2 Wochenstunden, 5 Klasse, 6 Lehrer, 7 Fach, 8 Fachraum, 12 Gruppe, 15 Datum von, 16 Datum bis, 42 Schülergruppe.
    const f = splitDif(bodyLines(gpu002)[2]!);
    expect(f[0]).toBe('2');
    expect(f[1]).toBe('1');
    expect([f[4], f[5], f[6], f[7]]).toEqual(['7A', 'CAN', 'Bild', 'Bildsalen']);
    expect(f[11]).toBe('A-vecka');
    expect([f[14], f[15]]).toEqual(['20260817', '20261218']);
    expect(f[41]).toBe('7A-1');
    // Every other field of the row is empty: nothing is written that the codec cannot read back.
    const used = new Set([0, 1, 2, 3, 4, 5, 6, 7, 11, 14, 15, 41]);
    f.forEach((value, index) => {
      if (!used.has(index)) expect(value).toBe('');
    });
  });

  it('ends every line with CRLF, has no header and no BOM, and a minute-based length on every GPU001 line (CHOICES 2 and 4)', () => {
    const { gpu001, gpu002 } = writeUntisGpu(highSchoolDocument());
    for (const file of [gpu001, gpu002]) {
      expect(file.charCodeAt(0)).not.toBe(0xfeff);
      expect(file.endsWith(CRLF)).toBe(true);
      expect(file.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
      expect(/^\d/.test(file)).toBe(true);
    }
    for (const line of bodyLines(gpu001)) expect(splitDif(line)[7]).toMatch(/^\d{2}:\d{2}$/);
  });

  it('writes no GPU011: the file set has two members (CHOICE 1)', () => {
    expect(Object.keys(writeUntisGpu(smallSchoolDocument())).sort()).toEqual(['gpu001', 'gpu002']);
  });

  it('is deterministic: the same lessons in another order give the same files, and so does a second call', () => {
    const doc = highSchoolDocument();
    const first = writeUntisGpu(doc);
    const shuffled: ExchangeDocument = { ...doc, lessons: [...doc.lessons.slice(7), ...doc.lessons.slice(0, 7)].reverse() };
    expect(writeUntisGpu(shuffled)).toEqual(first);
    expect(writeUntisGpu(doc)).toEqual(first);
  });

  it('gives one lesson number to every placement of the same lesson and a new one when anything differs (CHOICE 5)', () => {
    const { gpu001 } = writeUntisGpu(highSchoolDocument());
    const rows = bodyLines(gpu001).map(splitDif);
    const numbersOf = (klass: string, subject: string): Set<string> =>
      new Set(rows.filter((r) => r[1] === klass && r[3] === subject).map((r) => r[0]!));
    // 7A Matematik on Monday and Wednesday: one lesson, two placements.
    expect(numbersOf('7A', 'Matematik').size).toBe(1);
    expect(rows.filter((r) => r[1] === '7A' && r[3] === 'Matematik')).toHaveLength(2);
    // 7A and 7B Matematik have the same teacher but are different lessons.
    expect([...numbersOf('7A', 'Matematik')]).not.toEqual([...numbersOf('7B', 'Matematik')]);
    // The Bild/Musik term split: two halves, two subjects, each with its own dates: four lessons, four numbers
    // (the halves are both written as class 7A, so the class column alone could not tell them apart).
    const split = new Set([...numbersOf('7A', 'Bild'), ...numbersOf('7A', 'Musik')]);
    expect(split.size).toBe(4);
  });

  it('writes a teacher per line, lead first, the same room and slot on both, and 0 class periods on the second (CHOICE 6)', () => {
    const { gpu001, gpu002 } = writeUntisGpu(highSchoolDocument());
    const gym = bodyLines(gpu001).map(splitDif).filter((r) => r[1] === '8A' && r[3] === 'Idrott och hälsa');
    expect(gym.map((r) => r[2])).toEqual(['EST', 'FAL']);
    expect(gym[0]!.slice(4)).toEqual(gym[1]!.slice(4));
    const rows = bodyLines(gpu002).map(splitDif).filter((r) => r[4] === '8A' && r[6] === 'Idrott och hälsa');
    expect(rows.map((r) => r[2])).toEqual(['1', '0']);
    expect(rows.map((r) => r[3])).toEqual(['1', '1']);
  });

  it('writes the weekly periods as the number of placements and the rooms joined with ~ (CHOICES 12 and 13)', () => {
    const doc = snapshotDocument();
    doc.lessons.push(
      blankLesson({ ref: '', group: '8B', subject: 'Engelska', teachers: [], room: 'A102', day: 2, start: '10:30', end: '11:30' }),
    );
    // Same key as the room-less Engelska, so one lesson of two placements and two rooms (one of them none).
    const rows = bodyLines(writeUntisGpu(doc).gpu002).map(splitDif);
    const english = rows.find((r) => r[6] === 'Engelska')!;
    expect(english[1]).toBe('2');
    expect(english[7]).toBe('A102');
    doc.lessons.push(blankLesson({ ref: '', group: '8B', subject: 'Engelska', teachers: [], room: 'A103', day: 4, start: '10:30', end: '11:30' }));
    const again = bodyLines(writeUntisGpu(doc).gpu002).map(splitDif).find((r) => r[6] === 'Engelska')!;
    expect(again[1]).toBe('3');
    expect(again[7]).toBe('A102~A103');
  });

  it('quotes a text with a quote or a comma in it and reads it back (CHOICE 4)', () => {
    const doc = snapshotDocument();
    doc.lessons = [blankLesson({ ref: '', group: '7A', subject: 'Svenska, "extra"', teachers: [ABE], room: 'Sal "A", ost', day: 1, start: '08:00', end: '08:45' })];
    const files = writeUntisGpu(doc);
    expect(bodyLines(files.gpu001)[0]).toBe('1,"7A","ABE","Svenska, ""extra""","Sal ""A"", ost",1,480,00:45');
    const parsed = readUntisGpu(files);
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons[0]).toMatchObject({ subject: 'Svenska, "extra"', room: 'Sal "A", ost' });
  });

  it('replaces a comma or ~ in a group or teacher name, which could not be told from a list (CHOICE 8)', () => {
    const doc = snapshotDocument();
    doc.lessons = [blankLesson({ ref: '', group: '7A,x', subject: 'Matematik', teachers: [teacher('A~B', 'N', null)], room: null, day: 1, start: '08:00', end: '08:45' })];
    const parsed = readUntisGpu(writeUntisGpu(doc));
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.lessons[0]!.group).toBe('7A x');
    expect(parsed.lessons[0]!.teachers.map((t) => t.short)).toEqual(['A B']);
  });

  it('falls back to the teacher name when there is no signature and leaves a nameless teacher out', () => {
    const doc = snapshotDocument();
    doc.lessons = [
      blankLesson({
        ref: '',
        group: '7A',
        subject: 'Matematik',
        teachers: [teacher('', 'x', null), { short: null, name: 'Nina', email: null, id: null }, { short: null, name: null, email: null, id: null }],
        room: null,
        day: 1,
        start: '08:00',
        end: '08:45',
      }),
    ];
    // '' is a signature that is not a signature; null/null is nobody. Only the name-bearing teacher survives.
    const parsed = readUntisGpu(writeUntisGpu(doc));
    expect(parsed.lessons[0]!.teachers.map((t) => t.short)).toEqual(['Nina']);
  });

  it('throws RangeError for a lesson whose time or weekday is not valid, rather than writing a wrong file', () => {
    const bad = (more: Partial<ExchangeLesson>): ExchangeDocument => ({
      ...snapshotDocument(),
      lessons: [blankLesson({ ref: '', group: '7A', subject: 'Matematik', day: 1, start: '08:00', end: '08:45', ...more })],
    });
    expect(() => writeUntisGpu(bad({ start: '8.00' }))).toThrow(RangeError);
    expect(() => writeUntisGpu(bad({ end: '07:00' }))).toThrow(RangeError);
    expect(() => writeUntisGpu(bad({ day: 0 }))).toThrow(RangeError);
    expect(() => writeUntisGpu(bad({ day: 8 }))).toThrow(RangeError);
  });

  it('writes empty files for a document with no lessons', () => {
    expect(writeUntisGpu({ ...snapshotDocument(), lessons: [] })).toEqual({ gpu001: '', gpu002: '' });
  });
});

describe('round trip', () => {
  for (const [name, make] of [
    ['the small school', smallSchoolDocument],
    ['the high school', highSchoolDocument],
  ] as const) {
    it(`gives back the lessons of ${name} as a multiset, with no problems`, () => {
      const doc = make();
      const parsed = readUntisGpu(writeUntisGpu(doc));
      expect(parsed.problems).toEqual([]);
      expect(multiset(parsed.lessons)).toEqual(multiset(doc.lessons));
    });

    it(`sets a GPU001 line reference on every lesson of ${name}`, () => {
      const parsed = readUntisGpu(writeUntisGpu(make()));
      for (const lesson of parsed.lessons) expect(lesson.ref).toMatch(/^GPU001 rad \d+$/);
      expect(new Set(parsed.lessons.map((l) => l.ref)).size).toBe(parsed.lessons.length);
    });
  }

  it('carries the parts of the high school the codec is built for: a co-teacher, two classes, A/B weeks, term dates, a half class, no room or teacher', () => {
    const parsed = readUntisGpu(writeUntisGpu(highSchoolDocument()));
    const find = (group: string, subject: string): ExchangeLesson[] => parsed.lessons.filter((l) => l.group === group && l.subject === subject);
    expect(find('8A', 'Idrott och hälsa')[0]!.teachers.map((t) => t.short)).toEqual(['EST', 'FAL']);
    expect(find('8A', 'Musik')[0]!.extraGroups).toEqual(['8B']);
    expect(find('7A', 'Slöjd')[0]!.weeks).toBe('ODD');
    expect(find('7B', 'Slöjd')[0]!.weeks).toBe('EVEN');
    expect(find('7A-1', 'Bild')[0]).toMatchObject({ from: '2026-08-17', to: '2026-12-18' });
    expect(find('7A-2', 'Bild')[0]).toMatchObject({ from: '2027-01-11', to: '2027-06-11' });
    expect(find('8B', 'Engelska')[0]).toMatchObject({ room: null, teachers: [] });
  });

  it('says once what the format cannot carry, and the lost fields come back empty (CHOICE 13)', () => {
    const doc = highSchoolDocument();
    // The fixture really holds the things that are lost.
    expect(doc.lessons.some((l) => l.block !== null)).toBe(true);
    expect(doc.lessons.some((l) => l.subjectCode !== null)).toBe(true);
    expect(doc.lessons.some((l) => l.teachers.some((t) => t.email !== null && t.name !== null))).toBe(true);

    const parsed = readUntisGpu(writeUntisGpu(doc));
    expect(countNotes(parsed.notes, 'parallella block')).toBe(1);
    expect(countNotes(parsed.notes, 'e-postadress')).toBe(1);
    expect(countNotes(parsed.notes, 'ämneskod')).toBe(1);
    for (const lesson of parsed.lessons) {
      expect(lesson.block).toBeNull();
      expect(lesson.subjectCode).toBeNull();
      expect(lesson.ids).toEqual({});
      for (const t of lesson.teachers) expect(t).toEqual({ short: expect.any(String), name: null, email: null, id: null });
    }
  });

  it('reads the files the service has encoded and decoded as UTF-8 without a change', () => {
    const doc = highSchoolDocument();
    const files = writeUntisGpu(doc);
    const parsed = readUntisGpu({
      gpu001: decodeUntisBytes(Buffer.from(files.gpu001, 'utf8')),
      gpu002: decodeUntisBytes(Buffer.from(files.gpu002, 'utf8')),
    });
    expect(multiset(parsed.lessons)).toEqual(multiset(doc.lessons));
  });

  it('without GPU002 still gives the placements, reads every lesson as every week all year, says so, and reads a half class as its class (CHOICES 8, 9, 10)', () => {
    const doc = highSchoolDocument();
    const parsed = readUntisGpu({ gpu001: writeUntisGpu(doc).gpu001 });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons).toHaveLength(doc.lessons.length);
    expect(parsed.lessons.every((l) => l.weeks === 'ALL' && l.from === null && l.to === null)).toBe(true);
    expect(countNotes(parsed.notes, 'GPU002 saknas')).toBe(1);
    expect(parsed.notes.find((n) => n.includes('GPU002 saknas'))).toContain('halvklass');
    // The two Bild halves (autumn and spring) both come back as class 7A, indistinguishable, which is what the note warns of.
    expect(parsed.lessons.filter((l) => l.group === '7A' && l.subject === 'Bild')).toHaveLength(2);
    expect(parsed.lessons.some((l) => l.group === '7A-1' || l.group === '7A-2')).toBe(false);
  });
});

describe('CHOICE 1: GPU011 is a Stundentafel, not a time grid', () => {
  it('is accepted, not used, and explained in one note', () => {
    const gpu011 = text('"7A","Sjuan A","Matematik",3,4');
    const files = writeUntisGpu(smallSchoolDocument());
    const parsed = readUntisGpu({ ...files, gpu011 });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons).toHaveLength(smallSchoolDocument().lessons.length);
    expect(countNotes(parsed.notes, 'stundentafel')).toBe(1);
    expect(countNotes(readUntisGpu(files).notes, 'stundentafel')).toBe(0);
  });

  it('gives a period number no time even when a GPU011 is supplied', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '2', '')), gpu011: text('"8A","Åttan A","Matematik",3,4') });
    expect(codes(parsed)).toEqual(['GPU_UNKNOWN_PERIOD']);
    expect(parsed.lessons).toEqual([]);
  });
});

describe('CHOICE 2: times', () => {
  const grid: UntisPeriod[] = [
    { number: 1, start: '08:30', end: '09:15' },
    { number: 2, start: '09:30', end: '10:15' },
  ];

  it('reads Stunde as minutes after midnight and Stundenlänge as hh:mm', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '510', '00:45'), row001('2', '8B', 'BLU', 'Svenska', '', '3', '1020', '1:30')) });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons.map((l) => [l.day, l.start, l.end])).toEqual([
      [1, '08:30', '09:15'],
      [3, '17:00', '18:30'],
    ]);
    expect(countNotes(parsed.notes, 'minutform')).toBe(1);
  });

  it('also takes a start written hh:mm and a length in plain minutes, as enbrea does for the length', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '08:30', '45')) });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons[0]).toMatchObject({ start: '08:30', end: '09:15' });
  });

  it('refuses a time that is not inside the day, with GPU_BAD_TIME on that line only', () => {
    const parsed = readUntisGpu({
      gpu001: text(
        row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '1430', '00:45'),
        row001('2', '8A', 'ABE', 'Matematik', 'A101', '1', '510', '00:00'),
        row001('3', '8A', 'ABE', 'Matematik', 'A101', '1', 'abc', '00:45'),
        row001('4', '8A', 'ABE', 'Matematik', 'A101', '1', '510', 'lång'),
        row001('5', '8A', 'ABE', 'Matematik', 'A101', '1', '510', '00:75'),
        row001('6', '8A', 'ABE', 'Matematik', 'A101', '1', '510', '00:45'),
      ),
    });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([
      ['GPU001 rad 1', 'GPU_BAD_TIME'],
      ['GPU001 rad 2', 'GPU_BAD_TIME'],
      ['GPU001 rad 3', 'GPU_BAD_TIME'],
      ['GPU001 rad 4', 'GPU_BAD_TIME'],
      ['GPU001 rad 5', 'GPU_BAD_TIME'],
    ]);
    expect(parsed.lessons.map((l) => l.ref)).toEqual(['GPU001 rad 6']);
  });

  it('reads a period-numbered line only with the school’s own grid, and says where the times came from', () => {
    const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '1', ''), row001('2', '8B', 'BLU', 'Svenska', 'A102', '2', '2', ''));
    const parsed = readUntisGpu({ gpu001 }, { periods: grid });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons.map((l) => [l.start, l.end])).toEqual([
      ['08:30', '09:15'],
      ['09:30', '10:15'],
    ]);
    expect(countNotes(parsed.notes, 'periodnummer')).toBe(1);
  });

  it('never guesses a time: with no grid every period-numbered line is a GPU_UNKNOWN_PERIOD problem', () => {
    const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '1', ''), row001('2', '8B', 'BLU', 'Svenska', 'A102', '2', '2', ''), row001('3', '8B', 'BLU', 'Svenska', 'A102', '3', '2', ''));
    const parsed = readUntisGpu({ gpu001 });
    expect(parsed.lessons).toEqual([]);
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([
      ['GPU001 rad 1', 'GPU_UNKNOWN_PERIOD'],
      ['GPU001 rad 2', 'GPU_UNKNOWN_PERIOD'],
      ['GPU001 rad 3', 'GPU_UNKNOWN_PERIOD'],
    ]);
    expect(parsed.problems[0]!.message).toContain('tidsraster');
  });

  it('a period the grid lacks is a problem for each line that names it, and the others are read', () => {
    const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '1', ''), row001('2', '8B', 'BLU', 'Svenska', 'A102', '2', '9', ''), row001('3', '8B', 'BLU', 'Svenska', 'A102', '3', '9', ''));
    const parsed = readUntisGpu({ gpu001 }, { periods: grid });
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([
      ['GPU001 rad 2', 'GPU_UNKNOWN_PERIOD'],
      ['GPU001 rad 3', 'GPU_UNKNOWN_PERIOD'],
    ]);
    expect(parsed.problems[0]!.message).toContain('finns inte');
  });

  it('refuses a period that is not a number when there is no length to make it a time', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', 'tre', '')) }, { periods: grid });
    expect(codes(parsed)).toEqual(['GPU_BAD_PERIOD']);
  });

  it('ignores a grid entry that is not a time and says so', () => {
    const parsed = readUntisGpu(
      { gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '1', '')) },
      { periods: [{ number: 1, start: '08:30', end: '09:15' }, { number: 2, start: '25:00', end: '26:00' }] },
    );
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['tidsraster', 'GPU_BAD_PERIOD_GRID']]);
  });

  it('reads a file that mixes both forms line by line', () => {
    const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1', '1', ''), row001('2', '8B', 'BLU', 'Svenska', 'A102', '2', '780', '01:20'));
    const parsed = readUntisGpu({ gpu001 }, { periods: grid });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons.map((l) => [l.start, l.end])).toEqual([
      ['08:30', '09:15'],
      ['13:00', '14:20'],
    ]);
  });
});

describe('CHOICE 3: day numbering', () => {
  it('reads 1 as Monday through 7 as Sunday', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7].map((day) => row001(String(day), '8A', 'ABE', 'Matematik', 'A101', String(day)));
    const parsed = readUntisGpu({ gpu001: text(...rows) });
    expect(parsed.lessons.map((l) => l.day)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('refuses 0, 8, 10 and a word with GPU_BAD_DAY', () => {
    const rows = ['0', '8', '10', 'må', ''].map((day, i) => row001(String(i + 1), '8A', 'ABE', 'Matematik', 'A101', day));
    const parsed = readUntisGpu({ gpu001: text(...rows) });
    expect(parsed.lessons).toEqual([]);
    expect(codes(parsed)).toEqual(['GPU_BAD_DAY', 'GPU_BAD_DAY', 'GPU_BAD_DAY', 'GPU_BAD_DAY', 'GPU_BAD_DAY']);
  });
});

describe('CHOICE 4: separators, quoting, encoding, line ends', () => {
  const base: string[][] = [
    ['1', '8A', 'ABE', 'Matematik', 'A101', '1', '510', '00:45'],
    ['2', '8B', 'BLU', 'Svenska', '', '3', '570', '01:00'],
  ];
  const expected = (): string[] => [
    JSON.stringify({ group: '8A', extraGroups: [], subject: 'Matematik', teachers: ['ABE'], room: 'A101', day: 1, start: '08:30', end: '09:15', weeks: 'ALL', from: null, to: null }),
    JSON.stringify({ group: '8B', extraGroups: [], subject: 'Svenska', teachers: ['BLU'], room: null, day: 3, start: '09:30', end: '10:30', weeks: 'ALL', from: null, to: null }),
  ];

  function render(rows: string[][], separator: string, quoted: boolean, eol: string, extra: { bom?: boolean; trailing?: number } = {}): string {
    const lines = rows.map((r) => {
      const fields = r.map((value, index) => (quoted && index >= 1 && index <= 4 ? `"${value}"` : value));
      for (let i = 0; i < (extra.trailing ?? 0); i += 1) fields.push('');
      return fields.join(separator);
    });
    return (extra.bom ? '﻿' : '') + lines.join(eol) + eol;
  }

  const variants: [string, string][] = [
    ['comma, quoted, CRLF (what the writer writes)', render(base, ',', true, '\r\n')],
    ['semicolon, quoted, LF', render(base, ';', true, '\n')],
    ['tab, unquoted, LF', render(base, '\t', false, '\n')],
    ['comma, unquoted, CR only', render(base, ',', false, '\r')],
    ['semicolon, unquoted, CRLF, with a BOM', render(base, ';', false, '\r\n', { bom: true })],
    ['comma, quoted, trailing empty fields as Untis writes them', render(base, ',', true, '\r\n', { trailing: 2 })],
    ['blank lines and a last line with no line end', render(base, ',', true, '\r\n\r\n').trimEnd()],
  ];
  for (const [name, gpu001] of variants) {
    it(`reads ${name} to the same lessons`, () => {
      const parsed = readUntisGpu({ gpu001 });
      expect(parsed.problems).toEqual([]);
      expect(multiset(parsed.lessons)).toEqual(expected().sort());
    });
  }

  it('reads a text with a doubled quote, a separator and a leading space inside quotes', () => {
    const gpu001 = text('1,"8A","ABE","Sa ""x"", b","  Rum 1 ",1,510,00:45');
    const parsed = readUntisGpu({ gpu001 });
    expect(parsed.lessons[0]).toMatchObject({ subject: 'Sa "x", b', room: 'Rum 1' });
  });

  it('detects the separator by what is outside quotes, so a semicolon file may hold a comma class list', () => {
    const parsed = readUntisGpu({ gpu001: '1;8A,8B;ABE;Musik;Sal;5;630;01:00\n' });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons[0]).toMatchObject({ group: '8A', extraGroups: ['8B'] });
  });

  it('reads the longer revision of GPU001 and does not read the WebUntis time fields, saying so once', () => {
    const line = [...base[0]!.map((v, i) => (i >= 1 && i <= 4 ? `"${v}"` : v)), '"text 1"', '"text 2"', '13:00', '14:00', '', '', '', ''].join(',');
    const parsed = readUntisGpu({ gpu001: text(line, line.replace('1,"8A"', '2,"8B"')) });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons.map((l) => [l.start, l.end])).toEqual([
      ['08:30', '09:15'],
      ['08:30', '09:15'],
    ]);
    expect(countNotes(parsed.notes, 'WebUntis')).toBe(1);
  });

  it('decodes bytes: UTF-8 with or without a BOM, UTF-16 with a BOM, and otherwise windows-1252', () => {
    const word = 'Idrott och hälsa';
    expect(decodeUntisBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(word, 'utf8')]))).toBe(word);
    expect(decodeUntisBytes(Buffer.from(word, 'utf8'))).toBe(word);
    expect(decodeUntisBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(word, 'utf16le')]))).toBe(word);
    expect(decodeUntisBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(word, 'utf16le').swap16()]))).toBe(word);
    expect(decodeUntisBytes(Buffer.from(word, 'latin1'))).toBe(word);
    // 0x80 is a euro sign in windows-1252 and a control character in ISO-8859-1.
    expect(decodeUntisBytes(Buffer.from([0x41, 0x80]))).toBe('A€');
    // A lone UTF-8 lead byte is not UTF-8; it is read as the Latin-1 letter it would be there.
    expect(decodeUntisBytes(Buffer.from([0xc3]))).toBe('Ã');
    expect(decodeUntisBytes(Buffer.alloc(0))).toBe('');
  });

  it('reads a Latin-1 file once it is decoded', () => {
    const bytes = Buffer.from(text('1,"8A","ABE","Idrott och hälsa","Gymnastiksalen",4,490,01:30'), 'latin1');
    const parsed = readUntisGpu({ gpu001: decodeUntisBytes(bytes) });
    expect(parsed.lessons[0]!.subject).toBe('Idrott och hälsa');
  });
});

describe('CHOICE 5: a lesson number is not an identity on its own', () => {
  it('does not collapse a coupled block that shares one number across classes, subjects and teachers', () => {
    const parsed = readUntisGpu({
      gpu001: text(
        row001('7', 'Sp7', 'BLU', 'Spanska', 'A102', '4', '780', '00:40'),
        row001('7', 'Ty7', 'ABE', 'Tyska', 'A101', '4', '780', '00:40'),
        row001('7', 'Fr7', 'CAN', 'Franska', 'Bildsalen', '4', '780', '00:40'),
      ),
    });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons.map((l) => [l.group, l.subject, l.teachers[0]!.short])).toEqual([
      ['Sp7', 'Spanska', 'BLU'],
      ['Ty7', 'Tyska', 'ABE'],
      ['Fr7', 'Franska', 'CAN'],
    ]);
    expect(parsed.lessons.every((l) => l.block === null)).toBe(true);
  });

  it('keeps two placements of one number on different days as two lessons (a placement is a lesson in the exchange model)', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('3', '8A', 'ABE', 'Matematik', 'A101', '1'), row001('3', '8A', 'ABE', 'Matematik', 'A101', '3')) });
    expect(parsed.lessons.map((l) => l.day)).toEqual([1, 3]);
  });

  it('refuses a lesson number that is not a whole number', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('', '8A', 'ABE', 'Matematik', 'A101', '1'), row001('x1', '8A', 'ABE', 'Matematik', 'A101', '1'), row001('1.5', '8A', 'ABE', 'Matematik', 'A101', '1')) });
    expect(codes(parsed)).toEqual(['GPU_BAD_LESSON_NUMBER', 'GPU_BAD_LESSON_NUMBER', 'GPU_BAD_LESSON_NUMBER']);
  });
});

describe('CHOICE 6: several teachers are several lines', () => {
  it('merges the lines of one lesson into lead and co-teacher, in file order', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('4', '8A', 'EST', 'Idrott', 'Gym', '4'), row001('4', '8A', 'FAL', 'Idrott', 'Gym', '4')) });
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.lessons[0]!.teachers.map((t) => t.short)).toEqual(['EST', 'FAL']);
  });

  it('keeps one teacher when a line is repeated', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('4', '8A', 'EST', 'Idrott', 'Gym', '4'), row001('4', '8A', 'EST', 'Idrott', 'Gym', '4')) });
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.lessons[0]!.teachers).toHaveLength(1);
  });

  it('does not merge lines that differ in room: they are two lessons', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('4', '8A', 'EST', 'Idrott', 'Gym 1', '4'), row001('4', '8A', 'FAL', 'Idrott', 'Gym 2', '4')) });
    expect(parsed.lessons).toHaveLength(2);
  });

  it('also reads two teachers in one field, joined with ~ or a comma', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('4', '8A', 'EST~FAL', 'Idrott', 'Gym', '4'), row001('5', '8B', 'EST,FAL', 'Idrott', 'Gym', '5')) });
    expect(parsed.lessons.map((l) => l.teachers.map((t) => t.short))).toEqual([
      ['EST', 'FAL'],
      ['EST', 'FAL'],
    ]);
  });

  it('skips a lesson with three teachers with GPU_TOO_MANY_TEACHERS and keeps the rest', () => {
    const parsed = readUntisGpu({
      gpu001: text(
        row001('4', '8A', 'EST', 'Idrott', 'Gym', '4'),
        row001('4', '8A', 'FAL', 'Idrott', 'Gym', '4'),
        row001('4', '8A', 'GUS', 'Idrott', 'Gym', '4'),
        row001('5', '8B', 'EST', 'Idrott', 'Gym', '5'),
      ),
    });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 1', 'GPU_TOO_MANY_TEACHERS']]);
    expect(parsed.lessons.map((l) => l.group)).toEqual(['8B']);
  });

  it('reads a line with no teacher as a lesson with no teacher', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('4', '8A', '', 'Idrott', 'Gym', '4')) });
    expect(parsed.lessons[0]!.teachers).toEqual([]);
  });
});

describe('CHOICE 7: several classes', () => {
  it('reads a comma list and a ~ list in Class as the lesson’s group and extra groups', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '8A,8B', 'DNO', 'Musik', 'Musiksalen', '5'), row001('2', '9A~9B~9C', 'DNO', 'Musik', 'Musiksalen', '4')) });
    expect(parsed.lessons.map((l) => [l.group, l.extraGroups])).toEqual([
      ['8A', ['8B']],
      ['9A', ['9B', '9C']],
    ]);
  });

  it('does not split a class name on a space or a plus sign', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '9A + K', 'DNO', 'Musik', 'Sal', '5')) });
    expect(parsed.lessons[0]).toMatchObject({ group: '9A + K', extraGroups: [] });
  });

  it('merges lines that differ only in class into one lesson with extra groups, and says so', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('5', '8A', 'DNO', 'Musik', 'Musiksalen', '5'), row001('5', '8B', 'DNO', 'Musik', 'Musiksalen', '5')) });
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.lessons[0]).toMatchObject({ group: '8A', extraGroups: ['8B'] });
    expect(countNotes(parsed.notes, 'flera klasser')).toBe(1);
  });

  it('does not merge classes that have different teachers, rooms or subjects (that is a block, not a joint lesson)', () => {
    const parsed = readUntisGpu({
      gpu001: text(
        row001('5', '8A', 'DNO', 'Musik', 'Musiksalen', '5'),
        row001('5', '8B', 'EST', 'Musik', 'Musiksalen', '5'),
        row001('5', '8C', 'DNO', 'Musik', 'Sal 2', '5'),
        row001('5', '8D', 'DNO', 'Bild', 'Musiksalen', '5'),
      ),
    });
    expect(parsed.lessons).toHaveLength(4);
    expect(countNotes(parsed.notes, 'flera klasser')).toBe(0);
  });

  it('cannot read a class list in an unquoted comma file and says so with a problem instead of guessing', () => {
    const parsed = readUntisGpu({ gpu001: '1,8A,8B,DNO,Musik,Sal,5,630,01:00\r\n' });
    expect(parsed.lessons).toEqual([]);
    expect(codes(parsed)).toEqual(['GPU_BAD_DAY']);
  });

  it('refuses a line with no class and a line with no subject', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '', 'DNO', 'Musik', 'Sal', '5'), row001('2', '8A', 'DNO', '', 'Sal', '5')) });
    expect(codes(parsed)).toEqual(['GPU_NO_CLASS', 'GPU_NO_SUBJECT']);
  });
});

describe('CHOICE 8: student groups', () => {
  const gpu001 = text(row001('1', '7A', 'CAN', 'Bild', 'Bildsalen', '2', '780', '01:20'));

  it('uses Schülergruppe (field 42) as the group when the lesson’s GPU002 row has it, and says so', () => {
    const gpu002 = text(row002({ 1: '1', 5: '7A', 6: 'CAN', 7: 'Bild', 42: '7A-1' }));
    const parsed = readUntisGpu({ gpu001, gpu002 });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons[0]).toMatchObject({ group: '7A-1', extraGroups: [] });
    expect(countNotes(parsed.notes, 'Schülergruppe')).toBe(1);
  });

  it('reads a list of student groups as group and extra groups', () => {
    const gpu002 = text(row002({ 1: '1', 5: '7A', 6: 'CAN', 7: 'Bild', 42: '7A-1,7A-2' }));
    expect(readUntisGpu({ gpu001, gpu002 }).lessons[0]).toMatchObject({ group: '7A-1', extraGroups: ['7A-2'] });
  });

  it('uses the class when the row has no student group', () => {
    const gpu002 = text(row002({ 1: '1', 5: '7A', 6: 'CAN', 7: 'Bild' }));
    const parsed = readUntisGpu({ gpu001, gpu002 });
    expect(parsed.lessons[0]).toMatchObject({ group: '7A' });
    expect(countNotes(parsed.notes, 'Schülergruppe')).toBe(0);
  });
});

describe('CHOICE 9: A/B weeks', () => {
  const gpu001 = text(row001('1', '7A', 'FAL', 'Slöjd', 'Slöjdsalen', '2', '780', '01:20'));
  const weeksFor = (group: string): string =>
    readUntisGpu({ gpu001, gpu002: text(row002({ 1: '1', 5: '7A', 6: 'FAL', 7: 'Slöjd', 12: group })) }).lessons[0]!.weeks;

  const spellings: [string, string][] = [
    ['A-vecka', 'ODD'],
    ['B-vecka', 'EVEN'],
    ['A', 'ODD'],
    ['b', 'EVEN'],
    ['udda', 'ODD'],
    ['Jämn vecka', 'EVEN'],
    ['A-Woche', 'ODD'],
    ['B-Woche', 'EVEN'],
    ['ungerade', 'ODD'],
    ['Gerade Woche', 'EVEN'],
    ['Week A', 'ODD'],
    ['odd', 'ODD'],
    ['even', 'EVEN'],
    ['Vecka B', 'EVEN'],
    ['', 'ALL'],
    ['alla', 'ALL'],
    ['AB', 'ALL'],
  ];
  for (const [group, weeks] of spellings) {
    it(`reads the group ${JSON.stringify(group)} as ${weeks}`, () => {
      expect(weeksFor(group)).toBe(weeks);
    });
  }

  it('leaves another kind of group text alone and names it in a note', () => {
    const parsed = readUntisGpu({ gpu001, gpu002: text(row002({ 1: '1', 5: '7A', 6: 'FAL', 7: 'Slöjd', 12: 'G1' })) });
    expect(parsed.lessons[0]!.weeks).toBe('ALL');
    expect(parsed.problems).toEqual([]);
    expect(countNotes(parsed.notes, '”G1”')).toBe(1);
    // A bare "vecka" is not a pattern either.
    expect(weeksFor('vecka')).toBe('ALL');
  });

  it('counts the rows it read as a week pattern, so a school whose Grupp means something else can see it', () => {
    const parsed = readUntisGpu({ gpu001, gpu002: text(row002({ 1: '1', 5: '7A', 6: 'FAL', 7: 'Slöjd', 12: 'A' })) });
    expect(countNotes(parsed.notes, 'tolkades som veckomönster')).toBe(1);
    expect(parsed.notes.find((n) => n.includes('tolkades som veckomönster'))).toContain('1 rader');
  });

  it('writes ODD as A-vecka and EVEN as B-vecka in field 12 and nothing for ALL', () => {
    const doc = highSchoolDocument();
    const rows = bodyLines(writeUntisGpu(doc).gpu002).map(splitDif);
    const groupOf = (klass: string, subject: string): string => rows.find((r) => r[4] === klass && r[6] === subject)![11]!;
    expect(groupOf('7A', 'Slöjd')).toBe('A-vecka');
    expect(groupOf('7B', 'Slöjd')).toBe('B-vecka');
    expect(groupOf('7A', 'Matematik')).toBe('');
  });
});

describe('CHOICE 10: dates', () => {
  const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1'));
  const rowWith = (from: string, to: string): string => text(row002({ 1: '1', 5: '8A', 6: 'ABE', 7: 'Matematik', 15: from, 16: to }));

  it('reads YYYYMMDD, open ends and ISO dates, both ends inclusive as written', () => {
    expect(readUntisGpu({ gpu001, gpu002: rowWith('20260817', '20261218') }).lessons[0]).toMatchObject({ from: '2026-08-17', to: '2026-12-18' });
    expect(readUntisGpu({ gpu001, gpu002: rowWith('20270111', '') }).lessons[0]).toMatchObject({ from: '2027-01-11', to: null });
    expect(readUntisGpu({ gpu001, gpu002: rowWith('', '20261218') }).lessons[0]).toMatchObject({ from: null, to: '2026-12-18' });
    expect(readUntisGpu({ gpu001, gpu002: rowWith('2026-08-17', '2026-12-18') }).lessons[0]).toMatchObject({ from: '2026-08-17', to: '2026-12-18' });
    expect(readUntisGpu({ gpu001, gpu002: rowWith('20260817', '20260817') }).lessons[0]).toMatchObject({ from: '2026-08-17', to: '2026-08-17' });
  });

  it('refuses a date that is not on the calendar and a range that ends before it starts, skipping that GPU002 row', () => {
    for (const [from, to, code] of [
      ['20261340', '', 'GPU_BAD_DATE'],
      ['20260230', '', 'GPU_BAD_DATE'],
      ['hej', '', 'GPU_BAD_DATE'],
      ['2026081', '', 'GPU_BAD_DATE'],
      ['20261218', '20260817', 'GPU_BAD_DATE_RANGE'],
    ] as const) {
      const parsed = readUntisGpu({ gpu001, gpu002: rowWith(from, to) });
      expect(parsed.problems[0]).toMatchObject({ ref: 'GPU002 rad 1', code });
      // The lesson is kept, defaulted, and says that its GPU002 row is missing.
      expect(codes(parsed)).toEqual([code, 'GPU_NO_GPU002_ROW']);
      expect(parsed.lessons[0]).toMatchObject({ weeks: 'ALL', from: null, to: null });
    }
  });
});

describe('CHOICE 11: subject', () => {
  it('reads Fach as the subject name and leaves the code empty', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'MA', 'A101', '1')) });
    expect(parsed.lessons[0]).toMatchObject({ subject: 'MA', subjectCode: null });
  });
});

describe('CHOICE 12: weekly periods', () => {
  it('ignores fields 2-4 of GPU002, which are derived', () => {
    const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1'));
    const a = readUntisGpu({ gpu001, gpu002: text(row002({ 1: '1', 2: '99', 3: '98', 4: '97', 5: '8A', 6: 'ABE', 7: 'Matematik' })) });
    const b = readUntisGpu({ gpu001, gpu002: text(row002({ 1: '1', 5: '8A', 6: 'ABE', 7: 'Matematik' })) });
    expect(a.lessons).toEqual(b.lessons);
    expect(a.problems).toEqual([]);
  });
});

describe('CHOICE 14: joining GPU002 to GPU001', () => {
  it('narrows a lesson number’s rows by class and teacher, so each placement gets its own row', () => {
    const gpu001 = text(row001('3', '8A', 'ABE', 'Matematik', 'A101', '1'), row001('3', '8B', 'BLU', 'Matematik', 'A102', '2'));
    const gpu002 = text(
      row002({ 1: '3', 5: '8A', 6: 'ABE', 7: 'Matematik', 12: 'A-vecka' }),
      row002({ 1: '3', 5: '8B', 6: 'BLU', 7: 'Matematik', 12: 'B-vecka', 15: '20270111' }),
    );
    const parsed = readUntisGpu({ gpu001, gpu002 });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons.map((l) => [l.group, l.weeks, l.from])).toEqual([
      ['8A', 'ODD', null],
      ['8B', 'EVEN', '2027-01-11'],
    ]);
  });

  it('uses the first row and says so when rows that cannot be told apart disagree', () => {
    const gpu001 = text(row001('3', '8A', 'ABE', 'Matematik', 'A101', '1'));
    const gpu002 = text(row002({ 1: '3', 5: '8A', 6: 'ABE', 7: 'Matematik', 12: 'A-vecka' }), row002({ 1: '3', 5: '8A', 6: 'ABE', 7: 'Matematik', 12: 'B-vecka' }));
    const parsed = readUntisGpu({ gpu001, gpu002 });
    expect(parsed.lessons[0]!.weeks).toBe('ODD');
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toMatchObject({ ref: 'GPU001 rad 1', code: 'GPU_AMBIGUOUS_ROW' });
    expect(parsed.problems[0]!.message).toContain('GPU002 rad 1');
  });

  it('keeps a lesson whose number has no GPU002 row as every week all year, and names it', () => {
    const gpu001 = text(row001('3', '8A', 'ABE', 'Matematik', 'A101', '1'), row001('4', '8A', 'ABE', 'Svenska', 'A101', '2'));
    const gpu002 = text(row002({ 1: '3', 5: '8A', 6: 'ABE', 7: 'Matematik', 12: 'A-vecka' }));
    const parsed = readUntisGpu({ gpu001, gpu002 });
    expect(parsed.lessons.map((l) => l.weeks)).toEqual(['ODD', 'ALL']);
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 2', 'GPU_NO_GPU002_ROW']]);
  });

  it('skips a GPU002 row with too few fields or a bad number, by its own line number', () => {
    const gpu001 = text(row001('3', '8A', 'ABE', 'Matematik', 'A101', '1'));
    const gpu002 = text('3,1,1', row002({ 1: 'x', 5: '8A', 6: 'ABE', 7: 'Matematik' }), row002({ 1: '3', 5: '8A', 6: 'ABE', 7: 'Matematik', 12: 'A-vecka' }));
    const parsed = readUntisGpu({ gpu001, gpu002 });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([
      ['GPU002 rad 1', 'GPU_BAD_FIELD_COUNT'],
      ['GPU002 rad 2', 'GPU_BAD_LESSON_NUMBER'],
    ]);
    expect(parsed.lessons[0]!.weeks).toBe('ODD');
  });

  it('reads a short GPU002 (through Fach only) as no weeks and no dates, with no problem', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('3', '8A', 'ABE', 'Matematik', 'A101', '1')), gpu002: text('3,1,1,1,"8A","ABE","Matematik"') });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons[0]).toMatchObject({ weeks: 'ALL', from: null, to: null });
  });
});

describe('tolerance and limits', () => {
  it('reports a missing GPU001 and an empty one', () => {
    expect(codes(readUntisGpu({}))).toEqual(['GPU_NO_GPU001']);
    expect(codes(readUntisGpu({ gpu002: text(row002({ 1: '1' })) }))).toEqual(['GPU_NO_GPU001']);
    for (const empty of ['', '\r\n\r\n', '﻿', ' , ,, ', ';;;\n;;']) expect(codes(readUntisGpu({ gpu001: empty }))).toEqual(['GPU_EMPTY']);
  });

  it('skips a line with too few fields by its physical line number and reads the others', () => {
    const parsed = readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1'), '', '2,"8A","ABE","Svenska"', row001('3', '8A', 'ABE', 'Engelska', 'A101', '2')) });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 3', 'GPU_BAD_FIELD_COUNT']]);
    expect(parsed.lessons.map((l) => [l.ref, l.subject])).toEqual([
      ['GPU001 rad 1', 'Matematik'],
      ['GPU001 rad 4', 'Engelska'],
    ]);
    expect(parsed.problems[0]!.message).toContain('4 fält');
  });

  it('treats a header line as the line it is: a problem on that line, not a lesson', () => {
    const parsed = readUntisGpu({ gpu001: text('Unterr.-Nr.,Klasse,Lehrer,Fach,Raum,Tag,Stunde', row001('1', '8A', 'ABE', 'Matematik', 'A101', '1')) });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 1', 'GPU_BAD_LESSON_NUMBER']]);
    expect(parsed.lessons).toHaveLength(1);
  });

  it('refuses input over MAX_EXCHANGE_BYTES with GPU_TOO_LARGE and reads nothing, whichever file is large', () => {
    const big = '1'.repeat(MAX_EXCHANGE_BYTES + 1);
    expect(codes(readUntisGpu({ gpu001: big }))).toEqual(['GPU_TOO_LARGE']);
    expect(readUntisGpu({ gpu001: big }).lessons).toEqual([]);
    expect(codes(readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1')), gpu002: big }))).toEqual(['GPU_TOO_LARGE']);
    // Bytes, not characters: three-byte characters count three times.
    expect(codes(readUntisGpu({ gpu001: '€'.repeat(Math.floor(MAX_EXCHANGE_BYTES / 3) + 1) }))).toEqual(['GPU_TOO_LARGE']);
  });

  it('accepts exactly MAX_EXCHANGE_LESSONS lessons and refuses one more with GPU_TOO_MANY_LESSONS', () => {
    const many = (n: number): string => text(...Array.from({ length: n }, (_, i) => row001(String(i + 1), '8A', 'ABE', 'Matematik', 'A101', '1')));
    const ok = readUntisGpu({ gpu001: many(MAX_EXCHANGE_LESSONS) });
    expect(ok.problems).toEqual([]);
    expect(ok.lessons).toHaveLength(MAX_EXCHANGE_LESSONS);
    const over = readUntisGpu({ gpu001: many(MAX_EXCHANGE_LESSONS + 1) });
    expect(codes(over)).toEqual(['GPU_TOO_MANY_LESSONS']);
    expect(over.lessons).toEqual([]);
  });

  it('refuses a file of more than eight lines per accepted lesson before parsing it, for either file', () => {
    const lines = (n: number): string => 'x\n'.repeat(n);
    const limit = MAX_EXCHANGE_LESSONS * 8;
    expect(codes(readUntisGpu({ gpu001: lines(limit - 1) }))).not.toContain('GPU_TOO_MANY_LESSONS');
    const gpu001 = readUntisGpu({ gpu001: lines(limit + 1) });
    expect(gpu001.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001', 'GPU_TOO_MANY_LESSONS']]);
    expect(gpu001.lessons).toEqual([]);
    const gpu002 = readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1')), gpu002: lines(limit + 1) });
    expect(gpu002.problems.map((p) => [p.ref, p.code])).toEqual([['GPU002', 'GPU_TOO_MANY_LESSONS']]);
    expect(gpu002.lessons).toEqual([]);
    // A file with CR line ends only is counted the same way.
    expect(codes(readUntisGpu({ gpu001: 'x\r'.repeat(limit + 1) }))).toEqual(['GPU_TOO_MANY_LESSONS']);
  });

  it('refuses a line with a field over 2000 characters, in either file, and reads the lines around it', () => {
    const fine = 'a'.repeat(2000);
    const long = 'a'.repeat(2001);
    const parsed = readUntisGpu({
      gpu001: text(row001('1', '8A', 'ABE', fine, 'A101', '1'), row001('2', '8A', 'ABE', long, 'A101', '1'), row001('3', '8A', 'ABE', 'Svenska', 'A101', '2')),
    });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 2', 'GPU_FIELD_TOO_LONG']]);
    expect(parsed.lessons.map((l) => l.subject.length)).toEqual([2000, 7]);

    const row = row002({ 1: '3', 5: '8A', 6: 'ABE', 7: 'Svenska', 12: long });
    const second = readUntisGpu({ gpu001: text(row001('3', '8A', 'ABE', 'Svenska', 'A101', '2')), gpu002: text(row) });
    expect(second.problems.map((p) => [p.ref, p.code])).toEqual([
      ['GPU002 rad 1', 'GPU_FIELD_TOO_LONG'],
      ['GPU001 rad 1', 'GPU_NO_GPU002_ROW'],
    ]);
  });

  it('numbers lines the way an editor does when a quoted field holds a line break', () => {
    const parsed = readUntisGpu({ gpu001: '1,"8A","ABE","Mate\nmatik","A101",1,510,00:45\r\nx,y\r\n' });
    expect(parsed.lessons[0]).toMatchObject({ ref: 'GPU001 rad 1', subject: 'Mate matik' });
    expect(parsed.problems.map((p) => p.ref)).toEqual(['GPU001 rad 3']);
  });

  it('reads blanks before a quote and text after the closing quote, and a last line that ends in a separator', () => {
    const parsed = readUntisGpu({ gpu001: '1,  "8A" ,"ABE","Mate"matik,"A101",1,510,00:45,' });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons[0]).toMatchObject({ group: '8A', subject: 'Matematik' });
  });

  it('reads an unterminated quote as the rest of the file, without throwing', () => {
    const parsed = readUntisGpu({ gpu001: '1,"8A,ABE,Matematik,A101,1,510,00:45\r\n2,8A,ABE,Svenska,A101,1,510,00:45\r\n' });
    expect(parsed.lessons).toEqual([]);
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 1', 'GPU_BAD_FIELD_COUNT']]);
  });

  it('keeps a bounded list of problems for a file of nothing but bad lines', () => {
    const parsed = readUntisGpu({ gpu001: text(...Array.from({ length: 2000 }, () => 'x,y')) });
    expect(parsed.lessons).toEqual([]);
    expect(parsed.problems.length).toBeLessThanOrEqual(501);
    expect(parsed.problems[parsed.problems.length - 1]).toMatchObject({ code: 'GPU_TOO_MANY_PROBLEMS' });
    expect(parsed.problems[parsed.problems.length - 1]!.message).toContain('1500');
  });

  it('never throws, whatever the text', () => {
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const alphabet = ['"', ',', ';', '\t', '\r', '\n', '~', ' ', '0', '1', '7', '9', 'A', 'ä', '\u0000', '﻿', '-', '+', ':'];
    for (let i = 0; i < 300; i += 1) {
      let g1 = '';
      let g2 = '';
      const length = next() % 200;
      for (let k = 0; k < length; k += 1) {
        g1 += alphabet[next() % alphabet.length];
        g2 += alphabet[next() % alphabet.length];
      }
      expect(() => readUntisGpu({ gpu001: g1, gpu002: g2, gpu011: g1 })).not.toThrow();
    }
    for (const odd of ['"', '"""', ',,,,,,,,', '"unterminated,1,2,3', '﻿﻿', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16', 'a'.repeat(100_000)]) {
      const parsed = readUntisGpu({ gpu001: odd, gpu002: odd });
      expect(Array.isArray(parsed.lessons)).toBe(true);
      expect(Array.isArray(parsed.problems)).toBe(true);
      expect(Array.isArray(parsed.notes)).toBe(true);
    }
  });

  it('writes its problems in Swedish with stable codes', () => {
    const parsed = readUntisGpu({ gpu001: text('1,2,3', row001('2', '', 'ABE', 'Matematik', 'A101', '1')) });
    expect(parsed.problems.map((p) => p.code)).toEqual(['GPU_BAD_FIELD_COUNT', 'GPU_NO_CLASS']);
    for (const p of parsed.problems) {
      expect(p.message).toMatch(/hoppas över/);
      expect(p.ref).toMatch(/^GPU001 rad \d+$/);
    }
  });
});

describe('personnummer', () => {
  const PN = '850312-5678';
  const echoes = (value: unknown): boolean => /850312|5678/.test(JSON.stringify(value));

  it('drops a personnummer-like value in a column the codec does not read, never echoes it, and says how many in a note', () => {
    // Field 9 is Zeilentext 1 in the 16-field revision; a school could have typed anything there.
    const line = `${row001('1', '8A', 'ABE', 'Matematik', 'A101', '1')},"${PN}","19850312-5678"`;
    const parsed = readUntisGpu({ gpu001: text(line) });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons).toHaveLength(1);
    expect(echoes(parsed)).toBe(false);
    expect(countNotes(parsed.notes, '2 fält')).toBe(1);
    expect(parsed.notes.find((n) => n.includes('personnummer'))).toBeDefined();
  });

  it('skips a line where a column the codec reads holds one, with a problem that does not repeat it', () => {
    for (const where of [2, 3, 4, 5]) {
      const fields = ['1', '"8A"', '"ABE"', '"Matematik"', '"A101"', '1', '510', '00:45'];
      fields[where - 1] = `"${PN}"`;
      const parsed = readUntisGpu({ gpu001: text(fields.join(','), row001('2', '8A', 'ABE', 'Svenska', 'A101', '2')) });
      expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 1', 'GPU_PERSONNUMMER_DROPPED']]);
      expect(parsed.lessons.map((l) => l.subject)).toEqual(['Svenska']);
      expect(echoes(parsed)).toBe(false);
    }
  });

  it('also recognises the forms without a hyphen, with + and with a four-digit year', () => {
    for (const value of ['8503125678', '850312+5678', '198503125678', '19850312-5678', '850372-5678']) {
      const parsed = readUntisGpu({ gpu001: text(`1,"8A","${value}","Matematik","A101",1,510,00:45`) });
      expect(codes(parsed)).toEqual(['GPU_PERSONNUMMER_DROPPED']);
      expect(JSON.stringify(parsed)).not.toContain('5678');
    }
  });

  it('does not mistake an ordinary value for one', () => {
    // 991399-1234 has month 13; 123456-7890 has month 34; 20260817 is a date; 1 is a number; A101 a room.
    for (const value of ['991399-1234', '123456-7890', '2026081', '12345678', 'A101']) {
      const parsed = readUntisGpu({ gpu001: text(`1,"8A","ABE","Matematik","${value}",1,510,00:45`) });
      expect(parsed.problems).toEqual([]);
      expect(parsed.lessons[0]!.room).toBe(value);
    }
  });

  it('applies to GPU002 too: a read column skips the row, an unread one only counts', () => {
    const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1'));
    const skipped = readUntisGpu({ gpu001, gpu002: text(row002({ 1: '1', 5: '8A', 6: 'ABE', 7: 'Matematik', 42: PN })) });
    expect(codes(skipped)).toEqual(['GPU_PERSONNUMMER_DROPPED', 'GPU_NO_GPU002_ROW']);
    expect(skipped.problems[0]!.ref).toBe('GPU002 rad 1');
    expect(echoes(skipped)).toBe(false);

    const counted = readUntisGpu({ gpu001, gpu002: text(row002({ 1: '1', 5: '8A', 6: 'ABE', 7: 'Matematik', 13: PN, 21: PN })) });
    expect(counted.problems).toEqual([]);
    expect(counted.lessons[0]!.group).toBe('8A');
    expect(echoes(counted)).toBe(false);
    expect(countNotes(counted.notes, '2 fält')).toBe(1);
  });

  it('is not in the words of the notes when there is none', () => {
    expect(readUntisGpu(writeUntisGpu(highSchoolDocument())).notes.some((n) => n.includes('personnummer'))).toBe(false);
  });
});

// ─── The review of PR #256: personnummer anywhere in a field (H1) ────────────

describe('personnummer anywhere in a field', () => {
  /** Every way the review found that a number gets past a test of the whole field. */
  const EMBEDDED: Record<string, string> = {
    'namn och ÅÅÅÅMMDD-NNNN': 'Anna Berg 19800101-1234',
    'parentes (ÅÅMMDD-NNNN)': '(800101-1234)',
    'mellanslag runt bindestrecket': '19800101 - 1234',
    'ÅÅMMDD+NNNN i en text': 'f. 800101+1234 d.',
    'samordningsnummer i en text': 'Sam 19800181-1234 x',
    'tio siffror': '8001011234',
    'tolv siffror': '198001011234',
  };
  const leaked = (value: unknown): boolean => /1980|8001|1234/.test(JSON.stringify(value));

  const LINE_001 = ['1', '"8A"', '"ABE"', '"Matematik"', '"A101"', '1', '510', '00:45', '"Text 1"', '"Text 2"', '13:00', '14:00', '"x"', '"y"', '"z"', '"w"'];
  const NUMERIC_001 = new Set([0, 5, 6, 7, 10, 11]);
  const line001With = (index: number, value: string): string => {
    const fields = [...LINE_001];
    fields[index] = NUMERIC_001.has(index) ? value : `"${value}"`;
    return fields.join(',');
  };

  it('has a control: the untouched line reads clean', () => {
    const parsed = readUntisGpu({ gpu001: text(LINE_001.join(',')) });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons).toHaveLength(1);
  });

  it('skips a GPU001 line whose Unterr.-Nr., Klasse, Lehrer, Fach, Raum, Tag, Stunde or Stundenlänge holds one, in every form, and echoes nothing', () => {
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const [form, value] of Object.entries(EMBEDDED)) {
        const parsed = readUntisGpu({ gpu001: text(line001With(index, value), row001('2', '8A', 'ABE', 'Svenska', 'A101', '2')) });
        expect({ index, form, problems: parsed.problems.map((p) => [p.ref, p.code]) }).toEqual({ index, form, problems: [['GPU001 rad 1', 'GPU_PERSONNUMMER_DROPPED']] });
        expect({ index, form, lessons: parsed.lessons.map((l) => l.subject) }).toEqual({ index, form, lessons: ['Svenska'] });
        expect({ index, form, leaked: leaked(parsed) }).toEqual({ index, form, leaked: false });
      }
    }
  });

  it('blanks one in a GPU001 field the reader does not read, keeps the line, counts it in the note and echoes nothing', () => {
    for (const index of [8, 9, 10, 11, 12, 13, 14, 15]) {
      for (const [form, value] of Object.entries(EMBEDDED)) {
        const parsed = readUntisGpu({ gpu001: text(line001With(index, value)) });
        expect({ index, form, problems: parsed.problems }).toEqual({ index, form, problems: [] });
        expect({ index, form, lessons: parsed.lessons.length }).toEqual({ index, form, lessons: 1 });
        expect({ index, form, leaked: leaked(parsed) }).toEqual({ index, form, leaked: false });
        expect({ index, form, noted: countNotes(parsed.notes, '1 fält') }).toEqual({ index, form, noted: 1 });
      }
    }
  });

  it('finds one in a field that is not quoted, with spaces in it, in a semicolon file too', () => {
    const parsed = readUntisGpu({ gpu001: '1;8A;ABE;Matematik;Rum 19800101 - 1234 ;1;510;00:45\r\n2;8A;ABE;Svenska;A101;2;510;00:45\r\n' });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 1', 'GPU_PERSONNUMMER_DROPPED']]);
    expect(parsed.lessons.map((l) => l.subject)).toEqual(['Svenska']);
    expect(leaked(parsed)).toBe(false);
  });

  it('finds one that a quoted field breaks over two physical lines, since the field is tested whole', () => {
    const parsed = readUntisGpu({ gpu001: text('1,"8A","ABE","Matematik","Rum 19800101\n-1234",1,510,00:45', row001('2', '8A', 'ABE', 'Svenska', 'A101', '2')) });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU001 rad 1', 'GPU_PERSONNUMMER_DROPPED']]);
    expect(leaked(parsed)).toBe(false);
  });

  it('tests every one of the 45 GPU002 fields: a field the reader reads skips the row, any other is blanked and only counted', () => {
    const readIndexes = new Set([0, 4, 5, 6, 7, 11, 14, 15, 41]);
    const textIndexes = new Set([4, 5, 6, 7, 11, 41]);
    const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1'));
    for (let index = 0; index < 45; index += 1) {
      for (const [form, value] of Object.entries(EMBEDDED)) {
        const fields = new Array<string>(45).fill('');
        fields[0] = '1';
        fields[4] = '"8A"';
        fields[5] = '"ABE"';
        fields[6] = '"Matematik"';
        fields[11] = '"A-vecka"';
        fields[index] = index === 0 || !textIndexes.has(index) ? value : `"${value}"`;
        const parsed = readUntisGpu({ gpu001, gpu002: text(fields.join(',')) });
        const where = { index, form };
        expect({ ...where, leaked: leaked(parsed) }).toEqual({ ...where, leaked: false });
        if (readIndexes.has(index)) {
          expect({ ...where, codes: codes(parsed) }).toEqual({ ...where, codes: ['GPU_PERSONNUMMER_DROPPED', 'GPU_NO_GPU002_ROW'] });
          expect({ ...where, weeks: parsed.lessons[0]!.weeks }).toEqual({ ...where, weeks: 'ALL' });
        } else {
          expect({ ...where, problems: parsed.problems }).toEqual({ ...where, problems: [] });
          // The row was used: the week pattern in field 12 reached the lesson.
          expect({ ...where, weeks: parsed.lessons[0]!.weeks }).toEqual({ ...where, weeks: 'ODD' });
          expect({ ...where, noted: countNotes(parsed.notes, '1 fält') }).toEqual({ ...where, noted: 1 });
        }
      }
    }
  });

  it('does not take an ordinary text with digits in it for one', () => {
    for (const value of ['Sal 12 (2026-2027)', 'Rum 1234 och 5678', 'v. 34-35, 2026', 'A101 / A102 / A103', '2026-08-17 till 2026-12-18']) {
      const parsed = readUntisGpu({ gpu001: text(`1,"8A","ABE","Matematik","${value}",1,510,00:45`) });
      expect({ value, problems: parsed.problems }).toEqual({ value, problems: [] });
      expect(parsed.lessons[0]!.room).toBe(value);
    }
  });

  describe('what a message quotes of the file', () => {
    it('is control: a number in the shape the filter does not know gets past it, which is why the message must not quote it', () => {
      expect(hasPersonalNumber('1980:01:01#1234')).toBe(false);
      expect(hasPersonalNumber('19800101#1234')).toBe(false);
    });

    it('quotes a short value as it is', () => {
      const parsed = readUntisGpu({ gpu001: text('1,"8A","ABE","Matematik","A101",tisdag,510,00:45') });
      expect(parsed.problems[0]!.message).toContain('”tisdag”');
    });

    it('quotes at most 40 characters of a value, cut with an ellipsis, on one line', () => {
      const parsed = readUntisGpu({ gpu001: text(`1,"8A","ABE","Matematik","A101","${'x'.repeat(100)}",510,00:45`) });
      expect(parsed.problems[0]!.message).toContain(`”${'x'.repeat(40)}…”`);
      expect(parsed.problems[0]!.message).not.toContain('x'.repeat(41));
    });

    it('does not quote a value with ten digits or more, however they are separated, in any message that quotes the file', () => {
      const odd = '1980:01:01#1234';
      const grid: UntisPeriod[] = [{ number: 1, start: '08:30', end: '09:15' }];
      const cases: Array<[string, string, ReturnType<typeof readUntisGpu>]> = [
        ['Tag', 'GPU_BAD_DAY', readUntisGpu({ gpu001: text(`1,"8A","ABE","Matematik","A101","${odd}",510,00:45`) })],
        ['Unterr.-Nr.', 'GPU_BAD_LESSON_NUMBER', readUntisGpu({ gpu001: text(`${odd},"8A","ABE","Matematik","A101",1,510,00:45`) })],
        ['Stunde, minutform', 'GPU_BAD_TIME', readUntisGpu({ gpu001: text(`1,"8A","ABE","Matematik","A101",1,"${odd}",00:45`) })],
        ['Stundenlänge', 'GPU_BAD_TIME', readUntisGpu({ gpu001: text(`1,"8A","ABE","Matematik","A101",1,510,"${odd}"`) })],
        ['Stunde, periodform', 'GPU_BAD_PERIOD', readUntisGpu({ gpu001: text(`1,"8A","ABE","Matematik","A101",1,"${odd}",`) }, { periods: grid })],
        [
          'GPU002 Unt-Nummer',
          'GPU_BAD_LESSON_NUMBER',
          readUntisGpu({ gpu001: text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1')), gpu002: text(`${odd},,,,"8A","ABE","Matematik"`) }),
        ],
      ];
      for (const [where, code, parsed] of cases) {
        expect({ where, codes: codes(parsed).slice(0, 1) }).toEqual({ where, codes: [code] });
        expect({ where, message: parsed.problems[0]!.message }).toEqual({ where, message: expect.stringContaining('[siffror utelämnade]') });
        expect({ where, leaked: leaked(parsed) }).toEqual({ where, leaked: false });
      }
    });

    it('does not quote such a value in the note on a group text that is left alone either', () => {
      const parsed = readUntisGpu({
        gpu001: text(row001('1', '7A', 'FAL', 'Slöjd', 'Slöjdsalen', '2')),
        gpu002: text(row002({ 1: '1', 5: '7A', 6: 'FAL', 7: 'Slöjd', 12: 'Grupp 1980:01:01#1234' })),
      });
      expect(parsed.problems).toEqual([]);
      expect(countNotes(parsed.notes, '[siffror utelämnade]')).toBe(1);
      expect(leaked(parsed)).toBe(false);
    });

    it('sees the digits of a number that starts before the cut or after a run of blanks, and leaves a long text with digits far out alone', () => {
      const tag = (value: string): string => readUntisGpu({ gpu001: text(`1,"8A","ABE","Matematik","A101","${value}",510,00:45`) }).problems[0]!.message;
      expect(tag(`${'x'.repeat(35)}1980:01:01#1234`)).toContain('[siffror utelämnade]');
      expect(tag(`x${' '.repeat(1000)}1980:01:01#1234`)).toContain('[siffror utelämnade]');
      const farOut = tag(`${'x'.repeat(60)}1980:01:01#1234`);
      expect(farOut).toContain(`”${'x'.repeat(40)}…”`);
      expect(farOut).not.toMatch(/1980|1234/);
    });

    it('does quote a value with a few digits in it: a lesson number "1b" is not a secret', () => {
      const parsed = readUntisGpu({ gpu001: text(row001('1b', '8A', 'ABE', 'Matematik', 'A101', '1')) });
      expect(parsed.problems[0]!.message).toContain('”1b”');
    });
  });
});

// ─── The Gruppe field read word by word, and its cap (H4) ────────────────────

describe('the Gruppe field as a week pattern (CHOICE 9)', () => {
  const gpu001 = text(row001('1', '7A', 'FAL', 'Slöjd', 'Slöjdsalen', '2', '780', '01:20'));
  const read = (group: string): ReturnType<typeof readUntisGpu> =>
    readUntisGpu({ gpu001, gpu002: text(row002({ 1: '1', 5: '7A', 6: 'FAL', 7: 'Slöjd', 12: group })) });
  const weeksFor = (group: string): string => read(group).lessons[0]!.weeks;

  it.each([
    ['Vecka-A', 'ODD'],
    ['A - vecka', 'ODD'],
    ['a   Woche', 'ODD'],
    ['Week-B', 'EVEN'],
    ['Jämn-vecka', 'EVEN'],
    ['vecka - jämn', 'EVEN'],
    ['  B-VECKA  ', 'EVEN'],
    ['Ungerade-Woche', 'ODD'],
    ['Gerade', 'EVEN'],
    ['Alla veckor'.slice(0, 4), 'ALL'],
  ])('reads %j as %s', (group, weeks) => {
    expect(weeksFor(group)).toBe(weeks);
  });

  it.each(['vecka', 'Woche', 'week', 'vecka vecka', '---', '- -', 'A vecka B', 'Aa-vecka', 'vecka2', 'varje vecka', 'every week', 'G1-vecka'])(
    'does not take %j for a pattern: every week, and the text is named in the note',
    (group) => {
      const parsed = read(group);
      expect(parsed.lessons[0]!.weeks).toBe('ALL');
      expect(parsed.problems).toEqual([]);
      expect(countNotes(parsed.notes, 'ignoreras')).toBe(1);
      expect(countNotes(parsed.notes, 'tolkades som veckomönster')).toBe(0);
    },
  );

  it('reads a pattern of exactly 200 characters and treats one of 201 as a group name that is left alone', () => {
    const padded = (length: number): string => `A${' '.repeat(length - 'A'.length - 'vecka'.length)}vecka`;
    expect(padded(200)).toHaveLength(200);
    expect(weeksFor(padded(200))).toBe('ODD');
    const over = read(padded(201));
    expect(over.lessons[0]!.weeks).toBe('ALL');
    expect(over.problems).toEqual([]);
    expect(countNotes(over.notes, 'ignoreras')).toBe(1);
  });

  it('treats a long text as no pattern, names its start once and quotes it short', () => {
    const long = `Spanska steg tre ${'för åk åtta och nio, grupp A, '.repeat(20)}`;
    expect(long.length).toBeGreaterThan(200);
    const parsed = read(long);
    expect(parsed.lessons[0]!.weeks).toBe('ALL');
    expect(parsed.problems).toEqual([]);
    const note = parsed.notes.find((n) => n.includes('ignoreras'))!;
    expect(note).toContain(`”${long.slice(0, 40)}…”`);
    expect(note.length).toBeLessThan(400);
  });

  it('names at most three different group texts in one note, however many rows have one', () => {
    const rows = Array.from({ length: 300 }, (_v, i) => row002({ 1: String(i + 1), 5: '7A', 6: 'FAL', 7: 'Slöjd', 12: `Grupp ${'x'.repeat(250)} ${i}` }));
    const lines001 = Array.from({ length: 300 }, (_v, i) => row001(String(i + 1), '7A', 'FAL', 'Slöjd', 'Slöjdsalen', '2', String(480 + i), '00:45'));
    const parsed = readUntisGpu({ gpu001: text(...lines001), gpu002: text(...rows) });
    expect(parsed.lessons).toHaveLength(300);
    expect(parsed.problems).toEqual([]);
    expect(parsed.notes.filter((n) => n.includes('ignoreras'))).toHaveLength(1);
    // Every long text starts the same way, so they are one distinct quote.
    expect((parsed.notes.find((n) => n.includes('ignoreras'))!.match(/”/g) ?? []).length).toBe(2);
  });
});

// ─── What a stranger's file may cost (H4) ────────────────────────────────────

/**
 * CPU time rather than the clock on the wall: the host these run on is shared and
 * the wall clock counts the other processes too. The bounds are many times what
 * the fixed reader needs (tens to a few hundred milliseconds) and far under what
 * the unfixed one needed (2 to 44 seconds), so a loaded machine does not fail
 * them and a regression does. Every case is the same input at several sizes, so
 * that a change that is only less bad is caught too.
 */
const BOUND_MS = 1500;

function cpuMillis<T>(body: () => T): { result: T; ms: number } {
  const before = process.cpuUsage();
  const result = body();
  const used = process.cpuUsage(before);
  return { result, ms: (used.user + used.system) / 1000 };
}

describe('what a stranger’s file may cost', () => {
  const longRow002 = (n: number, group: string): string => {
    const f = new Array<string>(45).fill('');
    f[0] = String(n);
    f[4] = '"7A"';
    f[5] = '"AB"';
    f[6] = '"Matematik"';
    f[11] = `"${group}"`;
    return f.join(',');
  };
  const lines001 = (n: number): string => Array.from({ length: n }, (_v, i) => `${i + 1},"7A","AB","Matematik","",1,${480 + (i % 100) * 5},01:00`).join('\r\n');
  const repeated = (filler: string, length: number): string => filler.repeat(Math.max(1, Math.floor(length / filler.length)));

  describe('the Gruppe field of GPU002 (200 characters is the cap)', () => {
    const fillers = [' ', '-', ' -', '- ', 'A ', '- A', 'A-B ', 'vecka ', '-vecka', 'vecka-', ' vecka -', '1', '1 ', 'ä'];
    for (const length of [10, 100, 200, 201, 500, 1000, 1990]) {
      it(`300 rows whose field is each of ${fillers.length} fillers, ${length} characters long`, () => {
        for (const filler of fillers) {
          const gpu002 = Array.from({ length: 300 }, (_v, i) => longRow002(i + 1, repeated(filler, length))).join('\r\n');
          const { ms, result } = cpuMillis(() => readUntisGpu({ gpu001: lines001(300), gpu002 }));
          expect({ filler, length, tooSlow: ms >= BOUND_MS }).toEqual({ filler, length, tooSlow: false });
          expect(result.lessons).toHaveLength(300);
        }
      });
    }
  });

  describe('a GPU001 field of the longest size the reader takes (1 990 characters)', () => {
    const fillers = ['1', '1 ', '-', ' ', '- ', ':', '1:', '0:0', ',', 'a,', '~', '12345678 ', '19800101-', '"" '];
    const fieldNames = ['Unterr.-Nr.', 'Klasse', 'Lehrer', 'Fach', 'Raum', 'Tag', 'Stunde', 'Stundenlänge'];
    it.each(fieldNames.map((name, index) => [name, index] as const))('%s, with each filler, 150 lines', (_name, index) => {
      for (const filler of fillers) {
        const long = repeated(filler, 1990).slice(0, 1990).replace(/"/g, '');
        const lines = Array.from({ length: 150 }, (_v, i) => {
          const fields = [String(i + 1), '"7A"', '"AB"', '"Matematik"', '"A101"', '1', '510', '00:45'];
          fields[index] = `"${long}"`;
          return fields.join(',');
        });
        const { ms, result } = cpuMillis(() => readUntisGpu({ gpu001: lines.join('\r\n') }));
        expect({ filler, tooSlow: ms >= BOUND_MS }).toEqual({ filler, tooSlow: false });
        expect(result.problems.length).toBeLessThanOrEqual(501);
      }
    });

    it('all four text fields long at once, with each filler, 300 lines', () => {
      for (const filler of fillers) {
        const long = repeated(filler, 1990).slice(0, 1990).replace(/"/g, '');
        const lines = Array.from({ length: 300 }, (_v, i) => `${i + 1},"${long}","${long}","${long}","${long}",1,510,00:45`);
        const { ms } = cpuMillis(() => readUntisGpu({ gpu001: lines.join('\r\n') }));
        expect({ filler, tooSlow: ms >= BOUND_MS }).toEqual({ filler, tooSlow: false });
      }
    });
  });

  describe('a GPU002 row of 45 long fields', () => {
    it.each(['1', '1 ', '-', ' - ', '0:', 'a,', '12345678-'])('%j, 40 rows', (filler) => {
      const long = repeated(filler, 1990).slice(0, 1990);
      const row = Array.from({ length: 45 }, () => `"${long.replace(/"/g, '')}"`).join(',');
      const { ms, result } = cpuMillis(() =>
        readUntisGpu({ gpu001: text(row001('1', '7A', 'ABE', 'Matematik', 'A101', '1')), gpu002: Array.from({ length: 40 }, () => row).join('\r\n') }),
      );
      expect(ms).toBeLessThan(BOUND_MS);
      expect(result.problems.length).toBeLessThanOrEqual(501);
    });
  });

  describe('a file of as many lines as the reader takes', () => {
    const MANY = MAX_EXCHANGE_LESSONS * 8 - 10;

    it('lines of one lesson that differ only in the teacher are merged without comparing every line with every other', () => {
      const lines = Array.from({ length: MANY }, (_v, i) => `1,"8A","T${i}","Matematik","A101",1,510,00:45`);
      const { ms, result } = cpuMillis(() => readUntisGpu({ gpu001: lines.join('\r\n') }));
      expect(ms).toBeLessThan(BOUND_MS);
      expect(result.lessons).toEqual([]);
      expect(codes(result)).toEqual(['GPU_TOO_MANY_TEACHERS']);
    });

    it('lines of one lesson that differ only in the class are merged into one lesson with all of them', () => {
      const lines = Array.from({ length: MANY }, (_v, i) => `1,"C${i}","T","Matematik","A101",1,510,00:45`);
      const { ms, result } = cpuMillis(() => readUntisGpu({ gpu001: lines.join('\r\n') }));
      expect(ms).toBeLessThan(BOUND_MS);
      expect(result.problems).toEqual([]);
      expect(result.lessons).toHaveLength(1);
      expect(result.lessons[0]!.extraGroups).toHaveLength(MANY - 1);
      expect(countNotes(result.notes, 'flera klasser')).toBe(1);
    });

    it.each([[2000, 15_000], [5000, 35_000]])('%i lessons against %i GPU002 rows that all carry the same lesson number (nothing matches)', (lessons, rows) => {
      const gpu001 = Array.from({ length: lessons }, (_v, i) => `1,"X${i}","TX${i}","S${i}","R${i}",1,510,00:45`).join('\r\n');
      const gpu002 = Array.from({ length: rows }, (_v, i) => `1,,,,"C${i}","T${i}","Sub${i}"`).join('\r\n');
      const { ms, result } = cpuMillis(() => readUntisGpu({ gpu001, gpu002 }));
      expect(ms).toBeLessThan(BOUND_MS * 2);
      expect(result.lessons).toHaveLength(lessons);
      expect(codes(result)).toEqual(['GPU_TOO_MANY_ROWS']);
    });

    it.each([[2000, 15_000], [5000, 35_000]])('%i lessons against %i GPU002 rows that all match, and carry two different week patterns', (lessons, rows) => {
      const gpu001 = Array.from({ length: lessons }, (_v, i) => `1,"X","TX","S","R${i}",1,510,00:45`).join('\r\n');
      const gpu002 = Array.from({ length: rows }, (_v, i) => `1,,,,"X","TX","S",,,,,"${i % 2 === 0 ? 'A' : 'B'}-vecka"`).join('\r\n');
      const { ms, result } = cpuMillis(() => readUntisGpu({ gpu001, gpu002 }));
      expect(ms).toBeLessThan(BOUND_MS * 2);
      expect(result.lessons).toHaveLength(lessons);
      // The 500 rows that are read alternate between the weeks, so each lesson is ambiguous and says so.
      expect(codes(result).filter((c) => c === 'GPU_AMBIGUOUS_ROW').length).toBeGreaterThan(0);
    });
  });
});

describe('at most 500 GPU002 rows are read for one lesson number (CHOICE 14)', () => {
  const gpu001 = text(row001('1', '8A', 'ABE', 'Matematik', 'A101', '1'), row001('2', '8B', 'BLU', 'Svenska', 'A102', '2'));
  const rowsOf = (no: number, count: number, group: (i: number) => string): string[] =>
    Array.from({ length: count }, (_v, i) => row002({ 1: String(no), 5: no === 1 ? '8A' : '8B', 6: no === 1 ? 'ABE' : 'BLU', 7: no === 1 ? 'Matematik' : 'Svenska', 12: group(i) }));

  it('reads exactly 500 rows without a word', () => {
    const parsed = readUntisGpu({ gpu001, gpu002: text(...rowsOf(1, 500, () => 'A-vecka'), ...rowsOf(2, 1, () => '')) });
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons.map((l) => l.weeks)).toEqual(['ODD', 'ALL']);
  });

  it('names the number once, on the first row left out, and does not read that row or the ones after it', () => {
    // The 501st row says B-vecka; if it were read the lesson would be ambiguous.
    const gpu002 = text(...rowsOf(1, 500, () => 'A-vecka'), ...rowsOf(1, 20, () => 'B-vecka'), ...rowsOf(2, 1, () => 'B-vecka'));
    const parsed = readUntisGpu({ gpu001, gpu002 });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([['GPU002 rad 501', 'GPU_TOO_MANY_ROWS']]);
    expect(parsed.problems[0]!.message).toContain('Lektionsnummer 1');
    expect(parsed.problems[0]!.message).toContain('500');
    expect(parsed.lessons.map((l) => l.weeks)).toEqual(['ODD', 'EVEN']);
  });

  it('names each crowded number once', () => {
    const gpu002 = text(...rowsOf(1, 503, () => 'A-vecka'), ...rowsOf(2, 502, () => 'B-vecka'));
    const parsed = readUntisGpu({ gpu001, gpu002 });
    expect(parsed.problems.map((p) => [p.ref, p.code])).toEqual([
      ['GPU002 rad 501', 'GPU_TOO_MANY_ROWS'],
      ['GPU002 rad 1004', 'GPU_TOO_MANY_ROWS'],
    ]);
  });
});

describe('the lessons are counted before GPU002 is joined (CHOICE 14, LIMITS)', () => {
  const many = (n: number): string => text(...Array.from({ length: n }, (_v, i) => row001(String(i + 1), '8A', 'ABE', 'Matematik', 'A101', '1')));

  it('refuses too many lessons with the one problem, not with a problem per lesson that has no GPU002 row', () => {
    const parsed = readUntisGpu({ gpu001: many(MAX_EXCHANGE_LESSONS + 1), gpu002: text(row002({ 1: '1', 5: '8A', 6: 'ABE', 7: 'Matematik' })) });
    expect(parsed.lessons).toEqual([]);
    expect(codes(parsed)).toEqual(['GPU_TOO_MANY_LESSONS']);
    expect(parsed.problems[0]!.message).toContain(String(MAX_EXCHANGE_LESSONS + 1));
  });

  it('counts only the lessons it would read: ones refused for their teachers do not count against the limit', () => {
    const three = ['EST', 'FAL', 'GUS'].map((t) => row001('9999', '8A', t, 'Idrott', 'Gym', '4'));
    const parsed = readUntisGpu({ gpu001: text(...Array.from({ length: MAX_EXCHANGE_LESSONS }, (_v, i) => row001(String(i + 1), '8A', 'ABE', 'Matematik', 'A101', '1')), ...three) });
    expect(parsed.lessons).toHaveLength(MAX_EXCHANGE_LESSONS);
    expect(codes(parsed)).toEqual(['GPU_TOO_MANY_TEACHERS']);
  });
});

// ─── The writer says what it changed (LÅG-4) ─────────────────────────────────

describe('listSafeChanges: names the writer had to change', () => {
  const docWith = (lessons: ExchangeLesson[]): ExchangeDocument => ({ ...snapshotDocument(), lessons });
  const lessonOf = (more: Partial<ExchangeLesson>): ExchangeLesson =>
    blankLesson({ ref: '', group: '7A', subject: 'Matematik', teachers: [], room: null, day: 1, start: '08:00', end: '08:45', ...more });

  it('says nothing for documents whose names are written as they are', () => {
    expect(listSafeChanges(smallSchoolDocument())).toEqual([]);
    expect(listSafeChanges(highSchoolDocument())).toEqual([]);
    expect(listSafeChanges(snapshotDocument())).toEqual([]);
    expect(listSafeChanges({ ...snapshotDocument(), lessons: [] })).toEqual([]);
  });

  it('says in Swedish, with the real names, what a signature was written as and why', () => {
    const notes = listSafeChanges(docWith([lessonOf({ teachers: [teacher('A,B', 'Anna B', null)] })]));
    expect(notes).toEqual([
      'Signaturen ”A,B” skrevs som ”A B” i GPU001 och GPU002, eftersom komma och tilde skiljer namnen åt i Untis fält med flera värden.',
    ]);
  });

  it('says it for a tilde, a class, an extra class and a room, each with its own word and files', () => {
    const notes = listSafeChanges(
      docWith([lessonOf({ group: '7A,x', extraGroups: ['8~B'], teachers: [teacher('C~D', 'C D', null)], room: 'Sal 1, vån 2' })]),
    );
    expect(notes).toEqual([
      'Gruppen ”7A,x” skrevs som ”7A x” i GPU001 och GPU002, eftersom komma och tilde skiljer namnen åt i Untis fält med flera värden.',
      'Gruppen ”8~B” skrevs som ”8 B” i GPU001 och GPU002, eftersom komma och tilde skiljer namnen åt i Untis fält med flera värden.',
      'Signaturen ”C~D” skrevs som ”C D” i GPU001 och GPU002, eftersom komma och tilde skiljer namnen åt i Untis fält med flera värden.',
      'Rummet ”Sal 1, vån 2” skrevs som ”Sal 1 vån 2” i GPU002 (Fachraum), eftersom komma och tilde skiljer namnen åt i Untis fält med flera värden.',
    ]);
  });

  it('says it once for a name however many lessons carry it, and falls back to the teacher name like the writer does', () => {
    const named: TeacherRef = { short: null, name: 'Nina,Nord', email: null, id: null };
    const notes = listSafeChanges(docWith([lessonOf({ teachers: [named] }), lessonOf({ day: 2, teachers: [named, teacher('A,B', 'x', null)] }), lessonOf({ day: 3, teachers: [teacher('A,B', 'x', null)] })]));
    expect(notes.map((n) => n.replace(/ i GPU001.*$/, ''))).toEqual(['Signaturen ”A,B” skrevs som ”A B”', 'Signaturen ”Nina,Nord” skrevs som ”Nina Nord”']);
  });

  it('is the same whatever the order of the lessons', () => {
    const lessons = [lessonOf({ teachers: [teacher('Z,1', 'x', null)] }), lessonOf({ day: 2, teachers: [teacher('A,2', 'x', null)] }), lessonOf({ day: 3, group: '9,x' })];
    expect(listSafeChanges(docWith([...lessons].reverse()))).toEqual(listSafeChanges(docWith(lessons)));
  });

  it('does not report a change the writer does not make: control characters and edges are cleaned, but that is not an ambiguity', () => {
    expect(listSafeChanges(docWith([lessonOf({ group: ' 7A\n', teachers: [teacher('\tABE ', 'x', null)], room: 'A\u0000101' })]))).toEqual([]);
  });

  it('spells out five names and counts the rest in one closing sentence', () => {
    const lessons = (n: number): ExchangeLesson[] => Array.from({ length: n }, (_v, i) => lessonOf({ day: 1 + (i % 7), teachers: [teacher(`T,${i}`, 'x', null)] }));
    const five = listSafeChanges(docWith(lessons(5)));
    expect(five).toHaveLength(5);
    expect(five.every((n) => n.startsWith('Signaturen'))).toBe(true);
    const eight = listSafeChanges(docWith(lessons(8)));
    expect(eight).toHaveLength(6);
    expect(eight.slice(0, 5)).toEqual(five.slice(0, 5));
    expect(eight[5]).toBe('Ytterligare 3 namn med komma eller tilde skrevs om på samma sätt.');
  });

  it('agrees with the writer: what it reports is exactly what comes back different from a round trip', () => {
    const doc = docWith([
      lessonOf({ group: '7A,x', teachers: [teacher('A,B', 'x', null), teacher('CAN', 'x', null)] }),
      lessonOf({ day: 2, group: '8A', teachers: [teacher('DNO', 'x', null)] }),
    ]);
    const parsed = readUntisGpu(writeUntisGpu(doc));
    const names = new Set(parsed.lessons.flatMap((l) => [l.group, ...l.extraGroups, ...l.teachers.map((t) => t.short ?? '')]));
    expect([...names].sort()).toEqual(['7A x', '8A', 'A B', 'CAN', 'DNO']);
    const notes = listSafeChanges(doc);
    expect(notes).toHaveLength(2);
    expect(notes.join('\n')).toContain('”7A,x” skrevs som ”7A x”');
    expect(notes.join('\n')).toContain('”A,B” skrevs som ”A B”');
  });

  it('never quotes a personnummer in a name, and cuts a long name short', () => {
    const notes = listSafeChanges(docWith([lessonOf({ teachers: [teacher('Anna 19800101-1234,x', 'x', null)] }), lessonOf({ day: 2, group: `${'g'.repeat(100)},x` })]));
    expect(JSON.stringify(notes)).not.toMatch(/1980|1234/);
    expect(notes.join('\n')).toContain('[personnummer]');
    expect(notes.join('\n')).toContain(`”${'g'.repeat(40)}…”`);
  });

  it('does not throw for a document the writer refuses, and does not change the writer’s return value', () => {
    const bad = docWith([lessonOf({ start: '8.00', teachers: [teacher('A,B', 'x', null)] })]);
    expect(() => writeUntisGpu(bad)).toThrow(RangeError);
    expect(listSafeChanges(bad)).toHaveLength(1);
    expect(Object.keys(writeUntisGpu(snapshotDocument())).sort()).toEqual(['gpu001', 'gpu002']);
  });
});
