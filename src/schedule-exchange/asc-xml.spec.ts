import { decodeAscBytes, readAscXml, writeAscXml } from './asc-xml';
import { highSchoolDocument, smallSchoolDocument } from './__fixtures__/documents';
import {
  MAX_EXCHANGE_BYTES,
  MAX_EXCHANGE_LESSONS,
  blankLesson,
  type ExchangeDocument,
  type ExchangeLesson,
  type TeacherRef,
} from './exchange-model';
import { parseXml, type XmlNode } from './xml';

/**
 * aSc Timetables XML. One describe per numbered CHOICE in asc-xml.ts, so a
 * decision and its test are found by the same number; first the round trip,
 * which is the acceptance test, and the exact text of a small file, which pins
 * the layout.
 *
 * The hand-written files are built with `mini()` below, a small valid aSc
 * file in which a test changes the one thing it is about, and one larger file
 * (ASC_SAMPLE) written the way aSc's own export is laid out. Both are made up
 * for the tests: no value in them comes from a real school or a real file.
 */

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const ANNA: TeacherRef = { short: 'ABE', name: 'Anna Berg', email: 'anna.berg@skolan.example', id: null };

function lessonOf(more: Partial<ExchangeLesson> = {}): ExchangeLesson {
  return blankLesson({
    ref: '',
    group: '1A',
    subject: 'Matematik',
    subjectCode: 'MA',
    teachers: [ANNA],
    room: 'Klassrum 1',
    day: 1,
    start: '08:30',
    end: '09:15',
    ...more,
  });
}

function docOf(lessons: ExchangeLesson[], more: Partial<ExchangeDocument> = {}): ExchangeDocument {
  return {
    school: 'Lillskolan',
    year: { name: '2026/2027', start: '2026-08-17', end: '2027-06-11' },
    groups: [{ name: '1A', kind: 'CLASS', gradeLevel: 1, halfOf: null }],
    subjects: [{ name: 'Matematik', code: 'MA' }],
    rooms: ['Klassrum 1'],
    teachers: [ANNA],
    lessons,
    ...more,
  };
}

/** What a lesson is for the round trip: the fields the brief names, ids and ref ignored. */
function shape(l: ExchangeLesson): string {
  return JSON.stringify([l.group, l.extraGroups, l.subject, l.teachers.map((t) => t.short), l.room, l.day, l.start, l.end, l.weeks, l.from, l.to]);
}
const multiset = (lessons: ExchangeLesson[]): string[] => lessons.map(shape).sort();

function rowsIn(xml: string, section: string): XmlNode[] {
  return parseXml(xml).children.find((c) => c.name === section)?.children ?? [];
}

const attrs = (over: Record<string, string | null>, base: Record<string, string>): string =>
  Object.entries({ ...base, ...over })
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');

const cardRow = (over: Record<string, string | null> = {}): string =>
  `<card ${attrs(over, { lessonid: 'L1', classroomids: 'R1', period: '1', weeks: '1', terms: '1', days: '10000' })}/>`;
const lessonRow = (over: Record<string, string | null> = {}): string =>
  `<lesson ${attrs(over, { id: 'L1', subjectid: 'S1', classids: 'C1', teacherids: 'T1', classroomids: 'R1', periodspercard: '1', periodsperweek: '1' })}/>`;

const PERIODS_FROM_1 = `<periods><period period="1" starttime="8:00" endtime="8:45"/><period period="2" starttime="8:55" endtime="9:40"/><period period="3" starttime="10:00" endtime="10:45"/><period period="4" starttime="10:55" endtime="11:40"/></periods>`;

interface Mini {
  periods?: string;
  defs?: string;
  lessons?: string[];
  cards?: string[];
  groups?: string;
  root?: string;
  extra?: string;
}

