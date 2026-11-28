import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import type { StaffingWarning } from "@/lib/types";

/*
 * What a staffing write said back, as sentences.
 *
 * The gateway answers every write that staffs a timplanspost with the policy's
 * verdict in ONE shape, whichever mode produced it: a code from the engine
 * catalogue (optimization-engine/app/messages.py) and the flat params its
 * sentence is written from. WARN puts them in `warnings` beside the saved
 * row; REFUSE puts the first of them in a 409 problem body as `code` and
 * `params`, with the Swedish sentence as `detail`. So both are rendered by
 * the same function the generate page renders the engine's refusals with,
 * from the `engineMessages` namespace, and a reader in English gets English.
 *
 * NEVER A NAME. The params name the subject, the grades and the minutes —
 * the gateway leaves the teacher out on purpose, because a refusal sentence
 * ends up in logs and screenshots. The UI says whom it is about by where the
 * sentence is shown: under the candidate's own row.
 */

/**
 * The codes the staffing policy writes; the generate pre-flight's is the
 * last. A post that changes during the year is refused per period, with the
 * period's dates (src/staffing/staffing-checks.ts), or, to a reader who may
 * not see how it changes, with the verdict alone (..._HIDDEN).
 */
export const STAFFING_CODES = [
  "STAFF_TEACHER_NOT_QUALIFIED",
  "STAFF_TEACHER_OVER_TARGET",
  "STAFF_TEACHER_OVER_TARGET_IN_PERIOD",
  "STAFF_TEACHER_OVER_TARGET_HIDDEN",
  "STAFF_TEACHER_OVER_SCOPE",
  "STAFF_TEACHER_OVER_SCOPE_HIDDEN",
  "STAFF_UNSTAFFED_REQUIREMENTS",
] as const;

const isStaffingCode = (code: string | undefined): code is (typeof STAFFING_CODES)[number] =>
  code !== undefined && (STAFFING_CODES as readonly string[]).includes(code);

/** One WARN finding as a sentence. The code itself is the last-resort fallback. */
export function warningText(t: MessageLookup, warning: StaffingWarning): string {
  return engineMessage(t, { code: warning.code, message: warning.code, params: warning.params });
}

export interface StaffingRefusal {
  code: (typeof STAFFING_CODES)[number];
  params: Record<string, string | number>;
  /** The gateway's own Swedish sentence, shown when the catalogue lacks the key. */
  message: string;
}

/**
 * The policy's refusal, when `error` is one: a 409 carrying a STAFF_* code.
 * Anything else — a clash, a 403, the network — is null and the caller shows
 * it the way it shows every other failure.
 */
export function staffingRefusal(error: unknown): StaffingRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 409 || !isStaffingCode(error.code)) {
    return null;
  }
  return { code: error.code, params: error.params ?? {}, message: error.message };
}

export function refusalText(t: MessageLookup, refusal: StaffingRefusal): string {
  return engineMessage(t, refusal);
}

/**
 * A save's toast: "saved", or — when the staffing policy warned — the same
 * line as a warning with the policy's sentences under it, held longer than a
 * plain save because it names a behörighet or a limit the admin may want to
 * act on. For the writes that answer 200 with `warnings` and have no notice
 * of their own: the vikarie (never refused, only warned) and a lesson given
 * a new teacher.
 */
export function savedToast(
  t: MessageLookup,
  title: string,
  warnings: StaffingWarning[] | undefined,
  /** Låset vid en flytt (E4): the sentence that says the move locked the lesson, and the button that takes the lock off again. */
  lock?: LockedNote,
): void {
  const action = lock ? { label: lock.unlock, onClick: lock.onUnlock } : undefined;
  if (!warnings || warnings.length === 0) {
    if (lock) toast.success(title, { description: lock.text, action, duration: 8_000 });
    else toast.success(title);
    return;
  }
  toast.warning(title, {
    description: [...warnings.map((warning) => warningText(t, warning)), ...(lock ? [lock.text] : [])].join(" "),
    ...(action ? { action } : {}),
    duration: 12_000,
  });
}

/** What a save that locked the lesson says, and how it is taken back (the page's, since the page knows the lesson). */
export interface LockedNote {
  text: string;
  unlock: string;
  onUnlock: () => void;
}
