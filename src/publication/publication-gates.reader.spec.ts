import type { PrismaClient } from '@prisma/client';
import { createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { clashFinding, type GateLesson } from './publication-gates.reader';

/**
 * PUB_CLASHES over replacing groups (Ersättande grupper), with the reader's
 * own database reads played by a mock that answers by the filter it is asked:
 * the läsår of the replacing groups, and the lessons' own teaching groups
 * that keep their members on (keptByOf). Alva is in 7A.
 */
type Row = Record<string, unknown>;
type Query = { where?: Record<string, any> };

const YEAR = 'y26';
const gateLesson = (id: string, studentGroupId: string, subjectId: string, extra: Partial<GateLesson> = {}): GateLesson => ({
  id,
  subjectId,
  studentGroupId,
  teacherId: `t-${id}`,
  coTeacherId: null,
  roomId: `r-${id}`,
  dayOfWeek: 1,
  startTime: '10:00',
  endTime: '11:00',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  extraGroupIds: [],
  studentIds: [],
  subjectName: subjectId,
  groupName: studentGroupId,
  ...extra,
});

describe('PUB_CLASHES with replacing groups', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;

  /** The school: its groups (with läsår, kind, half, replaced subject) and memberships. */
  const arrange = (groups: Row[], memberships: Array<{ studentId: string; studentGroupId: string }>) => {
    tx.availabilityConstraint.findMany.mockResolvedValue([]);
    tx.teachingRequirement.findMany.mockResolvedValue([]);
    tx.academicYear.findUnique.mockResolvedValue({ isActive: true, predecessorId: null });
    tx.studentGroup.findMany.mockImplementation((query: Query = {}) => {
      const where = query.where ?? {};
      if ('halfOfId' in where && where['halfOfId']?.not === null && !('kind' in where)) return Promise.resolve([]);
      return Promise.resolve(
        groups.filter(
          (group) =>
            (where['academicYearId'] === undefined || group['academicYearId'] === where['academicYearId']) &&
            (where['replacesSubjectId']?.not !== null || group['replacesSubjectId'] !== null) &&
            (where['id']?.in === undefined || where['id'].in.includes(group['id'])) &&
            (where['kind'] === undefined || group['kind'] === where['kind']) &&
            (!('halfOfId' in where) || where['halfOfId'] !== null || group['halfOfId'] === null),
        ),
      );
    });
    tx.studentGroupMember.findMany.mockImplementation((query: Query = {}) =>
      Promise.resolve(memberships.filter((row) => query.where?.['studentGroupId']?.in?.includes(row.studentGroupId) ?? true)),
    );
    tx.user.findMany.mockImplementation((query: Query = {}) => {
      const homes = [{ id: 'alva', studentGroupId: '7A' }];
      const where = query.where ?? {};
      if (where['id']?.in) return Promise.resolve(homes.filter((row) => where['id'].in.includes(row.id)));
      const classes = where['studentGroupId']?.in ?? [where['studentGroupId']];
      return Promise.resolve(homes.filter((row) => classes.includes(row.studentGroupId)));
    });
  };

  beforeEach(() => {
    tx = createTxMock();
  });

  it('keeps a teaching group’s own svenska apart from SvA7 when they share a pupil', async () => {
    // Sv7n is Svenska fördjupning (a teaching group, not a half); Alva is in
    // it and in SvA7, which replaces Svenska. Placed in Sv7n, she goes there.
    arrange(
      [
        { id: 'SvA7', academicYearId: YEAR, kind: 'TEACHING_GROUP', halfOfId: null, replacesSubjectId: 'SV' },
        { id: 'Sv7n', academicYearId: YEAR, kind: 'TEACHING_GROUP', halfOfId: null, replacesSubjectId: null },
      ],
      [
        { studentId: 'alva', studentGroupId: 'Sv7n' },
        { studentId: 'alva', studentGroupId: 'SvA7' },
      ],
    );
    const finding = await clashFinding(client(), testUser(), YEAR, [gateLesson('fd', 'Sv7n', 'SV'), gateLesson('sva', 'SvA7', 'SVA')]);
    expect(finding.count).toBe(1);
    // The own teaching groups were read only beside a replacing group.
    expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['Sv7n', 'SvA7'] }, kind: 'TEACHING_GROUP', halfOfId: null },
      select: { id: true },
    });
  });

  it('lets SvA7 sit beside 7A’s svenska, and last year’s SvA6 hide no named pupil’s clash', async () => {
    arrange(
      [
        { id: 'SvA7', academicYearId: YEAR, kind: 'TEACHING_GROUP', halfOfId: null, replacesSubjectId: 'SV' },
        { id: 'SvA6', academicYearId: 'y25', kind: 'TEACHING_GROUP', halfOfId: null, replacesSubjectId: 'SV' },
        { id: '7A', academicYearId: YEAR, kind: 'CLASS', halfOfId: null, replacesSubjectId: null },
      ],
      [
        { studentId: 'alva', studentGroupId: 'SvA6' },
        { studentId: 'bo', studentGroupId: 'SvA7' },
      ],
    );
    // Alva, of last year's SvA6, is named on Ma7's lesson at the hour of 7A's
    // svenska: she is on both. SvA7's lesson beside it shares nobody.
    const finding = await clashFinding(client(), testUser(), YEAR, [
      gateLesson('sv', '7A', 'SV'),
      gateLesson('named', 'Ma7', 'MA', { studentIds: ['alva'] }),
      gateLesson('sva', 'SvA7', 'SVA'),
    ]);
    expect(finding.count).toBe(1);
    expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
      where: { academicYearId: YEAR, replacesSubjectId: { not: null } },
      select: { id: true, replacesSubjectId: true, academicYearId: true },
    });
  });
});
