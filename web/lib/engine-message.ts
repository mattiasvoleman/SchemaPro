/**
 * The Swedish for a sentence the engine wrote, or the engine's own English.
 *
 * The solver refuses a week in sentences a school has to act on — "the dining
 * hall's 115 seats cannot seat the 11 classes named" — and it has no idea who
 * is reading. So it sends a stable CODE and a flat dict of PARAMS beside the
 * English (optimization-engine/app/messages.py), and the reader renders the
 * language it is in. This is that render, for the one screen that shows them.
 *
 * THE FALLBACK IS THE POINT. Three things can go missing and none of them may
 * blank the screen of an admin whose generation just failed:
 *
 *   - the code, on a job row written before codes existed;
 *   - the message key, when the engine ships a sentence the web has not
 *     translated yet — the two deploy separately, so this is a Tuesday, not a
 *     bug;
 *   - a param the Swedish uses and the engine did not send, which would make
 *     next-intl throw inside the render.
 *
 * In all three the English is shown. Untranslated is a poor read; empty is no
 * read at all, and the sentence is the whole value of the response.
 *
 * TWO OF THEM ARE KNOWN AND ARE NOT LEFT TO THE FALLBACK. A refusal of a placed
 * lesson is stored with the job it refused, and the argument `block` (the block a
 * member's lesson belongs to) is newer than the oldest of them: a row written
 * before Förlägg blocket has no `block`, and reads as a lesson of no block.
 * Likewise a shared teacher's line written before it said what the classes
 * lose has no `classOwn`: the sentence branches on it, and "unknown" is the
 * branch that says what the line always said, in Swedish, which the English
 * fallback would not.
 */
const PARAM_DEFAULTS: Record<string, Record<string, string | number>> = {
  PLACEMENT_CANNOT_STAND: { block: "NO_BLOCK" },
  TEACHER_SHARED_BY_PARALLEL_GROUPS: { classOwn: "unknown" },
};

/** The half of next-intl's translator this needs, so a test can pass a stub. */
export interface MessageLookup {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

export interface EngineMessage {
  /** Absent on rows written before the engine named its sentences. */
  code?: string | null;
  /** The engine's own English, always present. */
  message: string;
  params?: Record<string, string | number> | null;
}

export function engineMessage(t: MessageLookup, sentence: EngineMessage): string {
  const { code, message, params } = sentence;
  if (!code || !t.has(code)) return message;
  try {
    return t(code, { ...(PARAM_DEFAULTS[code] ?? {}), ...(params ?? {}) });
  } catch {
    // next-intl throws on a missing argument rather than printing a hole.
    // Same answer as an untranslated key: show what the engine said.
    return message;
  }
}
