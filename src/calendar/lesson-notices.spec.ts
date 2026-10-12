import { lessonEmail } from './lesson-notices';

/** 08:00 on Tuesday 13 October in Stockholm (CEST), and 08:00 on Monday 26 October (CET). */
const SUMMER = new Date('2026-10-13T06:00:00.000Z');
const WINTER = new Date('2026-10-26T07:00:00.000Z');
const TZ = 'Europe/Stockholm';

describe('lessonEmail', () => {
  it('says each notice in Swedish, with the subject and the time on the school’s clock', () => {
    const lesson = { subjectName: 'Matematik', startsAt: SUMMER };
    const see = '\n\nSe schemat i SchemaPro.';
    expect(lessonEmail('LESSON_CANCELLED', lesson, TZ)).toEqual({
      subject: 'Inställd lektion: Matematik tis 13 okt 08:00',
      body: `Matematik tis 13 okt 08:00 är inställd.${see}`,
    });
    expect(lessonEmail('LESSON_CANCELLED', lesson, TZ, 'Brandövning')).toEqual({
      subject: 'Inställd lektion: Matematik tis 13 okt 08:00',
      body: `Matematik tis 13 okt 08:00 är inställd. Anledning: Brandövning${see}`,
    });
    expect(lessonEmail('LESSON_SUBSTITUTE', lesson, TZ)).toEqual({
      subject: 'Vikarie: Matematik tis 13 okt 08:00',
      body: `Matematik tis 13 okt 08:00 har en vikarie.${see}`,
    });
    expect(lessonEmail('LESSON_ROOM_CHANGED', lesson, TZ)).toEqual({
      subject: 'Ny sal: Matematik tis 13 okt 08:00',
      body: `Matematik tis 13 okt 08:00 har flyttat till en annan sal.${see}`,
    });
    expect(lessonEmail('LESSON_REINSTATED', lesson, TZ)).toEqual({
      subject: 'Lektionen blir av: Matematik tis 13 okt 08:00',
      body: `Matematik tis 13 okt 08:00 blir av som planerat.${see}`,
    });
    expect(lessonEmail('LESSON_SUPERVISED_STUDY', lesson, TZ)).toEqual({
      subject: 'Självstudier: Matematik tis 13 okt 08:00',
      body: `Matematik tis 13 okt 08:00 blir självstudier under tillsyn.${see}`,
    });
  });

  it('keeps the school’s 08:00 across the change to winter time, where a UTC instant moves an hour', () => {
    expect(lessonEmail('LESSON_CANCELLED', { subjectName: 'Bild', startsAt: WINTER }, TZ).subject).toBe(
      'Inställd lektion: Bild mån 26 okt 08:00',
    );
    // Another school's clock is its own.
    expect(lessonEmail('LESSON_CANCELLED', { subjectName: 'Bild', startsAt: WINTER }, 'Europe/Helsinki').subject).toBe(
      'Inställd lektion: Bild mån 26 okt 09:00',
    );
  });

  it('names no group, room or person, and no reason unless the cancellation gave one', () => {
    const text = JSON.stringify(
      (['LESSON_CANCELLED', 'LESSON_SUBSTITUTE', 'LESSON_ROOM_CHANGED', 'LESSON_REINSTATED', 'LESSON_SUPERVISED_STUDY'] as const).map(
        (type) => lessonEmail(type, { subjectName: 'Matematik', startsAt: SUMMER }, TZ),
      ),
    );
    expect(text).not.toMatch(/Anledning|Reason|T06:00|UTC/);
  });
});
