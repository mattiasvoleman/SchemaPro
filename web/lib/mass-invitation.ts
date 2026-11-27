/**
 * The mass invitation, in parts (Första veckan utan operatören).
 *
 * A school invites a class, a year or everybody. One call for all of them was one long request with no word of how far it had got, a
 * gateway that refused anything over 500 people with a 400, and no way to take it up again after a refusal. Supabase's own mail limit
 * (2 an hour on its own sender, 30 with the project's SMTP) makes a refusal part of the road: 300 people at 30 an hour is ten hours.
 *
 * So the web sends the people in parts of CHUNK, one part at a time, and says where it is. What makes it safe to stop and to take up
 * again is that nothing here remembers who was invited: the gateway skips a person who was invited already (`alreadyInvited`) and the
 * list to take up again is read from the register again, so a person is never invited twice, whether the run stopped for the limit,
 * for a network error, because the administrator pressed Stop or because the tab was closed.
 */

/** What POST /api/v1/users/invitations answers. Fields a gateway older than the web does not send are optional. */
export interface InvitationReport {
  sent: number;
  alreadyRegistered: number;
  /** People skipped because they were invited already (or are being invited right now by another request). */
  alreadyInvited?: number;
  /** People with no address to send to (Personer utan e-postadress). */
  noAddress?: number;
  errors: { userId: string; message: string }[];
  /** The project's mail limit was spent: the rest of the part was not tried. */
  stopped?: "RATE_LIMITED";
  /** How many of the part's people were not tried because of it. */
  notTried?: number;
}

export type MassPhase = "running" | "paused" | "stopped" | "done";

/** Why a paused run stopped: the project's mail limit, or a call that failed (the network, the gateway's own throttle). */
export type PausedFor = "RATE_LIMITED" | "ERROR";

export interface MassProgress {
  phase: MassPhase;
  pausedFor?: PausedFor;
  /** The call that failed, when pausedFor is ERROR: said by apiErrorText where it is shown, and never by its own message. */
  error?: unknown;
  /** The people this run set out to invite. */
  total: number;
  /** How many of them have been dealt with: invited, skipped for a reason below, or failed. */
  handled: number;
  sent: number;
  alreadyRegistered: number;
  alreadyInvited: number;
  noAddress: number;
  failed: { userId: string; message: string }[];
}

/** The people in one call: twenty is a few seconds of Supabase calls, short enough for a progress bar that moves. */
export const CHUNK = 20;

export interface MassOptions {
  chunk?: number;
  /** Called after every part, and at the start with nothing done. */
  onProgress?: (progress: MassProgress) => void;
  /** Asked before every part: true stops the run there ("Stoppa"), with everything before it kept. */
  shouldStop?: () => boolean;
}

export const emptyProgress = (total: number): MassProgress => ({
  phase: "running",
  total,
  handled: 0,
  sent: 0,
  alreadyRegistered: 0,
  alreadyInvited: 0,
  noAddress: 0,
  failed: [],
});

export function parts<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/**
 * Sends `ids` in parts, one at a time, through `send`, and answers how it went. Never throws: a call that fails pauses the run
 * (`pausedFor: "ERROR"`) with the people of that part still to do, because whether any of them was invited before the call failed is
 * for the register to say when the run is taken up again, not for this to guess.
 */
export async function inviteInParts(
  ids: readonly string[],
  send: (ids: string[]) => Promise<InvitationReport>,
  options: MassOptions = {},
): Promise<MassProgress> {
  const progress = emptyProgress(ids.length);
  const say = () => options.onProgress?.({ ...progress, failed: [...progress.failed] });
  say();
  for (const part of parts(ids, options.chunk ?? CHUNK)) {
    if (options.shouldStop?.()) {
      progress.phase = "stopped";
      say();
      return progress;
    }
    let report: InvitationReport;
    try {
      report = await send(part);
    } catch (error) {
      progress.phase = "paused";
      progress.pausedFor = "ERROR";
      progress.error = error;
      say();
      return progress;
    }
    const notTried = report.stopped ? Math.min(report.notTried ?? 0, part.length) : 0;
    progress.handled += part.length - notTried;
    progress.sent += report.sent;
    progress.alreadyRegistered += report.alreadyRegistered;
    progress.alreadyInvited += report.alreadyInvited ?? 0;
    progress.noAddress += report.noAddress ?? 0;
    progress.failed.push(...report.errors);
    if (report.stopped === "RATE_LIMITED") {
      progress.phase = "paused";
      progress.pausedFor = "RATE_LIMITED";
      say();
      return progress;
    }
    say();
  }
  progress.phase = "done";
  say();
  return progress;
}

/**
 * How long a run of `people` takes at `perHour` mails an hour, in whole hours rounded up, or null when the limit is not known or
 * the run fits in the first hour. What the dialog says before it starts, so that 300 people at 30 an hour is not a surprise.
 */
export function hoursToInvite(people: number, perHour: number | null): number | null {
  if (perHour === null || perHour <= 0 || people <= perHour) return null;
  return Math.ceil(people / perHour);
}
