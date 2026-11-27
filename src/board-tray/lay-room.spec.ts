import { createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { layRoomRefusal } from './lay-room';

/*
 * EN LAGD BRICKA HAR EN SAL SOM GENERATORNS REGLER GODKÄNNER, ELLER INGEN (E4 Klart (e), granskaren g490).
 *
 * Domaren vägrar en sal som är upptagen eller stängd; ingenting annat frågar om platser, typ eller årskurser. Läggningen frågar därför generatorns egen
 * regel (roomAllowed, med samma behov som generatorn läser) och nekar en sal den inte skulle ta, med skälet.
 */

const YEAR = '99999999-9999-4999-8999-999999999999';
const G7A = '66666666-6666-4666-8666-666666666666';
const KEM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LAB = '12121212-1212-4121-8121-121212121212';
const KLASSRUM = '13131313-1313-4131-8131-131313131313';
const ROOM = '11111111-1111-4111-8111-111111111111';

const room = (over: Record<string, unknown> = {}) => ({ id: ROOM, name: 'Sal', capacity: null, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null, ...over });

describe('layRoomRefusal: the generator\'s rule for a room, asked of the room a brick is laid in', () => {
  let tx: TxMock;
  let rooms: ReturnType<typeof room>;
  let requiredRoomTypeId: string | null;

  beforeEach(() => {
    tx = createTxMock();
    rooms = room();
    requiredRoomTypeId = null;
    tx['academicYear']!['findUnique']!.mockResolvedValue({ id: YEAR, isActive: true, predecessorId: null, gradeNumbering: 'NIOARIG' });
    tx['room']!['findUnique']!.mockImplementation(async () => rooms);
    tx['subject']!['findUnique']!.mockImplementation(async () => ({ requiredRoomTypeId }));
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: G7A, gradeLevel: 7, halfOfId: null }]);
    // Three pupils whose home class is 7A.
    tx['user']!['findMany']!.mockResolvedValue([1, 2, 3].map((n) => ({ id: `pupil-${n}`, studentGroupId: G7A })));
    tx['studentGroupMember']!['findMany']!.mockResolvedValue([]);
  });

  const ask = () => layRoomRefusal(tx as never, testUser(), { academicYearId: YEAR, studentGroupId: G7A, subjectId: KEM, roomId: ROOM });

  it('lets a room that fits through: no limits, enough seats, the kind the subject needs', async () => {
    expect(await ask()).toBeNull();
    rooms = room({ capacity: 3 });
    expect(await ask()).toBeNull();
    requiredRoomTypeId = LAB;
    rooms = room({ roomTypeId: LAB, capacity: 30 });
    expect(await ask()).toBeNull();
  });

  it('refuses a room with fewer seats than the class has pupils', async () => {
    rooms = room({ capacity: 2 });
    expect(await ask()).toBe('SEATS');
  });

  it('refuses a room of another kind than the subject needs, and a room of no kind when the subject needs one', async () => {
    requiredRoomTypeId = LAB;
    rooms = room({ roomTypeId: KLASSRUM });
    expect(await ask()).toBe('TYPE');
    rooms = room({ roomTypeId: null });
    expect(await ask()).toBe('TYPE');
  });

  it('refuses a room fenced to other years than the class\'s', async () => {
    rooms = room({ minGradeLevel: 8, maxGradeLevel: 9 });
    expect(await ask()).toBe('YEARS');
  });

  it('asks nothing of a room that is not the school\'s: the write\'s foreign key answers it as for every hand edit', async () => {
    tx['room']!['findUnique']!.mockResolvedValue(null);
    expect(await ask()).toBeNull();
  });
});
