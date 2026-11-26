import { exemptionFinding, type GateLesson } from './publication-gates.reader';
import { GATE_CODES, GATE_COLUMN, settleGates, DEFAULT_GATE_POLICY, gateVerdict } from './publication-gates';

/*
 * PUB_EXEMPTIONS (Undantag med flit): the publication says how many lessons stand outside the ramtid or over the class's meal on purpose, names each with
 * the rule it stands against, and asks for nothing.
 */
const lesson = (id: string, over: Partial<GateLesson> = {}): GateLesson => ({
  id,
  subjectId: 's',
  studentGroupId: 'g',
  teacherId: 't',
  coTeacherId: null,
  roomId: 'r',
  dayOfWeek: 1,
  startTime: '14:30',
  endTime: '15:30',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  extraGroupIds: [],
  studentIds: [],
  subjectName: 'Matematik',
  groupName: '7A',
  ...over,
});

describe('PUB_EXEMPTIONS', () => {
  it('counts the placed lessons that have an exemption, and names the rule each stands against', () => {
    const finding = exemptionFinding([lesson('a', { exemptFrom: ['FRAME'] }), lesson('b', { exemptFrom: ['FRAME', 'LUNCH'] }), lesson('c'), lesson('d', { exemptFrom: [] })]);
    expect(finding).toMatchObject({ code: 'PUB_EXEMPTIONS', count: 2, info: true });
    expect(finding.entries).toEqual([
      { label: 'Matematik · 7A, mån 14:30–15:30 (ramtid)', masterLessonId: 'a' },
      { label: 'Matematik · 7A, mån 14:30–15:30 (ramtid, lunch)', masterLessonId: 'b' },
    ]);
  });

  it('counts none on the tray: a lesson set aside occupies nothing, and its exemption ends there', () => {
    expect(exemptionFinding([lesson('a', { exemptFrom: ['FRAME'], isParked: true })]).count).toBe(0);
  });

  it('is information: it follows no policy column, is said when there is one, and asks for no "Publicera ändå"', () => {
    expect(GATE_CODES).toContain('PUB_EXEMPTIONS');
    expect(GATE_COLUMN['PUB_EXEMPTIONS']).toBeNull();
    const items = settleGates([exemptionFinding([lesson('a', { exemptFrom: ['LUNCH'] })])], { ...DEFAULT_GATE_POLICY, gateParked: 'REFUSE' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ code: 'PUB_EXEMPTIONS', severity: 'INFO', count: 1 });
    expect(gateVerdict(items)).toEqual({ refused: false, needsAcknowledgement: false });
    expect(settleGates([exemptionFinding([lesson('a')])], DEFAULT_GATE_POLICY)).toEqual([]);
  });
});
