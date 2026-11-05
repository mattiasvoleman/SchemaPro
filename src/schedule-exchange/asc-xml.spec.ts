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
import { MAX_PROBLEMS, hasPersonalNumber } from './file-safety';
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

/** A personnummer as a school's file might carry one, and a test for any trace of it, whole or in part, in an answer. */
const PN = '19800101-1234';
const leaks = (answer: unknown): boolean => /1980|800101|1234/.test(JSON.stringify(answer)) || hasPersonalNumber(JSON.stringify(answer));
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
    expect(r.notes).toContainEqual(expect.stringContaining('”Söndag”'));
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
    expect(r.notes).toContainEqual(expect.stringContaining(`”${name}”`));
  });

  it('names a term with no def by its position, and refuses a terms string that is not bits', () => {
    const r = readAscXml(mini({ cards: [cardRow({ terms: '010' }), cardRow({ terms: 'x', days: '01000' })] }));
    expect(r.lessons).toHaveLength(1);
    expect(r.notes).toContainEqual(expect.stringContaining('”period 2”'));
    expect(r.problems.map((p) => p.code)).toEqual(['ASC_TERMS_INVALID']);
  });

  describe('a name is cut apart in code and tried only up to MAX_SPAN_NAME characters', () => {
    const readTerm = (name: string) => {
      const defs = `<termsdefs><termsdef id="t1" name="${name}" terms="10"/></termsdefs>`;
      return readAscXml(mini({ defs, cards: [cardRow({ terms: '10' })] }));
    };
    // 10 + blanks + 1 + 10 characters: 99 blanks make 120, 100 make 121.
    const spaced = (blanks: number): string => `2026-08-17${' '.repeat(blanks)}–2026-12-18`;

    it('reads a span with 99 blanks before its dash (120 characters), the longest that is tried', () => {
      const r = readTerm(spaced(99));
      expect(r.lessons[0]).toMatchObject({ from: '2026-08-17', to: '2026-12-18' });
      expect(notesWithoutBlock(r.notes)).toEqual([]);
    });

    it('does not try a name of 121 characters, reads the whole year and says so without quoting the name', () => {
      const r = readTerm(spaced(100));
      expect(r.lessons[0]).toMatchObject({ from: null, to: null });
      expect(notesWithoutBlock(r.notes)).toEqual([expect.stringContaining('längre än 120 tecken')]);
      expect(JSON.stringify(r.notes)).not.toContain('2026-08-17');
    });

    it('says it once however many terms have a long name', () => {
      const long = 'T'.repeat(500);
      const defs = `<termsdefs><termsdef id="t1" name="${long}" terms="10"/><termsdef id="t2" name="${long}x" terms="01"/></termsdefs>`;
      const r = readAscXml(mini({ defs, cards: [cardRow({ terms: '10' }), cardRow({ terms: '01', days: '01000' })] }));
      expect(r.lessons.map((l) => [l.from, l.to])).toEqual([[null, null], [null, null]]);
      expect(r.notes.filter((n) => n.includes('längre än 120 tecken'))).toHaveLength(1);
    });

    it.each([0, 100, 32_000])('reads a name of a dash, %i blanks and an x in no time (it was quadratic)', (blanks) => {
      const started = Date.now();
      const r = readTerm(`–${' '.repeat(blanks)}x`);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(r.lessons[0]).toMatchObject({ from: null, to: null });
    });

    it.each([0, 50, 32_000])('reads a name of a date, %i blanks, a dash, the same blanks and an x in no time', (blanks) => {
      const started = Date.now();
      readTerm(`2026-08-17${' '.repeat(blanks)}–${' '.repeat(blanks)}x`);
      expect(Date.now() - started).toBeLessThan(1000);
    });

    it.each([
      ['a dash alone', '–'],
      ['two dates and no dash', '2026-08-17 2026-12-18'],
      ['a date, a dash and text', '2026-08-17–till jul'],
      ['text, a dash and a date', 'från–2026-12-18'],
      ['a bad first date', '2026-13-01–2026-12-18'],
      ['a bad second date', '2026-08-17–2026-02-30'],
    ])('does not read %s as a span', (_label, name) => {
      expect(readTerm(name).lessons[0]).toMatchObject({ from: null, to: null });
    });

    it('reads a span of one end however the blanks fall', () => {
      expect(readTerm('  2026-08-17 \t –  ').lessons[0]).toMatchObject({ from: '2026-08-17', to: null });
      expect(readTerm('–  2026-12-18').lessons[0]).toMatchObject({ from: null, to: '2026-12-18' });
    });

    it('gives every card of a term the term\'s dates, resolving the term once for all of them', () => {
      const defs = `<termsdefs><termsdef id="t1" name="${autumn}" terms="10"/></termsdefs>`;
      const cards = Array.from({ length: 300 }, (_, i) => cardRow({ terms: '10', days: '10000', period: String(1 + (i % 4)) }));
      const r = readAscXml(mini({ defs, cards }));
      expect(r.lessons).toHaveLength(300);
      expect(r.lessons.every((l) => l.from === '2026-08-17' && l.to === '2026-12-18')).toBe(true);
    });
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
    expect(r.problems).toEqual([{ ref: 'lektion 1', code: 'ASC_LESSON_REF_UNKNOWN', message: expect.stringContaining('läraren ”T404”') }]);
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
    expect(r.problems).toEqual([{ ref: 'kort 1', code: 'ASC_CARD_REF_UNKNOWN', message: expect.stringContaining('salen ”R404”') }]);
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
      'Perioden ”Term 1” i aSc har inga datum och läses som hela läsåret; sätt datum på lektionerna efter importen om de bara ska gälla en del av året.',
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

  it('refuses a lesson that points at a room the file does not have', () => {
    const r = readAscXml(mini({ lessons: [lessonRow({ classroomids: 'R1,R404' })] }));
    expect(r.lessons).toEqual([]);
    expect(r.problems).toEqual([{ ref: 'lektion 1', code: 'ASC_LESSON_REF_UNKNOWN', message: 'Lektion 1 hoppas över: salen ”R404” finns inte i filen.' }]);
  });

  it('reads the first of two rows with one id, whatever the others say', () => {
    const xml = mini({ groups: '<groups><group id="G1" classid="C1" name="Hela klassen" entireclass="1"/><group id="G1" classid="C1" name="Annan" entireclass="0"/></groups>' })
      .replace('<teacher id="T1" name="Teacher One" short="TO"/>', '<teacher id="T1" name="Teacher One" short="TO"/><teacher id="T1" name="Impostor" short="XX"/>');
    const r = readAscXml(xml.replace('<lesson ', '<lesson groupids="G1" '));
    expect(r.lessons[0]).toMatchObject({ group: '7A', teachers: [{ short: 'TO' }] });
  });

  it('refuses a lesson that points at a class or group the file does not have', () => {
    const r = readAscXml(mini({ lessons: [lessonRow({ classids: 'C1,C404', groupids: 'G404' })] }));
    expect(r.lessons).toEqual([]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.message).toContain('”G404”');
    expect(r.problems[0]!.message).toContain('”C404”');
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

  describe('a field named like one', () => {
    it('does not taint the row that carries it: the row is read, the field is not', () => {
      const xml = mini().replace('<teacher id="T1"', '<teacher id="T1" personnummer="19800101-1234"');
      const r = readAscXml(xml);
      expect(r.problems).toEqual([]);
      expect(r.lessons[0]!.teachers).toEqual([{ short: 'TO', name: 'Teacher One', email: null, id: null }]);
      expect(r.notes).toContainEqual('Filen har fält som liknar personnummer (personnummer). De läses aldrig och sparas inte.');
      expect(leaks(r)).toBe(false);
    });

    it('drops an element named like one, with its text and everything below it, and notes it only when it has text', () => {
      const xml = mini()
        .replace('<teachers>', '<teachers><pnr>19800101-1234</pnr><samordningsnummer/>')
        .replace('</timetable>', '<personnummer><teacher id="T9" name="Nine" short="NI"/></personnummer></timetable>');
      const r = readAscXml(xml);
      expect(r.problems).toEqual([]);
      expect(r.lessons).toHaveLength(1);
      expect(r.notes).toContainEqual(expect.stringContaining('(pnr)'));
      expect(leaks(r)).toBe(false);
      // Nothing below the dropped element is a teacher: a lesson that names T9 cannot find it.
      const t9 = readAscXml(xml.replace('teacherids="T1"', 'teacherids="T9"'));
      expect(t9.problems.map((p) => p.code)).toEqual(['ASC_LESSON_REF_UNKNOWN']);
    });

    it('lists at most ten names, sorted, and counts the rest', () => {
      const attrsOf = Array.from({ length: 13 }, (_, i) => `pnr${String(i).padStart(2, '0')}="x"`).join(' ');
      const r = readAscXml(mini({ extra: `<students><student id="X1" ${attrsOf}/></students>` }));
      const note = r.notes.find((n) => n.startsWith('Filen har fält som liknar personnummer'))!;
      expect(note).toContain('pnr00, pnr01, pnr02, pnr03, pnr04, pnr05, pnr06, pnr07, pnr08, pnr09, 3 till');
      expect(note).not.toContain('pnr10');
    });

    it('does not list a name that has the shape itself, it counts it', () => {
      const one = readAscXml(mini({ extra: '<students><student id="X1" pnr19800101-1234="x" ssn="y"/></students>' }));
      expect(one.notes).toContainEqual('Filen har fält som liknar personnummer (ssn, ett fält vars namn liknar ett personnummer). De läses aldrig och sparas inte.');
      const two = readAscXml(mini({ extra: '<students><student id="X1" pnr19800101-1234="x" ssn-198001011234="y"/></students>' }));
      expect(two.notes).toContainEqual('Filen har fält som liknar personnummer (2 fält vars namn liknar ett personnummer). De läses aldrig och sparas inte.');
      expect(leaks(one) || leaks(two)).toBe(false);
    });
  });

  /** Puts the number in a field of the first row that starts with `opening` (the field is added or, when the row has it, replaced: the last one wins). */
  const put = (xml: string, opening: string, field: string, value: string = PN): string => {
    const at = xml.indexOf(opening);
    expect(at).toBeGreaterThanOrEqual(0);
    const end = xml.indexOf('>', at);
    const close = xml[end - 1] === '/' ? end - 1 : end;
    return `${xml.slice(0, close)} ${field}="${value}"${xml.slice(close)}`;
  };
  const THE_NOTE = (what: string): string =>
    `Filen har värden som liknar personnummer i ${what}. De läses aldrig och sparas inte, och en lektion som hänvisar till dem läses inte heller. Rastra tar inte emot personnummer.`;

  describe('a COPIED field (a name, a short, an e-mail, a time) with the shape taints its row, which is not read', () => {
    const defsOf = [
      '<daysdefs><daysdef id="D1" name="Mån" days="10000"/></daysdefs>',
      '<weeksdefs><weeksdef id="W1" name="Varje" weeks="1"/></weeksdefs>',
      '<termsdefs><termsdef id="M1" name="Hela" terms="1"/></termsdefs>',
    ].join('');

    it.each([
      ['a teacher', mini(), '<teacher id="T1"', 'läraren', '1 lärare'],
      ['a class', mini(), '<class id="C1"', 'klassen', '1 klass'],
      ['a subject', mini(), '<subject id="S1"', 'ämnet', '1 ämne'],
      ['a classroom', mini(), '<classroom id="R1"', 'salen', '1 sal'],
      ['a group', mini({ lessons: [lessonRow({ groupids: 'G1' })] }), '<group id="G1"', 'gruppen', '1 grupp'],
      ['the class of a group', mini({ lessons: [lessonRow({ classids: null, groupids: 'G1' })] }), '<class id="C1"', 'klassen', '1 klass'],
      ['a days definition', mini({ defs: defsOf, lessons: [lessonRow({ daysdefid: 'D1' })] }), '<daysdef id="D1"', 'dagdefinitionen', '1 dagdefinition'],
      ['a weeks definition', mini({ defs: defsOf, lessons: [lessonRow({ weeksdefid: 'W1' })] }), '<weeksdef id="W1"', 'veckodefinitionen', '1 veckodefinition'],
      ['a terms definition', mini({ defs: defsOf, lessons: [lessonRow({ termsdefid: 'M1' })] }), '<termsdef id="M1"', 'terminen', '1 termin'],
    ])('a lesson that points at %s with one is one problem that names the kind and not the value', (_label, file, opening, the, counted) => {
      const r = readAscXml(put(file, opening, 'name'));
      expect(r.lessons).toEqual([]);
      expect(r.problems).toEqual([
        {
          ref: 'lektion 1',
          code: 'ASC_LESSON_PERSONAL_NUMBER',
          message: `Lektion 1 hoppas över: ${the} som lektionen hänvisar till har ett värde som liknar ett personnummer. Rastra tar inte emot personnummer.`,
        },
      ]);
      expect(r.notes).toContainEqual(THE_NOTE(counted));
      expect(leaks(r)).toBe(false);
    });

    it.each([
      ['a teacher’s name', '<teacher id="T1"', 'name'],
      ['a teacher’s short', '<teacher id="T1"', 'short'],
      ['a teacher’s e-mail', '<teacher id="T1"', 'email'],
      ['a teacher’s first name', '<teacher id="T1"', 'firstname'],
      ['a teacher’s last name', '<teacher id="T1"', 'lastname'],
      ['a subject’s short', '<subject id="S1"', 'short'],
      ['a classroom’s short', '<classroom id="R1"', 'short'],
      ['a class’s short', '<class id="C1"', 'short'],
    ])('%s', (_label, opening, field) => {
      const r = readAscXml(put(mini(), opening, field));
      expect(r.lessons).toEqual([]);
      expect(r.problems.map((p) => p.code)).toEqual(['ASC_LESSON_PERSONAL_NUMBER']);
      expect(leaks(r)).toBe(false);
    });

    it('also takes a definition’s short, which is matched against the names of the week days', () => {
      const defs = '<daysdefs><daysdef id="D1" name="Mån" days="10000"/></daysdefs>';
      const r = readAscXml(put(mini({ defs, lessons: [lessonRow({ daysdefid: 'D1' })] }), '<daysdef id="D1"', 'short'));
      expect(r.problems.map((p) => p.code)).toEqual(['ASC_LESSON_PERSONAL_NUMBER']);
    });

    it('reads the lessons that do not point at it, and says once what it did not read', () => {
      const two = mini({ lessons: [lessonRow(), lessonRow({ id: 'L2', teacherids: 'T2' })], cards: [cardRow(), cardRow({ lessonid: 'L2', days: '01000' }), cardRow({ lessonid: 'L2', days: '00100' })] });
      const r = readAscXml(put(two, '<teacher id="T1"', 'name'));
      expect(r.lessons.map((l) => [l.day, l.teachers[0]!.short])).toEqual([
        [2, 'TW'],
        [3, 'TW'],
      ]);
      expect(r.problems.map((p) => [p.ref, p.code])).toEqual([['lektion 1', 'ASC_LESSON_PERSONAL_NUMBER']]);
      expect(r.notes.filter((n) => n.includes('liknar personnummer'))).toEqual([THE_NOTE('1 lärare')]);
    });

    it('reports a lesson once however many cards it has', () => {
      const r = readAscXml(put(mini({ cards: [cardRow(), cardRow({ days: '01000' }), cardRow({ days: '00100' })] }), '<subject id="S1"', 'name'));
      expect(r.problems).toHaveLength(1);
    });

    it('is not silent about a tainted row nothing points at: one note, counted by kind', () => {
      let xml = mini();
      xml = xml.replace('<teachers>', `<teachers><teacher id="T8" name="${PN}" short="EI"/><teacher id="T9" name="Nine" short="${PN}"/>`);
      xml = xml.replace('<classrooms>', `<classrooms><classroom id="R9" name="${PN}"/>`);
      const r = readAscXml(xml);
      expect(r.problems).toEqual([]);
      expect(r.lessons).toHaveLength(1);
      expect(r.notes.filter((n) => n.includes('liknar personnummer'))).toEqual([THE_NOTE('2 lärare och 1 sal')]);
      expect(leaks(r)).toBe(false);
    });

    it('lists three kinds with commas and an "och"', () => {
      let xml = mini();
      xml = xml.replace('<teachers>', `<teachers><teacher id="T9" name="${PN}"/>`);
      xml = xml.replace('<classrooms>', `<classrooms><classroom id="R9" name="${PN}"/>`);
      xml = xml.replace('<subjects>', `<subjects><subject id="S9" name="${PN}"/>`);
      expect(readAscXml(xml).notes).toContainEqual(THE_NOTE('1 lärare, 1 ämne och 1 sal'));
    });

    it('never copies a field out of it, not even one that looks harmless', () => {
      const xml = mini().replace('<teachers>', `<teachers><teacher id="T7" name="Seven ${PN}" short="SE" email="seven@school.example"/>`);
      const r = readAscXml(xml.replace('teacherids="T1"', 'teacherids="T7,T1"'));
      expect(r.lessons).toEqual([]);
      expect(JSON.stringify(r)).not.toMatch(/Seven|seven@/);
    });

    it('says a kind once however many rows of it a lesson points at', () => {
      const xml = put(put(mini({ lessons: [lessonRow({ teacherids: 'T1,T2' })] }), '<teacher id="T1"', 'name'), '<teacher id="T2"', 'name');
      const r = readAscXml(xml);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]!.message.match(/läraren/g)).toHaveLength(1);
      expect(r.notes).toContainEqual(THE_NOTE('2 lärare'));
    });

    it('is a problem of the card when the card’s own room is tainted', () => {
      const file = mini({ lessons: [lessonRow({ classroomids: null })], cards: [cardRow({ classroomids: 'R1' }), cardRow({ classroomids: 'R2', days: '01000' })] });
      const r = readAscXml(put(file, '<classroom id="R1"', 'name'));
      expect(r.lessons.map((l) => l.room)).toEqual(['Sal 2']);
      expect(r.problems).toEqual([
        {
          ref: 'kort 1',
          code: 'ASC_CARD_PERSONAL_NUMBER',
          message: 'Kort 1 hoppas över: salen som kortet hänvisar till har ett värde som liknar ett personnummer. Rastra tar inte emot personnummer.',
        },
      ]);
    });

    describe('a period', () => {
      const periodsOf = (...rows: string[]): string => `<periods>${rows.join('')}</periods>`;
      const P1 = '<period period="1" starttime="8:00" endtime="8:45"/>';
      const P2 = '<period period="2" starttime="8:55" endtime="9:40"/>';
      const P1_TAINTED = `<period period="1" starttime="8:00" endtime="${PN}"/>`;
      const cards = [cardRow(), cardRow({ period: '2', days: '01000' })];
      const message = 'Kort 1 hoppas över: perioden 1 har ett värde som liknar ett personnummer. Rastra tar inte emot personnummer.';

      it('is a problem for the cards in it only, never a time', () => {
        const r = readAscXml(mini({ periods: periodsOf(P1_TAINTED, P2), cards }));
        expect(r.lessons.map((l) => [l.day, l.start])).toEqual([[2, '08:55']]);
        expect(r.problems).toEqual([{ ref: 'kort 1', code: 'ASC_PERIOD_PERSONAL_NUMBER', message }]);
        expect(r.notes).toContainEqual(THE_NOTE('1 period'));
        expect(leaks(r)).toBe(false);
      });

      it('stays one when the same number is listed again, clean, before or after', () => {
        for (const rows of [[P1_TAINTED, P1, P2], [P1, P1_TAINTED, P2]]) {
          const r = readAscXml(mini({ periods: periodsOf(...rows), cards }));
          expect(r.problems).toEqual([{ ref: 'kort 1', code: 'ASC_PERIOD_PERSONAL_NUMBER', message }]);
        }
      });

      it('is only counted when its number cannot be read', () => {
        const r = readAscXml(mini({ periods: periodsOf(P1, `<period period="x" starttime="${PN}"/>`, P2), cards }));
        expect(r.problems).toEqual([]);
        expect(r.notes).toContainEqual(THE_NOTE('1 period'));
      });

      it('names it “kortets period” when its number is itself shaped like a personnummer', () => {
        const file = mini({ periods: periodsOf(`<period period="8001011234" starttime="8:00" endtime="${PN}"/>`, P2), cards: [cardRow({ period: '8001011234' })] });
        const r = readAscXml(file);
        expect(r.problems).toEqual([
          {
            ref: 'kort 1',
            code: 'ASC_PERIOD_PERSONAL_NUMBER',
            message: 'Kort 1 hoppas över: kortets period har ett värde som liknar ett personnummer. Rastra tar inte emot personnummer.',
          },
        ]);
        expect(leaks(r)).toBe(false);
      });
    });

    describe('a terms definition', () => {
      const defs = (name: string): string => `<termsdefs><termsdef id="t1" name="${name}" terms="10"/><termsdef id="t2" name="Resten" terms="01"/></termsdefs>`;

      it('leaves a card that only it could name unread, and the cards the others name read', () => {
        const r = readAscXml(mini({ defs: defs(PN), cards: [cardRow({ terms: '10' }), cardRow({ terms: '01', days: '01000' }), cardRow({ terms: '11', days: '00100' })] }));
        expect(r.lessons.map((l) => [l.day, l.from, l.to])).toEqual([
          [2, null, null],
          [3, null, null],
        ]);
        expect(r.problems).toEqual([
          {
            ref: 'kort 1',
            code: 'ASC_CARD_PERSONAL_NUMBER',
            message:
              'Kort 1 hoppas över: kortets termin går inte att avgöra, eftersom en terminsdefinition i filen har ett värde som liknar ett personnummer. Rastra tar inte emot personnummer.',
          },
        ]);
        expect(r.notes).toContainEqual(THE_NOTE('1 termin'));
        expect(leaks(r)).toBe(false);
      });

      it('changes nothing for a file without one', () => {
        const r = readAscXml(mini({ defs: defs('Term 1'), cards: [cardRow({ terms: '10' })] }));
        expect(r.problems).toEqual([]);
        expect(r.lessons).toHaveLength(1);
      });
    });

    describe('a weeks definition', () => {
      const card = cardRow({ weeks: null });
      it('stops a card with no weeks from being read as every week, since the definition might hold a rotation', () => {
        const defs = `<weeksdefs><weeksdef id="W1" name="${PN}" weeks="10"/></weeksdefs>`;
        const r = readAscXml(mini({ defs, cards: [card] }));
        expect(r.problems.map((p) => p.code)).toEqual(['ASC_WEEKS_UNKNOWN']);
      });

      it('and a file without one reads the same card as every week', () => {
        const r = readAscXml(mini({ cards: [card] }));
        expect(r.problems).toEqual([]);
        expect(r.lessons.map((l) => l.weeks)).toEqual(['ALL']);
      });
    });
  });

  describe('a field the reader does not read never taints its row', () => {
    const UNREAD = (n: number): string =>
      n === 1
        ? 'Filen har 1 värde som liknar personnummer i ett fält som inte läses; det sparas inte. Rastra tar inte emot personnummer.'
        : `Filen har ${n} värden som liknar personnummer i fält som inte läses; de sparas inte. Rastra tar inte emot personnummer.`;

    it('keeps a teacher whose mobile number, birth date and extra column have the shape, and the lessons they teach', () => {
      const xml = put(put(put(mini(), '<teacher id="T1"', 'mobile', '0701234567'), '<teacher id="T1"', 'birthdate', PN), '<teacher id="T1"', 'skolid', PN);
      const r = readAscXml(xml);
      expect(r.problems).toEqual([]);
      expect(r.lessons).toHaveLength(1);
      expect(r.lessons[0]!.teachers).toEqual([{ short: 'TO', name: 'Teacher One', email: null, id: null }]);
      expect(r.notes).toContainEqual(UNREAD(3));
      expect(leaks(r)).toBe(false);
    });

    it('counts one value in the singular', () => {
      const r = readAscXml(put(mini(), '<teacher id="T1"', 'color', PN));
      expect(r.lessons).toHaveLength(1);
      expect(r.notes).toContainEqual(UNREAD(1));
    });

    it('does so in every row: a class’s teacher, a group’s count, a lesson’s capacity, a card’s id', () => {
      let xml = mini();
      xml = put(xml, '<class id="C1"', 'teacherid', PN);
      xml = put(xml, '<group id="G1"', 'studentcount', PN);
      xml = put(xml, '<lesson id="L1"', 'capacity', PN);
      xml = put(xml, '<card ', 'id', PN);
      const r = readAscXml(xml);
      expect(r.problems).toEqual([]);
      expect(r.lessons).toHaveLength(1);
      expect(r.notes).toContainEqual(UNREAD(4));
    });

    it('deletes the text of a row that has the shape, and reads the row', () => {
      const r = readAscXml(mini().replace('<teacher id="T1" name="Teacher One" short="TO"/>', `<teacher id="T1" name="Teacher One" short="TO">Anna ${PN}</teacher>`));
      expect(r.problems).toEqual([]);
      expect(r.lessons[0]!.teachers[0]!.name).toBe('Teacher One');
      expect(r.notes).toContainEqual(UNREAD(1));
      expect(leaks(r)).toBe(false);
    });

    it('counts a value in an element that is not a row, or that nothing reads, in the same note', () => {
      let xml = mini({ extra: `<students><student id="X1" name="Pupil ${PN}"/></students>` });
      xml = xml.replace('<timetable ', `<timetable displayname="${PN}" `);
      xml = xml.replace('<teachers>', `<teachers owner="${PN}">`);
      xml = xml.replace('<class id="C2" name="7B"/>', `<class id="C2" name="7B"><note why="${PN}"/></class>`);
      const r = readAscXml(xml);
      expect(r.problems).toEqual([]);
      expect(r.lessons).toHaveLength(1);
      expect(r.notes).toContainEqual(UNREAD(4));
      expect(leaks(r)).toBe(false);
    });

    it('adds the unread values to the note about tainted rows, in one note', () => {
      const xml = put(put(mini(), '<teacher id="T2"', 'mobile', '0701234567'), '<teacher id="T3"', 'name');
      const r = readAscXml(xml);
      expect(r.problems).toEqual([]);
      expect(r.notes.filter((n) => n.includes('liknar personnummer'))).toEqual([
        'Filen har värden som liknar personnummer i 1 lärare. De läses aldrig och sparas inte, och en lektion som hänvisar till dem läses inte heller. Dessutom finns 1 värde som liknar personnummer i ett fält som inte läses; det sparas inte. Rastra tar inte emot personnummer.',
      ]);
    });

    it('leaves the root’s options alone: they are read for daynumbering1 and never shown', () => {
      const r = readAscXml(mini({ root: `daynumbering1 ${PN}`, cards: [cardRow({ days: null, day: '1' })] }));
      expect(r.lessons.map((l) => l.day)).toEqual([1]);
      expect(r.notes.some((n) => n.includes('liknar personnummer') || n.includes('daynumbering1'))).toBe(false);
    });
  });

  describe('a LINK (an id, a bit string, a number) with the shape does not make its row unreadable, and is never copied', () => {
    const IDS = ['x19800101-1234y', '8001011234', '19800101-1234', '198001011234'];
    const control = readAscXml(mini());
    const sameAsControl = (r: ReturnType<typeof readAscXml>): void => {
      expect(r.problems).toEqual([]);
      expect(r.lessons).toEqual(control.lessons);
      expect(r.notes).toEqual(control.notes);
      expect(leaks(r)).toBe(false);
    };
    const renamed = (from: string, to: string, xml: string = mini()): string => xml.split(`"${from}"`).join(`"${to}"`);

    it.each(IDS)('reads a lesson, its cards and every row it points at when their ids are %s', (id) => {
      for (const from of ['L1', 'T1', 'S1', 'C1', 'R1']) sameAsControl(readAscXml(renamed(from, id)));
    });

    it.each(IDS)('reads a lesson in a group with the id %s, and the group of a class the same', (id) => {
      const file = mini({ lessons: [lessonRow({ groupids: 'G1' })] });
      const r = readAscXml(renamed('G1', id, file));
      expect(r.problems).toEqual([]);
      expect(r.lessons.map((l) => l.group)).toEqual(['7A']);
      expect(leaks(r)).toBe(false);
    });

    it.each(IDS)('reads the periods when their numbers are %s, and a card in one', (id) => {
      const r = readAscXml(mini().split('period="1"').join(`period="${id.replace(/\D/g, '') || '1'}"`));
      sameAsControl(r);
    });

    it.each(IDS)('reads the definitions and the bit strings that have the shape of %s', (id) => {
      const defs = `<daysdefs><daysdef id="${id}" name="Mån" days="10000"/></daysdefs><weeksdefs><weeksdef id="${id}x" name="V" weeks="0101010101"/></weeksdefs><termsdefs><termsdef id="${id}y" name="Alla" terms="1"/></termsdefs>`;
      const file = mini({ defs, lessons: [lessonRow({ daysdefid: id, weeksdefid: `${id}x`, termsdefid: `${id}y` })], cards: [cardRow({ weeks: '0101010101' })] });
      const r = readAscXml(file);
      expect(r.problems).toEqual([]);
      expect(r.lessons.map((l) => l.weeks)).toEqual(['EVEN']);
      expect(leaks(r)).toBe(false);
    });

    it('reads a card whose terms string has the shape, and names the term by its place', () => {
      const r = readAscXml(mini({ cards: [cardRow({ terms: '0101010101' })] }));
      expect(r.problems).toEqual([]);
      expect(r.notes).toContainEqual(expect.stringContaining('”period 2+4+6+8+10”'));
      expect(leaks(r)).toBe(false);
    });

    describe('a reference to one that is not in the file names the kind of thing and leaves the id out', () => {
      it.each(IDS)('in a lesson (%s)', (id) => {
        const cases: Array<[Record<string, string | null>, string, string]> = [
          [{ subjectid: id }, 'ASC_LESSON_NO_SUBJECT', 'ämnet'],
          [{ classids: id }, 'ASC_LESSON_REF_UNKNOWN', 'klassen'],
          [{ groupids: id }, 'ASC_LESSON_REF_UNKNOWN', 'gruppen'],
          [{ teacherids: id }, 'ASC_LESSON_REF_UNKNOWN', 'läraren'],
          [{ classroomids: id }, 'ASC_LESSON_REF_UNKNOWN', 'salen'],
        ];
        for (const [over, code, the] of cases) {
          const r = readAscXml(mini({ lessons: [lessonRow(over)] }));
          expect(r.problems).toEqual([
            { ref: 'lektion 1', code, message: `Lektion 1 hoppas över: ${the} som lektionen hänvisar till finns inte i filen.` },
          ]);
          expect(leaks(r)).toBe(false);
        }
      });

      it.each(IDS)('in a card (%s)', (id) => {
        const lesson = readAscXml(mini({ cards: [cardRow({ lessonid: id })] }));
        expect(lesson.problems).toEqual([
          { ref: 'kort 1', code: 'ASC_CARD_NO_LESSON', message: 'Kort 1 hoppas över: lektionen som kortet hänvisar till finns inte i filen.' },
        ]);
        const room = readAscXml(mini({ lessons: [lessonRow({ classroomids: null })], cards: [cardRow({ classroomids: id })] }));
        expect(room.problems).toEqual([
          { ref: 'kort 1', code: 'ASC_CARD_REF_UNKNOWN', message: 'Kort 1 hoppas över: salen som kortet hänvisar till finns inte i filen.' },
        ]);
        const period = readAscXml(mini({ cards: [cardRow({ period: id.replace(/\D/g, '') })] }));
        expect(period.problems).toEqual([
          { ref: 'kort 1', code: 'ASC_PERIOD_UNKNOWN', message: 'Kort 1 hoppas över: kortets period finns inte i filens perioder, och en tid gissas aldrig.' },
        ]);
        expect(leaks(lesson) || leaks(room) || leaks(period)).toBe(false);
      });

      it('and still quotes an id that is not shaped like one', () => {
        const r = readAscXml(mini({ lessons: [lessonRow({ teacherids: 'T404' })] }));
        expect(r.problems[0]!.message).toBe('Lektion 1 hoppas över: läraren ”T404” finns inte i filen.');
      });
    });

    it('does not name a bit string or a number that has the shape when it says the string cannot be read', () => {
      const days = readAscXml(mini({ cards: [cardRow({ days: '8001011234' })] }));
      const weeks = readAscXml(mini({ cards: [cardRow({ weeks: '8001011234' })] }));
      const terms = readAscXml(mini({ cards: [cardRow({ terms: '8001011234' })] }));
      expect(days.problems).toEqual([{ ref: 'kort 1', code: 'ASC_DAY_INVALID', message: 'Kort 1 hoppas över: dagarna pekar inte ut någon dag.' }]);
      expect(weeks.problems).toEqual([
        { ref: 'kort 1', code: 'ASC_WEEKS_UNSUPPORTED', message: 'Kort 1 hoppas över: veckorna går inte att uttrycka som varje, udda eller jämn vecka.' },
      ]);
      expect(terms.problems).toEqual([{ ref: 'kort 1', code: 'ASC_TERMS_INVALID', message: 'Kort 1 hoppas över: perioderna går inte att läsa.' }]);
      const perCard = readAscXml(mini({ lessons: [lessonRow({ periodspercard: '8001011234' })] }));
      expect(perCard.problems[0]!.message).toBe(
        'Kort 1 hoppas över: lektionen har ett orimligt antal perioder per kort men kortet har bara 1 på rad, så längden går inte att avgöra.',
      );
      expect(leaks([days, weeks, terms, perCard])).toBe(false);
    });

    it('does not use an id shaped like a personnummer as the name of a group or a definition that has none', () => {
      const group = readAscXml(
        mini({ groups: '<groups><group id="8001011234" classid="C1" entireclass="0"/></groups>', lessons: [lessonRow({ classids: null, groupids: '8001011234' })] }),
      );
      expect(group.lessons).toEqual([]);
      expect(group.problems.map((p) => [p.code, p.message])).toEqual([
        [
          'ASC_LESSON_PERSONAL_NUMBER',
          'Lektion 1 hoppas över: gruppen som lektionen hänvisar till har ett värde som liknar ett personnummer. Rastra tar inte emot personnummer.',
        ],
      ]);
      const term = readAscXml(mini({ defs: '<termsdefs><termsdef id="8001011234" terms="10"/></termsdefs>', cards: [cardRow({ terms: '10' })] }));
      expect(term.lessons).toHaveLength(1);
      expect(term.notes).toContainEqual(expect.stringContaining('Perioden ”utan namn” i aSc'));
      expect(leaks(group) || leaks(term)).toBe(false);
      // An id that is not shaped like one is still the name of a row that has none.
      const plainGroup = readAscXml(
        mini({ groups: '<groups><group id="Gx" classid="C1" entireclass="0"/></groups>', lessons: [lessonRow({ classids: null, groupids: 'Gx' })] }),
      );
      expect(plainGroup.lessons.map((l) => l.group)).toEqual(['Gx']);
      const plainTerm = readAscXml(mini({ defs: '<termsdefs><termsdef id="Tx" terms="10"/></termsdefs>', cards: [cardRow({ terms: '10' })] }));
      expect(plainTerm.notes).toContainEqual(expect.stringContaining('Perioden ”Tx” i aSc'));
    });

    it('does not call a group by the id of a class that is not in the file when that id has the shape', () => {
      const groups = '<groups><group id="G1" classid="8001011234" name="Grupp 1" entireclass="0"/><group id="G2" classid="C2" name="Grupp 1" entireclass="0"/></groups>';
      const r = readAscXml(mini({ groups, lessons: [lessonRow({ classids: null, groupids: 'G1' })] }));
      expect(r.problems).toEqual([]);
      expect(r.lessons.map((l) => l.group)).toEqual(['Grupp 1']);
      expect(leaks(r)).toBe(false);
      const plain = readAscXml(mini({ groups: groups.replace('8001011234', 'K404'), lessons: [lessonRow({ classids: null, groupids: 'G1' })] }));
      expect(plain.lessons.map((l) => l.group)).toEqual(['K404 Grupp 1']);
    });
  });

  describe('what of the file still reaches a message', () => {
    it('is quoted through excerpt: one line, 40 characters, a number redacted', () => {
      const r = readAscXml(mini({ lessons: [lessonRow({ teacherids: 'T1,Läraren\nmed ett mycket långt namn som inte finns i filen alls' })] }));
      expect(r.problems[0]!.message).toBe(
        'Lektion 1 hoppas över: läraren ”Läraren med ett mycket långt namn som in…” finns inte i filen.',
      );
    });

    it('is redacted in the reason of a parser error and in the name of a wrong root, and cut', () => {
      const bad = readAscXml(`<timetable><${PN}>`);
      expect(bad.problems).toEqual([{ ref: 'fil', code: 'ASC_XML_INVALID', message: 'Filen kunde inte läsas som XML: Elementet <[personnummer]> slutar aldrig.' }]);
      const wrongRoot = readAscXml(`<${'x'.repeat(5000)}/>`);
      expect(wrongRoot.problems[0]!.message).toBe(`Filen är ingen aSc Timetables XML: rotelementet är <${'x'.repeat(40)}…>, inte <timetable>.`);
      const longName = readAscXml(`<timetable><${'y'.repeat(5000)}>`);
      expect(longName.problems[0]!.message.length).toBeLessThan(220);
    });
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

  it('reads one lesson more than the limit through a card on two days, and refuses the file', () => {
    const cards = [...Array.from({ length: MAX_EXCHANGE_LESSONS - 1 }, () => cardRow()), cardRow({ days: '11000' })];
    const r = readAscXml(mini({ cards }));
    expect(r.lessons).toEqual([]);
    expect(r.problems.map((p) => p.code)).toEqual(['ASC_TOO_MANY_LESSONS']);
  });

  describe('an answer stays small however many cards echo one long value', () => {
    const answerSize = (r: unknown): number => JSON.stringify(r).length;

    it('one lesson with a 30 000-character terms value and 5 000 cards: 500 problems and a count', () => {
      const long = 'x'.repeat(30_000);
      const r = readAscXml(mini({ lessons: [lessonRow({ terms: long })], cards: Array.from({ length: 5000 }, () => cardRow({ terms: null })) }));
      expect(r.lessons).toEqual([]);
      expect(r.problems).toHaveLength(MAX_PROBLEMS + 1);
      expect(r.problems.slice(0, MAX_PROBLEMS).every((p) => p.code === 'ASC_TERMS_INVALID')).toBe(true);
      expect(r.problems[0]).toEqual({
        ref: 'kort 1',
        code: 'ASC_TERMS_INVALID',
        message: `Kort 1 hoppas över: perioderna ”${'x'.repeat(40)}…” går inte att läsa.`,
      });
      expect(r.problems.at(-1)).toEqual({ ref: '', code: 'ASC_TOO_MANY_PROBLEMS', message: `Ytterligare ${5000 - MAX_PROBLEMS} problem visas inte.` });
      expect(answerSize(r)).toBeLessThan(200_000);
    });

    const lessonLevel: Array<[string, string, string, Record<string, string | null>, Record<string, string | null>]> = [
      ['weeks', 'veckorna', 'ASC_WEEKS_UNSUPPORTED', { weeks: 'y'.repeat(30_000) }, { weeks: null }],
      ['terms', 'perioderna', 'ASC_TERMS_INVALID', { terms: 'y'.repeat(30_000) }, { terms: null }],
    ];
    it.each(lessonLevel)('the same for the lesson-level %s', (_label, what, code, onLesson, onCard) => {
      const r = readAscXml(mini({ lessons: [lessonRow(onLesson)], cards: Array.from({ length: 3000 }, () => cardRow(onCard)) }));
      expect(r.problems).toHaveLength(MAX_PROBLEMS + 1);
      expect(r.problems[0]).toMatchObject({ code, message: expect.stringContaining(`${what} ”${'y'.repeat(40)}…”`) });
      expect(answerSize(r)).toBeLessThan(200_000);
    });

    it('5 000 lessons that each name a 1 000-character subject the file does not have', () => {
      const lessonsOf = Array.from({ length: 5000 }, (_, i) => lessonRow({ id: `L${i}`, subjectid: `${'s'.repeat(1000)}${i}` }));
      const cardsOf = Array.from({ length: 5000 }, (_, i) => cardRow({ lessonid: `L${i}` }));
      const r = readAscXml(mini({ lessons: lessonsOf, cards: cardsOf }));
      expect(r.problems).toHaveLength(MAX_PROBLEMS + 1);
      expect(r.problems[0]!.message).toBe(`Lektion 1 hoppas över: ämnet ”${'s'.repeat(40)}…” finns inte i filen.`);
      expect(answerSize(r)).toBeLessThan(200_000);
    });

    it('5 000 cards that name a lesson the file does not have, by a 1 000-character id each', () => {
      const r = readAscXml(mini({ cards: Array.from({ length: 5000 }, (_, i) => cardRow({ lessonid: `${'k'.repeat(1000)}${i}` })) }));
      expect(r.problems).toHaveLength(MAX_PROBLEMS + 1);
      expect(answerSize(r)).toBeLessThan(200_000);
    });

    it('keeps the problems that come first in the file, in the file’s order, however the passes found them', () => {
      // A block that is one card short is found in a later pass than a card with no lesson, but sits earlier in the file.
      const cards = [
        cardRow({ lessonid: 'LB', period: '1' }),
        ...Array.from({ length: 600 }, () => cardRow({ lessonid: 'L404' })),
      ];
      const r = readAscXml(mini({ lessons: [lessonRow({ id: 'LB', periodspercard: '2' })], cards }));
      expect(r.problems).toHaveLength(MAX_PROBLEMS + 1);
      expect(r.problems.slice(0, 3).map((p) => [p.ref, p.code])).toEqual([
        ['kort 1', 'ASC_CARD_BLOCK_INCOMPLETE'],
        ['kort 2', 'ASC_CARD_NO_LESSON'],
        ['kort 3', 'ASC_CARD_NO_LESSON'],
      ]);
      expect(r.problems[MAX_PROBLEMS - 1]!.ref).toBe(`kort ${MAX_PROBLEMS}`);
      expect(r.problems.at(-1)!.message).toBe('Ytterligare 101 problem visas inte.');
    });

    it('closes with no count when the problems fit', () => {
      const r = readAscXml(mini({ cards: Array.from({ length: MAX_PROBLEMS }, () => cardRow({ lessonid: 'L404' })) }));
      expect(r.problems).toHaveLength(MAX_PROBLEMS);
      expect(r.problems.some((p) => p.code === 'ASC_TOO_MANY_PROBLEMS')).toBe(false);
    });

    it('spells out five reasons of a lesson and counts the rest, whatever a lesson names', () => {
      const unknown = Array.from({ length: 200_000 }, (_, i) => `K${i}`).join(',');
      const r = readAscXml(mini({ lessons: [lessonRow({ classids: unknown })] }));
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]!.message).toMatch(/^Lektion 1 hoppas över: klassen ”K0” finns inte i filen\. klassen ”K1” .* klassen ”K4” finns inte i filen\. Ytterligare 199995 orsaker visas inte\.$/);
      expect(r.problems[0]!.message.length).toBeLessThan(400);
      const six = readAscXml(mini({ lessons: [lessonRow({ classids: 'K0,K1,K2,K3,K4,K5' })] }));
      expect(six.problems[0]!.message.endsWith(' Ytterligare 1 orsak visas inte.')).toBe(true);
    });

    it('says the personnummer sentence once, and gives the lesson its code, when other reasons come first and fill the list', () => {
      let xml = mini({ lessons: [lessonRow({ groupids: 'G404,G405,G406,G407,G408,G409', classids: 'C1', teacherids: 'T1' })] });
      xml = xml.replace('<class id="C1"', `<class id="C1" short="${PN}"`).replace('<teacher id="T1"', `<teacher id="T1" email="${PN}"`);
      const r = readAscXml(xml);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toMatchObject({ ref: 'lektion 1', code: 'ASC_LESSON_PERSONAL_NUMBER' });
      const message = r.problems[0]!.message;
      expect(message).toMatch(/Ytterligare 3 orsaker visas inte\. Rastra tar inte emot personnummer\.$/);
      expect(message.match(/Rastra tar inte emot personnummer/g)).toHaveLength(1);
    });

    it('lists at most ten terms by name in the notes and counts the rest, one note each, never one per card', () => {
      const width = 13;
      const bits = (i: number): string => '0'.repeat(i) + '1' + '0'.repeat(width - i - 1);
      const defs = `<termsdefs>${Array.from({ length: width }, (_, i) => `<termsdef id="t${i}" name="Term ${i}" terms="${bits(i)}"/>`).join('')}</termsdefs>`;
      const cards = Array.from({ length: 2000 }, (_, i) => cardRow({ terms: bits(i % width), period: String(1 + (i % 4)) }));
      const r = readAscXml(mini({ defs, cards }));
      const termNotes = r.notes.filter((n) => n.startsWith('Perioden') || n.includes('perioder till') || n.includes('period till'));
      expect(termNotes).toHaveLength(11);
      expect(termNotes[0]).toContain('”Term 0”');
      expect(termNotes[9]).toContain('”Term 9”');
      expect(termNotes[10]).toBe('3 perioder till i aSc har inga datum och läses som hela läsåret.');
      expect(answerSize(r.notes)).toBeLessThan(10_000);
    });

    it('lists at most ten week days that start on another position, and counts the rest', () => {
      const daysdefs = (n: number): string =>
        `<daysdefs>${Array.from({ length: n }, (_, i) => `<daysdef id="d${i}" name="Söndag ${i}" short="Sön" days="1000000"/>`).join('')}</daysdefs>`;
      const mismatches = (n: number) => readAscXml(mini({ defs: daysdefs(n) })).notes.filter((note) => note.includes('position 1 som måndag'));
      expect(mismatches(1)).toHaveLength(1);
      expect(mismatches(10)).toHaveLength(10);
      expect(mismatches(12)).toHaveLength(10);
      expect(readAscXml(mini({ defs: daysdefs(12) })).notes).toContainEqual(
        'Ytterligare 2 dagar i filen står på en annan position än den som läses som deras veckodag.',
      );
      expect(readAscXml(mini({ defs: daysdefs(11) })).notes).toContainEqual(
        'Ytterligare 1 dag i filen står på en annan position än den som läses som dess veckodag.',
      );
    });

    it('names a day with a long name only by its first characters', () => {
      const defs = `<daysdefs><daysdef id="d1" name="Söndag${'x'.repeat(5000)}" days="1000000"/></daysdefs>`;
      const note = readAscXml(mini({ defs })).notes.find((n) => n.includes('position 1 som måndag'))!;
      expect(note.length).toBeLessThan(200);
    });
  });

  describe('a string of days, weeks or terms is at most MAX_BITS characters (64)', () => {
    it.each([
      ['days', (n: number) => cardRow({ days: `1${'0'.repeat(n - 1)}` }), 'ASC_DAY_INVALID'],
      ['weeks', (n: number) => cardRow({ weeks: '1'.repeat(n) }), 'ASC_WEEKS_UNSUPPORTED'],
      ['terms', (n: number) => cardRow({ terms: '1'.repeat(n) }), 'ASC_TERMS_INVALID'],
    ])('%s: 64 characters are read, 65 are not', (_label, make, code) => {
      expect(readAscXml(mini({ cards: [make(64)] })).problems).toEqual([]);
      expect(readAscXml(mini({ cards: [make(64)] })).lessons).toHaveLength(1);
      const r = readAscXml(mini({ cards: [make(65)] }));
      expect(r.lessons).toEqual([]);
      expect(r.problems.map((p) => p.code)).toEqual([code]);
    });

    it('costs the cards of a lesson with a megabyte of ones in its weeks the length check, not the megabyte', () => {
      const started = Date.now();
      const r = readAscXml(mini({ lessons: [lessonRow({ weeks: '1'.repeat(1_000_000) })], cards: Array.from({ length: 4000 }, () => cardRow({ weeks: null })) }));
      expect(Date.now() - started).toBeLessThan(2000);
      expect(r.problems).toHaveLength(MAX_PROBLEMS + 1);
    });
  });

  describe('the work a lesson or a card costs is linear in the file', () => {
    it('a lesson in 20 000 classes and as many groups, each group of one class (was a pass over all groups per class: 12 s)', () => {
      const n = 20_000;
      const classes = Array.from({ length: n }, (_, i) => `<class id="C${i}" name="K${i}"/>`).join('');
      const groups = Array.from({ length: n }, (_, i) => `<group id="G${i}" classid="C${i}" name="g${i}" entireclass="0"/>`).join('');
      const ids = (prefix: string): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(',');
      const xml = mini({ groups: `<groups>${groups}</groups>`, lessons: [lessonRow({ classids: ids('C'), groupids: ids('G') })] }).replace('<classes><class id="C1" name="7A"/><class id="C2" name="7B"/></classes>', `<classes>${classes}</classes>`);
      const started = Date.now();
      const r = readAscXml(xml);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(r.problems).toEqual([]);
      expect(r.lessons).toHaveLength(1);
      expect(r.lessons[0]!.extraGroups).toHaveLength(n - 1);
    });

    it('30 000 cards of a lesson that wants two periods in a row (were copied once per card: 1.8 s)', () => {
      const cards = Array.from({ length: 40_000 }, (_, i) => cardRow({ period: String(1 + (i % 2)), days: '10000' }));
      const started = Date.now();
      const r = readAscXml(mini({ lessons: [lessonRow({ periodspercard: '2' })], cards }));
      expect(Date.now() - started).toBeLessThan(1500);
      expect(r.problems.length).toBeGreaterThan(0);
    });
  });
});
