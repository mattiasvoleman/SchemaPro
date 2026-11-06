/*
 * What Krisläge keeps in the browser, and the one way to wipe it (lib/crisis-queue.ts says what it is).
 *
 * Its own module and nothing else in it: the user menu calls clearCrisisStorage when someone signs
 * out, and the menu is in every signed-in route's shared chunk, so it must not drag the queue, the
 * hook or the types with it.
 */

/** Every key of Krisläge starts so, whoever it was kept for. */
export const CRISIS_STORAGE_PREFIX = "rastra.crisis.";

/**
 * Removes everything Krisläge has kept on this device, for every login that has used it: the lists
 * of pupils and the marks not yet sent belong to the person who was signed in, and the next one on
 * a shared computer must not find them. A storage that cannot be read or written leaves nothing to wipe.
 */
export function clearCrisisStorage(): void {
  try {
    const store = globalThis.localStorage;
    for (const key of Object.keys(store)) if (key.startsWith(CRISIS_STORAGE_PREFIX)) store.removeItem(key);
  } catch {
    // Blocked site data or a private window: there is nothing of ours in it.
  }
}
