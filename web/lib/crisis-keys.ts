/**
 * The react-query keys of Krisläge, under one prefix: a `crisis_updated` event
 * (started, ended, or a mark made) invalidates the prefix and every mounted
 * read of the alarm asks again. The event names no pupil and no group, so it
 * can only say "ask again".
 *
 * Its own module, like lib/cover-keys.ts, so the realtime hook does not import
 * the pages' hooks.
 */
export const CRISIS_KEYS = {
  all: ["crisis"] as const,
  settings: ["crisis", "settings"] as const,
  /** The newest alarms, from which the page finds the one that is open. */
  recent: ["crisis", "alarms", "recent"] as const,
  list: (mode: "LIVE" | "DRILL") => ["crisis", "alarms", mode] as const,
  detail: (id: string) => ["crisis", "alarm", id] as const,
  protocol: (id: string) => ["crisis", "protocol", id] as const,
  mine: ["crisis", "mine"] as const,
  /**
   * The teacher's search for a pupil they found (POST /crisis/mine/pupils; the text is in its body, never in a URL). NOT under "crisis" on purpose:
   * the `crisis_updated` event invalidates that prefix at every mark made, and an open search would ask
   * again each time. It lives only while the picker is open (gcTime 0) and is held nowhere else.
   */
  search: (alarmId: string, q: string) => ["crisis-search", alarmId, q] as const,
};
