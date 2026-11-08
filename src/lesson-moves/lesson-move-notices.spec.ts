import { moveEmail, moveMeta } from './lesson-move-notices';

const IDS = { fromLessonId: 'l-from', toLessonId: 'l-to', studentId: 'p-1' };
const FROM = { subjectName: 'Svenska', startsAt: new Date('2027-01-25T07:00:00.000Z') };
const TO = { subjectName: 'Engelska', startsAt: new Date('2027-01-25T07:15:00.000Z') };

describe('what a move tells', () => {
  it('names the lesson the pupil is on now as subjectName: where they went after a move, where they are back after Ångra', () => {
    expect(moveMeta(IDS, FROM, TO, false)).toMatchObject({ subjectName: 'Engelska', fromSubjectName: 'Svenska', toSubjectName: 'Engelska' });
    expect(moveMeta(IDS, FROM, TO, true)).toMatchObject({ subjectName: 'Svenska', undone: true });
  });

  it('times the notice by the lesson the pupil left, carries the ids the app opens, and no name of a pupil or a mover', () => {
    const meta = moveMeta(IDS, FROM, TO, false);
    expect(meta.startsAt).toBe('2027-01-25T07:00:00.000Z');
    expect(meta).toMatchObject(IDS);
    expect('undone' in meta).toBe(false);
    expect(Object.keys(meta).sort()).toEqual(['fromLessonId', 'fromSubjectName', 'startsAt', 'studentId', 'subjectName', 'toLessonId', 'toSubjectName']);
  });

  it('words the guardian’s e-mail with the subjects and the time, Swedish on the school’s clock, and never a name', () => {
    const moved = moveEmail(FROM, TO, 'Europe/Stockholm', false);
    expect(moved.subject).toMatch(/^Ett barn byter lektion: /);
    expect(moved.body).toContain('Engelska i stället för Svenska');
    const undone = moveEmail(FROM, TO, 'Europe/Stockholm', true);
    expect(undone.subject).toMatch(/^Ett barns lektion är som planerat: /);
    expect(undone.body).toContain('ångrat');
    expect(undone.body).toContain('Svenska');
    for (const mail of [moved, undone]) expect(`${mail.subject}${mail.body}`).not.toMatch(/Alva|Rask/);
  });
});
