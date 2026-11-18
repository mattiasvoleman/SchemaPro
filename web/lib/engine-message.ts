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
 *   - a param the Swedish uses and the engine did not send. next-intl does not
 *     throw for that: it reports the missing argument and answers with its
 *     fallback for the key, "<namespace>.<CODE>", which is what a school would
 *     read in place of the sentence (see below).
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
  // `classes` is read by the one branch that says the classes have nothing of their own (one class or several); a line that is in that branch
  // always carries it, and a line that does not read as several, which is what the sentence said before it counted them.
  TEACHER_SHARED_BY_PARALLEL_GROUPS: { classOwn: "unknown", classes: 0 },
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
    const text = t(code, { ...(PARAM_DEFAULTS[code] ?? {}), ...(params ?? {}) });
    // The real translator does not throw on a missing argument: its default
    // onError only reports it and the answer is its fallback for the key,
    // "<namespace>.<CODE>". That is not a sentence. Same answer as an
    // untranslated key: show what the engine said.
    return text === code || text.endsWith(`.${code}`) ? message : text;
  } catch {
    // A translator that does throw (a stub, or one with an onError that does).
    return message;
  }
}