/** A small valid aSc file: one subject, two rooms, three teachers, two classes, one lesson and one card, each replaceable. */
function mini(o: Mini = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<timetable ascttversion="2017.6.10" importtype="database" options="${o.root ?? 'groupstype1'}">
${o.periods ?? PERIODS_FROM_1}
${o.defs ?? ''}
<subjects><subject id="S1" name="Matematik" short="Ma"/></subjects>
<classrooms><classroom id="R1" name="Sal 1"/><classroom id="R2" name="Sal 2"/></classrooms>
<teachers><teacher id="T1" name="Teacher One" short="TO"/><teacher id="T2" name="Teacher Two" short="TW"/><teacher id="T3" firstname="Third" lastname="Teacher" short="TH" email="th@school.example"/></teachers>
<classes><class id="C1" name="7A"/><class id="C2" name="7B"/></classes>
${o.groups ?? '<groups><group id="G1" classid="C1" name="Hela klassen" entireclass="1"/><group id="G2" classid="C2" name="Hela klassen" entireclass="1"/></groups>'}
<lessons>${(o.lessons ?? [lessonRow()]).join('')}</lessons>
<cards>${(o.cards ?? [cardRow()]).join('')}</cards>
${o.extra ?? ''}
</timetable>`;
}

const notesWithoutBlock = (notes: string[]): string[] => notes.filter((n) => !n.includes('parallella block'));
const BLOCK_NOTE = expect.stringContaining('parallella block');
const WEEKS_NOTE = expect.stringContaining('lägen i en rotation');

// ---------------------------------------------------------------------------
// A file laid out the way aSc's own export is (structure after the public
// sample in SOURCES [S12]; names and values invented).
// ---------------------------------------------------------------------------

const ASC_SAMPLE = `<?xml version="1.0" encoding="windows-1252"?>
<timetable ascttversion="2017.6.10" importtype="database" options="export:idprefix:%CHRID,import:idprefix:%TEMPID,groupstype1,decimalseparatordot,lessonsincludeclasseswithoutstudents" defaultexport="1" displayname="aSc Timetables 2012 XML" displaycountries="">
  <periods options="canadd,export:silent" columns="period,name,short,starttime,endtime">
    <period name="1" short="1" period="1" starttime="8:00" endtime="8:45"/>
    <period name="2" short="2" period="2" starttime="8:55" endtime="9:40"/>
    <period name="3" short="3" period="3" starttime="10:00" endtime="10:45"/>
    <period name="4" short="4" period="4" starttime="10:55" endtime="11:40"/>
  </periods>
  <daysdefs options="canadd,export:silent" columns="id,days,name,short">
    <daysdef id="D0A1B2C3D4E5F601" name="Monday" short="Mo" days="10000"/>
    <daysdef id="D0A1B2C3D4E5F602" name="Tuesday" short="Tu" days="01000"/>
    <daysdef id="D0A1B2C3D4E5F603" name="Every day" short="E" days="11111"/>
    <daysdef id="D0A1B2C3D4E5F604" name="Any day" short="A" days="10000,01000,00100,00010,00001"/>
  </daysdefs>
  <weeksdefs options="canadd,export:silent" columns="id,weeks,name,short">
    <weeksdef id="W0A1B2C3D4E5F601" name="Every week" short="E" weeks="11"/>
    <weeksdef id="W0A1B2C3D4E5F602" name="Week A" short="A" weeks="10"/>
    <weeksdef id="W0A1B2C3D4E5F603" name="Week B" short="B" weeks="01"/>
  </weeksdefs>
  <termsdefs options="canadd,export:silent" columns="id,terms,name,short">
    <termsdef id="T0A1B2C3D4E5F601" name="Whole year" short="Y" terms="11"/>
    <termsdef id="T0A1B2C3D4E5F602" name="Term 1" short="T1" terms="10"/>
    <termsdef id="T0A1B2C3D4E5F603" name="Term 2" short="T2" terms="01"/>
  </termsdefs>
  <subjects options="canadd,export:silent" columns="id,name,short,partner_id">
    <subject id="S0A1B2C3D4E5F601" name="Mathematics" short="Ma" partner_id=""/>
    <subject id="S0A1B2C3D4E5F602" name="English" short="En" partner_id=""/>
  </subjects>
  <teachers options="canadd,export:silent" columns="id,name,short,gender,color,email,mobile,partner_id,firstname,lastname">
    <teacher id="E0A1B2C3D4E5F601" name="Teacher One" short="TO" gender="F" color="#00FF00" email="to@school.example" mobile="" partner_id="" firstname="" lastname=""/>
    <teacher id="E0A1B2C3D4E5F602" name="Teacher Two" short="TW" gender="M" color="#FF0000" email="" mobile="" partner_id="" firstname="" lastname=""/>
  </teachers>
  <classrooms options="canadd,export:silent" columns="id,name,short,capacity,partner_id">
    <classroom id="R0A1B2C3D4E5F601" name="Room 1" short="R1" capacity="*" partner_id=""/>
    <classroom id="R0A1B2C3D4E5F602" name="Room 2" short="R2" capacity="*" partner_id=""/>
  </classrooms>
  <grades options="canadd,export:silent" columns="grade,name,short">
    <grade grade="7" name="7" short="7"/>
  </grades>
  <classes options="canadd,export:silent" columns="id,name,short,classroomids,teacherid,grade,partner_id">
    <class id="C0A1B2C3D4E5F601" name="7A" short="7A" teacherid="" classroomids="R0A1B2C3D4E5F601" grade="7" partner_id=""/>
    <class id="C0A1B2C3D4E5F602" name="7B" short="7B" teacherid="" classroomids="R0A1B2C3D4E5F602" grade="7" partner_id=""/>
  </classes>
  <groups options="canadd,export:silent" columns="id,classid,name,entireclass,divisiontag,studentcount,studentids">
    <group id="G0A1B2C3D4E5F601" name="Entire class" classid="C0A1B2C3D4E5F601" studentids="" entireclass="1" divisiontag="0" studentcount=""/>
    <group id="G0A1B2C3D4E5F602" name="Group 1" classid="C0A1B2C3D4E5F601" studentids="" entireclass="0" divisiontag="1" studentcount=""/>
    <group id="G0A1B2C3D4E5F603" name="Group 2" classid="C0A1B2C3D4E5F601" studentids="" entireclass="0" divisiontag="1" studentcount=""/>
    <group id="G0A1B2C3D4E5F604" name="Entire class" classid="C0A1B2C3D4E5F602" studentids="" entireclass="1" divisiontag="0" studentcount=""/>
    <group id="G0A1B2C3D4E5F605" name="Group 1" classid="C0A1B2C3D4E5F602" studentids="" entireclass="0" divisiontag="1" studentcount=""/>
  </groups>
  <students options="canadd,export:silent" columns="id,classid,name,number,email,mobile,partner_id,firstname,lastname"/>
  <studentsubjects options="canadd,export:silent" columns="studentid,subjectid,seminargroup,importance,alternatefor"/>
  <lessons options="canadd,export:silent" columns="id,subjectid,classids,groupids,teacherids,classroomids,periodspercard,periodsperweek,daysdefid,weeksdefid,termsdefid,seminargroup,capacity,partner_id">
    <lesson id="A0A1B2C3D4E5F601" classids="C0A1B2C3D4E5F601" subjectid="S0A1B2C3D4E5F601" periodspercard="2" periodsperweek="2.0" teacherids="E0A1B2C3D4E5F601" classroomids="R0A1B2C3D4E5F601" groupids="G0A1B2C3D4E5F601" capacity="*" seminargroup="" termsdefid="T0A1B2C3D4E5F601" weeksdefid="W0A1B2C3D4E5F601" daysdefid="D0A1B2C3D4E5F604" partner_id=""/>
    <lesson id="A0A1B2C3D4E5F602" classids="C0A1B2C3D4E5F601" subjectid="S0A1B2C3D4E5F602" periodspercard="1" periodsperweek="1.0" teacherids="E0A1B2C3D4E5F601,E0A1B2C3D4E5F602" classroomids="R0A1B2C3D4E5F602" groupids="G0A1B2C3D4E5F602" capacity="*" seminargroup="" termsdefid="T0A1B2C3D4E5F601" weeksdefid="W0A1B2C3D4E5F602" daysdefid="D0A1B2C3D4E5F604" partner_id=""/>
    <lesson id="A0A1B2C3D4E5F603" classids="C0A1B2C3D4E5F602" subjectid="S0A1B2C3D4E5F602" periodspercard="1" periodsperweek="1.0" teacherids="E0A1B2C3D4E5F601,E0A1B2C3D4E5F602" classroomids="R0A1B2C3D4E5F602" groupids="G0A1B2C3D4E5F605" capacity="*" seminargroup="" termsdefid="T0A1B2C3D4E5F601" weeksdefid="W0A1B2C3D4E5F603" daysdefid="D0A1B2C3D4E5F604" partner_id=""/>
    <lesson id="A0A1B2C3D4E5F604" classids="C0A1B2C3D4E5F602" subjectid="S0A1B2C3D4E5F601" periodspercard="1" periodsperweek="1.0" teacherids="E0A1B2C3D4E5F602" classroomids="" groupids="G0A1B2C3D4E5F604" capacity="*" seminargroup="" termsdefid="T0A1B2C3D4E5F602" weeksdefid="W0A1B2C3D4E5F601" daysdefid="D0A1B2C3D4E5F604" partner_id=""/>
    <lesson id="A0A1B2C3D4E5F605" classids="C0A1B2C3D4E5F602" subjectid="S0A1B2C3D4E5F601" periodspercard="1" periodsperweek="1.0" teacherids="E0A1B2C3D4E5F602" classroomids="" groupids="G0A1B2C3D4E5F604" capacity="*" seminargroup="" termsdefid="T0A1B2C3D4E5F601" weeksdefid="W0A1B2C3D4E5F601" daysdefid="D0A1B2C3D4E5F604" partner_id=""/>
  </lessons>
  <cards options="canadd,export:silent" columns="lessonid,classroomids,period,weeks,terms,days">
    <card lessonid="A0A1B2C3D4E5F601" classroomids="R0A1B2C3D4E5F601" period="1" weeks="11" terms="11" days="10000"/>
    <card lessonid="A0A1B2C3D4E5F601" classroomids="R0A1B2C3D4E5F601" period="2" weeks="11" terms="11" days="10000"/>
    <card lessonid="A0A1B2C3D4E5F602" classroomids="R0A1B2C3D4E5F602" period="3" weeks="10" terms="11" days="01000"/>
    <card lessonid="A0A1B2C3D4E5F603" classroomids="R0A1B2C3D4E5F602" period="3" weeks="01" terms="11" days="01000"/>
    <card lessonid="A0A1B2C3D4E5F604" classroomids="" period="4" weeks="11" terms="10" days="00100"/>
  </cards>
</timetable>
`;

// ---------------------------------------------------------------------------
// The acceptance test and the layout
// ---------------------------------------------------------------------------

describe('aSc XML round trip', () => {
  const fixtures: Array<[string, () => ExchangeDocument]> = [
    ['the small school (whole classes, one week)', smallSchoolDocument],
    ['the high school (block, halves, A/B, term split, co-teaching, shared lesson)', highSchoolDocument],
  ];

  it.each(fixtures)('reads back what it wrote: %s', (_name, make) => {
    const doc = make();
    const parsed = readAscXml(writeAscXml(doc));
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons).toHaveLength(doc.lessons.length);
    expect(multiset(parsed.lessons)).toEqual(multiset(doc.lessons));
  });

  it.each(fixtures)('also keeps the subject code, the teachers\' names and e-mail, and sets a ref on every lesson: %s', (_name, make) => {
    const doc = make();
    const parsed = readAscXml(writeAscXml(doc));
    const detail = (l: ExchangeLesson): string =>
      JSON.stringify([shape(l), l.subjectCode, l.teachers.map((t) => [t.short, t.name, t.email, t.id])]);
    expect(parsed.lessons.map(detail).sort()).toEqual(doc.lessons.map(detail).sort());
    expect(parsed.lessons.every((l) => /^kort \d+$/.test(l.ref))).toBe(true);
    expect(parsed.lessons.every((l) => Object.keys(l.ids).length === 0)).toBe(true);
  });

  it('says that the parallel block cannot be carried, once, and returns it empty (CHOICE 17)', () => {
    const doc = highSchoolDocument();
    expect(doc.lessons.some((l) => l.block !== null)).toBe(true);
    const parsed = readAscXml(writeAscXml(doc));
    expect(parsed.lessons.every((l) => l.block === null)).toBe(true);
    expect(parsed.notes.filter((n) => n.includes('parallella block'))).toHaveLength(1);
  });

  it('is deterministic and does not touch its input', () => {
    const doc = highSchoolDocument();
    const before = JSON.stringify(doc);
    const first = writeAscXml(doc);
    expect(writeAscXml(doc)).toBe(first);
    expect(JSON.stringify(doc)).toBe(before);
    expect(writeAscXml(highSchoolDocument())).toBe(first);
  });

  it('round-trips names the document\'s lists forgot, and a teacher with only e-mail and name', () => {
    const perEk: TeacherRef = { short: null, name: 'Per Ek', email: 'per.ek@skolan.example', id: null };
    const doc = docOf([lessonOf({ group: '9Z', subject: 'Slöjd', subjectCode: null, teachers: [perEk], room: 'Verkstan' })], { groups: [], subjects: [], rooms: [], teachers: [] });
    const parsed = readAscXml(writeAscXml(doc));
    expect(parsed.problems).toEqual([]);
    expect(parsed.lessons).toHaveLength(1);
    expect(parsed.lessons[0]).toMatchObject({ group: '9Z', subject: 'Slöjd', subjectCode: null, room: 'Verkstan' });
    // No signature to write: the initials stand in, and name and e-mail travel.
    expect(parsed.lessons[0]!.teachers).toEqual([{ short: 'PE', name: 'Per Ek', email: 'per.ek@skolan.example', id: null }]);
  });

  it('refuses a document no file could hold, as a RangeError and not as a broken file', () => {
    expect(() => writeAscXml(docOf([lessonOf({ day: 8 })]))).toThrow(RangeError);
    expect(() => writeAscXml(docOf([lessonOf({ start: '10:00', end: '09:00' })]))).toThrow(RangeError);
    expect(() => writeAscXml(docOf([lessonOf({ start: 'tidigt', end: '09:00' })]))).toThrow(RangeError);
    expect(() => writeAscXml(docOf([lessonOf({ from: '2026-02-30' })]))).toThrow(RangeError);
    expect(() => writeAscXml(docOf([lessonOf({ teachers: [{ short: null, name: null, email: null, id: null }] })]))).toThrow(RangeError);
  });
});

describe('aSc XML exact text', () => {
  const EXPECTED = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Rastra: Lillskolan, läsår 2026/2027 -->
<timetable ascttversion="2012.9.1" importtype="database" options="idprefix:Rastra,groupstype1,decimalseparatordot">
  <periods options="canadd,export:silent" columns="period,name,short,starttime,endtime">
    <period period="1" name="1" short="1" starttime="8:30" endtime="9:15"/>
  </periods>
  <daysdefs options="canadd,export:silent" columns="id,name,short,days">
    <daysdef id="D1" name="Måndag" short="Mån" days="10000"/>
    <daysdef id="D2" name="Tisdag" short="Tis" days="01000"/>
    <daysdef id="D3" name="Onsdag" short="Ons" days="00100"/>
    <daysdef id="D4" name="Torsdag" short="Tor" days="00010"/>
    <daysdef id="D5" name="Fredag" short="Fre" days="00001"/>
    <daysdef id="D6" name="Valfri dag" short="Valfri" days="10000,01000,00100,00010,00001"/>
  </daysdefs>
  <weeksdefs options="canadd,export:silent" columns="id,name,short,weeks">
    <weeksdef id="W1" name="Varje vecka" short="Alla" weeks="1"/>
  </weeksdefs>
  <termsdefs options="canadd,export:silent" columns="id,name,short,terms">
    <termsdef id="M1" name="Hela läsåret" short="Hela" terms="1"/>
  </termsdefs>
  <subjects options="canadd,export:silent" columns="id,name,short">
    <subject id="S1" name="Matematik" short="MA"/>
  </subjects>
  <classrooms options="canadd,export:silent" columns="id,name,short">
    <classroom id="R1" name="Klassrum 1" short="Klassrum 1"/>
  </classrooms>
  <teachers options="canadd,export:silent" columns="id,name,short,email">
    <teacher id="T1" name="Anna Berg" short="ABE" email="anna.berg@skolan.example"/>
  </teachers>
  <classes options="canadd,export:silent" columns="id,name,short">
    <class id="C1" name="1A" short="1A"/>
  </classes>
  <groups options="canadd,export:silent" columns="id,classid,name,entireclass,divisiontag">
    <group id="G1" classid="C1" name="Hela klassen" entireclass="1" divisiontag="0"/>
  </groups>
  <lessons options="canadd,export:silent" columns="id,subjectid,classids,groupids,teacherids,classroomids,periodspercard,periodsperweek,daysdefid,weeksdefid,termsdefid">
    <lesson id="L1" subjectid="S1" classids="C1" groupids="G1" teacherids="T1" classroomids="R1" periodspercard="1" periodsperweek="2" daysdefid="D6" weeksdefid="W1" termsdefid="M1"/>
  </lessons>
  <cards options="canadd,export:silent" columns="lessonid,classroomids,period,weeks,terms,days">
    <card lessonid="L1" classroomids="R1" period="1" weeks="1" terms="1" days="10000"/>
    <card lessonid="L1" classroomids="R1" period="1" weeks="1" terms="1" days="00100"/>
  </cards>
</timetable>
`;

  it('pins the layout of a small file (CHOICE 1, 4, 5, 6, 9, 12, 14, 15, 16)', () => {
    const doc = docOf([lessonOf(), lessonOf({ day: 3 })]);
    expect(writeAscXml(doc)).toBe(EXPECTED);
  });

  it('is well-formed XML that this repo\'s own parser reads, and says UTF-8 (CHOICE 2)', () => {
    const xml = writeAscXml(docOf([lessonOf()]));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(parseXml(xml).name).toBe('timetable');
    expect(decodeAscBytes(Buffer.from(xml, 'utf8'))).toBe(xml);
  });

  it('keeps a comment safe when the school name has dashes (CHOICE 1)', () => {
    const xml = writeAscXml(docOf([lessonOf()], { school: 'Skola -- A -' }));
    expect(() => parseXml(xml)).not.toThrow();
    expect(xml).toContain('<!-- Rastra: Skola - A -, läsår 2026/2027 -->');
  });
});

