import { blankLesson, type ExchangeDocument, type ExchangeLesson, type TeacherRef } from '../exchange-model';

/**
 * Two timetables for the codecs to round-trip, hand-built to hold what a real
 * one holds: the small one is a lågstadium week of whole classes; the large one
 * is a högstadium week with a parallel block (Språkval), a class split into
 * halves, alternating A/B weeks, a term split (one half reads Bild in the
 * autumn and Musik in the spring, the other the opposite), a co-taught lesson,
 * a lesson two classes attend, a teacher with no e-mail and a lesson with no
 * room.
 */

const t = (short: string, name: string, email: string | null): TeacherRef => ({ short, name, email, id: null });

const ANNA = t('ABE', 'Anna Berg', 'anna.berg@skolan.example');
const BO = t('BLU', 'Bo Lund', 'bo.lund@skolan.example');
const CIA = t('CAN', 'Cia Andersson', 'cia.andersson@skolan.example');
const DAN = t('DNO', 'Dan Nord', null);
const EVA = t('EST', 'Eva Strand', 'eva.strand@skolan.example');
const FAR = t('FAL', 'Farid Alm', 'farid.alm@skolan.example');

const YEAR = { name: '2026/2027', start: '2026-08-17', end: '2027-06-11' };

function lesson(
  group: string,
  subject: string,
  subjectCode: string | null,
  teachers: TeacherRef[],
  room: string | null,
  day: number,
  start: string,
  end: string,
  more: Partial<ExchangeLesson> = {},
): ExchangeLesson {
  return blankLesson({ ref: '', group, subject, subjectCode, teachers, room, day, start, end, ...more });
}

export function smallSchoolDocument(): ExchangeDocument {
  return {
    school: 'Lillskolan',
    year: YEAR,
    groups: [
      { name: '1A', kind: 'CLASS', gradeLevel: 1, halfOf: null },
      { name: '2A', kind: 'CLASS', gradeLevel: 2, halfOf: null },
    ],
    subjects: [
      { name: 'Matematik', code: 'MA' },
      { name: 'Svenska', code: 'SV' },
      { name: 'Idrott och hälsa', code: 'IDH' },
    ],
    rooms: ['Klassrum 1', 'Klassrum 2', 'Gympasalen'],
    teachers: [ANNA, BO],
    lessons: [
      lesson('1A', 'Matematik', 'MA', [ANNA], 'Klassrum 1', 1, '08:30', '09:15'),
      lesson('1A', 'Svenska', 'SV', [ANNA], 'Klassrum 1', 1, '09:30', '10:15'),
      lesson('1A', 'Matematik', 'MA', [ANNA], 'Klassrum 1', 3, '08:30', '09:15'),
      lesson('1A', 'Idrott och hälsa', 'IDH', [BO], 'Gympasalen', 4, '10:30', '11:15'),
      lesson('2A', 'Matematik', 'MA', [BO], 'Klassrum 2', 1, '08:30', '09:15'),
      lesson('2A', 'Svenska', 'SV', [BO], 'Klassrum 2', 2, '08:30', '09:15'),
      lesson('2A', 'Idrott och hälsa', 'IDH', [BO], 'Gympasalen', 4, '08:30', '09:15'),
    ],
  };
}

