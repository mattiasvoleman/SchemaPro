/*
 * SÄKERHETSNÄT (E9): what the page saw of a lesson, for the fields a write sets.
 *
 * A PATCH of a lesson says what the page read of the fields it is about to write (`expected`), and the gateway refuses it, under the lesson's
 * row lock, when somebody else has changed one of them since: 409 LESSON_CHANGED, with the names. Only the fields the write sets are named, so a
 * colleague's change of something else is not in its way, and the page's own earlier writes are what the lesson holds by then.
 */

/**
 * What a lesson in `state` (a snapshot, a list's row or a write's answer) holds of the fields `patch` sets, by the names the patch sets them by,
 * which are the gateway's own (`EXPECTED_FIELDS`, src/calendar/lesson-expectation.ts; lesson-expected.test.ts holds a snapshot's fields to them). A key
 * of the patch that the state has no value for is no field of the lesson (`propagate`) or not read, and is left out.
 */
export function seenOf(state: object, patch: object): Record<string, unknown> {
  const from = state as Record<string, unknown>;
  const seen: Record<string, unknown> = {};
  for (const field of Object.keys(patch)) {
    // The exemption is `exempt` in a write and `exemptFrom` in a row and an answer, and a lesson that has none says nothing.
    const value = field === "exempt" ? (from["exempt"] ?? from["exemptFrom"] ?? []) : from[field];
    if (value !== undefined) seen[field] = /Time$/.test(field) ? String(value).slice(0, 5) : value;
  }
  return seen;
}