// ---------------------------------------------------------------------------
// One describe per CHOICE
// ---------------------------------------------------------------------------

describe('CHOICE 1: the envelope', () => {
  it('writes every column of a table on every row, "" where there is nothing, as the real export does', () => {
    const xml = writeAscXml(highSchoolDocument());
    const root = parseXml(xml);
    expect(root.attrs).toEqual({ ascttversion: '2012.9.1', importtype: 'database', options: 'idprefix:Rastra,groupstype1,decimalseparatordot' });
    for (const section of root.children) {
      const columns = (section.attrs.columns ?? '').split(',');
      expect(section.attrs.options).toBe('canadd,export:silent');
      for (const row of section.children) expect(Object.keys(row.attrs).sort()).toEqual([...columns].sort());
    }
    expect(rowsIn(xml, 'teachers').find((t) => t.attrs.short === 'DNO')!.attrs.email).toBe('');
  });

  it('reads a file whose root options or attributes it has never heard of', () => {
    const r = readAscXml(mini({ root: 'something:odd,groupstype2,lessonsincludeclasseswithoutstudents' }));
    expect(r.problems).toEqual([]);
    expect(r.lessons).toHaveLength(1);
  });
});

describe('CHOICE 2: bytes and encoding', () => {
  it('decodes a windows-1252 file by its declaration', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="windows-1252"?><a n="Ämnen åäö"/>', 'latin1');
    expect(decodeAscBytes(buf)).toContain('Ämnen åäö');
  });

  it('lets a byte order mark decide first (UTF-8 and UTF-16 LE), even against the declaration', () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0" encoding="windows-1252"?><a n="å"/>', 'utf8')]);
    expect(decodeAscBytes(utf8)).toBe('<?xml version="1.0" encoding="windows-1252"?><a n="å"/>');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<a n="å"/>', 'utf16le')]);
    expect(decodeAscBytes(utf16)).toBe('<a n="å"/>');
  });

  it('with no declaration reads UTF-8, or windows-1252 when the bytes are not valid UTF-8', () => {
    expect(decodeAscBytes(Buffer.from('<a n="å"/>', 'utf8'))).toBe('<a n="å"/>');
    expect(decodeAscBytes(Buffer.from('<a n="å"/>', 'latin1'))).toBe('<a n="å"/>');
  });

  it('does not throw on an encoding it does not know', () => {
    const buf = Buffer.from('<?xml version="1.0" encoding="x-no-such-code-page"?><a/>', 'latin1');
    expect(decodeAscBytes(buf)).toContain('<a/>');
  });

  it('reads a latin-1 file of a school end to end', () => {
    const xml = mini().replace('Matematik', 'Matematik och språk åäö').replace('encoding="UTF-8"', 'encoding="windows-1252"');
    const r = readAscXml(decodeAscBytes(Buffer.from(xml, 'latin1')));
    expect(r.lessons[0]!.subject).toBe('Matematik och språk åäö');
  });
});

describe('CHOICE 3: tolerance', () => {
  it('matches element names without regard to case (the older reference spells Class and Lesson)', () => {
    const xml = mini()
      .replace('<classes>', '<Classes>')
      .replace('</classes>', '</Classes>')
      .replace('<class id="C1" name="7A"/>', '<Class id="C1" name="7A"/>')
      .replace(/<lessons>([\s\S]*)<\/lessons>/, '<lessons>$1</lessons>')
      .replace('<lesson ', '<Lesson ');
    const r = readAscXml(xml);
    expect(r.problems).toEqual([]);
    expect(r.lessons[0]!.group).toBe('7A');
  });

  it('ignores extra attributes and elements, and takes any string as an id', () => {
    const xml = mini({
      lessons: [lessonRow({ id: 'lektion med mellanslag', surprise: 'ja' })],
      cards: [cardRow({ lessonid: 'lektion med mellanslag', unknown: 'x' })],
      extra: '<somethingelse><deep a="1"><deeper/></deep></somethingelse>',
    });
    const r = readAscXml(xml);
    expect(r.problems).toEqual([]);
    expect(r.lessons).toHaveLength(1);
  });

  it('reads a file with sections missing: no groups, no defs, no classrooms, no teachers', () => {
    const xml = `<timetable>${PERIODS_FROM_1}<subjects><subject id="S1" name="Matematik"/></subjects><classes><class id="C1" name="7A"/></classes><lessons><lesson id="L1" subjectid="S1" classids="C1"/></lessons><cards><card lessonid="L1" period="2" days="01000"/></cards></timetable>`;
    const r = readAscXml(xml);
    expect(r.problems).toEqual([]);
    expect(r.lessons[0]).toMatchObject({ group: '7A', subject: 'Matematik', subjectCode: null, teachers: [], room: null, day: 2, start: '08:55', end: '09:40', weeks: 'ALL', from: null, to: null });
  });

  it('merges two sections of one name', () => {
    const r = readAscXml(mini({ cards: [cardRow()], extra: `<cards>${cardRow({ period: '2' })}</cards>` }));
    expect(r.lessons.map((l) => l.start)).toEqual(['08:00', '08:55']);
  });
});

