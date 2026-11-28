import { pairTemplates, templateKey, type TemplateFields } from './restore-calendar';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';

/** A Monday lesson of one class: everything a calendar row is made of. */
const template = (over: Partial<TemplateFields> = {}): TemplateFields => ({
  subjectId: 'subject-1',
  studentGroupId: 'group-1',
  teacherId: 'teacher-1',
  coTeacherId: null,
  roomId: 'room-1',
  dayOfWeek: 1,
  startTime: '08:00',
  endTime: '09:00',
  isParked: false,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  ...over,
});

describe('templateKey: "the same template" is everything a calendar row is made of', () => {
  it('is the same for the same lesson, whatever order its groups and pupils come in', () => {
    expect(templateKey(template({ extraGroupIds: ['g2', 'g1'], studentIds: ['p2', 'p1'] }))).toBe(
      templateKey(template({ extraGroupIds: ['g1', 'g2'], studentIds: ['p1', 'p2'] })),
    );
  });

  // Each of these is a field the calendar row is made of (CalendarService.materialise): a restore that read two lessons as the same when one
  // of them differs here would carry the published rows to a template that says something other than they do, and nothing would show it.
  it.each<[string, Partial<TemplateFields>]>([
    ['subject', { subjectId: 'subject-2' }],
    ['class', { studentGroupId: 'group-2' }],
    ['teacher', { teacherId: 'teacher-2' }],
    ['no teacher', { teacherId: null }],
    ['co-teacher', { coTeacherId: 'teacher-3' }],
    ['room', { roomId: 'room-2' }],
    ['no room', { roomId: null }],
    ['weekday', { dayOfWeek: 2 }],
    ['start', { startTime: '08:05' }],
    ['end', { endTime: '09:05' }],
    ['weeks', { recurrence: 'ODD_WEEKS' }],
    ['first day', { startDate: '2026-09-01' }],
    ['last day', { endDate: '2026-12-18' }],
    ['another group on it', { extraGroupIds: ['g1'] }],
    ['a pupil named on it', { studentIds: ['p1'] }],
    ['being on the tray (a parked lesson publishes nothing)', { isParked: true }],
  ])('differs when the %s differs', (_field, over) => {
    expect(templateKey(template(over))).not.toBe(templateKey(template()));
  });
});

describe('pairTemplates', () => {
  it('takes over every row of a lesson the version holds unchanged, and replaces none', () => {
    const current = [{ id: A, ...template() }, { id: B, ...template({ dayOfWeek: 3 }) }];
    const pairing = pairTemplates(current, [template({ dayOfWeek: 3 }), template()]);
    expect(pairing.from).toEqual([B, A]);
    expect(pairing.replaced).toEqual([]);
  });

  it('replaces a lesson the version changes or leaves out, and takes over nothing for a lesson it adds', () => {
    const current = [{ id: A, ...template() }, { id: B, ...template({ dayOfWeek: 3 }) }, { id: C, ...template({ dayOfWeek: 5 }) }];
    const pairing = pairTemplates(current, [template(), template({ dayOfWeek: 3, roomId: 'room-2' }), template({ dayOfWeek: 4 })]);
    expect(pairing.from).toEqual([A, null, null]);
    expect(pairing.replaced.sort()).toEqual([B, C]);
  });

  it('pairs one to one: two equal lessons in the version take two lessons of the year, and a third has none', () => {
    const current = [{ id: C, ...template() }, { id: A, ...template() }];
    const pairing = pairTemplates(current, [template(), template(), template()]);
    // In the order of the ids, so the same lesson takes the same rows every time.
    expect(pairing.from).toEqual([A, C, null]);
    expect(pairing.replaced).toEqual([]);
  });

  it('leaves one of two equal lessons of the year to be replaced when the version holds one', () => {
    const current = [{ id: A, ...template() }, { id: B, ...template() }];
    const pairing = pairTemplates(current, [template()]);
    expect(pairing.from).toEqual([A]);
    expect(pairing.replaced).toEqual([B]);
  });

  it('is empty for an empty year and for an empty version', () => {
    expect(pairTemplates([], [template()])).toEqual({ from: [null], replaced: [] });
    expect(pairTemplates([{ id: D, ...template() }], [])).toEqual({ from: [], replaced: [D] });
  });
});