export function highSchoolDocument(): ExchangeDocument {
  const autumn = { from: '2026-08-17', to: '2026-12-18' };
  const spring = { from: '2027-01-11', to: '2027-06-11' };
  return {
    school: 'Högstadieskolan',
    year: YEAR,
    groups: [
      { name: '7A', kind: 'CLASS', gradeLevel: 7, halfOf: null },
      { name: '7B', kind: 'CLASS', gradeLevel: 7, halfOf: null },
      { name: '8A', kind: 'CLASS', gradeLevel: 8, halfOf: null },
      { name: '8B', kind: 'CLASS', gradeLevel: 8, halfOf: null },
      { name: '7A-1', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOf: '7A' },
      { name: '7A-2', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOf: '7A' },
      { name: 'Sp7', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOf: null },
      { name: 'Ty7', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOf: null },
      { name: 'Fr7', kind: 'TEACHING_GROUP', gradeLevel: 7, halfOf: null },
    ],
    subjects: [
      { name: 'Matematik', code: 'MA' },
      { name: 'Svenska', code: 'SV' },
      { name: 'Engelska', code: 'EN' },
      { name: 'Idrott och hälsa', code: 'IDH' },
      { name: 'Bild', code: 'BL' },
      { name: 'Musik', code: 'MU' },
      { name: 'Slöjd', code: null },
      { name: 'Moderna språk Spanska', code: 'MSP' },
      { name: 'Moderna språk Tyska', code: 'MTY' },
      { name: 'Moderna språk Franska', code: 'MFR' },
    ],
    rooms: ['A101', 'A102', 'Bildsalen', 'Musiksalen', 'Slöjdsalen', 'Gymnastiksalen'],
    teachers: [ANNA, BO, CIA, DAN, EVA, FAR],
    lessons: [
      lesson('7A', 'Matematik', 'MA', [ANNA], 'A101', 1, '08:10', '09:10'),
      lesson('7A', 'Matematik', 'MA', [ANNA], 'A101', 3, '08:10', '09:10'),
      lesson('7A', 'Svenska', 'SV', [BO], 'A102', 1, '09:20', '10:20'),
      lesson('7B', 'Matematik', 'MA', [ANNA], 'A101', 2, '08:10', '09:10'),
      lesson('7B', 'Svenska', 'SV', [BO], 'A102', 2, '09:20', '10:20'),
      lesson('8A', 'Engelska', 'EN', [CIA], 'A102', 1, '10:30', '11:30'),
      // Co-taught, with two teachers; no room on the second.
      lesson('8A', 'Idrott och hälsa', 'IDH', [EVA, FAR], 'Gymnastiksalen', 4, '08:10', '09:40'),
      lesson('8B', 'Idrott och hälsa', 'IDH', [EVA], 'Gymnastiksalen', 4, '09:50', '11:20'),
      // Two classes attend one lesson; the teacher has no e-mail.
      lesson('8A', 'Musik', 'MU', [DAN], 'Musiksalen', 5, '10:30', '11:30', { extraGroups: ['8B'] }),
      // A lesson with no room and no teacher yet.
      lesson('8B', 'Engelska', 'EN', [], null, 3, '13:00', '14:00'),
      // A/B weeks: the same slot, two classes in turns.
      lesson('7A', 'Slöjd', null, [FAR], 'Slöjdsalen', 2, '13:00', '14:20', { weeks: 'ODD' }),
      lesson('7B', 'Slöjd', null, [FAR], 'Slöjdsalen', 2, '13:00', '14:20', { weeks: 'EVEN' }),
      // The class split in halves, with the term split: each half reads the other subject in the spring.
      lesson('7A-1', 'Bild', 'BL', [CIA], 'Bildsalen', 3, '13:00', '14:20', { ...autumn }),
      lesson('7A-1', 'Musik', 'MU', [DAN], 'Musiksalen', 3, '13:00', '14:20', { ...spring }),
      lesson('7A-2', 'Musik', 'MU', [DAN], 'Musiksalen', 3, '13:00', '14:20', { ...autumn }),
      lesson('7A-2', 'Bild', 'BL', [CIA], 'Bildsalen', 3, '13:00', '14:20', { ...spring }),
      // The parallel block: three groups, one slot, three teachers.
      lesson('Sp7', 'Moderna språk Spanska', 'MSP', [BO], 'A102', 4, '13:00', '13:40', { block: 'Språkval åk 7' }),
      lesson('Ty7', 'Moderna språk Tyska', 'MTY', [ANNA], 'A101', 4, '13:00', '13:40', { block: 'Språkval åk 7' }),
      lesson('Fr7', 'Moderna språk Franska', 'MFR', [CIA], 'Bildsalen', 4, '13:00', '13:40', { block: 'Språkval åk 7' }),
    ],
  };
}