describe('CHOICE 4: the period grid', () => {
  it('writes the distinct slots ordered by start then end, numbered from 1, overlaps and all', () => {
    const periods = rowsIn(writeAscXml(highSchoolDocument()), 'periods').map((p) => [p.attrs.period, p.attrs.starttime, p.attrs.endtime]);
    expect(periods).toEqual([
      ['1', '8:10', '9:10'],
      ['2', '8:10', '9:40'],
      ['3', '9:20', '10:20'],
      ['4', '9:50', '11:20'],
      ['5', '10:30', '11:30'],
      ['6', '13:00', '13:40'],
      ['7', '13:00', '14:00'],
      ['8', '13:00', '14:20'],
    ]);
  });

  it('does not split a long lesson: one card at its own slot', () => {
    const xml = writeAscXml(docOf([lessonOf({ start: '08:10', end: '09:40' }), lessonOf({ day: 2, start: '08:10', end: '08:55' })]));
    expect(rowsIn(xml, 'cards')).toHaveLength(2);
    expect(rowsIn(xml, 'periods')).toHaveLength(2);
  });

  it('looks a period up by its number, so a file that counts from 0 reads right', () => {
    const periods = `<periods><period period="0" starttime="7:10" endtime="7:55"/><period period="1" starttime="8:00" endtime="8:45"/></periods>`;
    const r = readAscXml(mini({ periods, cards: [cardRow({ period: '0' }), cardRow({ period: '1' })] }));
    expect(r.lessons.map((l) => [l.start, l.end])).toEqual([
      ['07:10', '07:55'],
      ['08:00', '08:45'],
    ]);
  });

  it('refuses a period that is listed twice with different times, but not one listed twice alike', () => {
    const clash = `<periods><period period="1" starttime="8:00" endtime="8:45"/><period period="1" starttime="8:05" endtime="8:50"/></periods>`;
    const r = readAscXml(mini({ periods: clash }));
    expect(r.lessons).toEqual([]);
    expect(r.problems).toEqual([{ ref: 'kort 1', code: 'ASC_PERIOD_AMBIGUOUS', message: expect.stringContaining('Kort 1 hoppas över') }]);
    const same = `<periods><period period="1" starttime="8:00" endtime="8:45"/><period period="1" starttime="08:00" endtime="08:45"/></periods>`;
    expect(readAscXml(mini({ periods: same })).lessons).toHaveLength(1);
  });
});

describe('CHOICE 5: times', () => {
  it('writes H:MM without a leading zero and reads both spellings', () => {
    expect(writeAscXml(docOf([lessonOf({ start: '08:05', end: '09:00' })]))).toContain('starttime="8:05" endtime="9:00"');
    const periods = `<periods><period period="1" starttime="08:30" endtime="9:15"/></periods>`;
    expect(readAscXml(mini({ periods })).lessons[0]).toMatchObject({ start: '08:30', end: '09:15' });
  });

  it('makes a period without a usable time a problem for its cards only, never a guessed time', () => {
    const periods = `<periods><period period="1" starttime="25:00" endtime="8:45"/><period period="2" starttime="9:00" endtime="8:00"/><period period="3" starttime="10:00" endtime="10:45"/></periods>`;
    const r = readAscXml(mini({ periods, cards: [cardRow({ period: '1' }), cardRow({ period: '2' }), cardRow({ period: '3' })] }));
    expect(r.lessons.map((l) => l.start)).toEqual(['10:00']);
    expect(r.problems.map((p) => [p.ref, p.code])).toEqual([
      ['kort 1', 'ASC_PERIOD_TIME_INVALID'],
      ['kort 2', 'ASC_PERIOD_TIME_INVALID'],
    ]);
  });
});

describe('CHOICE 6: days', () => {
  it('writes five days, or as many as the highest day used (6 and 7), with a "Valfri dag" list', () => {
    const five = writeAscXml(docOf([lessonOf({ day: 5 })]));
    expect(rowsIn(five, 'daysdefs').map((d) => d.attrs.days)).toEqual(['10000', '01000', '00100', '00010', '00001', '10000,01000,00100,00010,00001']);
    const six = writeAscXml(docOf([lessonOf({ day: 6 })]));
    expect(rowsIn(six, 'daysdefs')).toHaveLength(7);
    expect(rowsIn(six, 'cards')[0]!.attrs.days).toBe('000001');
    const seven = writeAscXml(docOf([lessonOf({ day: 7 })]));
    expect(rowsIn(seven, 'daysdefs').map((d) => d.attrs.name).slice(5)).toEqual(['Lördag', 'Söndag', 'Valfri dag']);
    expect(rowsIn(seven, 'cards')[0]!.attrs.days).toBe('0000001');
    expect(readAscXml(seven).lessons[0]!.day).toBe(7);
    expect(readAscXml(six).lessons[0]!.day).toBe(6);
  });

  it('reads several 1s in one card as one lesson per day, with one ref', () => {
    const r = readAscXml(mini({ cards: [cardRow({ days: '10100' })] }));
    expect(r.lessons.map((l) => [l.day, l.ref])).toEqual([
      [1, 'kort 1'],
      [3, 'kort 1'],
    ]);
  });

  it('refuses a day string that is empty, malformed, a list, or beyond the seventh day', () => {
    const r = readAscXml(mini({ cards: [cardRow({ days: '00000' }), cardRow({ days: '1x000' }), cardRow({ days: '10000,01000' }), cardRow({ days: '0000000001' }), cardRow({ days: '01000' })] }));
    expect(r.problems.map((p) => [p.ref, p.code])).toEqual([
      ['kort 1', 'ASC_DAY_INVALID'],
      ['kort 2', 'ASC_DAY_INVALID'],
      ['kort 3', 'ASC_DAY_INVALID'],
      ['kort 4', 'ASC_DAY_CYCLE'],
    ]);
    expect(r.lessons.map((l) => l.day)).toEqual([2]);
  });

  it('reads a card that only has a numeric day: 0 is Monday unless daynumbering1, and a note says which', () => {
    const zero = readAscXml(mini({ cards: [cardRow({ days: null, day: '0' })] }));
    expect(zero.lessons[0]!.day).toBe(1);
    expect(zero.notes).toContainEqual(expect.stringContaining('0 som måndag'));
    const one = readAscXml(mini({ root: 'groupstype1,daynumbering1', cards: [cardRow({ days: null, day: '1' })] }));
    expect(one.lessons[0]!.day).toBe(1);
    expect(notesWithoutBlock(one.notes)).toEqual([]);
    const bad = readAscXml(mini({ root: 'daynumbering1', cards: [cardRow({ days: null, day: '9' }), cardRow({ days: null })] }));
    expect(bad.problems.map((p) => p.code)).toEqual(['ASC_DAY_INVALID', 'ASC_DAY_INVALID']);
  });

  it('notes a week that starts on a day it can recognise as not Monday', () => {
    const defs = `<daysdefs><daysdef id="d1" name="Söndag" short="Sön" days="1000000"/><daysdef id="d2" name="Måndag" short="Mån" days="0100000"/></daysdefs>`;
    const r = readAscXml(mini({ defs }));
    expect(r.notes).toContainEqual(expect.stringContaining('position 1 som måndag'));
    expect(r.notes).toContainEqual(expect.stringContaining('"Söndag"'));
    expect(notesWithoutBlock(readAscXml(writeAscXml(highSchoolDocument())).notes).some((n) => n.includes('position 1 som måndag'))).toBe(false);
  });
});

