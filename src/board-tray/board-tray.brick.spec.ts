import { createPrismaMock, createTxMock, testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { BoardTrayService } from './board-tray.service';

const YEAR = '99999999-9999-4999-8999-999999999999';
const GROUP = '66666666-6666-4666-8666-666666666666';
const SUBJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ANNA = '44444444-4444-4444-8444-444444444444';
const CIA = '55555555-5555-4555-8555-555555555555';
const POST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/*
 * A brick says who is in the room besides its teacher. The question "where can this brick stand?" (E3, POST /master-lessons/possible-times with a `brick`)
 * takes a medlärare, and the page builds that question from the brick: without the field it would be asked of a lesson with one teacher less, and
 * every time the medlärare is busy would be called free.
 */
describe('BoardTrayService: the brick of a post with a medlärare', () => {
  it('carries the post\'s medlärare on every brick, and null on a post without one', async () => {
    const tx = createTxMock();
    const service = new BoardTrayService(createPrismaMock(tx) as unknown as PrismaService, {} as never);
    const post = (id: string, coTeacherId: string | null) => ({
      id,
      studentGroupId: GROUP,
      subjectId: SUBJECT,
      teacherId: ANNA,
      coTeacherId,
      lessonsPerWeek: 2,
      minutesPerLesson: 60,
      lessonLengths: [],
      recurrence: 'ALL_WEEKS',
      blockId: null,
      startDate: null,
      endDate: null,
      minutesBefore: 0,
      minutesAfter: 0,
      shares: [],
    });
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR });
    tx['teachingRequirement']!['findMany']!.mockResolvedValue([post(POST, CIA), post('dddddddd-dddd-4ddd-8ddd-dddddddddddd', null)]);
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([]);
    tx['masterLesson']!['findMany']!.mockResolvedValue([]);
    tx['teachingBlock']!['findMany']!.mockResolvedValue([]);
    const tray = await service.trayOfYear(YEAR, undefined, testUser());
    expect(tray.bricks.filter((brick) => brick.postId === POST).map((brick) => brick.coTeacherId)).toEqual([CIA, CIA]);
    expect(tray.bricks.filter((brick) => brick.postId !== POST).map((brick) => brick.coTeacherId)).toEqual([null, null]);
  });
});
