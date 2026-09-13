import {
  LESSON_UPDATED_EVENT,
  MASTER_TIMETABLE_UPDATED_EVENT,
  TIMETABLE_PRESENCE_EVENT,
} from './realtime.types';

/*
 * The clients do not import these constants; they subscribe by literal string.
 * The teacher app listens in mobile/src/services/sync/websocket_client.ts, the
 * timetable editor in web/lib/use-timetable-realtime.ts. Every server spec
 * imports the constant, so a rename here compiles, passes all of them, and
 * silently stops the updates. This file is the only place the server side
 * holds the names the clients hold.
 */
describe('realtime wire event names', () => {
  it.each([
    ['a changed calendar lesson, heard by the teacher app', LESSON_UPDATED_EVENT, 'calendar_lesson_updated'],
    ['a changed master timetable, heard by the web editor', MASTER_TIMETABLE_UPDATED_EVENT, 'master_timetable_updated'],
    ['the editor presence roster, heard by the web editor', TIMETABLE_PRESENCE_EVENT, 'timetable_presence'],
  ])('%s', (_what, constant, listenedFor) => {
    expect(constant).toBe(listenedFor);
  });
});