describe('CHOICE 7: weeks', () => {
  it('writes one week as "1" and an alternating school as 11, 10 and 01 with the defs', () => {
    const plain = writeAscXml(smallSchoolDocument());
    expect(new Set(rowsIn(plain, 'cards').map((c) => c.attrs.weeks))).toEqual(new Set(['1']));
    expect(rowsIn(plain, 'weeksdefs').map((w) => w.attrs.weeks)).toEqual(['1']);
    const ab = writeAscXml(highSchoolDocument());
    expect(new Set(rowsIn(ab, 'cards').map((c) => c.attrs.weeks))).toEqual(new Set(['11', '10', '01']));
    expect(rowsIn(ab, 'weeksdefs').map((w) => [w.attrs.name, w.attrs.weeks])).toEqual([
      ['Varje vecka', '11'],
      ['A-vecka', '10'],
      ['B-vecka', '01'],
    ]);
  });

  it('reads the first week as A (ODD) and the second as B (EVEN)', () => {
    const r = readAscXml(mini({ cards: [cardRow({ weeks: '10' }), cardRow({ weeks: '01', days: '01000' }), cardRow({ weeks: '11', days: '00100' }), cardRow({ weeks: '1', days: '00010' })] }));
    expect(r.lessons.map((l) => l.weeks)).toEqual(['ODD', 'EVEN', 'ALL', 'ALL']);
  });

  it('reads a two-periodic longer rotation, and refuses one the model cannot hold', () => {
    const r = readAscXml(mini({ cards: [cardRow({ weeks: '1010' }), cardRow({ weeks: '0101', days: '01000' }), cardRow({ weeks: '1100', days: '00100' }), cardRow({ weeks: '100', days: '00010' }), cardRow({ weeks: '0', days: '00001' })] }));
    expect(r.lessons.map((l) => l.weeks)).toEqual(['ODD', 'EVEN']);
    expect(r.problems.map((p) => [p.ref, p.code])).toEqual([
      ['kort 3', 'ASC_WEEKS_UNSUPPORTED'],
      ['kort 4', 'ASC_WEEKS_UNSUPPORTED'],
      ['kort 5', 'ASC_WEEKS_UNSUPPORTED'],
    ]);
  });

  it('adds the note about rotation positions on every import that alternates or has a weeksdef with a 0 in it, and only then', () => {
    expect(readAscXml(writeAscXml(highSchoolDocument())).notes).toContainEqual(WEEKS_NOTE);
    expect(readAscXml(writeAscXml(smallSchoolDocument())).notes).not.toContainEqual(WEEKS_NOTE);
    const defsOnly = `<weeksdefs><weeksdef id="WA" name="A" weeks="10"/></weeksdefs>`;
    expect(readAscXml(mini({ defs: defsOnly, cards: [cardRow({ weeks: '11' })] })).notes).toContainEqual(WEEKS_NOTE);
    const note = readAscXml(mini({ cards: [cardRow({ weeks: '10' })] })).notes.find((n) => n.includes('rotation'))!;
    expect(note).toContain('udda ISO-veckor');
    expect(note).toContain('byter A och B plats');
  });

  it('takes the week from the lesson\'s weeksdef when the card says nothing, and refuses to guess in a many-week file', () => {
    const defs = `<weeksdefs><weeksdef id="WA" name="A" weeks="10"/><weeksdef id="WB" name="B" weeks="01"/><weeksdef id="WAny" name="Any" weeks="10,01"/></weeksdefs>`;
    const fromDef = readAscXml(mini({ defs, lessons: [lessonRow({ weeksdefid: 'WB' })], cards: [cardRow({ weeks: null })] }));
    expect(fromDef.lessons[0]!.weeks).toBe('EVEN');
    const anyWeek = readAscXml(mini({ defs, lessons: [lessonRow({ weeksdefid: 'WAny' })], cards: [cardRow({ weeks: null })] }));
    expect(anyWeek.lessons).toEqual([]);
    expect(anyWeek.problems.map((p) => p.code)).toEqual(['ASC_WEEKS_UNKNOWN']);
    expect(readAscXml(mini({ cards: [cardRow({ weeks: null })] })).lessons[0]!.weeks).toBe('ALL');
  });
});

