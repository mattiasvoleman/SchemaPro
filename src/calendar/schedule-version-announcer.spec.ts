import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { testUser } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ScheduleVersionsController } from './schedule-versions.controller';
import { ScheduleVersionAnnouncer } from './schedule-version-announcer';
import type { ScheduleVersionNamesService } from './schedule-version-names.service';
import type { ScheduleVersionsService } from './schedule-versions.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const VERSION = '55555555-5555-4555-8555-555555555555';

/*
 * EN ÅTERSTÄLLNING SÄGER TILL PERSONALRUMMET (E9, g465 L-4): a restore replaces every lesson of the year, and a colleague with the timetable open got nothing
 * (and `docs/schedule-editing.md` said the client reads the year). The event names no lesson, since they have new ids. It is sent once the restore has
 * committed, to administrators alone in the draft mode, and a restore that fails tells nobody.
 */
describe('ScheduleVersionAnnouncer', () => {
  const build = (mode: 'DIRECT' | 'DRAFT' | null, readFails = false) => {
    const findUnique = jest.fn(async () => {
      if (readFails) throw new Error('no connection');
      return mode ? { publishMode: mode } : null;
    });
    const prisma = { queryWithRls: jest.fn((_user: unknown, run: (db: unknown) => unknown) => run({ publicationSettings: { findUnique } })) };
    const realtime = { notifyMasterTimetableChanged: jest.fn() };
    return { announcer: new ScheduleVersionAnnouncer(prisma as unknown as PrismaService, realtime as unknown as RealtimeService), realtime, findUnique };
  };

  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('tells everyone who reads the grundschema, in the school of the caller, naming no lesson', async () => {
    const { announcer, realtime, findUnique } = build('DIRECT');
    await announcer.restored(testUser({ schoolId: SCHOOL }));
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledTimes(1);
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, {});
    expect(findUnique).toHaveBeenCalledWith({ where: { schoolId: SCHOOL }, select: { publishMode: true } });
  });

  it('tells a school with no settings row as one that publishes directly', async () => {
    const { announcer, realtime } = build(null);
    await announcer.restored(testUser({ schoolId: SCHOOL }));
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, {});
  });

  it('tells only the administrators when the school publishes through a draft', async () => {
    const { announcer, realtime } = build('DRAFT');
    await announcer.restored(testUser({ schoolId: SCHOOL }));
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, { draft: true });
  });

  it('tells everyone when the mode cannot be read: a client that is told too much reads the year and finds what it had', async () => {
    const { announcer, realtime } = build('DRAFT', true);
    await announcer.restored(testUser({ schoolId: SCHOOL }));
    expect(realtime.notifyMasterTimetableChanged).toHaveBeenCalledWith(SCHOOL, {});
  });
});

describe('POST /api/v1/schedule-versions/:id/restore tells the staff room once it has committed', () => {
  const build = (restore: jest.Mock) => {
    const announcer = { restored: jest.fn().mockResolvedValue(undefined) };
    const controller = new ScheduleVersionsController({ restore } as unknown as ScheduleVersionsService, {} as unknown as ScheduleVersionNamesService, announcer as unknown as ScheduleVersionAnnouncer);
    return { controller, announcer };
  };

  it('answers what the restore answered, and tells after the restore has returned', async () => {
    const restore = jest.fn().mockResolvedValue({ restoredLessons: 12, safetyVersionId: 's-1' });
    const { controller, announcer } = build(restore);
    const user = testUser({ schoolId: SCHOOL });
    await expect(controller.restore(VERSION, user)).resolves.toEqual({ restoredLessons: 12, safetyVersionId: 's-1' });
    expect(restore).toHaveBeenCalledWith(VERSION, user);
    expect(announcer.restored).toHaveBeenCalledWith(user);
    expect(restore.mock.invocationCallOrder[0]).toBeLessThan(announcer.restored.mock.invocationCallOrder[0]!);
  });

  it('tells nobody when the restore fails: nothing was replaced', async () => {
    const restore = jest.fn().mockRejectedValue(new Error('SCHEDULE_BUSY'));
    const { controller, announcer } = build(restore);
    await expect(controller.restore(VERSION, testUser({ schoolId: SCHOOL }))).rejects.toThrow('SCHEDULE_BUSY');
    expect(announcer.restored).not.toHaveBeenCalled();
  });
});