describe('CHOICE 8: terms and dates', () => {
  const autumn = '2026-08-17–2026-12-18';
  const spring = '2027-01-11–2027-06-11';

  it('writes every distinct span as a named term, with the whole year as all ones', () => {
    const terms = rowsIn(writeAscXml(highSchoolDocument()), 'termsdefs').map((t) => [t.attrs.name, t.attrs.terms]);
    expect(terms).toEqual([
      ['Hela läsåret', '11'],
      [autumn, '10'],
      [spring, '01'],
    ]);
  });

  it('gives a lone span a second term so that "this span" and "all year" differ, and keeps both through a round trip', () => {
    const doc = docOf([lessonOf({ from: '2026-08-17', to: '2026-12-18' }), lessonOf({ day: 2 })]);
    const xml = writeAscXml(doc);
    expect(rowsIn(xml, 'termsdefs').map((t) => [t.attrs.name, t.attrs.terms])).toEqual([
      ['Hela läsåret', '11'],
      [autumn, '10'],
      ['Resten av läsåret', '01'],
    ]);
    const r = readAscXml(xml);
    expect(r.problems).toEqual([]);
    expect(r.lessons.map((l) => [l.day, l.from, l.to])).toEqual([
      [1, '2026-08-17', '2026-12-18'],
      [2, null, null],
    ]);
    expect(notesWithoutBlock(r.notes)).toEqual([]);
  });

  it('round-trips a span with only one end', () => {
    const doc = docOf([lessonOf({ from: '2026-08-17', to: null }), lessonOf({ day: 2, from: null, to: '2026-12-18' })]);
    const xml = writeAscXml(doc);
    expect(rowsIn(xml, 'termsdefs').map((t) => t.attrs.name)).toEqual(['Hela läsåret', '–2026-12-18', '2026-08-17–']);
    expect(multiset(readAscXml(xml).lessons)).toEqual(multiset(doc.lessons));
  });

  it.each([
    ['en dash', '2026-08-17–2026-12-18'],
    ['spaced hyphen', '2026-08-17 - 2026-12-18'],
    ['bare hyphen', '2026-08-17-2026-12-18'],
    ['em dash', '2026-08-17—2026-12-18'],
  ])('reads a term named as a date span: %s', (_label, name) => {
    const defs = `<termsdefs><termsdef id="t1" name="${name}" terms="10"/><termsdef id="t2" name="Resten" terms="01"/></termsdefs>`;
    const r = readAscXml(mini({ defs, cards: [cardRow({ terms: '10' })] }));
    expect(r.lessons[0]).toMatchObject({ from: '2026-08-17', to: '2026-12-18' });
    expect(notesWithoutBlock(r.notes)).toEqual([]);
  });

  it('reads plain names such as "Term 1" as the whole year, with a note naming the term, once', () => {
    const defs = `<termsdefs><termsdef id="t1" name="Term 1" terms="10"/><termsdef id="t2" name="Term 2" terms="01"/><termsdef id="t3" name="Year" terms="11"/></termsdefs>`;
    const r = readAscXml(mini({ defs, cards: [cardRow({ terms: '10' }), cardRow({ terms: '10', days: '01000' }), cardRow({ terms: '11', days: '00100' })] }));
    expect(r.lessons.map((l) => [l.from, l.to])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
    const termNotes = r.notes.filter((n) => n.includes('Term 1'));
    expect(termNotes).toHaveLength(1);
    expect(termNotes[0]).toContain('hela läsåret');
    expect(r.notes.filter((n) => n.includes('Term 2'))).toEqual([]);
  });

  it.each([
    ['dates the wrong way round', '2026-12-18–2026-08-17'],
    ['a date that does not exist', '2026-02-30–2026-03-01'],
    ['a single date', '2026-08-17'],
  ])('does not read %s as a span', (_label, name) => {
    const defs = `<termsdefs><termsdef id="t1" name="${name}" terms="10"/></termsdefs>`;
    const r = readAscXml(mini({ defs, cards: [cardRow({ terms: '10' })] }));
    expect(r.lessons[0]).toMatchObject({ from: null, to: null });
    expect(r.notes).toContainEqual(expect.stringContaining(`"${name}"`));
  });

  it('names a term with no def by its position, and refuses a terms string that is not bits', () => {
    const r = readAscXml(mini({ cards: [cardRow({ terms: '010' }), cardRow({ terms: 'x', days: '01000' })] }));
    expect(r.lessons).toHaveLength(1);
    expect(r.notes).toContainEqual(expect.stringContaining('"period 2"'));
    expect(r.problems.map((p) => p.code)).toEqual(['ASC_TERMS_INVALID']);
  });
});

describe('CHOICE 9: lessons and cards', () => {
  it('merges lessons with the same attendees, subject, teachers, weeks and term, and counts the cards', () => {
    const xml = writeAscXml(highSchoolDocument());
    const lessons = rowsIn(xml, 'lessons');
    const cards = rowsIn(xml, 'cards');
    expect(lessons.length).toBeLessThan(cards.length);
    expect(cards).toHaveLength(highSchoolDocument().lessons.length);
    for (const l of lessons) {
      expect(Number(l.attrs.periodsperweek)).toBe(cards.filter((c) => c.attrs.lessonid === l.attrs.id).length);
      expect(l.attrs.periodspercard).toBe('1');
    }
    // 7A Matematik on Monday and Wednesday is one lesson with two cards.
    const sevenA = lessons.find((l) => l.attrs.periodsperweek === '2')!;
    expect(cards.filter((c) => c.attrs.lessonid === sevenA.attrs.id).map((c) => c.attrs.days)).toEqual(['10000', '00100']);
  });

  it('keeps the same subject in two terms apart: one lesson per term', () => {
    const lessons = rowsIn(writeAscXml(highSchoolDocument()), 'lessons');
    expect(lessons.filter((l) => l.attrs.groupids === 'G2')).toHaveLength(2);
  });

  it('reads one lesson per card, ignoring periodsperweek', () => {
    const r = readAscXml(mini({ lessons: [lessonRow({ periodsperweek: '9.0' })], cards: [cardRow(), cardRow({ days: '01000' }), cardRow({ days: '00100' })] }));
    expect(r.lessons.map((l) => [l.day, l.ref])).toEqual([
      [1, 'kort 1'],
      [2, 'kort 2'],
      [3, 'kort 3'],
    ]);
  });

  it('prefers what the card says to what its lesson says', () => {
    const defs = `<weeksdefs><weeksdef id="WA" name="A" weeks="10"/></weeksdefs><termsdefs><termsdef id="TA" name="2026-08-17–2026-12-18" terms="10"/></termsdefs>`;
    const r = readAscXml(mini({ defs, lessons: [lessonRow({ weeks: '10', weeksdefid: 'WA', termsdefid: 'TA' })], cards: [cardRow({ weeks: '01', terms: '11' })] }));
    expect(r.lessons[0]).toMatchObject({ weeks: 'EVEN', from: null, to: null });
  });

  it('counts lessons that no card places, once, and says when there are no cards at all', () => {
    const r = readAscXml(mini({ lessons: [lessonRow(), lessonRow({ id: 'L2' }), lessonRow({ id: 'L3' })] }));
    expect(r.lessons).toHaveLength(1);
    expect(r.notes).toContainEqual('2 lektioner i filen har inga kort (är inte placerade) och hoppas över.');
    const none = readAscXml(mini({ cards: [] }));
    expect(none.lessons).toEqual([]);
    expect(none.notes).toEqual(['Filen innehåller inga placerade kort, så det finns inget schema att läsa.']);
  });
});

describe('CHOICE 10: double lessons', () => {
  const doubleLesson = lessonRow({ periodspercard: '2', periodsperweek: '2.0' });

  it('reads the two cards of a double lesson as one lesson from the first period\'s start to the last period\'s end', () => {
    const r = readAscXml(mini({ lessons: [doubleLesson], cards: [cardRow({ period: '1' }), cardRow({ period: '2' })] }));
    expect(r.problems).toEqual([]);
    expect(r.lessons).toHaveLength(1);
    expect(r.lessons[0]).toMatchObject({ day: 1, start: '08:00', end: '09:40', ref: 'kort 1–2' });
  });

  it('reads one card with durationperiods=2 the same way, and lets the lesson\'s durationperiods stand in for periodspercard', () => {
    const one = readAscXml(mini({ cards: [cardRow({ period: '3', durationperiods: '2' })] }));
    expect(one.lessons[0]).toMatchObject({ start: '10:00', end: '11:40', ref: 'kort 1' });
    const viaLesson = readAscXml(mini({ lessons: [lessonRow({ durationperiods: '2', periodspercard: '1' })], cards: [cardRow({ period: '1' }), cardRow({ period: '2' })] }));
    expect(viaLesson.lessons).toHaveLength(1);
    expect(viaLesson.lessons[0]).toMatchObject({ start: '08:00', end: '09:40' });
  });

  it('reads a triple lesson, and two doubles back to back, from the lowest period up', () => {
    const triple = readAscXml(mini({ lessons: [lessonRow({ periodspercard: '3' })], cards: [cardRow({ period: '3' }), cardRow({ period: '1' }), cardRow({ period: '2' })] }));
    expect(triple.lessons).toHaveLength(1);
    expect(triple.lessons[0]).toMatchObject({ start: '08:00', end: '10:45' });
    const two = readAscXml(mini({ lessons: [doubleLesson], cards: [cardRow({ period: '1' }), cardRow({ period: '2' }), cardRow({ period: '3' }), cardRow({ period: '4' })] }));
    expect(two.lessons.map((l) => [l.start, l.end])).toEqual([
      ['08:00', '09:40'],
      ['10:00', '11:40'],
    ]);
  });

  it('keeps doubles on different days apart, and different weeks apart', () => {
    const r = readAscXml(mini({ lessons: [doubleLesson], cards: [cardRow({ period: '1', days: '10000' }), cardRow({ period: '2', days: '10000' }), cardRow({ period: '1', days: '01000', weeks: '1' }), cardRow({ period: '2', days: '01000' })] }));
    expect(r.lessons.map((l) => [l.day, l.start, l.end])).toEqual([
      [1, '08:00', '09:40'],
      [2, '08:00', '09:40'],
    ]);
  });

  it('refuses cards that do not make a whole block, naming each, and reads the rest', () => {
    const single = readAscXml(mini({ lessons: [doubleLesson], cards: [cardRow({ period: '1' })] }));
    expect(single.lessons).toEqual([]);
    expect(single.problems).toEqual([{ ref: 'kort 1', code: 'ASC_CARD_BLOCK_INCOMPLETE', message: expect.stringContaining('2 perioder per kort') }]);
    const apart = readAscXml(mini({ lessons: [doubleLesson], cards: [cardRow({ period: '1' }), cardRow({ period: '3' })] }));
    expect(apart.problems.map((p) => p.ref)).toEqual(['kort 1', 'kort 2']);
    const three = readAscXml(mini({ lessons: [doubleLesson], cards: [cardRow({ period: '1' }), cardRow({ period: '2' }), cardRow({ period: '3' })] }));
    expect(three.lessons).toHaveLength(1);
    expect(three.problems.map((p) => [p.ref, p.code])).toEqual([['kort 3', 'ASC_CARD_BLOCK_INCOMPLETE']]);
  });

  it('refuses a block whose later period is not in the period table', () => {
    const r = readAscXml(mini({ cards: [cardRow({ period: '4', durationperiods: '2' })] }));
    expect(r.lessons).toEqual([]);
    expect(r.problems).toEqual([{ ref: 'kort 1', code: 'ASC_PERIOD_UNKNOWN', message: expect.stringContaining('perioden 5') }]);
  });

  it('never writes a double lesson: periodspercard is always 1 and a long slot is a period of its own', () => {
    const xml = writeAscXml(highSchoolDocument());
    expect(rowsIn(xml, 'lessons').every((l) => l.attrs.periodspercard === '1')).toBe(true);
    expect(xml).not.toContain('durationperiods');
  });
});

describe('CHOICE 11: which attendee is the lesson\'s own group', () => {
  it('writes the group first and the extra groups after it, and reads the first back as group', () => {
    const doc = docOf([lessonOf({ group: '8B', extraGroups: ['8A'] })], { groups: [{ name: '8A', kind: 'CLASS', gradeLevel: 8, halfOf: null }, { name: '8B', kind: 'CLASS', gradeLevel: 8, halfOf: null }] });
    const xml = writeAscXml(doc);
    expect(rowsIn(xml, 'lessons')[0]!.attrs.classids).toBe('C2,C1');
    expect(readAscXml(xml).lessons[0]).toMatchObject({ group: '8B', extraGroups: ['8A'] });
  });

  it('reads classids=[7A,7B] of a foreign file as 7A with 7B as an extra group', () => {
    const r = readAscXml(mini({ lessons: [lessonRow({ classids: 'C1,C2' })] }));
    expect(r.lessons[0]).toMatchObject({ group: '7A', extraGroups: ['7B'] });
  });

  it('reads a selected group of a class instead of the class, and an entire-class group as the class', () => {
    const groups = `<groups><group id="G1" classid="C1" name="Hälft 1" entireclass="0"/><group id="G2" classid="C1" name="Hälft 2" entireclass="0"/><group id="G3" classid="C2" name="Hela" entireclass="1"/></groups>`;
    const r = readAscXml(mini({ groups, lessons: [lessonRow({ classids: 'C1,C2', groupids: 'G1,G3' }), lessonRow({ id: 'L2', classids: 'C1', groupids: 'G2,G1' })], cards: [cardRow(), cardRow({ lessonid: 'L2', days: '01000' })] }));
    expect(r.lessons.map((l) => [l.group, l.extraGroups])).toEqual([
      ['Hälft 1', ['7B']],
      ['Hälft 2', ['Hälft 1']],
    ]);
  });

  it('reads a group of several classes (groupstype2) once and not as its classes', () => {
    const groups = `<groups><group id="G9" classids="C1,C2" name="Spanska" entireclass="0"/></groups>`;
    const r = readAscXml(mini({ groups, root: 'groupstype2', lessons: [lessonRow({ classids: 'C1,C2', groupid: 'G9' })] }));
    expect(r.lessons[0]).toMatchObject({ group: 'Spanska', extraGroups: [] });
  });
});

describe('CHOICE 12: classes and groups as written', () => {
  const xml = writeAscXml(highSchoolDocument());

  it('writes an entire-class group per class, halves as groups of their class, and a teaching group with no class as a class', () => {
    const classes = rowsIn(xml, 'classes');
    expect(classes.map((c) => c.attrs.name)).toEqual(['7A', '7B', '8A', '8B', 'Sp7', 'Ty7', 'Fr7']);
    const groups = rowsIn(xml, 'groups');
    expect(groups.filter((g) => g.attrs.entireclass === '1')).toHaveLength(classes.length);
    expect(groups.filter((g) => g.attrs.entireclass === '1').every((g) => g.attrs.divisiontag === '0' && g.attrs.name === 'Hela klassen')).toBe(true);
    const sevenA = classes.find((c) => c.attrs.name === '7A')!.attrs.id;
    expect(groups.filter((g) => g.attrs.entireclass === '0').map((g) => [g.attrs.name, g.attrs.classid, g.attrs.divisiontag])).toEqual([
      ['7A-1', sevenA, '1'],
      ['7A-2', sevenA, '1'],
    ]);
    expect(groups.some((g) => g.attrs.name === 'Sp7')).toBe(false);
  });

  it('refers to the entire-class group from an entire-class lesson', () => {
    const lesson = rowsIn(xml, 'lessons').find((l) => l.attrs.classids === 'C3' && l.attrs.subjectid === 'S3')!;
    expect(lesson.attrs.groupids).toBe('G5');
  });
});

describe('CHOICE 13: group names on read', () => {
  it('puts the class in front of a group name that more than one class has, with one note', () => {
    const r = readAscXml(ASC_SAMPLE);
    expect(r.lessons.map((l) => l.group)).toEqual(['7A', '7A Group 1', '7B Group 1', '7B']);
    expect(r.notes.filter((n) => n.includes('klassens namn framför'))).toHaveLength(1);
  });

  it('leaves a name that is unique alone, and says nothing', () => {
    const r = readAscXml(writeAscXml(highSchoolDocument()));
    expect(r.lessons.some((l) => l.group === '7A-1')).toBe(true);
    expect(r.notes.some((n) => n.includes('klassens namn framför'))).toBe(false);
  });
});

describe('CHOICE 14: subjects', () => {
  it('writes short = the code, or the name when there is none, and reads a short that differs from the name as the code', () => {
    const xml = writeAscXml(highSchoolDocument());
    const subjects = rowsIn(xml, 'subjects').map((s) => [s.attrs.name, s.attrs.short]);
    expect(subjects).toContainEqual(['Matematik', 'MA']);
    expect(subjects).toContainEqual(['Slöjd', 'Slöjd']);
    const parsed = readAscXml(xml);
    expect(parsed.lessons.find((l) => l.subject === 'Slöjd')!.subjectCode).toBeNull();
    expect(parsed.lessons.find((l) => l.subject === 'Matematik')!.subjectCode).toBe('MA');
  });

  it('takes the short as the name when a subject has no name, and a lesson with no known subject is a problem', () => {
    const noName = mini().replace('name="Matematik" short="Ma"', 'short="Ma"');
    expect(readAscXml(noName).lessons[0]).toMatchObject({ subject: 'Ma', subjectCode: null });
    const r = readAscXml(mini({ lessons: [lessonRow({ subjectid: 'S404' })] }));
    expect(r.problems.map((p) => [p.ref, p.code])).toEqual([['lektion 1', 'ASC_LESSON_NO_SUBJECT']]);
  });
});

describe('CHOICE 15: teachers', () => {
  it('writes id, name, short and e-mail with the lead teacher first, and reads them back', () => {
    const xml = writeAscXml(highSchoolDocument());
    const coTaught = rowsIn(xml, 'lessons').find((l) => l.attrs.teacherids.includes(','))!;
    const teachers = rowsIn(xml, 'teachers');
    expect(coTaught.attrs.teacherids.split(',').map((id) => teachers.find((t) => t.attrs.id === id)!.attrs.short)).toEqual(['EST', 'FAL']);
    const parsed = readAscXml(xml);
    expect(parsed.lessons.find((l) => l.teachers.length === 2)!.teachers).toEqual([
      { short: 'EST', name: 'Eva Strand', email: 'eva.strand@skolan.example', id: null },
      { short: 'FAL', name: 'Farid Alm', email: 'farid.alm@skolan.example', id: null },
    ]);
    expect(parsed.lessons.find((l) => l.teachers[0]?.short === 'DNO')!.teachers[0]!.email).toBeNull();
  });

  it('builds a name from first and last name, and reads e-mail', () => {
    const r = readAscXml(mini({ lessons: [lessonRow({ teacherids: 'T3' })] }));
    expect(r.lessons[0]!.teachers).toEqual([{ short: 'TH', name: 'Third Teacher', email: 'th@school.example', id: null }]);
  });

  it('keeps the first two of more than two teachers and says how many lessons lost one', () => {
    const r = readAscXml(mini({ lessons: [lessonRow({ teacherids: 'T1,T2,T3' })], cards: [cardRow(), cardRow({ days: '01000' })] }));
    expect(r.lessons.map((l) => l.teachers.map((t) => t.short))).toEqual([['TO', 'TW'], ['TO', 'TW']]);
    expect(r.notes).toContainEqual('1 lektion har fler än två lärare i aSc; de två första följer med.');
  });

  it('refuses a lesson that names a teacher the file does not have, rather than dropping the teacher', () => {
    const r = readAscXml(mini({ lessons: [lessonRow({ teacherids: 'T1,T404' })] }));
    expect(r.lessons).toEqual([]);
    expect(r.problems).toEqual([{ ref: 'lektion 1', code: 'ASC_LESSON_REF_UNKNOWN', message: expect.stringContaining('läraren "T404"') }]);
  });
});

describe('CHOICE 16: rooms', () => {
  it('puts the room on the card and the rooms the lesson may use on the lesson', () => {
    const xml = writeAscXml(highSchoolDocument());
    const cards = rowsIn(xml, 'cards');
    const withoutRoom = cards.filter((c) => c.attrs.classroomids === '');
    expect(withoutRoom).toHaveLength(1);
    const parsed = readAscXml(xml);
    expect(parsed.lessons.filter((l) => l.room === null)).toHaveLength(1);
  });

  it('takes the card\'s first room and counts cards with several', () => {
    const r = readAscXml(mini({ cards: [cardRow({ classroomids: 'R2,R1' })] }));
    expect(r.lessons[0]!.room).toBe('Sal 2');
    expect(r.notes).toContainEqual('1 kort har flera salar; den första följer med.');
  });

  it('takes the lesson\'s room when the card has no room column and the lesson lists exactly one, none when it lists several', () => {
    const one = readAscXml(mini({ cards: [cardRow({ classroomids: null })] }));
    expect(one.lessons[0]!.room).toBe('Sal 1');
    const several = readAscXml(mini({ lessons: [lessonRow({ classroomids: 'R1,R2' })], cards: [cardRow({ classroomids: null })] }));
    expect(several.lessons[0]!.room).toBeNull();
    expect(several.notes).toContainEqual('1 kort saknar vald sal i en lektion med flera möjliga salar och får ingen sal.');
    const empty = readAscXml(mini({ cards: [cardRow({ classroomids: '' })] }));
    expect(empty.lessons[0]!.room).toBeNull();
  });

  it('refuses a card whose room is not in the file', () => {
    const r = readAscXml(mini({ cards: [cardRow({ classroomids: 'R404' })] }));
    expect(r.problems).toEqual([{ ref: 'kort 1', code: 'ASC_CARD_REF_UNKNOWN', message: expect.stringContaining('salen "R404"') }]);
  });
});

describe('CHOICE 17: what the format cannot carry', () => {
  it('still writes a valid file for a lesson in a block, and has no block anywhere in it', () => {
    const xml = writeAscXml(highSchoolDocument());
    expect(() => parseXml(xml)).not.toThrow();
    expect(xml).not.toContain('Språkval');
    expect(xml).not.toContain('block');
  });

  it('says it once for a hand-written file as well, and not at all when nothing was read', () => {
    const r = readAscXml(ASC_SAMPLE);
    expect(r.notes.filter((n) => n.includes('parallella block'))).toHaveLength(1);
    expect(r.lessons.every((l) => l.block === null)).toBe(true);
    expect(readAscXml(mini({ cards: [] })).notes.some((n) => n.includes('parallella block'))).toBe(false);
  });
});

describe('a file as aSc would export it', () => {
  const r = readAscXml(ASC_SAMPLE);

  it('reads every placed lesson, with no problems', () => {
    expect(r.problems).toEqual([]);
    expect(r.lessons).toHaveLength(4);
  });

  it('reads the double lesson (periodspercard 2, two cards) as one lesson over both periods', () => {
    expect(r.lessons[0]).toMatchObject({
      ref: 'kort 1–2',
      group: '7A',
      extraGroups: [],
      subject: 'Mathematics',
      subjectCode: 'Ma',
      room: 'Room 1',
      day: 1,
      start: '08:00',
      end: '09:40',
      weeks: 'ALL',
      from: null,
      to: null,
    });
    expect(r.lessons[0]!.teachers).toEqual([{ short: 'TO', name: 'Teacher One', email: 'to@school.example', id: null }]);
  });

  it('reads the weeksdef "10" and "01" as A and B, two teachers in order, and groups of the same name apart', () => {
    expect(r.lessons[1]).toMatchObject({ ref: 'kort 3', group: '7A Group 1', subject: 'English', day: 2, start: '10:00', end: '10:45', weeks: 'ODD', room: 'Room 2' });
    expect(r.lessons[1]!.teachers.map((t) => [t.short, t.email])).toEqual([['TO', 'to@school.example'], ['TW', null]]);
    expect(r.lessons[2]).toMatchObject({ ref: 'kort 4', group: '7B Group 1', weeks: 'EVEN' });
  });

  it('reads plain term names as the whole year and a card with no room as having none', () => {
    expect(r.lessons[3]).toMatchObject({ ref: 'kort 5', group: '7B', day: 3, start: '10:55', end: '11:40', room: null, from: null, to: null });
  });

  it('notes what it assumed, each once', () => {
    expect(r.notes).toEqual([
      '1 lektion i filen har inga kort (är inte placerade) och hoppas över.',
      expect.stringContaining('lägen i en rotation'),
      'Perioden "Term 1" i aSc har inga datum och läses som hela läsåret; sätt datum på lektionerna efter importen om de bara ska gälla en del av året.',
      expect.stringContaining('klassens namn framför'),
      BLOCK_NOTE,
    ]);
  });

  it('sets a ref on every lesson and keeps no aSc id', () => {
    expect(r.lessons.every((l) => l.ref !== '' && Object.keys(l.ids).length === 0)).toBe(true);
  });
});

describe('CHOICE 18: never guess', () => {
  it('makes a card without a period a problem for that card only', () => {
    const r = readAscXml(mini({ cards: [cardRow({ period: null }), cardRow({ days: '01000' })] }));
    expect(r.lessons.map((l) => l.day)).toEqual([2]);
    expect(r.problems).toEqual([{ ref: 'kort 1', code: 'ASC_CARD_NO_PERIOD', message: 'Kort 1 hoppas över: kortet saknar period, och en tid gissas aldrig.' }]);
  });

  it('makes a period that is not in <periods> a problem, naming the number', () => {
    const r = readAscXml(mini({ cards: [cardRow({ period: '9' }), cardRow({ period: 'x', days: '01000' })] }));
    expect(r.lessons).toEqual([]);
    expect(r.problems.map((p) => [p.ref, p.code])).toEqual([
      ['kort 1', 'ASC_PERIOD_UNKNOWN'],
      ['kort 2', 'ASC_CARD_NO_PERIOD'],
    ]);
    expect(r.problems[0]!.message).toContain('perioden 9');
  });

  it('reads no time at all from a file without <periods>', () => {
    const r = readAscXml(mini({ periods: '' }));
    expect(r.lessons).toEqual([]);
    expect(r.problems.map((p) => p.code)).toEqual(['ASC_PERIOD_UNKNOWN']);
  });

  it('makes a card of an unknown or unnamed lesson a problem', () => {
    const r = readAscXml(mini({ cards: [cardRow({ lessonid: 'nope' }), cardRow({ lessonid: null }), cardRow()] }));
    expect(r.lessons).toHaveLength(1);
    expect(r.problems.map((p) => [p.ref, p.code])).toEqual([
      ['kort 1', 'ASC_CARD_NO_LESSON'],
      ['kort 2', 'ASC_CARD_NO_LESSON'],
    ]);
  });

  it('reports a bad lesson once however many cards it has, by its place in the file, and reads the others', () => {
    const r = readAscXml(mini({ lessons: [lessonRow(), lessonRow({ id: 'L2', subjectid: null }), lessonRow({ id: 'L3', classids: null })], cards: [cardRow(), cardRow({ lessonid: 'L2' }), cardRow({ lessonid: 'L2', days: '01000' }), cardRow({ lessonid: 'L3' })] }));
    expect(r.lessons).toHaveLength(1);
    expect(r.problems.map((p) => [p.ref, p.code])).toEqual([
      ['lektion 2', 'ASC_LESSON_NO_SUBJECT'],
      ['lektion 3', 'ASC_LESSON_NO_GROUP'],
    ]);
    expect(r.problems.every((p) => /hoppas över/.test(p.message))).toBe(true);
  });

  it('refuses a lesson that points at a class or group the file does not have', () => {
    const r = readAscXml(mini({ lessons: [lessonRow({ classids: 'C1,C404', groupids: 'G404' })] }));
    expect(r.lessons).toEqual([]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.message).toContain('"G404"');
    expect(r.problems[0]!.message).toContain('"C404"');
  });
});

describe('CHOICE 19: no personnummer', () => {
  it('ignores a field named like one, never echoes its value, and names the field in one note', () => {
    const value = '19121212-1212';
    const xml = mini({ extra: `<students><student id="X1" classid="C1" name="Pupil" personnummer="${value}" ssn="${value}"/></students>` })
      .replace('short="TO"', `short="TO" pnr="${value}"`)
      .replace('<card ', `<card civic_number="${value}" `);
    const r = readAscXml(xml);
    expect(r.problems).toEqual([]);
    expect(r.lessons).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(value);
    expect(JSON.stringify(r)).not.toContain('19121212');
    const note = r.notes.find((n) => n.includes('personnummer'))!;
    expect(note).toContain('personnummer, pnr, ssn');
    expect(note).not.toContain('civic_number' + value);
    expect(r.notes.filter((n) => n.includes('liknar personnummer'))).toHaveLength(1);
    expect(r.lessons[0]!.teachers[0]).toEqual({ short: 'TO', name: 'Teacher One', email: null, id: null });
  });

  it('says nothing when the field is empty or absent', () => {
    expect(notesWithoutBlock(readAscXml(mini({ extra: '<students><student id="X1" classid="C1" personnummer=""/></students>' })).notes)).toEqual([]);
  });

  it('writes none: nothing in the document model could carry one', () => {
    expect(writeAscXml(highSchoolDocument())).not.toMatch(/personnummer|pnr|ssn/i);
  });
});

describe('CHOICE 20: limits and invalid files', () => {
  it('reports a malformed file as one ASC_XML_INVALID, in Swedish, and never throws', () => {
    for (const bad of ['', 'inte xml', '<timetable><periods></timetable>', '<timetable>', '<a/><b/>']) {
      const r = readAscXml(bad);
      expect(r.lessons).toEqual([]);
      expect(r.notes).toEqual([]);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toMatchObject({ ref: 'fil', code: 'ASC_XML_INVALID' });
      expect(r.problems[0]!.message).toMatch(/^Filen kunde inte läsas som XML: /);
    }
  });

  it('refuses a DOCTYPE and an ENTITY by name, and expands nothing', () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE timetable [<!ENTITY boom "boom">]><timetable><subjects><subject id="S1" name="&boom;"/></subjects></timetable>`;
    const r = readAscXml(xml);
    expect(r.lessons).toEqual([]);
    expect(r.problems).toEqual([{ ref: 'fil', code: 'ASC_XML_INVALID', message: 'Filen kunde inte läsas som XML: DOCTYPE och ENTITY tas inte emot.' }]);
  });

  it('refuses a file that is not an aSc file', () => {
    const r = readAscXml('<html><body/></html>');
    expect(r.problems).toEqual([{ ref: 'fil', code: 'ASC_NOT_TIMETABLE', message: expect.stringContaining('<html>') }]);
  });

  it('refuses a source over MAX_EXCHANGE_BYTES before it parses it', () => {
    const r = readAscXml(`<timetable>${' '.repeat(MAX_EXCHANGE_BYTES)}</timetable>`);
    expect(r.lessons).toEqual([]);
    expect(r.problems).toEqual([{ ref: 'fil', code: 'ASC_TOO_LARGE', message: 'Filen är större än 8 MB och läses inte.' }]);
  });

  it('takes exactly MAX_EXCHANGE_LESSONS lessons and refuses one more, whole', () => {
    const ok = readAscXml(mini({ cards: Array.from({ length: MAX_EXCHANGE_LESSONS }, () => cardRow()) }));
    expect(ok.problems).toEqual([]);
    expect(ok.lessons).toHaveLength(MAX_EXCHANGE_LESSONS);
    const over = readAscXml(mini({ cards: Array.from({ length: MAX_EXCHANGE_LESSONS + 1 }, () => cardRow()) }));
    expect(over.lessons).toEqual([]);
    expect(over.problems).toEqual([{ ref: 'fil', code: 'ASC_TOO_MANY_LESSONS', message: `Filen har fler än ${MAX_EXCHANGE_LESSONS} lektioner och läses inte.` }]);
  });

  it('counts a card on several days as several lessons against the limit', () => {
    const r = readAscXml(mini({ cards: Array.from({ length: MAX_EXCHANGE_LESSONS / 5 + 1 }, () => cardRow({ days: '11111' })) }));
    expect(r.lessons).toEqual([]);
    expect(r.problems.map((p) => p.code)).toEqual(['ASC_TOO_MANY_LESSONS']);
  });
});
